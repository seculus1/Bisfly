const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

const root = __dirname;
const dataFile = path.join(root, "leads.json");
const insuranceFile = path.join(root, "insurance-applications.json");
const agreementFile = path.join(root, "agreements.json");
const adminFile = path.join(root, "admin-credentials.json");
const adminUsersFile = path.join(root, "admin-users.json");
const uploadsDir = path.join(root, "uploads");
const sessionsDir = path.join(root, "sessions");
const packagesFile = path.join(root, "packages.json");
const passportFile = path.join(root, "passport-requests.json");
const partnershipFile = path.join(root, "partnerships.json");

function loadEnvFile() {
  const candidates = [path.join(root, ".env.local"), path.join(root, ".env")];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
      const value = key === "EMAIL_PASS" ? rawValue.replace(/\s+/g, "") : rawValue;

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }

    console.log(`✓ Loaded environment variables from ${path.basename(envPath)}`);
    return;
  }
}

loadEnvFile();
const port = Number(process.env.PORT || 8082);
const host = process.env.HOST || "0.0.0.0";

// Ensure directories exist
const logsDir = path.join(root, "logs");
[uploadsDir, sessionsDir, logsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const activityLogFile = path.join(logsDir, "activity.log");
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

// ==================== SECURITY & VALIDATION ====================
function generateSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function hashPasswordWithSalt(password, salt = null) {
  if (!salt) salt = generateSalt();
  const hash = crypto.pbkdf2Sync(String(password || ""), salt, 100000, 64, "sha512").toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const result = crypto.pbkdf2Sync(String(password || ""), salt, 100000, 64, "sha512").toString("hex");
  return result === hash;
}

// Input Validation
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

function validatePhone(phone) {
  const re = /^[\d\+\-\(\)\s]{7,}$/;
  return re.test(String(phone));
}

function validateDate(dateStr) {
  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

function sanitizeInput(input) {
  if (typeof input !== "string") return input;
  return input.trim().replace(/[<>\"']/g, "");
}

// ==================== ACTIVITY LOGGING ====================
function logActivity(action, details, user = "system") {
  const logEntry = {
    timestamp: new Date().toISOString(),
    action,
    user,
    details,
    ip: null
  };
  try {
    const log = fs.readFileSync(activityLogFile, "utf8");
    const entries = log.split("\n").filter(l => l).map(l => JSON.parse(l));
    entries.push(logEntry);
    // Keep only last 10000 entries
    if (entries.length > 10000) entries.shift();
    fs.writeFileSync(activityLogFile, entries.map(e => JSON.stringify(e)).join("\n"));
  } catch (e) {
    fs.writeFileSync(activityLogFile, JSON.stringify(logEntry) + "\n");
  }
}

// ==================== RATE LIMITING ====================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 100;

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  const limit = rateLimitMap.get(ip);
  if (now > limit.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  limit.count++;
  if (limit.count > RATE_LIMIT_MAX) return false;
  return true;
}

// Cleanup expired rate limits periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of rateLimitMap.entries()) {
    if (now > limit.resetTime) rateLimitMap.delete(ip);
  }
}, 60000);

// Email Transporter Setup
let emailTransporter;

function getEmailFrom() {
  const configuredFrom = process.env.RESEND_FROM_EMAIL || process.env.EMAIL_FROM || process.env.EMAIL_USER || "hello@yourdomain.com";
  if (String(process.env.EMAIL_HOST || "").includes("resend") && /@gmail\.com$/i.test(configuredFrom)) {
    return "onboarding@resend.dev";
  }
  return configuredFrom;
}

async function initializeEmailTransport() {
  try {
    const resendApiKey = process.env.RESEND_API_KEY || process.env.EMAIL_PASS || "";
    const smtpUsername = process.env.RESEND_SMTP_USER || process.env.SMTP_USER || "resend";
    const fromEmail = getEmailFrom();
    const emailUser = process.env.EMAIL_USER || fromEmail;
    const emailPass = process.env.EMAIL_PASS || resendApiKey || "";
    const emailService = (process.env.EMAIL_SERVICE || (process.env.RESEND_API_KEY ? "resend" : "gmail")).toLowerCase();
    const emailHost = process.env.EMAIL_HOST || (process.env.RESEND_API_KEY ? "smtp.resend.com" : "");
    const emailPort = Number(process.env.EMAIL_PORT || (emailHost.includes("resend") ? 587 : (emailService === "gmail" ? 587 : 465)));
    const emailSecure = String(process.env.EMAIL_SECURE ?? (emailHost.includes("resend") ? "false" : (emailService === "gmail" ? "false" : "true"))).toLowerCase() === "true";

    if (emailHost.includes("resend") && resendApiKey && !resendApiKey.startsWith("re_")) {
      throw new Error("Invalid Resend API key format. Generate a Resend key beginning with re_ and set it as RESEND_API_KEY and EMAIL_PASS.");
    }

    if (!emailPass) {
      console.warn("\n⚠️  EMAIL_PASS / RESEND_API_KEY environment variable not set. Falling back to Ethereal test account for email preview.");
      const testAccount = await nodemailer.createTestAccount();
      emailTransporter = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass
        }
      });
      console.log(`✓ Ethereal test account created; preview emails will be available via a preview URL.`);
      return;
    }

    const transportOptions = emailHost
      ? {
          host: emailHost,
          port: emailPort,
          secure: emailSecure,
          auth: {
            user: smtpUsername,
            pass: emailPass
          },
          tls: {
            rejectUnauthorized: false
          }
        }
      : {
          service: emailService,
          auth: {
            user: emailUser,
            pass: emailPass
          }
        };

    if (emailHost && emailHost.includes("resend")) {
      Object.assign(transportOptions, {
        host: "smtp.resend.com",
        port: 587,
        secure: false,
        tls: {
          rejectUnauthorized: false
        }
      });
    }

    if (!emailHost && emailService === "gmail") {
      Object.assign(transportOptions, {
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        tls: {
          rejectUnauthorized: false
        }
      });
    }

    emailTransporter = nodemailer.createTransport(transportOptions);

    await emailTransporter.verify();
    console.log(`✓ Email service configured: SMTP user=${smtpUsername}, sender=${fromEmail}, host=${emailHost || emailService}`);
  } catch (error) {
    console.warn("Email configuration error. Notifications will be skipped:", error.message);
  }
}

async function sendApprovalEmail(agreement) {
  if (!emailTransporter) return { sent: false, error: "Email not configured" };

  try {
    const pdfBuffer = await generateAgreementPdf(agreement);
    const fromEmail = getEmailFrom();

    const mailOptions = {
      from: fromEmail,
      to: agreement.email,
      subject: "Your BisFly Travels Agreement - Approved",
      html: `
        <h2>Dear ${agreement.fullName},</h2>
        <p>Your BisFly Travels and Tours agreement has been approved by our admin team.</p>
        <p><strong>Agreement Details:</strong></p>
        <ul>
          <li><strong>Destination:</strong> ${agreement.destination}</li>
          <li><strong>Location:</strong> ${agreement.location}</li>
          <li><strong>Amount Paid:</strong> ${agreement.amountPaid}</li>
          <li><strong>Agreement Date:</strong> ${agreement.signatureDate || new Date(agreement.createdAt).toLocaleDateString()}</li>
        </ul>
        <p>Your approved agreement is attached as a PDF. Please download and keep it for your records.</p>
        <p>If you have any questions, please contact us at bisflytravels@gmail.com</p>
        <p>Best regards,<br/>BisFly Travels and Tours Team</p>
      `,
      attachments: [
        {
          filename: `bisfly-agreement-${agreement.id}.pdf`,
          content: pdfBuffer
        }
      ]
    };

    const info = await emailTransporter.sendMail(mailOptions);
    console.log(`✓ Approval email sent to ${agreement.email}`);
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    console.error(`✗ Failed to send approval email to ${agreement.email}:`, error.message);
    return { sent: false, error: error.message };
  }
}

async function sendSimpleEmail(to, subject, html) {
  if (!emailTransporter) return { sent: false, error: 'Email not configured' };
  try {
    const fromEmail = getEmailFrom();
    const info = await emailTransporter.sendMail({
      from: fromEmail,
      to,
      subject,
      html
    });
    console.log(`✓ Confirmation email sent to ${to}`);
    // If using Ethereal, log the preview URL
    try {
      const preview = nodemailer.getTestMessageUrl(info);
      if (preview) console.log('Email preview URL:', preview);
    } catch (e) {
      // ignore
    }
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    console.error('Failed to send email to', to, error.message || error);
    return { sent: false, error: error.message };
  }
}

function notifySubmission(customerEmail, customerSubject, customerHtml, adminSubject, adminHtml) {
  const adminEmail = process.env.EMAIL_USER || process.env.RESEND_FROM_EMAIL;
  const messages = [];

  if (customerEmail) messages.push(sendSimpleEmail(customerEmail, customerSubject, customerHtml));
  if (adminEmail && adminEmail.toLowerCase() !== String(customerEmail || "").toLowerCase()) {
    messages.push(sendSimpleEmail(adminEmail, adminSubject, adminHtml));
  }

  Promise.all(messages).then(results => {
    results.filter(result => !result.sent).forEach(result => {
      console.error("Submission email was not sent:", result.error || "Unknown email error");
    });
  }).catch(error => console.error("Submission email error:", error.message));
}

function initializeAdmin() {
  if (!fs.existsSync(adminFile)) {
    const { hash, salt } = hashPasswordWithSalt("BisFly@2026");
    const adminCreds = {
      username: "admin",
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(adminFile, JSON.stringify(adminCreds, null, 2));
    console.log("✓ Admin credentials initialized with secure hashing");
  }
}

function readLeads() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch (error) {
    return [];
  }
}

function writeLeads(leads) {
  fs.writeFileSync(dataFile, JSON.stringify(leads, null, 2));
}

function readInsurance() {
  try {
    return JSON.parse(fs.readFileSync(insuranceFile, "utf8"));
  } catch (error) {
    return [];
  }
}

function writeInsurance(data) {
  fs.writeFileSync(insuranceFile, JSON.stringify(data, null, 2));
}

function readAgreements() {
  try {
    return JSON.parse(fs.readFileSync(agreementFile, "utf8"));
  } catch (error) {
    return [];
  }
}

function writeAgreements(data) {
  fs.writeFileSync(agreementFile, JSON.stringify(data, null, 2));
}

function readPackages() {
  try {
    const packages = JSON.parse(fs.readFileSync(packagesFile, "utf8"));
    return Array.isArray(packages) ? packages : [];
  } catch (error) {
    console.error("Unable to read packages:", error.message);
    return [];
  }
}

function writePackages(data) {
  const temporaryFile = `${packagesFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temporaryFile, packagesFile);
}

function readPassports() {
  try {
    return JSON.parse(fs.readFileSync(passportFile, "utf8"));
  } catch (error) {
    return [];
  }
}

function writePassports(data) {
  fs.writeFileSync(passportFile, JSON.stringify(data, null, 2));
}

function readPartnerships() {
  try {
    return JSON.parse(fs.readFileSync(partnershipFile, "utf8"));
  } catch (error) {
    return [];
  }
}

function writePartnerships(data) {
  fs.writeFileSync(partnershipFile, JSON.stringify(data, null, 2));
}

function normalizeCustomerFields(input = {}) {
  const fullName = input.fullName || input.name || input.clientName || input.customerName || "";
  const name = input.name || fullName;
  const email = input.email || input.contactEmail || "";
  const phone = input.phone || input.mobile || input.contactPhone || "";
  const destination = input.destination || input.country || input.location || input.travelDestination || "";
  const country = input.country || destination || "";
  const service = input.service || input.visaType || input.requestType || input.passportType || input.packageType || "Visa request";
  const message = input.message || input.notes || input.additionalDetails || "";
  const date = input.date || input.travelDate || input.startDate || input.tripDate || input.visitDate || "";

  return {
    ...input,
    fullName,
    name,
    email,
    phone,
    destination,
    country,
    service,
    message,
    date
  };
}

function normalizePackagePrice(value) {
  if (value === null || value === undefined || value === "") return "";
  let next = String(value).trim();
  if (!next) return "";
  if (/^(ngn|naira|₦)/i.test(next)) return next;
  if (/^[\d,.]+$/.test(next.replace(/[^\d.]/g, ""))) {
    return `₦ ${next.replace(/\s+/g, "")}`;
  }
  return `₦ ${next}`;
}

function normalizePackageTags(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function generateTablePdf(title, rows = []) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
    const buffers = [];

    doc.on("data", chunk => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const safeRows = Array.isArray(rows) ? rows : [];
    const headers = safeRows.length ? Object.keys(safeRows[0] || {}) : [];

    doc.font("Helvetica-Bold").fontSize(18).text(title, { align: "center" });
    doc.moveDown(0.5);

    if (!headers.length) {
      doc.font("Helvetica").fontSize(11).text("No data available", { align: "center" });
      doc.end();
      return;
    }

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = pageWidth / headers.length;
    let y = doc.y;
    let pageStartY = y;

    const drawHeader = () => {
      doc.font("Helvetica-Bold").fontSize(8);
      headers.forEach((header, index) => {
        const x = doc.page.margins.left + index * colWidth;
        doc.text(String(header || "").slice(0, 24), x, y, { width: colWidth - 6, align: "left" });
      });
      y += 18;
      doc.moveTo(doc.page.margins.left, y - 5).lineTo(doc.page.width - doc.page.margins.right, y - 5).stroke();
    };

    const drawRow = (row) => {
      if (y > doc.page.height - 70) {
        doc.addPage({ size: "A4", layout: "landscape" });
        y = doc.page.margins.top;
        drawHeader();
      }

      doc.font("Helvetica").fontSize(7);
      headers.forEach((header, index) => {
        const value = row[header];
        const stringValue = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
        const x = doc.page.margins.left + index * colWidth;
        doc.text(stringValue.slice(0, 80), x, y, { width: colWidth - 6, align: "left" });
      });
      y += 16;
      doc.moveTo(doc.page.margins.left, y - 4).lineTo(doc.page.width - doc.page.margins.right, y - 4).stroke();
    };

    drawHeader();
    safeRows.forEach(row => drawRow(row));
    doc.end();
  });
}

function generateAgreementPdf(agreement) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const buffers = [];

    doc.on("data", chunk => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const logoPath = path.join(root, "bisfly-logo.png");
    const signaturePath = agreement.signatureFile ? path.join(uploadsDir, agreement.signatureFile) : null;

    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, { fit: [120, 120], align: "center" });
      } catch (error) {
        // ignore missing or invalid logo image
      }
    }

    doc
      .font("Helvetica-Bold")
      .fontSize(20)
      .text("BisFly Travels and Tours Agreement", { align: "center" })
      .moveDown(0.5);

    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#555")
      .text("Agreement between BisFly Travels and Tours and the customer.", { align: "center" })
      .moveDown(1.5);

    doc.fontSize(12).fillColor("#111");
    doc.text("Customer Information", { underline: true });
    doc.moveDown(0.5);

    const info = [
      ["Client Name:", agreement.fullName],
      ["Email:", agreement.email],
      ["Date of Birth:", agreement.dateOfBirth],
      ["Destination:", agreement.destination],
      ["Location:", agreement.location],
      ["Amount Paid:", agreement.amountPaid],
      ["Balance Amount:", agreement.balanceAmount],
      ["Agreement Date:", agreement.signatureDate || new Date(agreement.createdAt).toLocaleDateString()]
    ];

    info.forEach(([label, value]) => {
      doc.font("Helvetica-Bold").text(label, { continued: true, width: 150 });
      doc.font("Helvetica").text(value || "N/A");
    });

    doc.moveDown(1);
    doc.font("Helvetica-Bold").text("Terms and Conditions");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(10).text(
      "This agreement confirms that the customer accepts BisFly Travels and Tours terms and conditions of service. There is a strict no refund policy under all circumstances, regardless of reason or condition. The customer acknowledges that payments made are non-refundable once confirmed and processed.",
      { align: "justify" }
    );

    doc.moveDown(1);
    doc.font("Helvetica-Bold").text("Customer Signature");
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").text("Signature Name:", { continued: true, width: 150 });
    doc.font("Helvetica").text(agreement.customerSignature || "_____________________________");
    doc.font("Helvetica-Bold").text("Signature Date:", { continued: true, width: 150 });
    doc.font("Helvetica").text(agreement.signatureDate || new Date(agreement.createdAt).toLocaleDateString());

    if (signaturePath && fs.existsSync(signaturePath)) {
      try {
        doc.moveDown(0.5);
        doc.image(signaturePath, { fit: [250, 120] });
      } catch (error) {
        // ignore invalid signature image
      }
    }

    doc.moveDown(1);
    const stampX = doc.x;
    const currentY = doc.y;
    const stampText = `BisFly Travels and Tours Stamp\n${new Date(agreement.createdAt).toLocaleDateString()}`;
    doc.rect(stampX, currentY, 220, 90).stroke();
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, stampX + 10, currentY + 10, { fit: [80, 80] });
      } catch (error) {
        // ignore logo drawing errors
      }
    }
    doc.font("Helvetica-Bold").fontSize(10).text(stampText, stampX + 100, currentY + 22, { width: 110 });

    doc.moveDown(5);
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(
      "This agreement was prepared for the customer listed above and reflects the current payment details and terms agreed at the time of signing.",
      { align: "justify" }
    );

    doc.end();
  });
}

function readAdminCreds() {
  try {
    return JSON.parse(fs.readFileSync(adminFile, "utf8"));
  } catch (error) {
    return null;
  }
}

// Old SHA256 function kept for legacy support - DO NOT USE FOR NEW PASSWORDS
function hashPassword(value) {
  // DEPRECATED: Use hashPasswordWithSalt instead
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function readAdminUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(adminUsersFile, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    return [];
  }
}

function writeAdminUsers(users) {
  fs.writeFileSync(adminUsersFile, JSON.stringify(users, null, 2));
}

function initializeAdminUsers() {
  const { hash, salt } = hashPasswordWithSalt("BisFly@2026");
  const defaultUser = {
    id: 1,
    username: "admin",
    passwordHash: hash,
    passwordSalt: salt,
    role: "super-admin",
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const users = readAdminUsers();
  if (!users.length) {
    writeAdminUsers([defaultUser]);
    console.log("✓ Admin users initialized with secure hashing");
    return;
  }

  const hasAdmin = users.some(user => String(user.username).toLowerCase() === "admin");
  if (!hasAdmin) {
    users.unshift(defaultUser);
    writeAdminUsers(users);
  }
}

function sanitizeUser(user) {
  if (!user) return null;
  const safeUser = { ...user };
  delete safeUser.passwordHash;
  delete safeUser.passwordSalt;
  return safeUser;
}

function isMasterAdminSession(session) {
  const role = String(session?.role || "").toLowerCase();
  return role === "super-admin" || role === "master-admin" || role === "admin" && session?.username === "admin";
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createSession(adminUsername, role = "admin") {
  const token = generateSessionToken();
  const sessionFile = path.join(sessionsDir, token);
  fs.writeFileSync(sessionFile, JSON.stringify({
    username: adminUsername,
    role,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  }));
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const sessionFile = path.join(sessionsDir, token);
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    if (session.expiresAt < Date.now()) {
      fs.unlinkSync(sessionFile);
      return null;
    }
    return session;
  } catch (error) {
    return null;
  }
}

// Cleanup expired sessions periodically
setInterval(() => {
  try {
    const files = fs.readdirSync(sessionsDir);
    const now = Date.now();
    files.forEach(file => {
      const sessionFile = path.join(sessionsDir, file);
      try {
        const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        if (session.expiresAt < now) {
          fs.unlinkSync(sessionFile);
        }
      } catch (e) {
        // ignore errors, file might be deleted
      }
    });
  } catch (e) {
    // ignore
  }
}, 300000); // Every 5 minutes

function parseMultipartForm(body, boundary) {
  if (!boundary) return { fields: {}, files: {} };
  const parts = body.split(`--${boundary}`);
  const fields = {};
  const files = {};

  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.substring(0, headerEnd);
    const content = part.substring(headerEnd + 4, part.length - 2);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const contentTypeMatch = headers.match(/Content-Type: ([^\r\n]+)/i);

    if (nameMatch) {
      const fieldName = nameMatch[1];
      if (filenameMatch) {
        files[fieldName] = {
          filename: filenameMatch[1],
          data: Buffer.from(content, "binary"),
          contentType: contentTypeMatch ? contentTypeMatch[1].trim() : "application/octet-stream"
        };
      } else {
        fields[fieldName] = content.trim();
      }
    }
  }

  return { fields, files };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 10_000_000) {
        request.destroy();
        reject(new Error("Body too large"));
      }
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks);
        const contentType = request.headers["content-type"] || "";
        if (contentType.includes("multipart/form-data")) {
          const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
          const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : "";
          const bodyStr = raw.toString("binary");
          const parsed = parseMultipartForm(bodyStr, boundary);
          resolve(parsed);
        } else {
          const text = raw.toString("utf8");
          resolve(text ? JSON.parse(text) : {});
        }
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, data, contentType = "application/json; charset=utf-8") {
  response.writeHead(status, { "Content-Type": contentType });
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    response.end(data);
    return;
  }
  response.end(typeof data === "string" ? data : JSON.stringify(data));
}

function chatReply(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("insurance")) {
    return "BisFly offers comprehensive travel insurance. Visit our Insurance section to submit your application with travel document and personal information.";
  }
  if (text.includes("schengen")) {
    return "BisFly can guide Schengen travel plans, including itinerary support, hotel reservation, insurance reminders, and appointment preparation.";
  }
  if (text.includes("e-visa") || text.includes("evisa") || text.includes("online visa")) {
    return "For E-Visas, BisFly helps confirm eligibility, required documents, processing expectations, and safe application steps.";
  }
  if (text.includes("visa")) {
    return "Great. Which country are you applying to, and is it for tourism, study, business, or work? BisFly can help with document checks and next steps.";
  }
  if (text.includes("flight") || text.includes("ticket")) {
    return "Please share your departure city, destination, travel date, passenger count, and budget range so BisFly can compare flight options.";
  }
  if (text.includes("study")) {
    return "For study abroad, tell me your preferred country, course level, timeline, and whether you already have admission.";
  }
  if (text.includes("hotel")) {
    return "BisFly can help with hotel options. Share the city, dates, guest count, and preferred budget.";
  }
  if (text.includes("contact") || text.includes("instagram") || text.includes("facebook")) {
    return "You can email bisflytravels@gmail.com, message @bisfly_travels on Instagram (https://www.instagram.com/bisfly_travels), or contact BisFly through the Facebook page.";
  }
  return "Thanks for chatting with BisFly. Tell me your destination, travel date, number of travelers, budget range, and the service you need.";
}

function serveStatic(request, response) {
  const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/admin") pathname = "/admin-login.html";
  if (pathname === "/admin-login") pathname = "/admin-login.html";
  if (pathname === "/admin-dashboard") pathname = "/admin-dashboard.html";

  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root)) {
    send(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(response, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    send(response, 200, data, mimeTypes[path.extname(filePath)] || "application/octet-stream");
  });
}

const server = http.createServer(async (request, response) => {
  const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (request.method === "OPTIONS") {
    response.writeHead(200);
    response.end();
    return;
  }

  // Restrict direct public access to the agreement page; require admin session
  try {
    const reqPath = parsedUrl.pathname;
    if (request.method === "GET" && reqPath === "/agreement.html") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 404, "Not found", "text/plain; charset=utf-8");
        return;
      }
    }
  } catch (e) {
    // ignore session validation errors and continue
  }

  try {

    // Admin Authentication Endpoints
    if (parsedUrl.pathname === "/api/admin/login" && request.method === "POST") {
      const body = await readBody(request);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const users = readAdminUsers();
      const user = users.find(item => String(item.username).toLowerCase() === username.toLowerCase() && item.active !== false);
      const creds = readAdminCreds();

      // Verify against new users with salt-based hashing
      if (user && user.passwordSalt && user.passwordHash && verifyPassword(password, user.passwordHash, user.passwordSalt)) {
        const token = createSession(user.username, user.role || "admin");
        logActivity("admin_login", { username: user.username, role: user.role || "admin" }, username);
        send(response, 200, { ok: true, token, username: user.username, role: user.role || "admin", message: "Login successful" });
        return;
      }

      // Legacy support: verify against old SHA256 hashes
      if (user && !user.passwordSalt && user.passwordHash === hashPassword(password)) {
        const token = createSession(user.username, user.role || "admin");
        logActivity("admin_login", { username: user.username, role: user.role || "admin", legacyHash: true }, username);
        // Upgrade to new hash
        const { hash, salt } = hashPasswordWithSalt(password);
        user.passwordHash = hash;
        user.passwordSalt = salt;
        writeAdminUsers(users);
        send(response, 200, { ok: true, token, username: user.username, role: user.role || "admin", message: "Login successful" });
        return;
      }

      // Legacy support: verify against old admin credentials
      if (creds && username === creds.username) {
        if (creds.passwordSalt && verifyPassword(password, creds.passwordHash, creds.passwordSalt)) {
          const token = createSession(creds.username, "super-admin");
          logActivity("admin_login", { username: creds.username, role: "super-admin" }, username);
          send(response, 200, { ok: true, token, username: creds.username, role: "super-admin", message: "Login successful" });
          return;
        }
        if (!creds.passwordSalt && creds.passwordHash === hashPassword(password)) {
          const token = createSession(creds.username, "super-admin");
          logActivity("admin_login", { username: creds.username, role: "super-admin", legacyHash: true }, username);
          // Upgrade to new hash
          const { hash, salt } = hashPasswordWithSalt(password);
          creds.passwordHash = hash;
          creds.passwordSalt = salt;
          fs.writeFileSync(adminFile, JSON.stringify(creds, null, 2));
          send(response, 200, { ok: true, token, username: creds.username, role: "super-admin", message: "Login successful" });
          return;
        }
      }

      logActivity("admin_login_failed", { username, reason: "invalid_credentials" }, username);
      send(response, 401, { ok: false, message: "Invalid credentials" });
      return;
    }

    if (parsedUrl.pathname === "/api/admin/users" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      if (!isMasterAdminSession(session)) {
        send(response, 403, { ok: false, message: "Master admin access required" });
        return;
      }
      const users = readAdminUsers().map(sanitizeUser);
      send(response, 200, users);
      return;
    }

    if (parsedUrl.pathname === "/api/admin/users" && request.method === "POST") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      if (!isMasterAdminSession(session)) {
        send(response, 403, { ok: false, message: "Master admin access required" });
        return;
      }

      const body = await readBody(request);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const role = String(body.role || "admin").trim();

      if (!username || !password || password.length < 8) {
        send(response, 400, { ok: false, message: "Username and a password of at least 8 characters are required" });
        return;
      }

      const users = readAdminUsers();
      const exists = users.some(item => String(item.username).toLowerCase() === username.toLowerCase());
      if (exists) {
        send(response, 409, { ok: false, message: "That username already exists" });
        return;
      }

      const { hash, salt } = hashPasswordWithSalt(password);
      const newUser = {
        id: Date.now(),
        username,
        passwordHash: hash,
        passwordSalt: salt,
        role,
        active: body.active !== false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      users.unshift(newUser);
      writeAdminUsers(users);
      logActivity("admin_user_created", { username: session.username, target: username, role }, session.username);
      send(response, 201, { ok: true, user: sanitizeUser(newUser) });
      return;
    }

    if (parsedUrl.pathname.match(/^\/api\/admin\/users\/[0-9]+$/) && request.method === "PUT") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      if (!isMasterAdminSession(session)) {
        send(response, 403, { ok: false, message: "Master admin access required" });
        return;
      }

      const id = Number(parsedUrl.pathname.split("/").pop());
      const body = await readBody(request);
      const users = readAdminUsers();
      const userIndex = users.findIndex(item => item.id === id);
      if (userIndex === -1) {
        send(response, 404, { ok: false, message: "User not found" });
        return;
      }

      const existing = users[userIndex];
      const nextUsername = String(body.username || existing.username).trim();
      if (nextUsername && nextUsername.toLowerCase() !== existing.username.toLowerCase()) {
        const conflict = users.some(item => item.id !== id && String(item.username).toLowerCase() === nextUsername.toLowerCase());
        if (conflict) {
          send(response, 409, { ok: false, message: "That username already exists" });
          return;
        }
      }

      const updated = {
        ...existing,
        username: nextUsername || existing.username,
        role: String(body.role || existing.role || "admin").trim(),
        active: body.active !== undefined ? body.active !== false : existing.active !== false,
        updatedAt: new Date().toISOString()
      };

      if (body.password) {
        const { hash, salt } = hashPasswordWithSalt(body.password);
        updated.passwordHash = hash;
        updated.passwordSalt = salt;
      }

      users[userIndex] = updated;
      writeAdminUsers(users);
      logActivity("admin_user_updated", { username: session.username, target: updated.username, role: updated.role }, session.username);
      send(response, 200, { ok: true, user: sanitizeUser(users[userIndex]) });
      return;
    }

    if (parsedUrl.pathname.match(/^\/api\/admin\/users\/[0-9]+$/) && request.method === "DELETE") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      if (!isMasterAdminSession(session)) {
        send(response, 403, { ok: false, message: "Master admin access required" });
        return;
      }

      const id = Number(parsedUrl.pathname.split("/").pop());
      const users = readAdminUsers();
      const index = users.findIndex(item => item.id === id);
      if (index === -1) {
        send(response, 404, { ok: false, message: "User not found" });
        return;
      }

      const [removed] = users.splice(index, 1);
      if (String(removed.username).toLowerCase() === String(session.username).toLowerCase()) {
        send(response, 400, { ok: false, message: "You cannot delete your own account while logged in" });
        users.splice(index, 0, removed);
        return;
      }

      writeAdminUsers(users);
      logActivity("admin_user_deleted", { username: session.username, target: removed.username }, session.username);
      send(response, 200, { ok: true, deleted: sanitizeUser(removed) });
      return;
    }

    if (parsedUrl.pathname.match(/^\/api\/admin\/users\/[0-9]+\/reset-password$/) && request.method === "POST") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      if (!isMasterAdminSession(session)) {
        send(response, 403, { ok: false, message: "Master admin access required" });
        return;
      }

      const id = Number(parsedUrl.pathname.split("/")[4]);
      const body = await readBody(request);
      const newPassword = String(body.newPassword || "");
      if (!newPassword || newPassword.length < 8) {
        send(response, 400, { ok: false, message: "New password must be at least 8 characters" });
        return;
      }

      const users = readAdminUsers();
      const user = users.find(item => item.id === id);
      if (!user) {
        send(response, 404, { ok: false, message: "User not found" });
        return;
      }

      const { hash, salt } = hashPasswordWithSalt(newPassword);
      user.passwordHash = hash;
      user.passwordSalt = salt;
      user.updatedAt = new Date().toISOString();
      writeAdminUsers(users);
      logActivity("admin_password_reset", { username: session.username, target: user.username }, session.username);
      send(response, 200, { ok: true, message: `Password reset for ${user.username}` });
      return;
    }

    if (parsedUrl.pathname === "/api/admin/logout" && request.method === "POST") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      if (token) {
        const sessionFile = path.join(sessionsDir, token);
        if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
      }
      send(response, 200, { ok: true, message: "Logged out" });
      return;
    }

    if (parsedUrl.pathname === "/api/admin/verify" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      send(response, session ? 200 : 401, { authenticated: !!session, username: session?.username, role: session?.role || "admin" });
      return;
    }

    // Chat API
    if (parsedUrl.pathname === "/api/chat" && request.method === "POST") {
      const body = await readBody(request);
      send(response, 200, { reply: chatReply(body.message) });
      return;
    }

    // Travel Insurance Endpoints
    if (parsedUrl.pathname === "/api/insurance" && request.method === "POST") {
      const { fields, files } = await readBody(request);
      if (!files.travelDocument) {
        send(response, 400, { ok: false, message: "Travel document required" });
        return;
      }

      const file = files.travelDocument;
      const ext = path.extname(file.filename).toLowerCase();
      if (![".jpg", ".jpeg"].includes(ext)) {
        send(response, 400, { ok: false, message: "Only JPG files allowed" });
        return;
      }

      const fileName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
      const filePath = path.join(uploadsDir, fileName);
      fs.writeFileSync(filePath, file.data);

      const normalized = normalizeCustomerFields(fields);
      const insurance = readInsurance();
      insurance.unshift({
        ...normalized,
        id: Date.now(),
        documentFile: fileName,
        createdAt: new Date().toISOString(),
        status: "pending"
      });
      writeInsurance(insurance);
      send(response, 201, { ok: true, message: "Insurance application submitted" });
      if (normalized.email) {
        const html = `<p>Dear ${normalized.fullName || normalized.name || 'Customer'},</p><p>Thank you for submitting your travel insurance application. We will review it and contact you shortly.</p><p>Reference ID: ${insurance[0].id}</p><p>Best regards,<br/>BisFly Travels and Tours</p>`;
        notifySubmission(normalized.email, 'BisFly: Insurance application received', html, 'BisFly: New insurance application', `<p>A new travel insurance application was submitted.</p><p><strong>Name:</strong> ${normalized.fullName || normalized.name || 'Customer'}</p><p><strong>Email:</strong> ${normalized.email}</p><p><strong>Reference ID:</strong> ${insurance[0].id}</p>`);
      }
      return;
    }

    if (parsedUrl.pathname === "/api/insurance" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      send(response, 200, readInsurance());
      return;
    }

    // Packages endpoints
    if (parsedUrl.pathname === "/api/packages" && request.method === "GET") {
      response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      send(response, 200, readPackages());
      return;
    }

    if (parsedUrl.pathname === "/api/packages" && request.method === "POST") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }

      const parsed = await readBody(request);
      const fields = parsed.fields || parsed;
      const files = parsed.files || {};

      if (!fields.title || !fields.description) {
        send(response, 400, { ok: false, message: 'title and description are required' });
        return;
      }

      const pkg = {
        id: Date.now(),
        title: String(fields.title || "Untitled Package").trim(),
        description: String(fields.description || "").trim(),
        price: normalizePackagePrice(fields.price),
        duration: fields.duration ? String(fields.duration).trim() : "",
        tags: normalizePackageTags(fields.tags),
        imageFile: null,
        createdAt: new Date().toISOString(),
      };

      if (files.image) {
        const file = files.image;
        const ext = path.extname(file.filename).toLowerCase();
        if (![".jpg", ".jpeg", ".png"].includes(ext)) {
          send(response, 400, { ok: false, message: "Image must be JPG or PNG" });
          return;
        }
        const imageName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
        fs.writeFileSync(path.join(uploadsDir, imageName), file.data);
        pkg.imageFile = imageName;
      }

      const packages = readPackages();
      packages.unshift(pkg);
      writePackages(packages);
      send(response, 201, { ok: true, package: pkg });
      return;
    }

    if (parsedUrl.pathname.match(/^\/api\/packages\/[^\/]+$/) && request.method === "PUT") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) return send(response, 401, { ok: false, message: "Unauthorized" });

      const id = Number(parsedUrl.pathname.split("/")[3]);
      const packages = readPackages();
      const idx = packages.findIndex(p => p.id === id);
      if (idx === -1) return send(response, 404, { ok: false, message: "Package not found" });

      const parsed = await readBody(request);
      const fields = parsed.fields || parsed;
      const files = parsed.files || {};
      const existing = packages[idx];

      if (!fields.title || !fields.description) {
        send(response, 400, { ok: false, message: 'title and description are required' });
        return;
      }

      const updated = {
        ...existing,
        title: String(fields.title || existing.title || "Untitled Package").trim(),
        description: String(fields.description || existing.description || "").trim(),
        price: normalizePackagePrice(fields.price !== undefined ? fields.price : existing.price),
        duration: fields.duration !== undefined ? String(fields.duration).trim() : (existing.duration || ""),
        tags: fields.tags !== undefined ? normalizePackageTags(fields.tags) : (Array.isArray(existing.tags) ? existing.tags : [])
      };

      if (files.image) {
        const file = files.image;
        const ext = path.extname(file.filename).toLowerCase();
        if (![".jpg", ".jpeg", ".png"].includes(ext)) {
          send(response, 400, { ok: false, message: "Image must be JPG or PNG" });
          return;
        }
        if (existing.imageFile) {
          const oldImagePath = path.join(uploadsDir, existing.imageFile);
          if (fs.existsSync(oldImagePath)) fs.unlinkSync(oldImagePath);
        }
        const imageName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
        fs.writeFileSync(path.join(uploadsDir, imageName), file.data);
        updated.imageFile = imageName;
      }

      packages[idx] = updated;
      writePackages(packages);
      send(response, 200, { ok: true, package: updated });
      return;
    }

    if (parsedUrl.pathname.match(/^\/api\/packages\/[^\/]+$/) && request.method === "DELETE") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) return send(response, 401, { ok: false, message: "Unauthorized" });
      const id = Number(parsedUrl.pathname.split("/")[3]);
      const packages = readPackages();
      const idx = packages.findIndex(p => p.id === id);
      if (idx === -1) return send(response, 404, { ok: false, message: "Package not found" });
      const removed = packages.splice(idx, 1)[0];
      if (removed.imageFile) {
        const imgPath = path.join(uploadsDir, removed.imageFile);
        if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
      }
      writePackages(packages);
      send(response, 200, { ok: true });
      return;
    }

    if (parsedUrl.pathname === "/api/passports" && request.method === "POST") {
      const parsed = await readBody(request);
      const fields = parsed.fields || parsed;
      const requiredFields = ["fullName", "email", "phone", "nationality", "passportType", "requestType"];
      for (const field of requiredFields) {
        if (!fields[field]) {
          send(response, 400, { ok: false, message: `${field} is required` });
          return;
        }
      }

      const normalized = normalizeCustomerFields(fields);
      const passports = readPassports();
      passports.unshift({
        id: Date.now(),
        fullName: normalized.fullName,
        name: normalized.name,
        email: normalized.email,
        phone: normalized.phone,
        nationality: normalized.nationality || normalized.country || "",
        passportType: normalized.passportType || normalized.service || "",
        requestType: normalized.requestType || normalized.service || "",
        dob: normalized.dob || normalized.date || null,
        travelDate: normalized.travelDate || normalized.date || null,
        message: normalized.message || "",
        status: "pending",
        createdAt: new Date().toISOString()
      });
      writePassports(passports);
      send(response, 201, { ok: true, message: "Passport request submitted" });
      if (normalized.email) {
        const html = `<p>Dear ${normalized.fullName || normalized.name || 'Customer'},</p><p>Your passport request has been received. We will contact you shortly with next steps.</p><p>Reference ID: ${passports[0].id}</p><p>Thank you,<br/>BisFly Travels and Tours</p>`;
        notifySubmission(normalized.email, 'BisFly: Passport request received', html, 'BisFly: New passport request', `<p>A new passport request was submitted.</p><p><strong>Name:</strong> ${normalized.fullName || normalized.name || 'Customer'}</p><p><strong>Email:</strong> ${normalized.email}</p><p><strong>Reference ID:</strong> ${passports[0].id}</p>`);
      }
      return;
    }

    if (parsedUrl.pathname === "/api/partnerships" && request.method === "POST") {
      const body = await readBody(request);
      const fields = body.fields || body;
      const requiredFields = ["companyName", "contactName", "email", "phone", "partnershipType", "message"];
      for (const field of requiredFields) {
        if (!fields[field]) {
          send(response, 400, { ok: false, message: `${field} is required` });
          return;
        }
      }

      const normalized = {
        id: Date.now(),
        companyName: String(fields.companyName || "").trim(),
        contactName: String(fields.contactName || "").trim(),
        email: String(fields.email || "").trim(),
        phone: String(fields.phone || "").trim(),
        country: String(fields.country || "").trim(),
        businessFocus: String(fields.businessFocus || "").trim(),
        expectedVolume: String(fields.expectedVolume || "").trim(),
        partnershipType: String(fields.partnershipType || "").trim(),
        message: String(fields.message || "").trim(),
        status: "pending",
        createdAt: new Date().toISOString()
      };

      const partnerships = readPartnerships();
      partnerships.unshift(normalized);
      writePartnerships(partnerships);
      send(response, 201, { ok: true, message: "Partnership request submitted" });
      if (normalized.email) {
        const html = `<p>Dear ${normalized.contactName || 'Partner'},</p><p>Thank you for your interest in partnering with BisFly Travel and Tours. Our team will review your proposal and contact you soon.</p><p>Partnership Type: ${normalized.partnershipType}</p><p>Reference ID: ${normalized.id}</p><p>Best regards,<br/>BisFly Travels and Tours</p>`;
        notifySubmission(normalized.email, 'BisFly: Partnership request received', html, 'BisFly: New partnership request', `<p>A new partnership request was submitted.</p><p><strong>Company:</strong> ${normalized.companyName}</p><p><strong>Contact:</strong> ${normalized.contactName}</p><p><strong>Email:</strong> ${normalized.email}</p><p><strong>Phone:</strong> ${normalized.phone}</p><p><strong>Type:</strong> ${normalized.partnershipType}</p>`);
      }
      return;
    }

    if (parsedUrl.pathname === "/api/partnerships" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      send(response, 200, readPartnerships());
      return;
    }

    if (parsedUrl.pathname === "/api/passports" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      send(response, 200, readPassports());
      return;
    }

    if (parsedUrl.pathname.match(/^\/api\/passports\/[^\/]+$/) && request.method === "DELETE") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const id = Number(parsedUrl.pathname.split("/")[3]);
      const passports = readPassports();
      const idx = passports.findIndex(item => item.id === id);
      if (idx === -1) {
        send(response, 404, { ok: false, message: "Passport request not found" });
        return;
      }
      passports.splice(idx, 1);
      writePassports(passports);
      send(response, 200, { ok: true, message: "Passport request deleted" });
      return;
    }

    if (parsedUrl.pathname === "/api/agreement" && request.method === "POST") {
      const parsed = await readBody(request);
      const fields = parsed.fields || parsed;
      const files = parsed.files || {};
      const requiredFields = ["fullName", "email", "dateOfBirth", "location", "destination", "amountPaid", "balanceAmount", "customerSignature", "signatureDate"];
      for (const field of requiredFields) {
        if (!fields[field]) {
          send(response, 400, { ok: false, message: `${field} is required` });
          return;
        }
      }

      const agreement = {
        ...fields,
        id: Date.now(),
        status: "pending",
        createdAt: new Date().toISOString()
      };

      if (files.signatureFile) {
        const file = files.signatureFile;
        const ext = path.extname(file.filename).toLowerCase();
        if (![".jpg", ".jpeg", ".png"].includes(ext)) {
          send(response, 400, { ok: false, message: "Signature image must be JPG or PNG" });
          return;
        }
        const signatureName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
        fs.writeFileSync(path.join(uploadsDir, signatureName), file.data);
        agreement.signatureFile = signatureName;
        agreement.signatureMime = file.contentType || (ext === ".png" ? "image/png" : "image/jpeg");
      }

      const agreements = readAgreements();
      agreements.unshift(agreement);
      writeAgreements(agreements);
      send(response, 201, { ok: true, id: agreement.id, downloadUrl: `/api/agreements/${agreement.id}/download`, message: "Agreement submitted" });
      return;
    }

    if (parsedUrl.pathname === "/api/agreements" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      send(response, 200, readAgreements());
      return;
    }

    if (parsedUrl.pathname.match(/^\/api\/agreements\/[^\/]+\/approve$/) && request.method === "POST") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const id = Number(parsedUrl.pathname.split("/")[3]);
      const agreements = readAgreements();
      const agreement = agreements.find(item => item.id === id);
      if (!agreement) {
        send(response, 404, { ok: false, message: "Agreement not found" });
        return;
      }
      agreement.status = "approved";
      agreement.approvedAt = new Date().toISOString();
      agreement.approvedBy = session.username;

      // Send approval email to customer
      const emailResult = await sendApprovalEmail(agreement);
      if (emailResult.sent) {
        agreement.emailSent = true;
        agreement.emailSentAt = new Date().toISOString();
      }

      writeAgreements(agreements);
      send(response, 200, { ok: true, agreement, emailSent: emailResult.sent, emailError: emailResult.error });
      return;
    }

    if (parsedUrl.pathname.match(/^\/api\/agreements\/[^\/]+\/download$/) && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      const id = Number(parsedUrl.pathname.split("/")[3]);
      const agreement = readAgreements().find(item => item.id === id);
      if (!agreement) {
        send(response, 404, "Agreement not found", "text/plain; charset=utf-8");
        return;
      }
      if (agreement.status !== "approved" && !session) {
        send(response, 403, "Agreement not approved yet", "text/plain; charset=utf-8");
        return;
      }
      const pdfBuffer = await generateAgreementPdf(agreement);
      response.setHeader("Content-Disposition", `attachment; filename="bisfly-agreement-${id}.pdf"`);
      send(response, 200, pdfBuffer, "application/pdf");
      return;
    }

    // Regular Leads Endpoints
    if (parsedUrl.pathname === "/api/leads" && request.method === "GET") {
      send(response, 200, readLeads());
      return;
    }

    if (parsedUrl.pathname === "/api/leads" && request.method === "POST") {
      const body = await readBody(request);
      const normalized = normalizeCustomerFields(body);
      const leads = readLeads();
      leads.unshift({ ...normalized, id: Date.now(), createdAt: new Date().toISOString() });
      writeLeads(leads);
      send(response, 201, { ok: true });
      if (normalized.email) {
        const lead = leads[0];
        const html = `<p>Dear ${lead.name || lead.fullName || 'Customer'},</p><p>Thank you for contacting BisFly Travels. We received your request and will follow up soon.</p><p>Reference ID: ${lead.id}</p><p>Best regards,<br/>BisFly Travels and Tours</p>`;
        notifySubmission(normalized.email, 'BisFly: We received your request', html, 'BisFly: New customer request', `<p>A new customer request was submitted.</p><p><strong>Name:</strong> ${lead.name || lead.fullName || 'Customer'}</p><p><strong>Email:</strong> ${normalized.email}</p><p><strong>Phone:</strong> ${normalized.phone || 'Not provided'}</p><p><strong>Reference ID:</strong> ${lead.id}</p>`);
      }
      return;
    }

    if (parsedUrl.pathname === "/api/leads" && request.method === "DELETE") {
      writeLeads([]);
      send(response, 200, { ok: true });
      return;
    }

    // File Download Endpoint
    if (parsedUrl.pathname.startsWith("/uploads/")) {
      const fileName = path.basename(parsedUrl.pathname);
      const filePath = path.normalize(path.join(uploadsDir, fileName));
      if (!filePath.startsWith(uploadsDir)) {
        send(response, 403, "Forbidden", "text/plain; charset=utf-8");
        return;
      }
      fs.readFile(filePath, (error, data) => {
        if (error) {
          send(response, 404, "Not found", "text/plain; charset=utf-8");
          return;
        }
        response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        send(response, 200, data, "image/jpeg");
      });
      return;
    }

    // ==================== NEW FEATURES: SEARCH & FILTER ====================
    
    // Search in leads
    if (parsedUrl.pathname === "/api/leads/search" && request.method === "GET") {
      const query = parsedUrl.searchParams.get("q") || "";
      const leads = readLeads().filter(lead => 
        (lead.fullName || lead.name || "").toLowerCase().includes(query.toLowerCase()) ||
        (lead.email || "").toLowerCase().includes(query.toLowerCase()) ||
        (lead.phone || "").toLowerCase().includes(query.toLowerCase()) ||
        (lead.destination || "").toLowerCase().includes(query.toLowerCase())
      );
      send(response, 200, leads);
      return;
    }

    // Search in insurance applications
    if (parsedUrl.pathname === "/api/insurance/search" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const query = parsedUrl.searchParams.get("q") || "";
      const insurance = readInsurance().filter(app =>
        (app.fullName || app.name || "").toLowerCase().includes(query.toLowerCase()) ||
        (app.email || "").toLowerCase().includes(query.toLowerCase()) ||
        (app.destination || "").toLowerCase().includes(query.toLowerCase())
      );
      send(response, 200, insurance);
      return;
    }

    // Search in agreements
    if (parsedUrl.pathname === "/api/agreements/search" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const query = parsedUrl.searchParams.get("q") || "";
      const agreements = readAgreements().filter(ag =>
        (ag.fullName || "").toLowerCase().includes(query.toLowerCase()) ||
        (ag.email || "").toLowerCase().includes(query.toLowerCase()) ||
        (ag.destination || "").toLowerCase().includes(query.toLowerCase())
      );
      send(response, 200, agreements);
      return;
    }

    // Filter leads by status/date
    if (parsedUrl.pathname === "/api/leads/filter" && request.method === "GET") {
      const status = parsedUrl.searchParams.get("status");
      const fromDate = parsedUrl.searchParams.get("from");
      const toDate = parsedUrl.searchParams.get("to");
      let leads = readLeads();
      
      if (fromDate) {
        const from = new Date(fromDate);
        leads = leads.filter(l => new Date(l.createdAt) >= from);
      }
      if (toDate) {
        const to = new Date(toDate);
        leads = leads.filter(l => new Date(l.createdAt) <= to);
      }
      send(response, 200, leads);
      return;
    }

    // Filter insurance by status
    if (parsedUrl.pathname === "/api/insurance/filter" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const status = parsedUrl.searchParams.get("status");
      let insurance = readInsurance();
      if (status) {
        insurance = insurance.filter(app => app.status === status);
      }
      send(response, 200, insurance);
      return;
    }

    // Filter agreements by status
    if (parsedUrl.pathname === "/api/agreements/filter" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const status = parsedUrl.searchParams.get("status");
      let agreements = readAgreements();
      if (status) {
        agreements = agreements.filter(ag => ag.status === status);
      }
      send(response, 200, agreements);
      return;
    }

    // ==================== DATA EXPORT (PDF TABLES) ====================

    // Export leads to PDF table
    if (parsedUrl.pathname === "/api/leads/export" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      if (!validateSession(token)) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const leads = readLeads();
      const pdfBuffer = await generateTablePdf("BisFly Leads Export", leads);
      response.setHeader("Content-Disposition", 'attachment; filename="leads-' + new Date().toISOString().split("T")[0] + '.pdf"');
      send(response, 200, pdfBuffer, "application/pdf");
      return;
    }

    // Export insurance applications to PDF table
    if (parsedUrl.pathname === "/api/insurance/export" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const insurance = readInsurance();
      const pdfBuffer = await generateTablePdf("BisFly Insurance Applications Export", insurance);
      response.setHeader("Content-Disposition", 'attachment; filename="insurance-' + new Date().toISOString().split("T")[0] + '.pdf"');
      send(response, 200, pdfBuffer, "application/pdf");
      return;
    }

    // Export agreements to PDF table
    if (parsedUrl.pathname === "/api/agreements/export" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const agreements = readAgreements();
      const pdfBuffer = await generateTablePdf("BisFly Agreements Export", agreements);
      response.setHeader("Content-Disposition", 'attachment; filename="agreements-' + new Date().toISOString().split("T")[0] + '.pdf"');
      send(response, 200, pdfBuffer, "application/pdf");
      return;
    }

    // Export passports to PDF table
    if (parsedUrl.pathname === "/api/passports/export" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const passports = readPassports();
      const pdfBuffer = await generateTablePdf("BisFly Passport Requests Export", passports);
      response.setHeader("Content-Disposition", 'attachment; filename="passports-' + new Date().toISOString().split("T")[0] + '.pdf"');
      send(response, 200, pdfBuffer, "application/pdf");
      return;
    }

    // Export partnerships and packages to PDF tables
    if (parsedUrl.pathname === "/api/partnerships/export" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      if (!validateSession(token)) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const partnerships = readPartnerships();
      const pdfBuffer = await generateTablePdf("BisFly Partnerships Export", partnerships);
      response.setHeader("Content-Disposition", 'attachment; filename="partnerships-' + new Date().toISOString().split("T")[0] + '.pdf"');
      send(response, 200, pdfBuffer, "application/pdf");
      return;
    }

    if (parsedUrl.pathname === "/api/packages/export" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      if (!validateSession(token)) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const packages = readPackages();
      const pdfBuffer = await generateTablePdf("BisFly Packages Export", packages);
      response.setHeader("Content-Disposition", 'attachment; filename="packages-' + new Date().toISOString().split("T")[0] + '.pdf"');
      send(response, 200, pdfBuffer, "application/pdf");
      return;
    }

    // ==================== ANALYTICS & DASHBOARD ====================

    // Get analytics/statistics
    if (parsedUrl.pathname === "/api/analytics" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      
      const leads = readLeads();
      const insurance = readInsurance();
      const agreements = readAgreements();
      const passports = readPassports();
      const packages = readPackages();
      const partnerships = readPartnerships();

      const stats = {
        leads: {
          total: leads.length,
          thisMonth: leads.filter(l => {
            const d = new Date(l.createdAt);
            const now = new Date();
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
          }).length
        },
        insurance: {
          total: insurance.length,
          pending: insurance.filter(i => i.status === "pending").length,
          approved: insurance.filter(i => i.status === "approved").length
        },
        agreements: {
          total: agreements.length,
          pending: agreements.filter(a => a.status === "pending").length,
          approved: agreements.filter(a => a.status === "approved").length
        },
        passports: {
          total: passports.length,
          pending: passports.filter(p => p.status === "pending").length,
          approved: passports.filter(p => p.status === "approved").length
        },
        packages: {
          total: packages.length
        },
        partnerships: {
          total: partnerships.length,
          pending: partnerships.filter(p => p.status === "pending").length,
          approved: partnerships.filter(p => p.status === "approved").length
        },
        generatedAt: new Date().toISOString()
      };
      send(response, 200, stats);
      return;
    }

    // Get activity log
    if (parsedUrl.pathname === "/api/admin/activity-log" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      
      try {
        const limit = Number(parsedUrl.searchParams.get("limit")) || 100;
        const log = fs.readFileSync(activityLogFile, "utf8");
        const entries = log.split("\n").filter(l => l).map(l => {
          try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(e => e).reverse().slice(0, limit);
        send(response, 200, entries);
      } catch (e) {
        send(response, 200, []);
      }
      return;
    }

    // Update admin user password with validation
    if (parsedUrl.pathname === "/api/admin/change-password" && request.method === "POST") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }

      const body = await readBody(request);
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");

      if (!newPassword || newPassword.length < 8) {
        send(response, 400, { ok: false, message: "New password must be at least 8 characters" });
        return;
      }

      const users = readAdminUsers();
      const user = users.find(u => u.username === session.username);
      if (!user) {
        send(response, 404, { ok: false, message: "User not found" });
        return;
      }

      // Verify current password
      if (!verifyPassword(currentPassword, user.passwordHash, user.passwordSalt)) {
        logActivity("password_change_failed", { username: session.username }, session.username);
        send(response, 401, { ok: false, message: "Current password is incorrect" });
        return;
      }

      // Update password
      const { hash, salt } = hashPasswordWithSalt(newPassword);
      user.passwordHash = hash;
      user.passwordSalt = salt;
      user.updatedAt = new Date().toISOString();
      writeAdminUsers(users);
      logActivity("password_changed", { username: session.username }, session.username);
      send(response, 200, { ok: true, message: "Password updated successfully" });
      return;
    }

    serveStatic(request, response);
  } catch (error) {
    console.error("Error:", error);
    send(response, 500, { error: "Server error" });
  }
});

  // Initialize admin credentials and email transport on startup
initializeAdmin();
initializeAdminUsers();
initializeEmailTransport().catch(err => console.error("Email init error:", err));

// Ensure packages file exists
if (!fs.existsSync(packagesFile)) writePackages([]);
if (!fs.existsSync(passportFile)) writePassports([]);
if (!fs.existsSync(partnershipFile)) writePartnerships([]);
if (!fs.existsSync(adminUsersFile)) writeAdminUsers([]);

server.listen(port, host, () => {
  console.log(`BisFly website running at http://${host}:${port}`);
  console.log(`Admin portal available at http://${host}:${port}/admin`);
  console.log(`Admin dashboard available at http://${host}:${port}/admin-dashboard`);
  console.log(`Default Admin Username: admin | Default Password: BisFly@2026`);
});
