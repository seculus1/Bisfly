const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const { PDFParse } = require("pdf-parse");

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
const inflowsFile = path.join(root, "bank-inflows.json");
const documentsFile = path.join(root, "admin-documents.json");
const clientsFile = path.join(root, "clients.json");
const disclaimersFile = path.join(root, "disclaimers.json");
const expensesFile = path.join(root, "expenses.json");
const receiptsFile = path.join(root, "receipts.json");
const flightBookingsFile = path.join(root, "flight-bookings.json");
const flightSearchesFile = path.join(root, "flight-searches.json");
const flightSearchRateLimits = new Map();

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

function validateDateOnly(dateStr) {
  const value = String(dateStr || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateClientDocument(file, label, maxBytes = 15_000_000) {
  if (!file?.data?.length) return `${label} is required.`;
  if (file.data.length > maxBytes) return `${label} must be smaller than ${Math.floor(maxBytes / 1_000_000)} MB.`;
  const extension = path.extname(file.filename).toLowerCase();
  const header = file.data.subarray(0, 8);
  const validFile = extension === ".pdf" ? header.subarray(0, 5).toString("ascii") === "%PDF-"
    : [".jpg", ".jpeg"].includes(extension) ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
      : extension === ".png" && header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return validFile ? null : `${label} must be a valid PDF, JPG, or PNG file.`;
}

function parseClientPaymentSchedule(fields) {
  const paymentMethod = String(fields.paymentMethod || "full");
  if (!["full", "installment"].includes(paymentMethod)) {
    return { error: "Select full initial payment or installments." };
  }
  let schedule;
  try {
    schedule = fields.paymentSchedule ? JSON.parse(fields.paymentSchedule) : [];
  } catch {
    return { error: "The payment schedule is invalid." };
  }
  if (!Array.isArray(schedule)) return { error: "The payment schedule is invalid." };
  if (paymentMethod === "full") {
    const amount = Number(fields.amountPaid);
    const paymentDate = String(fields.paymentDate || "");
    const amountCents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(amountCents) ||
        Math.abs(amount - amountCents / 100) > 1e-8 || !validateDateOnly(paymentDate)) {
      return { error: "Enter a valid initial payment amount and date." };
    }
    return {
      paymentMethod,
      paymentSchedule: [{ amount: amountCents / 100, paymentDate }],
      amountPaid: amountCents / 100,
      paymentDate,
      initialDepositComplete: true
    };
  }
  if (schedule.length < 2 || schedule.length > 3) {
    return { error: "Enter two or three installment payments." };
  }
  let totalCents = 0;
  for (const payment of schedule) {
    const amount = Number(payment?.amount);
    const paymentDate = String(payment?.paymentDate || "");
    const amountCents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(amountCents) ||
        Math.abs(amount - amountCents / 100) > 1e-8 || !validateDateOnly(paymentDate)) {
      return { error: "Each installment needs a positive amount and a valid payment date." };
    }
    totalCents += amountCents;
  }
  if (!Number.isSafeInteger(totalCents)) {
    return { error: "The installment total is too large." };
  }
  const paymentDate = schedule.map(payment => payment.paymentDate).sort().slice(-1)[0];
  return {
    paymentMethod,
    paymentSchedule: schedule.map(payment => ({ amount: Math.round(Number(payment.amount) * 100) / 100, paymentDate: String(payment.paymentDate) })),
    amountPaid: totalCents / 100,
    paymentDate,
    initialDepositComplete: String(fields.initialDepositComplete).toLowerCase() === "true"
  };
}

function getDuffelAccessToken() {
  const token = String(process.env.DUFFEL_ACCESS_TOKEN || "").trim();
  if (!token) {
    const error = new Error("Flight booking is not configured yet. Set DUFFEL_ACCESS_TOKEN in the server environment after creating a Duffel account.");
    error.statusCode = 503;
    throw error;
  }
  return token;
}

async function duffelRequest(endpoint, { method = "GET", body, idempotencyKey } = {}) {
  const baseUrl = String(process.env.DUFFEL_API_BASE || "https://api.duffel.com").replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${getDuffelAccessToken()}`,
    "Duffel-Version": process.env.DUFFEL_API_VERSION || "v2",
    Accept: "application/json"
  };
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let response;
  try {
    response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25_000)
    });
  } catch (error) {
    const failure = new Error(`Unable to reach the flight booking provider: ${error.message || "network request failed"}`);
    failure.statusCode = 502;
    throw failure;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const failure = new Error("The flight booking provider returned an invalid response.");
    failure.statusCode = 502;
    throw failure;
  }
  if (!response.ok) {
    const providerMessage = Array.isArray(payload?.errors)
      ? payload.errors.map(item => item.message).filter(Boolean).join("; ")
      : "";
    const failure = new Error(providerMessage || `Flight provider request failed (${response.status}).`);
    failure.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw failure;
  }
  return payload.data;
}

function validateFlightSearch(body) {
  const origin = String(body.origin || "").trim().toUpperCase();
  const destination = String(body.destination || "").trim().toUpperCase();
  const departureDate = String(body.departureDate || "");
  const returnDate = String(body.returnDate || "");
  const cabinClass = String(body.cabinClass || "economy");
  const passengerCount = Number(body.passengerCount);
  const childAges = body.childAges === undefined
    ? []
    : Array.isArray(body.childAges) ? body.childAges.map(Number) : null;
  const today = new Date().toISOString().slice(0, 10);
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination) {
    return { error: "Enter different three-letter IATA airport codes for origin and destination." };
  }
  if (!validateDateOnly(departureDate) || departureDate < today ||
      (returnDate && (!validateDateOnly(returnDate) || returnDate <= departureDate))) {
    return { error: "Enter a valid future departure date and, if selected, a return date after departure." };
  }
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 9) {
    return { error: "Search for 1 to 9 adult passengers." };
  }
  if (!childAges || childAges.length > 8 ||
      childAges.some(age => !Number.isInteger(age) || age < 2 || age > 11) ||
      passengerCount + childAges.length > 9) {
    return { error: "Select an age from 2 to 11 for each child. Search for no more than 9 passengers in total." };
  }
  if (!["economy", "premium_economy", "business", "first"].includes(cabinClass)) {
    return { error: "Select a valid cabin class." };
  }
  return { origin, destination, departureDate, returnDate, cabinClass, passengerCount, childAges };
}

function ageOnDate(bornOn, travelDate) {
  const birth = new Date(`${bornOn}T00:00:00Z`);
  const travel = new Date(`${travelDate}T00:00:00Z`);
  let age = travel.getUTCFullYear() - birth.getUTCFullYear();
  if (travel.getUTCMonth() < birth.getUTCMonth() ||
      (travel.getUTCMonth() === birth.getUTCMonth() && travel.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

function summarizeFlightOffer(offer) {
  return {
    id: offer.id,
    totalAmount: String(offer.total_amount || ""),
    totalCurrency: String(offer.total_currency || ""),
    expiresAt: offer.expires_at || null,
    ownerName: offer.owner?.name || "Airline",
    ownerCode: offer.owner?.iata_code || "",
    cabinClass: offer.slices?.[0]?.segments?.[0]?.passengers?.[0]?.cabin_class || "",
    slices: (offer.slices || []).map(slice => ({
      origin: {
        code: slice.origin?.iata_code || "",
        name: slice.origin?.name || "",
        city: slice.origin?.city_name || ""
      },
      destination: {
        code: slice.destination?.iata_code || "",
        name: slice.destination?.name || "",
        city: slice.destination?.city_name || ""
      },
      departingAt: slice.departing_at || "",
      arrivingAt: slice.arriving_at || "",
      duration: slice.duration || "",
      segments: (slice.segments || []).map(segment => ({
        airline: segment.marketing_carrier?.name || segment.operating_carrier?.name || "Airline",
        flightNumber: segment.marketing_carrier_flight_number || segment.operating_carrier_flight_number || "",
        origin: segment.origin?.iata_code || "",
        destination: segment.destination?.iata_code || "",
        departingAt: segment.departing_at || "",
        arrivingAt: segment.arriving_at || ""
      }))
    }))
  };
}

function publicFlightBooking(booking) {
  return {
    reference: booking.reference,
    status: booking.status,
    createdAt: booking.createdAt,
    paymentConfirmedAt: booking.paymentConfirmedAt || null,
    bookingReference: booking.bookingReference || null,
    ticketNumbers: booking.ticketNumbers || [],
    pdfAvailable: Boolean(booking.bookingReference)
  };
}

function adminFlightBooking(booking) {
  const { publicToken, offerPassengerIds, ...safeBooking } = booking;
  return safeBooking;
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
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
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

    Object.assign(transportOptions, {
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000
    });

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
      subject: "Your BisFly Limited Agreement - Approved",
      html: `
        <h2>Dear ${agreement.fullName},</h2>
        <p>Your BisFly Limited agreement has been approved by our admin team.</p>
        <p><strong>Agreement Details:</strong></p>
        <ul>
          <li><strong>Destination:</strong> ${agreement.destination}</li>
          <li><strong>Location:</strong> ${agreement.location}</li>
          <li><strong>Amount Paid:</strong> ${agreement.amountPaid}</li>
          <li><strong>Agreement Date:</strong> ${agreement.signatureDate || new Date(agreement.createdAt).toLocaleDateString()}</li>
        </ul>
        <p>Your approved agreement is attached as a PDF. Please download and keep it for your records.</p>
        <p>If you have any questions, please contact us at bisflytravels@gmail.com</p>
        <p>Best regards,<br/>BisFly Limited Team</p>
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

async function sendReceiptEmail(receipt) {
  if (!emailTransporter) {
    return { sent: false, error: "Email service is not configured. Configure SMTP to send receipts; the PDF remains available for download." };
  }
  try {
    const escapeHtml = value => String(value || "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
    const pdfBuffer = await generateReceiptPdf(receipt);
    const info = await emailTransporter.sendMail({
      from: getEmailFrom(),
      to: receipt.clientEmail,
      subject: `BisFly Limited Payment Receipt - ${receipt.referenceNumber}`,
      html: `<p>Dear ${escapeHtml(receipt.clientName)},</p><p>Please find attached your BisFly Limited payment receipt, reference <strong>${escapeHtml(receipt.referenceNumber)}</strong>.</p><p>Thank you for choosing BisFly Limited.</p>`,
      attachments: [{
        filename: `bisfly-payment-receipt-${receipt.referenceNumber}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf"
      }]
    });
    const previewUrl = nodemailer.getTestMessageUrl(info) || null;
    if (previewUrl) console.log("Receipt email preview URL:", previewUrl);
    return { sent: true, messageId: info.messageId, previewUrl };
  } catch (error) {
    console.error(`Failed to email receipt ${receipt.referenceNumber}:`, error.message || error);
    return { sent: false, error: String(error.message || "Email delivery failed.").slice(0, 500) };
  }
}

const receiptEmailJobs = new Set();

async function processReceiptEmail(receiptId) {
  if (receiptEmailJobs.has(receiptId)) return;
  receiptEmailJobs.add(receiptId);
  try {
    const receipts = readJsonArray(receiptsFile);
    const receipt = receipts.find(item => item.id === receiptId);
    if (!receipt || receipt.approvalStatus !== "approved" || receipt.emailStatus !== "sending") return;

    const delivery = await sendReceiptEmail(receipt);
    const latestReceipts = readJsonArray(receiptsFile);
    const latestReceipt = latestReceipts.find(item => item.id === receiptId);
    if (!latestReceipt || latestReceipt.approvalStatus !== "approved") return;
    latestReceipt.emailStatus = delivery.sent ? "sent" : "failed";
    latestReceipt.emailError = delivery.sent ? null : delivery.error;
    latestReceipt.emailSentAt = delivery.sent ? new Date().toISOString() : null;
    latestReceipt.emailPreviewUrl = delivery.previewUrl || null;
    writeJsonArray(receiptsFile, latestReceipts);
    logActivity("payment_receipt_email_attempted", {
      id: latestReceipt.id,
      referenceNumber: latestReceipt.referenceNumber,
      sent: delivery.sent
    }, latestReceipt.approvedBy || "system");
  } catch (error) {
    console.error(`Unable to finish receipt email job ${receiptId}:`, error);
    const receipts = readJsonArray(receiptsFile);
    const receipt = receipts.find(item => item.id === receiptId);
    if (receipt && receipt.approvalStatus === "approved") {
      receipt.emailStatus = "failed";
      receipt.emailError = String(error.message || "Email delivery failed.").slice(0, 500);
      receipt.emailSentAt = null;
      writeJsonArray(receiptsFile, receipts);
    }
  } finally {
    receiptEmailJobs.delete(receiptId);
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

function readInflows() {
  try {
    const records = JSON.parse(fs.readFileSync(inflowsFile, "utf8"));
    return Array.isArray(records) ? records : [];
  } catch (error) {
    return [];
  }
}

function writeInflows(records) {
  const temporaryFile = `${inflowsFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(records, null, 2), "utf8");
  fs.renameSync(temporaryFile, inflowsFile);
}

function readAdminDocuments() {
  try {
    const documents = JSON.parse(fs.readFileSync(documentsFile, "utf8"));
    return Array.isArray(documents) ? documents : [];
  } catch (error) {
    return [];
  }
}

function writeAdminDocuments(documents) {
  const temporaryFile = `${documentsFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(documents, null, 2), "utf8");
  fs.renameSync(temporaryFile, documentsFile);
}

function readJsonArray(filePath) {
  try {
    const records = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(records)) throw new Error("Expected a JSON array.");
    return records;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    console.error(`Unable to read ${path.basename(filePath)}:`, error.message);
    throw error;
  }
}

function writeJsonArray(filePath, records) {
  const temporaryFile = `${filePath}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(records, null, 2), "utf8");
  fs.renameSync(temporaryFile, filePath);
}

function getClientCashInflows(from = "", to = "") {
  return readJsonArray(clientsFile).flatMap(client => {
    const schedule = Array.isArray(client.paymentSchedule) && client.paymentSchedule.length
      ? client.paymentSchedule
      : [{ amount: client.amountPaid, paymentDate: client.paymentDate }];
    return schedule.flatMap((payment, index) => {
      const paymentDate = String(payment.paymentDate || "");
      const amount = Number(payment.amount);
      if (!validateDateOnly(paymentDate) || !Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Invalid payment schedule entry for ${client.fullName || "a client"}.`);
      }
      if (from && paymentDate < from || to && paymentDate > to) return [];
      return [{
        paymentDate: payment.paymentDate,
        fullName: client.fullName || "Client",
        amount,
        packageType: client.packageType || "",
        phone: client.phone || "",
        installmentNumber: schedule.length > 1 ? index + 1 : null
      }];
    });
  }).sort((first, second) => first.paymentDate.localeCompare(second.paymentDate) || first.fullName.localeCompare(second.fullName));
}

function sumMoneyCents(records, field) {
  return records.reduce((sum, record) => {
    const amount = Number(record[field] || 0);
    if (!Number.isFinite(amount)) throw new Error(`Invalid financial amount in ${field}.`);
    return sum + Math.round(amount * 100);
  }, 0);
}

const submittedRecordCollections = {
  leads: { read: readLeads, write: writeLeads },
  insurance: { read: readInsurance, write: writeInsurance, files: ["documentFile"] },
  agreements: { read: readAgreements, write: writeAgreements },
  passports: { read: readPassports, write: writePassports },
  partnerships: { read: readPartnerships, write: writePartnerships },
  documents: { read: readAdminDocuments, write: writeAdminDocuments, files: ["storedName"] },
  clients: { read: () => readJsonArray(clientsFile), write: records => writeJsonArray(clientsFile, records), files: ["signedDisclaimerFile", "signedAgreementFile", "visaApplicationFile", "submittedSupportingDocument1File", "submittedSupportingDocument2File"] },
  disclaimers: { read: () => readJsonArray(disclaimersFile), write: records => writeJsonArray(disclaimersFile, records), files: ["signedFile"] },
  expenses: { read: () => readJsonArray(expensesFile), write: records => writeJsonArray(expensesFile, records) },
  receipts: { read: () => readJsonArray(receiptsFile), write: records => writeJsonArray(receiptsFile, records) }
};

const protectedSubmittedRecordFields = new Set([
  "id", "createdAt", "uploadedAt", "createdBy", "uploadedBy", "uploadedById",
  "generatedBy", "updatedAt", "updatedBy", "documentFile", "storedName",
  "signedFile", "signedDisclaimerFile", "signedAgreementFile", "visaApplicationFile",
  "submittedSupportingDocument1File", "submittedSupportingDocument2File", "paymentSchedule",
  "paymentMethod", "initialDepositComplete", "imageFile",
  "size", "contentType", "originalFileName", "approvalStatus", "approvedAt",
  "approvedBy", "emailStatus", "emailError", "emailSentAt", "emailPreviewUrl"
]);

function removeUnusedRecordFiles(removedRecord) {
  const referencedFiles = new Set();
  for (const collection of Object.values(submittedRecordCollections)) {
    for (const record of collection.read()) {
      for (const field of collection.files || []) {
        if (record[field]) referencedFiles.add(path.basename(record[field]));
      }
    }
  }
  for (const pkg of readPackages()) {
    if (pkg.imageFile) referencedFiles.add(path.basename(pkg.imageFile));
  }
  for (const collection of Object.values(submittedRecordCollections)) {
    for (const field of collection.files || []) {
      const fileName = removedRecord[field];
      if (!fileName || path.basename(fileName) !== fileName || referencedFiles.has(fileName)) continue;
      const filePath = path.join(uploadsDir, fileName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field.trim());
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field.trim());
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field.trim());
  if (row.some(value => value !== "")) rows.push(row);
  return rows;
}

function normalizeCsvHeader(value) {
  return String(value || "").replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseStatementAmount(value) {
  const cleaned = String(value || "").replace(/[₦,\s]/g, "").replace(/^NGN/i, "").trim();
  if (!cleaned) return 0;
  const parenthesized = /^\(.*\)$/.test(cleaned);
  const amount = Number(cleaned.replace(/[()]/g, ""));
  if (!Number.isFinite(amount)) return 0;
  return parenthesized ? -Math.abs(amount) : amount;
}

function parseStatementDate(value) {
  const text = String(value || "").trim();
  const dayFirst = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+.*)?$/);
  if (dayFirst) {
    const [, dayText, monthText, yearText] = dayFirst;
    const parsed = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
    if (parsed.getUTCFullYear() === Number(yearText) && parsed.getUTCMonth() === Number(monthText) - 1 && parsed.getUTCDate() === Number(dayText)) {
      return parsed;
    }
    return new Date(NaN);
  }
  return new Date(text);
}

function parseBankStatementCsv(text, filename) {
  const rows = parseCsv(String(text || ""));
  if (rows.length < 2) throw new Error("The CSV file has no transaction rows.");

  const headers = rows[0].map(normalizeCsvHeader);
  const findColumn = names => headers.findIndex(header => names.includes(header));
  const dateIndex = findColumn(["date", "transactiondate", "valuedate", "postingdate", "posteddate"]);
  const descriptionIndex = findColumn(["narration", "description", "transactiondetails", "details", "remarks", "particulars"]);
  const referenceIndex = findColumn(["reference", "transactionreference", "refno", "transactionid", "sessionid"]);
  const creditIndex = findColumn(["credit", "creditamount", "paidin", "deposit", "depositamount"]);
  const debitIndex = findColumn(["debit", "debitamount", "withdrawal", "withdrawalamount"]);
  const amountIndex = findColumn(["amount", "transactionamount"]);
  const directionIndex = findColumn(["type", "transactiontype", "drcr", "transactionindicator", "direction"]);
  const balanceIndex = findColumn(["balance", "availablebalance", "runningbalance"]);

  if (dateIndex < 0 || (creditIndex < 0 && amountIndex < 0)) {
    throw new Error("CSV needs a transaction date and a Credit or Amount column.");
  }

  const existing = readInflows();
  const knownIds = new Set(existing.map(record => record.id));
  const importedAt = new Date().toISOString();
  const batchId = crypto.randomBytes(12).toString("hex");
  const accepted = [];
  let skipped = 0;
  let duplicates = 0;
  let openingBalance = null;
  let closingBalance = null;

  for (const cells of rows.slice(1)) {
    const valueAt = index => index < 0 ? "" : String(cells[index] || "").trim();
    const dateText = valueAt(dateIndex);
    const parsedDate = parseStatementDate(dateText);
    const direction = valueAt(directionIndex).toLowerCase();
    const credit = creditIndex >= 0 ? parseStatementAmount(valueAt(creditIndex)) : 0;
    const debit = debitIndex >= 0 ? parseStatementAmount(valueAt(debitIndex)) : 0;
    const genericAmount = amountIndex >= 0 ? parseStatementAmount(valueAt(amountIndex)) : 0;
    let signedAmount;
    if (creditIndex >= 0 || debitIndex >= 0) {
      signedAmount = credit > 0 ? credit : debit > 0 ? -debit : 0;
    } else {
      const isDebit = genericAmount < 0 || /(debit|\bdr\b|withdrawal|outflow|paid.?out)/i.test(direction);
      const isCredit = /(credit|\bcr\b|deposit|inflow|paid.?in)/i.test(direction);
      signedAmount = isDebit ? -Math.abs(genericAmount) : isCredit ? Math.abs(genericAmount) : genericAmount;
    }
    if (creditIndex < 0 && debitIndex < 0 && directionIndex >= 0 && !/(credit|\bcr\b|deposit|inflow|paid.?in|debit|\bdr\b|withdrawal|outflow|paid.?out)/i.test(direction)) {
      skipped += 1;
      continue;
    }
    const amount = Math.abs(signedAmount);
    if (!dateText || Number.isNaN(parsedDate.getTime()) || amount <= 0) {
      skipped += 1;
      continue;
    }

    const description = valueAt(descriptionIndex);
    const reference = valueAt(referenceIndex);
    const id = crypto.createHash("sha256")
      .update([parsedDate.toISOString().slice(0, 10), signedAmount.toFixed(2), reference, description].join("|"))
      .digest("hex")
      .slice(0, 24);
    if (knownIds.has(id)) {
      duplicates += 1;
      continue;
    }

    knownIds.add(id);
    const balance = parseStatementAmount(valueAt(balanceIndex));
    if (balanceIndex >= 0 && valueAt(balanceIndex)) {
      if (openingBalance === null) openingBalance = balance - signedAmount;
      closingBalance = balance;
    }
    accepted.push({
      id,
      date: parsedDate.toISOString(),
      amount,
      signedAmount,
      type: signedAmount > 0 ? "inflow" : "outflow",
      currency: "NGN",
      reference,
      description,
      balance: balanceIndex >= 0 && valueAt(balanceIndex) ? balance : null,
      batchId,
      sourceFile: String(filename || "bank-statement.csv").slice(0, 120),
      importedAt,
      status: "unmatched",
      matchedClient: ""
    });
  }

  return { accepted, skipped, duplicates, openingBalance, closingBalance };
}

async function parseBankStatementPdf(buffer, filename) {
  const parser = new PDFParse({ data: buffer });
  let text;
  try {
    const result = await parser.getText();
    text = result.text || "";
  } finally {
    await parser.destroy();
  }

  if (!text.trim()) {
    throw new Error("This PDF contains no selectable text. It may be scanned; save a text-based PDF or export the statement as CSV.");
  }

  const parseLabeledBalance = label => {
    const match = text.match(new RegExp(`${label}\\s*(?:balance)?\\s*[:：]?\\s*(?:NGN|₦)?\\s*([\\d,]+(?:\\.\\d{1,2})?)`, "i"));
    return match ? parseStatementAmount(match[1]) : null;
  };
  const statedOpening = parseLabeledBalance("opening");
  const statedClosing = parseLabeledBalance("closing");
  const existing = readInflows();
  const knownIds = new Set(existing.map(record => record.id));
  const batchId = crypto.randomBytes(12).toString("hex");
  const importedAt = new Date().toISOString();
  const accepted = [];
  let skipped = 0;
  let duplicates = 0;
  let previousBalance = statedOpening;
  let firstDerivedOpening = null;
  let lastTransactionBalance = null;

  const datePattern = /^(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2})\s+(.+)$/;
  const amountPattern = /(?:₦\s*|NGN\s*)?-?\(?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\)?|-?\(?\d+\.\d{2}\)?/gi;
  const ignoredLine = /^(date\b|transaction\s*(details|date)|description\b|reference\b|page\s+\d+|fidelity\s+bank\b|account\s+(name|number)\b)/i;

  const statementLines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || ignoredLine.test(line)) continue;
    const dateMatch = line.match(datePattern);
    if (dateMatch) {
      statementLines.push({ dateText: dateMatch[1], text: dateMatch[2] });
    } else if (statementLines.length && /^(?:NGN\s*)?[\d,]+\.\d{2}$/.test(line)) {
      statementLines[statementLines.length - 1].text += ` ${line}`;
    }
  }

  for (const statementLine of statementLines) {
    const parsedDate = parseStatementDate(statementLine.dateText);
    const tail = statementLine.text;
    const amountMatches = [...tail.matchAll(amountPattern)];
    if (Number.isNaN(parsedDate.getTime()) || amountMatches.length < 1) {
      skipped += 1;
      continue;
    }

    const values = amountMatches.map(match => parseStatementAmount(match[0]));
    const hasDirectionMarker = /\b(CR|CREDIT|DR|DEBIT)\b/i.test(tail);
    const useTrailingBalance = values.length >= 2 || (values.length === 1 && previousBalance !== null && previousBalance !== undefined && !hasDirectionMarker);
    const balance = useTrailingBalance ? values[values.length - 1] : null;
    const candidateAmounts = balance === null ? values : values.slice(0, -1);
    const nonZeroTransactions = candidateAmounts.filter(value => value !== 0);
    const direction = tail.match(/\b(CR|CREDIT|DR|DEBIT)\b/i)?.[1]?.toLowerCase();
    let signedAmount = null;

    if (balance !== null && previousBalance !== null && previousBalance !== undefined) {
      signedAmount = balance - previousBalance;
    } else if (nonZeroTransactions.length === 1) {
      const magnitude = Math.abs(nonZeroTransactions[0]);
      if (direction === "cr" || direction === "credit") signedAmount = magnitude;
      if (direction === "dr" || direction === "debit") signedAmount = -magnitude;
      if (signedAmount === null && /refund|deposit|credit|transfer\s+in|paid\s+in/i.test(tail)) signedAmount = magnitude;
      if (signedAmount === null && /charge|fee|withdraw|debit|transfer\s+out|paid\s+out/i.test(tail)) signedAmount = -magnitude;
    }

    if (signedAmount === null || Math.abs(signedAmount) < 0.005) {
      skipped += 1;
      if (balance !== null && previousBalance === null) previousBalance = balance;
      continue;
    }

    if (balance !== null) previousBalance = balance;
    if (firstDerivedOpening === null && statedOpening === null && balance !== null) firstDerivedOpening = balance - signedAmount;
    if (balance !== null) lastTransactionBalance = balance;
    const description = tail.replace(amountPattern, " ").replace(/\s+/g, " ").trim();
    const id = crypto.createHash("sha256")
      .update([parsedDate.toISOString().slice(0, 10), signedAmount.toFixed(2), description].join("|"))
      .digest("hex")
      .slice(0, 24);
    if (knownIds.has(id)) {
      duplicates += 1;
      continue;
    }
    knownIds.add(id);
    accepted.push({
      id,
      date: parsedDate.toISOString(),
      amount: Math.abs(signedAmount),
      signedAmount,
      type: signedAmount > 0 ? "inflow" : "outflow",
      currency: "NGN",
      reference: "",
      description,
      balance,
      batchId,
      sourceFile: String(filename || "fidelity-statement.pdf").slice(0, 120),
      importedAt,
      status: "unmatched",
      matchedClient: ""
    });
  }

  if (!accepted.length && duplicates === 0) {
    throw new Error("No transaction rows were recognized in this PDF. If it is scanned, OCR or a CSV export is required.");
  }

  return {
    accepted,
    skipped,
    duplicates,
    openingBalance: statedOpening ?? firstDerivedOpening,
    closingBalance: statedClosing ?? lastTransactionBalance
  };
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
    const doc = new PDFDocument({ margin: 32, size: "A4", layout: "landscape" });
    const buffers = [];

    doc.on("data", chunk => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const safeRows = Array.isArray(rows) ? rows : [];
    const headers = safeRows.length ? Object.keys(safeRows[0] || {}) : [];

    doc.font("Helvetica-Bold").fontSize(17).fillColor("#10264a").text(title, { align: "center" });
    doc.moveDown(0.35);
    doc.font("Helvetica").fontSize(8).fillColor("#64748b")
      .text(`Generated ${new Date().toLocaleString()} | ${safeRows.length} record${safeRows.length === 1 ? "" : "s"}`, { align: "center" });
    doc.moveDown(0.8);

    if (!headers.length) {
      doc.font("Helvetica").fontSize(11).fillColor("#334155").text("No data available", { align: "center" });
      doc.end();
      return;
    }

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cellPaddingX = 5;
    const cellPaddingY = 5;
    const minColumnWidth = Math.max(38, Math.min(58, pageWidth / headers.length));
    const maxColumnWidth = Math.min(180, pageWidth);
    const cellValues = safeRows.map(row => headers.map(header => {
      const value = row?.[header];
      const text = value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
      return text.length > 600 ? `${text.slice(0, 597)}...` : text;
    }));
    const naturalWidths = headers.map((header, columnIndex) => {
      const sample = [String(header), ...cellValues.slice(0, 100).map(values => values[columnIndex])];
      const longestLine = sample.reduce((longest, text) => Math.max(longest, ...text.split(/\r?\n/).map(line => line.length)), 0);
      return Math.max(minColumnWidth, Math.min(maxColumnWidth, longestLine * 4 + cellPaddingX * 2));
    });
    const naturalWidthTotal = naturalWidths.reduce((total, width) => total + width, 0);
    const widthScale = naturalWidthTotal > pageWidth ? pageWidth / naturalWidthTotal : 1;
    const columnWidths = naturalWidths.map(width => width * widthScale);
    if (naturalWidthTotal < pageWidth) {
      const extraPerColumn = (pageWidth - naturalWidthTotal) / headers.length;
      columnWidths.forEach((_, index) => { columnWidths[index] += extraPerColumn; });
    }

    const getRowHeight = (values, fontName, fontSize) => {
      doc.font(fontName).fontSize(fontSize);
      const heights = values.map((text, index) => doc.heightOfString(text || " ", {
        width: Math.max(1, columnWidths[index] - cellPaddingX * 2),
        lineGap: 1
      }));
      return Math.max(24, Math.max(...heights) + cellPaddingY * 2);
    };

    let y = doc.y;
    const drawHeader = () => {
      const headerValues = headers.map(header => String(header || ""));
      const headerHeight = getRowHeight(headerValues, "Helvetica-Bold", 8);
      const tableX = doc.page.margins.left;
      doc.save().fillColor("#10264a").rect(tableX, y, pageWidth, headerHeight).fill().restore();
      let x = tableX;
      headerValues.forEach((header, index) => {
        doc.save().rect(x, y, columnWidths[index], headerHeight).lineWidth(0.5).strokeColor("#cbd5e1").stroke().restore();
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff").text(header, x + cellPaddingX, y + cellPaddingY, {
          width: columnWidths[index] - cellPaddingX * 2,
          height: headerHeight - cellPaddingY * 2,
          lineGap: 1
        });
        x += columnWidths[index];
      });
      y += headerHeight;
    };

    const drawRow = (values, rowIndex) => {
      const rowHeight = getRowHeight(values, "Helvetica", 7.5);
      const bottomLimit = doc.page.height - doc.page.margins.bottom;
      if (y + rowHeight > bottomLimit) {
        doc.addPage({ size: "A4", layout: "landscape", margin: 32 });
        y = doc.page.margins.top;
        drawHeader();
      }

      const tableX = doc.page.margins.left;
      if (rowIndex % 2 === 1) {
        doc.save().fillColor("#f1f5f9").rect(tableX, y, pageWidth, rowHeight).fill().restore();
      }

      let x = tableX;
      values.forEach((text, index) => {
        doc.save().rect(x, y, columnWidths[index], rowHeight).lineWidth(0.35).strokeColor("#cbd5e1").stroke().restore();
        doc.font("Helvetica").fontSize(7.5).fillColor("#1e293b").text(text, x + cellPaddingX, y + cellPaddingY, {
          width: columnWidths[index] - cellPaddingX * 2,
          height: rowHeight - cellPaddingY * 2,
          lineGap: 1
        });
        x += columnWidths[index];
      });
      y += rowHeight;
    };

    drawHeader();
    cellValues.forEach((values, index) => drawRow(values, index));
    doc.end();
  });
}

function generateFlightBookingPdf(booking) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 42 });
    const buffers = [];
    doc.on("data", chunk => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const logoPath = path.join(root, "bisfly-logo.jpeg");
    if (fs.existsSync(logoPath)) doc.image(logoPath, doc.page.margins.left, 30, { width: 82, height: 56, fit: [82, 56] });
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#10264a").text("FLIGHT BOOKING CONFIRMATION", 136, 38, { width: width - 94 });
    doc.font("Helvetica").fontSize(9).fillColor("#64748b").text("BisFly Limited · Ibadan, Oyo State, Nigeria", 136, 64);
    doc.moveTo(doc.page.margins.left, 100).lineTo(doc.page.width - doc.page.margins.right, 100).strokeColor("#bfdbfe").stroke();
    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#123a8c").text(`Booking reference: ${booking.reference}`);
    doc.moveDown(0.35);
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(`Generated: ${new Date().toLocaleString("en-NG")}`);
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#123a8c").text(`Airline booking reference (PNR): ${booking.bookingReference}`);
    doc.moveDown(0.35);
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(`Airline: ${booking.offer?.ownerName || "Airline"}${booking.offer?.ownerCode ? ` (${booking.offer.ownerCode})` : ""}`);
    doc.text(`Status: ${booking.bookingStatus || "Provider confirmed"}`);
    doc.text(`Fare: ${booking.offer?.totalCurrency || ""} ${booking.offer?.totalAmount || ""}`);
    doc.moveDown(0.7);

    doc.font("Helvetica-Bold").fontSize(11).fillColor("#123a8c").text("Passengers");
    doc.moveDown(0.25);
    (booking.passengers || []).forEach((passenger, index) => {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#1e293b")
        .text(`${index + 1}. ${passenger.title} ${passenger.givenName} ${passenger.familyName}`);
      doc.font("Helvetica").fontSize(8).fillColor("#475569")
        .text(`${passenger.type === "child" ? `Child · age ${passenger.age} at departure` : "Adult"} · Date of birth: ${passenger.bornOn} · Contact: ${passenger.email}`);
      doc.moveDown(0.25);
    });

    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#123a8c").text("Itinerary");
    doc.moveDown(0.25);
    (booking.offer?.slices || []).forEach((slice, sliceIndex) => {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#1e293b")
        .text(`${sliceIndex === 0 ? "Outbound" : "Return"}: ${slice.origin?.city || slice.origin?.code} (${slice.origin?.code}) to ${slice.destination?.city || slice.destination?.code} (${slice.destination?.code})`);
      doc.font("Helvetica").fontSize(8).fillColor("#475569")
        .text(`Departure: ${slice.departingAt || "See airline itinerary"}    Arrival: ${slice.arrivingAt || "See airline itinerary"}`);
      (slice.segments || []).forEach(segment => {
        doc.text(`${segment.airline} ${segment.flightNumber} · ${segment.origin} → ${segment.destination} · ${segment.departingAt} – ${segment.arrivingAt}`);
      });
      doc.moveDown(0.35);
    });

    const ticketNumbers = booking.ticketNumbers || [];
    doc.moveDown(0.35);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#123a8c").text("E-ticket number(s)");
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(
      ticketNumbers.length ? ticketNumbers.join(", ") : "No e-ticket number was returned by the airline/provider at the time this confirmation was generated."
    );
    doc.moveDown(0.8);
    doc.save().fillColor(ticketNumbers.length ? "#ecfdf5" : "#fffbeb").roundedRect(doc.page.margins.left, doc.y, width, 54, 7).fill().restore();
    const noteY = doc.y + 10;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(ticketNumbers.length ? "#047857" : "#92400e")
      .text(ticketNumbers.length ? "ELECTRONIC TICKET DETAILS PROVIDED" : "BOOKING CONFIRMATION — NOT AN E-TICKET", doc.page.margins.left + 12, noteY, { width: width - 24 });
    doc.font("Helvetica").fontSize(7.5).fillColor("#475569")
      .text("Verify your booking reference and ticket status with the operating airline before travel. Schedule changes and carrier conditions are controlled by the airline.", doc.page.margins.left + 12, noteY + 15, { width: width - 24 });
    doc.end();
  });
}

function generateReceiptPdf(receipt) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const buffers = [];
    doc.on("data", chunk => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const margin = 40;
    doc.rect(0, 0, pageWidth, pageHeight).fill("#ffffff");

    doc.save().opacity(0.07).fillColor("#2563eb").font("Helvetica-Bold").fontSize(13);
    for (let y = 110; y < pageHeight - 40; y += 92) {
      for (let x = -70; x < pageWidth; x += 205) {
        doc.save().rotate(-24, { origin: [x + 80, y + 10] });
        doc.text("BisFly Limited  BisFly Limited", x, y, { lineBreak: false });
        doc.restore();
      }
    }
    doc.restore();

    const headerGradient = doc.linearGradient(margin, 36, pageWidth - margin, 36);
    headerGradient.stop(0, "#123a8c").stop(1, "#1687d4");
    doc.roundedRect(margin, 36, pageWidth - margin * 2, 112, 15).fill(headerGradient);

    const logoPath = path.join(root, "bisfly-logo.jpeg");
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, margin + 18, 54, { width: 80, height: 72, fit: [80, 72], align: "center", valign: "center" });
    }
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#ffffff").text("BisFly Limited", margin + 112, 54, { width: 260 });
    doc.font("Helvetica").fontSize(8.5).fillColor("#eaf4ff").text(
      "SW/8, 1A, Iyun Close, Ibadan, Oyo State, Nigeria",
      margin + 112, 81, { width: 270 }
    );
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#ffffff").text(
      "PAYMENT RECEIPT",
      pageWidth - margin - 151, 59, { width: 135, align: "right", characterSpacing: 0.6 }
    );
    doc.font("Helvetica").fontSize(8).fillColor("#eaf4ff").text(
      `Reference: ${receipt.referenceNumber}`,
      pageWidth - margin - 190, 82, { width: 174, align: "right" }
    );
    doc.font("Helvetica").fontSize(8).fillColor("#eaf4ff").text(
      `Date: ${new Date(`${receipt.receiptDate}T00:00:00`).toLocaleDateString("en-NG", { year: "numeric", month: "long", day: "numeric" })}`,
      pageWidth - margin - 190, 99, { width: 174, align: "right" }
    );

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#123a8c").text("Payment received", margin, 180);
    doc.font("Helvetica").fontSize(10).fillColor("#475569").text(
      "This receipt confirms that BisFly Limited has received the payment below.",
      margin, 204, { width: pageWidth - margin * 2 }
    );

    const cardX = margin;
    const cardY = 250;
    const cardWidth = pageWidth - margin * 2;
    doc.roundedRect(cardX, cardY, cardWidth, 195, 10).lineWidth(1).strokeColor("#bfdbfe").stroke();
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#2563eb").text("RECEIVED FROM", cardX + 20, cardY + 18);
    doc.font("Helvetica-Bold").fontSize(15).fillColor("#123a8c").text(receipt.clientName, cardX + 20, cardY + 35, { width: cardWidth - 40 });
    doc.font("Helvetica").fontSize(9).fillColor("#475569").text(receipt.clientEmail, cardX + 20, cardY + 61, { width: cardWidth - 40 });
    doc.moveTo(cardX + 20, cardY + 81).lineTo(cardX + cardWidth - 20, cardY + 81).strokeColor("#dbeafe").lineWidth(1).stroke();
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#2563eb").text("PACKAGE / SERVICE", cardX + 20, cardY + 92);
    doc.font("Helvetica").fontSize(10).fillColor("#1e3a8a").text(receipt.packageType, cardX + 160, cardY + 90, { width: cardWidth - 180 });
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#2563eb").text(
      receipt.paymentMethod === "installment" ? "PAYMENT METHOD" : "PAYMENT DATE",
      cardX + 20, cardY + 119
    );
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(
      receipt.paymentMethod === "installment" ? "Installments" : receipt.paymentDate || receipt.receiptDate,
      cardX + 112, cardY + 117, { width: 130 }
    );
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#2563eb").text("BALANCE AFTER APPROVAL", cardX + 260, cardY + 119);
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(
      `NGN ${Number(receipt.balanceAfterApproval || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      cardX + 390, cardY + 117, { width: cardWidth - 410 }
    );
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#2563eb").text("PAYMENT HISTORY", cardX + 20, cardY + 139);
    const paymentSchedule = Array.isArray(receipt.paymentSchedule) && receipt.paymentSchedule.length
      ? receipt.paymentSchedule
      : [{ amount: receipt.amountPaid, paymentDate: receipt.paymentDate || receipt.receiptDate }];
    paymentSchedule.slice(0, 3).forEach((payment, index) => {
      const y = cardY + 153 + index * 12;
      doc.font("Helvetica").fontSize(8).fillColor("#334155").text(
        `${paymentSchedule.length > 1 ? `Installment ${index + 1}` : "Payment"} · ${payment.paymentDate}`,
        cardX + 20, y, { width: cardWidth - 180 }
      );
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#1e3a8a").text(
        `NGN ${Number(payment.amount || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        cardX + cardWidth - 160, y, { width: 140, align: "right" }
      );
    });

    const amountGradient = doc.linearGradient(margin, 454, pageWidth - margin, 454);
    amountGradient.stop(0, "#0b3b91").stop(1, "#1687d4");
    doc.roundedRect(margin, 454, pageWidth - margin * 2, 78, 12).fill(amountGradient);
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#dbeafe").text("TOTAL AMOUNT RECEIVED", margin + 22, 468);
    doc.font("Helvetica-Bold").fontSize(25).fillColor("#ffffff").text(
      `NGN ${Number(receipt.amountPaid).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      margin + 22, 490, { width: pageWidth - margin * 2 - 44 }
    );

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#123a8c").text("OFFICIAL PAYMENT ACCOUNT", margin, 544);
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(
      "Fidelity Bank  |  Account Name: Bisfly Limited  |  Account Number: 5601847112",
      margin, 561, { width: pageWidth - margin * 2 }
    );
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(
      `Receipt prepared by ${receipt.createdBy || "BisFly Limited"}. Keep this receipt for your records.`,
      margin, 582, { width: pageWidth - margin * 2 }
    );

    const stampPath = path.join(root, "bisfly-company-stamp.png");
    if (fs.existsSync(stampPath)) {
      doc.save().opacity(0.38).image(stampPath, margin + 56, 608, { width: 112, height: 82, fit: [112, 82], align: "center", valign: "center" }).restore();
    }

    const signaturePath = path.join(root, "bisfly-signature.png");
    if (fs.existsSync(signaturePath)) {
      doc.image(signaturePath, margin + 22, 622, { width: 132, height: 45, fit: [132, 45], align: "center", valign: "center" });
    } else {
      doc.font("Helvetica-Oblique").fontSize(15).fillColor("#123a8c").text("BisFly Limited", margin + 20, 635, { width: 140, align: "center" });
    }
    doc.moveTo(margin + 14, 670).lineTo(margin + 170, 670).strokeColor("#1e40af").lineWidth(0.8).stroke();
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#1e3a8a").text("Authorized signature", margin + 14, 677, { width: 156, align: "center" });

    const footerGradient = doc.linearGradient(margin, pageHeight - 72, pageWidth - margin, pageHeight - 72);
    footerGradient.stop(0, "#123a8c").stop(1, "#1687d4");
    doc.roundedRect(margin, pageHeight - 73, pageWidth - margin * 2, 2, 1).fill(footerGradient);
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(
      "Thank you for choosing BisFly Limited.",
      margin, pageHeight - 61, { width: pageWidth - margin * 2, align: "center" }
    );
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

    const logoPath = path.join(root, "bisfly-logo.jpeg");
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, doc.page.width / 2 - 38, 35, { width: 76, height: 56, fit: [76, 56], align: "center", valign: "center" });
      doc.y = 101;
    }
    doc.font("Helvetica-Bold").fontSize(19).fillColor("#10264a").text("TRAVEL SERVICE AGREEMENT", { align: "center" });
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(10).fillColor("#64748b").text("BisFly Limited", { align: "center" });
    doc.moveDown(1.2);

    const drawSection = (heading, fields) => {
      const x = doc.page.margins.left;
      const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#10264a").text(heading);
      doc.moveDown(0.35);
      const labelWidth = 145;
      fields.forEach(([label, value], index) => {
        const rowY = doc.y;
        const valueText = String(value || "N/A");
        const valueHeight = doc.heightOfString(valueText, { width: width - labelWidth - 24, font: "Helvetica", fontSize: 10 });
        const rowHeight = Math.max(27, valueHeight + 12);
        if (index % 2 === 0) doc.save().fillColor("#f1f5f9").rect(x, rowY - 3, width, rowHeight).fill().restore();
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#334155").text(label, x + 10, rowY + 5, { width: labelWidth - 16 });
        doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(valueText, x + labelWidth, rowY + 5, { width: width - labelWidth - 12 });
        doc.y = rowY + rowHeight;
      });
      doc.moveDown(0.6);
    };

    const agreementDate = agreement.agreementDate || agreement.signatureDate || new Date(agreement.createdAt).toLocaleDateString();
    drawSection("CLIENT DETAILS", [
      ["Client Name", agreement.fullName],
      ["Phone Number", agreement.phone],
      ["Email Address", agreement.email],
      ["Date of Birth", agreement.dateOfBirth],
      ["Address", agreement.address],
      ["Agreement Date", agreementDate]
    ]);
    drawSection("PACKAGE DETAILS", [
      ["Package Type", agreement.packageType || agreement.destination],
      ["Package Option", agreement.packageOption || "Single"],
      ["Description", agreement.description]
    ]);
    drawSection("PAYMENT SCHEDULE", [
      ["Total Package Amount", agreement.totalAmount ?? agreement.amountPaid],
      ["Amount Deposited", agreement.amountDeposited ?? agreement.amountPaid],
      ["Balance After Visa Approval", agreement.balanceAfterApproval ?? agreement.balanceAmount],
      ["Payment Date", agreement.paymentDate || agreement.createdAt]
    ]);
    drawSection("OFFICIAL PAYMENT ACCOUNT", [
      ["Bank", "Fidelity Bank"],
      ["Account Name", "Bisfly Limited"],
      ["Account Number", "5601847112"]
    ]);

    doc.font("Helvetica-Bold").fontSize(11).fillColor("#10264a").text("TERMS AND CONDITIONS");
    doc.moveDown(0.35);
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(
      agreement.terms || "The client agrees to the package and payment schedule recorded above. Once payment is confirmed, work begins on the client's behalf. Because resources and professional services are committed at that point, confirmed payments are non-refundable, except where applicable law requires otherwise. Any balance shown as payable after visa approval remains due in accordance with the agreed package. BisFly Limited provides travel and application support only; visa applications are decided solely by the relevant government or consular authority. BisFly Limited cannot guarantee approval and is not responsible for visa authorization, refusal, processing delays, or decisions made by those authorities. Payments must be made only to the official corporate account listed in this agreement.",
      { align: "justify", lineGap: 2 }
    );

    doc.moveDown(1);
    doc.moveDown(1.2);
    if (doc.y > doc.page.height - 185) doc.addPage();
    const leftX = doc.page.margins.left;
    const rightX = doc.page.width / 2 + 12;
    const signatureY = doc.y + 38;
    const stampPath = path.join(root, "bisfly-company-stamp.png");
    const stampX = leftX + 56;
    if (fs.existsSync(stampPath)) {
      doc.save().opacity(0.3).image(stampPath, stampX, signatureY - 38, { width: 100, height: 70, fit: [100, 70], align: "center", valign: "center" }).restore();
    } else {
      doc.save().opacity(0.12).font("Helvetica-Bold").fontSize(9).fillColor("#073c9a").text("BISFLY", stampX - 10, signatureY - 2, { width: 88, align: "center" }).restore();
    }
    const signaturePath = path.join(root, "bisfly-signature.png");
    if (fs.existsSync(signaturePath)) {
      doc.image(signaturePath, leftX + 48, signatureY - 48, { width: 116, height: 39, fit: [116, 39], align: "center", valign: "center" });
    } else {
      doc.font("Helvetica-Oblique").fontSize(17).fillColor("#073c9a").text("BisFly Limited", leftX, signatureY - 28, { width: 210, align: "center" });
    }
    doc.moveTo(leftX + 8, signatureY).lineTo(leftX + 218, signatureY).strokeColor("#334155").lineWidth(0.8).stroke();
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#334155").text("For BisFly Limited", leftX + 8, signatureY + 7, { width: 210, align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(`Authorized representative - ${agreement.generatedBy || "Admin"}`, leftX + 8, signatureY + 21, { width: 210, align: "center" });

    doc.moveTo(rightX, signatureY).lineTo(rightX + 210, signatureY).strokeColor("#334155").lineWidth(0.8).stroke();
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#334155").text(String(agreement.fullName || "Client"), rightX, signatureY + 7, { width: 210, align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text("Client signature", rightX, signatureY + 21, { width: 210, align: "center" });
    doc.moveTo(rightX + 50, signatureY + 65).lineTo(rightX + 160, signatureY + 65).strokeColor("#64748b").lineWidth(0.6).stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text("Date", rightX, signatureY + 71, { width: 210, align: "center" });

    doc.y = signatureY + 100;
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(`Generated by ${agreement.generatedBy || "BisFly Limited"} on ${new Date(agreement.createdAt).toLocaleString()}`, { align: "center" });

    doc.end();
  });
}

function generateDisclaimerPdf(disclaimer) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 52, size: "A4" });
    const buffers = [];
    doc.on("data", chunk => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const logoPath = path.join(root, "bisfly-logo.jpeg");
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, doc.page.width / 2 - 38, 38, { width: 76, height: 56, fit: [76, 56], align: "center", valign: "center" });
      doc.y = 107;
    }
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#10264a").text("CLIENT SERVICE DISCLAIMER", { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(10).fillColor("#64748b").text("BisFly Limited and the Client", { align: "center" });
    doc.moveDown(1.3);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#10264a").text("CLIENT INFORMATION");
    doc.moveDown(0.4);
    [
      ["Client name", disclaimer.fullName],
      ["Gender", disclaimer.gender],
      ["Phone number", disclaimer.phone],
      ["Address", disclaimer.address],
      ["Email address", disclaimer.email]
    ].forEach(([label, value]) => {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#334155").text(`${label}: `, { continued: true });
      doc.font("Helvetica").fontSize(9).fillColor("#0f172a").text(String(value || "Not provided"));
      doc.moveDown(0.25);
    });
    if (disclaimer.secondPersonRelationship) {
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#10264a").text("ADDITIONAL PERSON");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(9).fillColor("#0f172a").text(
        `${disclaimer.secondPersonName || "Name not provided"} (${disclaimer.secondPersonRelationship})`
      );
    }
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#10264a").text("CLIENT ACKNOWLEDGEMENT");
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(
      "I confirm that the information and documents I provide to BisFly Limited are accurate and complete to the best of my knowledge. I understand that BisFly Limited provides travel planning and application-support services but does not issue visas and cannot guarantee that a visa or other authorization will be granted. All visa decisions, requirements, processing times, and authorizations are determined by the relevant government or consular authorities. BisFly Limited is not responsible for a refusal, delay, or decision made by those authorities. I understand that work begins once my payment is confirmed and that confirmed payments are non-refundable, except where applicable law requires otherwise. I will make payments only to the company's official corporate account below.",
      { align: "justify", lineGap: 3 }
    );
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#10264a").text("OFFICIAL CORPORATE ACCOUNT");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9).fillColor("#0f172a").text("Fidelity Bank | Bisfly Limited | Account Number: 5601847112");
    doc.moveDown(5);
    if (doc.y > doc.page.height - 185) doc.addPage();
    const signatureY = doc.y;
    const leftX = doc.page.margins.left;
    const rightX = doc.page.width / 2 + 12;
    const stampPath = path.join(root, "bisfly-company-stamp.png");
    if (fs.existsSync(stampPath)) {
      doc.save().opacity(0.3).image(stampPath, rightX + 56, signatureY - 38, { width: 100, height: 70, fit: [100, 70], align: "center", valign: "center" }).restore();
    }
    doc.moveTo(leftX, signatureY).lineTo(leftX + 210, signatureY).strokeColor("#334155").stroke();
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#334155").text("Client signature", leftX, signatureY + 6, { width: 210, align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(`Client: ${disclaimer.fullName}`, leftX, signatureY + 19, { width: 210, align: "center" });
    doc.moveTo(rightX, signatureY).lineTo(rightX + 210, signatureY).strokeColor("#334155").stroke();
    const signaturePath = path.join(root, "bisfly-signature.png");
    if (fs.existsSync(signaturePath)) {
      doc.image(signaturePath, rightX + 48, signatureY - 49, { width: 116, height: 39, fit: [116, 39], align: "center", valign: "center" });
    }
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#334155").text("For BisFly Limited", rightX, signatureY + 6, { width: 210, align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(`Authorized representative: ${disclaimer.generatedBy || "Admin"}`, rightX, signatureY + 19, { width: 210, align: "center" });
    doc.moveTo(leftX, signatureY + 55).lineTo(leftX + 210, signatureY + 55).strokeColor("#64748b").stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#64748b").text("Date", leftX, signatureY + 60, { width: 210, align: "center" });
    if (disclaimer.secondPersonRelationship) {
      doc.moveTo(rightX, signatureY + 55).lineTo(rightX + 210, signatureY + 55).strokeColor("#64748b").stroke();
      doc.font("Helvetica").fontSize(8).fillColor("#64748b").text("Additional person signature / date", rightX, signatureY + 60, { width: 210, align: "center" });
    }
    doc.end();
  });
}

function generateReportPdf(title, subtitle, headers, rows, totalLabel = "", totalValue = null) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
    const buffers = [];
    doc.on("data", chunk => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
    const logoPath = path.join(root, "bisfly-logo.jpeg");
    if (fs.existsSync(logoPath)) doc.image(logoPath, 36, 24, { width: 55, height: 42, fit: [55, 42] });
    doc.font("Helvetica-Bold").fontSize(17).fillColor("#10264a").text(title, 102, 29);
    doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(subtitle, 102, 53);
    let y = 90;
    const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const widths = headers.map(() => tableWidth / headers.length);
    const drawHeader = () => {
      let x = doc.page.margins.left;
      headers.forEach((header, index) => {
        doc.save().fillColor("#10264a").rect(x, y, widths[index], 24).fill().restore();
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#ffffff").text(String(header), x + 5, y + 7, { width: widths[index] - 10 });
        x += widths[index];
      });
      y += 24;
    };
    drawHeader();
    rows.forEach((row, rowIndex) => {
      const values = headers.map(header => String(row[header] ?? ""));
      const rowHeight = 28;
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 34) {
        doc.addPage();
        y = 40;
        drawHeader();
      }
      let x = doc.page.margins.left;
      values.forEach((value, index) => {
        doc.save().fillColor(rowIndex % 2 ? "#f8fafc" : "#eef2f7").rect(x, y, widths[index], rowHeight).fill().restore();
        doc.font("Helvetica").fontSize(7.5).fillColor("#1e293b").text(value, x + 5, y + 6, { width: widths[index] - 10, height: rowHeight - 10, ellipsis: true });
        x += widths[index];
      });
      y += rowHeight;
    });
    if (totalLabel && totalValue !== null) {
      if (y + 36 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = 40;
      }
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#10264a").text(`${totalLabel}: ${totalValue}`, doc.page.margins.left, y + 8);
    }
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
  safeUser.dashboardFeatures = effectiveDashboardFeatures(user);
  return safeUser;
}

function isMasterAdminSession(session) {
  const role = String(session?.role || "").toLowerCase();
  return role === "super-admin" || role === "master-admin" || role === "admin" && session?.username === "admin";
}

function normalizeAdminRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return normalized === "customer" ? "support" : normalized;
}

const DASHBOARD_FEATURES = [
  "dashboard", "leads", "documents", "clients", "disclaimers", "flights", "cash-inflows",
  "account-balance", "expenses", "receipts", "insurance", "agreements", "passports", "partnerships", "packages",
  "users", "activity"
];
const ADMIN_DASHBOARD_FEATURES = [
  "leads", "documents", "clients", "disclaimers", "flights", "cash-inflows", "expenses", "receipts",
  "insurance", "agreements", "passports", "partnerships", "packages"
];
const SUPPORT_DASHBOARD_FEATURES = [
  "leads", "documents", "insurance", "agreements", "passports", "partnerships", "packages"
];
const SUPER_ADMIN_ONLY_DASHBOARD_FEATURES = new Set(["users", "account-balance"]);
const GRANTABLE_DASHBOARD_FEATURES = DASHBOARD_FEATURES.filter(
  feature => !SUPER_ADMIN_ONLY_DASHBOARD_FEATURES.has(feature)
);

function dashboardFeaturesForRole(user) {
  const role = normalizeAdminRole(user?.role);
  if (isMasterAdminSession(user)) return DASHBOARD_FEATURES;
  return ["admin", "manager"].includes(role) ? ADMIN_DASHBOARD_FEATURES : SUPPORT_DASHBOARD_FEATURES;
}

function effectiveDashboardFeatures(user) {
  if (isMasterAdminSession(user)) return [...DASHBOARD_FEATURES];
  if (!Array.isArray(user?.featureAccess)) return dashboardFeaturesForRole(user);
  return user.featureAccess.filter(
    feature => GRANTABLE_DASHBOARD_FEATURES.includes(feature)
  );
}

function dashboardFeatureForRequest(pathname) {
  const recordMatch = pathname.match(/^\/api\/admin\/records\/([^/]+)/);
  if (recordMatch) {
    const featureByCollection = {
      leads: "leads",
      insurance: "insurance",
      agreements: "agreements",
      passports: "passports",
      partnerships: "partnerships",
      documents: "documents",
      clients: "clients",
      disclaimers: "disclaimers",
      expenses: "expenses",
      receipts: "receipts"
    };
    return featureByCollection[recordMatch[1]] || null;
  }
  const routes = [
    [/^\/api\/analytics(?:\/|$)/, "dashboard"],
    [/^\/api\/(?:leads|admin\/leads)(?:\/|$)/, "leads"],
    [/^\/api\/admin\/documents(?:\/|$)/, "documents"],
    [/^\/api\/admin\/document-access-users(?:\/|$)/, "documents"],
    [/^\/api\/admin\/clients(?:\/|$)/, "clients"],
    [/^\/api\/admin\/disclaimers(?:\/|$)/, "disclaimers"],
    [/^\/api\/admin\/flights(?:\/|$)/, "flights"],
    [/^\/api\/admin\/cash-inflows(?:\/|$)/, "cash-inflows"],
    [/^\/api\/admin\/account-balance(?:\/|$)/, "account-balance"],
    [/^\/api\/(?:bank-inflows|admin\/bank-inflows)(?:\/|$)/, "cash-inflows"],
    [/^\/api\/admin\/expenses(?:\/|$)/, "expenses"],
    [/^\/api\/admin\/receipts(?:\/|$)/, "receipts"],
    [/^\/api\/insurance(?:\/|$)/, "insurance"],
    [/^\/api\/agreements(?:\/|$)/, "agreements"],
    [/^\/api\/admin\/agreements(?:\/|$)/, "agreements"],
    [/^\/api\/passports(?:\/|$)/, "passports"],
    [/^\/api\/partnerships(?:\/|$)/, "partnerships"],
    [/^\/api\/packages(?:\/|$)/, "packages"],
    [/^\/api\/admin\/activity-log(?:\/|$)/, "activity"]
  ];
  return routes.find(([pattern]) => pattern.test(pathname))?.[1] || null;
}

function requireDashboardFeature(response, session, feature) {
  if (!session || !feature || effectiveDashboardFeatures(session).includes(feature)) return true;
  send(response, 403, { ok: false, message: "You do not have access to this dashboard feature." });
  return false;
}

function isManagerSession(session) {
  return normalizeAdminRole(session?.role) === "manager";
}

function isSupportSession(session) {
  return normalizeAdminRole(session?.role) === "support";
}

function requireSuperAdmin(response, session) {
  if (!session) {
    send(response, 401, { ok: false, message: "Unauthorized" });
    return false;
  }
  if (!isMasterAdminSession(session)) {
    send(response, 403, { ok: false, message: "Super-admin access required" });
    return false;
  }
  return true;
}

function requireAdminOperationsAccess(response, session, pathname) {
  if (!session) {
    send(response, 401, { ok: false, message: "Unauthorized" });
    return false;
  }
  const role = normalizeAdminRole(session.role);
  const feature = dashboardFeatureForRequest(pathname || "");
  if (!isMasterAdminSession(session) && role !== "manager" && role !== "admin" &&
      (!feature || !effectiveDashboardFeatures(session).includes(feature))) {
    send(response, 403, { ok: false, message: "This action requires access to the relevant dashboard feature. Ask a Super Admin to grant access." });
    return false;
  }
  return true;
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createSession(adminUsername, role = "admin") {
  const token = generateSessionToken();
  const sessionFile = path.join(sessionsDir, token);
  const account = readAdminUsers().find(user => String(user.username).toLowerCase() === String(adminUsername).toLowerCase());
  fs.writeFileSync(sessionFile, JSON.stringify({
    username: adminUsername,
    userId: account ? Number(account.id) : null,
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
    const account = readAdminUsers().find(user => String(user.username).toLowerCase() === String(session.username).toLowerCase());
    if (!account || account.active === false) {
      fs.unlinkSync(sessionFile);
      return null;
    }
    session.userId = Number(account.id);
    session.role = account.role || "support";
    session.featureAccess = account.featureAccess;
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
      if (size > 20_000_000) {
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
    return "BisFly Limited offers comprehensive travel insurance. Visit our Insurance section to submit your application with travel document and personal information.";
  }
  if (text.includes("schengen")) {
    return "BisFly Limited can guide Schengen travel plans, including itinerary support, hotel reservation, insurance reminders, and appointment preparation.";
  }
  if (text.includes("e-visa") || text.includes("evisa") || text.includes("online visa")) {
    return "For E-Visas, BisFly Limited helps confirm eligibility, required documents, processing expectations, and safe application steps.";
  }
  if (text.includes("visa")) {
    return "Great. Which country are you applying to, and is it for tourism, study, business, or work? BisFly Limited can help with document checks and next steps.";
  }
  if (text.includes("flight") || text.includes("ticket")) {
    return "Please share your departure city, destination, travel date, passenger count, and budget range so BisFly Limited can compare flight options.";
  }
  if (text.includes("study")) {
    return "For study abroad, tell me your preferred country, course level, timeline, and whether you already have admission.";
  }
  if (text.includes("hotel")) {
    return "BisFly Limited can help with hotel options. Share the city, dates, guest count, and preferred budget.";
  }
  if (text.includes("contact") || text.includes("instagram") || text.includes("facebook")) {
    return "You can email bisflytravels@gmail.com, message @bisfly_travels on Instagram (https://www.instagram.com/bisfly_travels), or contact BisFly Limited through the Facebook page.";
  }
  return "Thanks for chatting with BisFly Limited. Tell me your destination, travel date, number of travelers, budget range, and the service you need.";
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
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (request.method === "OPTIONS") {
    response.writeHead(200);
    response.end();
    return;
  }

  try {
    const requestSession = validateSession(request.headers.authorization?.replace("Bearer ", ""));
    const requiredDashboardFeature = dashboardFeatureForRequest(parsedUrl.pathname);
    if (requestSession && requiredDashboardFeature &&
        !requireDashboardFeature(response, requestSession, requiredDashboardFeature)) return;

    if (parsedUrl.pathname === "/api/flights/config" && request.method === "GET") {
      return send(response, 200, {
        enabled: Boolean(process.env.DUFFEL_ACCESS_TOKEN),
        message: process.env.DUFFEL_ACCESS_TOKEN
          ? null
          : "Live flight search is not configured. BisFly Limited will enable it after its Duffel account is set up."
      });
    }

    if (parsedUrl.pathname === "/api/flights/search" && request.method === "POST") {
      const clientIp = request.socket.remoteAddress || "unknown";
      const searchWindowStart = Date.now() - 60_000;
      const recentSearches = (flightSearchRateLimits.get(clientIp) || []).filter(timestamp => timestamp > searchWindowStart);
      if (recentSearches.length >= 20) {
        response.setHeader("Retry-After", "60");
        return send(response, 429, { ok: false, message: "Too many flight searches from this connection. Wait a minute and try again." });
      }
      recentSearches.push(Date.now());
      flightSearchRateLimits.set(clientIp, recentSearches);
      const body = await readBody(request);
      const search = validateFlightSearch(body);
      if (search.error) return send(response, 400, { ok: false, message: search.error });
      try {
        const slices = [{
          origin: search.origin,
          destination: search.destination,
          departure_date: search.departureDate
        }];
        if (search.returnDate) slices.push({
          origin: search.destination,
          destination: search.origin,
          departure_date: search.returnDate
        });
        const offerRequest = await duffelRequest("/air/offer_requests?return_offers=true", {
          method: "POST",
          body: {
            data: {
              slices,
              passengers: [
                ...Array.from({ length: search.passengerCount }, () => ({ type: "adult" })),
                ...search.childAges.map(age => ({ age }))
              ],
              cabin_class: search.cabinClass
            }
          }
        });
        const offers = Array.isArray(offerRequest?.offers) ? offerRequest.offers : [];
        if (!offers.length) return send(response, 200, { ok: true, searchId: offerRequest.id, offers: [] });
        const searchId = crypto.randomBytes(18).toString("hex");
        const createdAt = new Date().toISOString();
        const cachedSearches = readJsonArray(flightSearchesFile)
          .filter(item => new Date(item.expiresAt).getTime() > Date.now())
          .slice(0, 100);
        cachedSearches.unshift({
          id: searchId,
          createdAt,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          passengerCount: search.passengerCount,
          childAges: search.childAges,
          departureDate: search.departureDate,
          offers: offers.slice(0, 30)
        });
        writeJsonArray(flightSearchesFile, cachedSearches);
        return send(response, 200, {
          ok: true,
          searchId,
          offers: offers.slice(0, 30).map(summarizeFlightOffer)
        });
      } catch (error) {
        console.error("Duffel flight search failed:", error.message);
        return send(response, error.statusCode || 502, { ok: false, message: error.message || "Flight search failed." });
      }
    }

    if (parsedUrl.pathname === "/api/flights/requests" && request.method === "POST") {
      const body = await readBody(request);
      const searches = readJsonArray(flightSearchesFile);
      const search = searches.find(item => item.id === body.searchId && new Date(item.expiresAt).getTime() > Date.now());
      if (!search) return send(response, 410, { ok: false, message: "These flight offers have expired. Search again to see current availability and prices." });
      const offer = search.offers.find(item => item.id === body.offerId);
      if (!offer) return send(response, 400, { ok: false, message: "Select a valid flight offer from the latest search results." });
      if (offer.expires_at && new Date(offer.expires_at).getTime() <= Date.now()) {
        return send(response, 410, { ok: false, message: "This fare has expired. Search again to see current availability and prices." });
      }
      const expectedPassengerCount = search.passengerCount + (search.childAges || []).length;
      if (!Array.isArray(body.passengers) || body.passengers.length !== expectedPassengerCount) {
        return send(response, 400, { ok: false, message: `Enter details for all ${expectedPassengerCount} passenger(s).` });
      }
      const passengers = [];
      for (const [index, passenger] of body.passengers.entries()) {
        const type = index < search.passengerCount ? "adult" : "child";
        const submittedType = String(passenger.type || type).trim().toLowerCase();
        const childIndex = index - search.passengerCount;
        const expectedAge = type === "child" ? search.childAges[childIndex] : null;
        const selectedAge = type === "child" ? Number(passenger.age) : null;
        const title = String(passenger.title || "").trim().toLowerCase();
        const givenName = String(passenger.givenName || "").trim();
        const familyName = String(passenger.familyName || "").trim();
        const bornOn = String(passenger.bornOn || "");
        const gender = String(passenger.gender || "").trim().toLowerCase();
        const email = String(passenger.email || passengers[0]?.email || "").trim();
        const phoneNumber = String(passenger.phoneNumber || passengers[0]?.phoneNumber || "").trim();
        if (submittedType !== type || !["mr", "ms", "mrs", "miss", "dr"].includes(title) ||
            !givenName || givenName.length > 100 || !familyName || familyName.length > 100 ||
            !validateDateOnly(bornOn) || bornOn >= new Date().toISOString().slice(0, 10) ||
            !["m", "f"].includes(gender) || !validateEmail(email) || email.length > 180 ||
            !validatePhone(phoneNumber) || phoneNumber.length > 40 ||
            (type === "adult" && ageOnDate(bornOn, search.departureDate) < 12) ||
            (type === "child" && (selectedAge !== expectedAge || ageOnDate(bornOn, search.departureDate) !== expectedAge))) {
          const ageRequirement = type === "adult"
            ? " Adult passengers must be 12 or older on the departure date."
            : ` Enter the selected age (${expectedAge}) and a date of birth that makes the child that age on departure.`;
          return send(response, 400, { ok: false, message: `Enter valid title, name, date of birth, gender, email, and phone number for passenger ${index + 1}.${ageRequirement}` });
        }
        passengers.push({ type, age: type === "child" ? expectedAge : null, title, givenName, familyName, bornOn, gender, email, phoneNumber });
      }
      const reference = `BFLF-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      const booking = {
        id: crypto.randomBytes(12).toString("hex"),
        reference,
        publicToken: crypto.randomBytes(32).toString("hex"),
        status: "awaiting_payment",
        passengers,
        adultCount: search.passengerCount,
        childAges: search.childAges || [],
        offerId: offer.id,
        offer: summarizeFlightOffer(offer),
        offerPassengerIds: (offer.passengers || []).map(passenger => passenger.id),
        offerExpiresAt: offer.expires_at || null,
        paymentConfirmed: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const bookings = readJsonArray(flightBookingsFile);
      bookings.unshift(booking);
      writeJsonArray(flightBookingsFile, bookings);
      logActivity("flight_booking_request_created", {
        id: booking.id,
        reference: booking.reference,
        origin: booking.offer.slices[0]?.origin?.code,
        destination: booking.offer.slices[0]?.destination?.code
      }, passengers[0].email);
      return send(response, 201, { ok: true, booking: publicFlightBooking(booking), accessToken: booking.publicToken });
    }

    const publicFlightBookingMatch = parsedUrl.pathname.match(/^\/api\/flights\/bookings\/([a-f0-9]{64})(?:\/(pdf))?$/);
    if (publicFlightBookingMatch) {
      if (request.method !== "GET") return send(response, 405, { ok: false, message: "Method not allowed." });
      const booking = readJsonArray(flightBookingsFile).find(item => item.publicToken === publicFlightBookingMatch[1]);
      if (!booking) return send(response, 404, { ok: false, message: "Flight booking request not found." });
      if (publicFlightBookingMatch[2] === "pdf") {
        if (!booking.bookingReference) return send(response, 409, { ok: false, message: "Your flight request is not yet a provider-confirmed booking. The itinerary PDF will be available after an admin completes booking." });
        const pdf = await generateFlightBookingPdf(booking);
        response.setHeader("Content-Disposition", `attachment; filename="bisfly-flight-${booking.reference}.pdf"`);
        return send(response, 200, pdf, "application/pdf");
      }
      return send(response, 200, { ok: true, booking: publicFlightBooking(booking) });
    }

    if (parsedUrl.pathname === "/api/admin/flights" && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      return send(response, 200, readJsonArray(flightBookingsFile).map(adminFlightBooking));
    }

    const adminFlightRoute = parsedUrl.pathname.match(/^\/api\/admin\/flights\/([^/]+)\/(payment-confirmation|book|refresh|pdf)$/);
    if (adminFlightRoute) {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const [, bookingId, action] = adminFlightRoute;
      const bookings = readJsonArray(flightBookingsFile);
      const booking = bookings.find(item => item.id === bookingId);
      if (!booking) return send(response, 404, { ok: false, message: "Flight booking request not found." });

      if (action === "payment-confirmation" && request.method === "POST") {
        const body = await readBody(request);
        if (body.confirmed !== true) return send(response, 400, { ok: false, message: "Explicitly confirm that payment has been received and verified before proceeding." });
        if (booking.status !== "awaiting_payment") return send(response, 409, { ok: false, message: "Payment can only be confirmed for a request awaiting payment." });
        booking.paymentConfirmed = true;
        booking.paymentConfirmedAt = new Date().toISOString();
        booking.paymentConfirmedBy = session.username;
        booking.paymentReference = String(body.paymentReference || "").trim().slice(0, 120) || null;
        booking.status = "payment_confirmed";
        booking.updatedAt = new Date().toISOString();
        writeJsonArray(flightBookingsFile, bookings);
        logActivity("flight_booking_payment_confirmed", { id: booking.id, reference: booking.reference, paymentReference: booking.paymentReference }, session.username);
        return send(response, 200, { ok: true, booking: adminFlightBooking(booking) });
      }

      if (action === "book" && request.method === "POST") {
        if (!booking.paymentConfirmed || booking.status !== "payment_confirmed") {
          return send(response, 409, { ok: false, message: "Verify and confirm customer payment before placing an order against BisFly’s Duffel balance." });
        }
        if (booking.duffelOrderId || ["booking_in_progress", "booking_attention", "booked"].includes(booking.status)) {
          return send(response, 409, { ok: false, message: "This request already has a booking attempt. Refresh its provider status before taking further action to avoid a duplicate charge." });
        }
        if (booking.offerExpiresAt && new Date(booking.offerExpiresAt).getTime() <= Date.now()) {
          booking.status = "offer_expired";
          booking.updatedAt = new Date().toISOString();
          writeJsonArray(flightBookingsFile, bookings);
          return send(response, 409, { ok: false, message: "The selected fare has expired. Ask the customer to submit a new flight request at the current price." });
        }
        booking.status = "booking_in_progress";
        booking.bookingAttemptedAt = new Date().toISOString();
        booking.bookingAttemptedBy = session.username;
        booking.updatedAt = new Date().toISOString();
        writeJsonArray(flightBookingsFile, bookings);
        let order;
        try {
          const currentOffer = await duffelRequest(`/air/offers/${encodeURIComponent(booking.offerId)}`);
          const currentAmount = Number(currentOffer.total_amount);
          const approvedAmount = Number(booking.offer.totalAmount);
          if (!Number.isFinite(currentAmount) || currentOffer.total_currency !== booking.offer.totalCurrency ||
              Math.abs(currentAmount - approvedAmount) > 0.000001 ||
              currentOffer.expires_at && new Date(currentOffer.expires_at).getTime() <= Date.now()) {
            booking.status = "offer_expired";
            booking.offer = summarizeFlightOffer(currentOffer);
            booking.offerExpiresAt = currentOffer.expires_at || null;
            booking.updatedAt = new Date().toISOString();
            writeJsonArray(flightBookingsFile, bookings);
            return send(response, 409, { ok: false, message: "The provider fare or availability changed. Do not book against the previous payment; confirm the new fare with the customer and request a new offer." });
          }
          const providerPassengers = booking.passengers.map((passenger, index) => {
            const passengerId = booking.offerPassengerIds[index];
            if (!passengerId) throw new Error("The selected flight offer did not include a passenger identifier. Submit a new flight request.");
            return {
              id: passengerId,
              title: passenger.title,
              given_name: passenger.givenName,
              family_name: passenger.familyName,
              born_on: passenger.bornOn,
              gender: passenger.gender,
              email: passenger.email,
              phone_number: passenger.phoneNumber
            };
          });
          order = await duffelRequest("/air/orders", {
            method: "POST",
            idempotencyKey: `bisfly-${booking.id}`,
            body: {
              data: {
                type: "instant",
                selected_offers: [booking.offerId],
                passengers: providerPassengers,
                payments: [{
                  type: "balance",
                  currency: currentOffer.total_currency,
                  amount: currentOffer.total_amount
                }]
              }
            }
          });
        } catch (error) {
          booking.status = "booking_attention";
          booking.bookingError = `${error.message || "Provider booking failed."} Check the Duffel dashboard before retrying; the order may have been created if the provider timed out.`;
          booking.updatedAt = new Date().toISOString();
          writeJsonArray(flightBookingsFile, bookings);
          logActivity("flight_booking_provider_error", { id: booking.id, reference: booking.reference, message: error.message }, session.username);
          return send(response, error.statusCode || 502, { ok: false, message: booking.bookingError, booking: adminFlightBooking(booking) });
        }
        booking.duffelOrderId = order.id || null;
        booking.bookingReference = order.booking_reference || null;
        booking.bookingStatus = order.booking_status || order.status || null;
        booking.ticketNumbers = (order.documents || [])
          .filter(document => /electronic[_ -]?ticket/i.test(String(document.type || "")) && document.unique_identifier)
          .map(document => String(document.unique_identifier));
        booking.status = booking.bookingReference ? "booked" : "booking_attention";
        booking.bookingError = booking.bookingReference
          ? null
          : "Duffel accepted the order but did not return an airline booking reference yet. Refresh the provider order before sharing a confirmation.";
        booking.bookedAt = new Date().toISOString();
        booking.bookedBy = session.username;
        booking.updatedAt = new Date().toISOString();
        writeJsonArray(flightBookingsFile, bookings);
        logActivity("flight_booking_order_created", {
          id: booking.id,
          reference: booking.reference,
          duffelOrderId: booking.duffelOrderId,
          bookingReference: booking.bookingReference
        }, session.username);
        return send(response, 200, { ok: true, booking: adminFlightBooking(booking) });
      }

      if (action === "refresh" && request.method === "POST") {
        if (!booking.duffelOrderId) return send(response, 409, { ok: false, message: "There is no Duffel order to refresh for this request." });
        try {
          const order = await duffelRequest(`/air/orders/${encodeURIComponent(booking.duffelOrderId)}`);
          booking.bookingReference = order.booking_reference || booking.bookingReference || null;
          booking.bookingStatus = order.booking_status || order.status || booking.bookingStatus || null;
          booking.ticketNumbers = (order.documents || [])
            .filter(document => /electronic[_ -]?ticket/i.test(String(document.type || "")) && document.unique_identifier)
            .map(document => String(document.unique_identifier));
          booking.status = booking.bookingReference ? "booked" : "booking_attention";
          booking.bookingError = booking.bookingReference ? null : "The provider order still has no airline booking reference.";
          booking.updatedAt = new Date().toISOString();
          writeJsonArray(flightBookingsFile, bookings);
          return send(response, 200, { ok: true, booking: adminFlightBooking(booking) });
        } catch (error) {
          return send(response, error.statusCode || 502, { ok: false, message: error.message || "Unable to refresh provider order." });
        }
      }

      if (action === "pdf" && request.method === "GET") {
        if (!booking.bookingReference) return send(response, 409, { ok: false, message: "A provider-confirmed airline booking reference is not available yet." });
        const pdf = await generateFlightBookingPdf(booking);
        response.setHeader("Content-Disposition", `attachment; filename="bisfly-flight-${booking.reference}.pdf"`);
        return send(response, 200, pdf, "application/pdf");
      }
    }

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
      const role = normalizeAdminRole(body.role || "admin");

      if (!new Set(["admin", "manager", "support", "super-admin"]).has(role)) {
        send(response, 400, { ok: false, message: "Role must be Admin, Manager, Support/Customer, or Super Admin." });
        return;
      }

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
      if (body.featureAccess !== undefined && String(existing.username).toLowerCase() === String(session.username).toLowerCase()) {
        send(response, 400, { ok: false, message: "You cannot change your own dashboard feature access." });
        return;
      }
      const nextUsername = String(body.username || existing.username).trim();
      const nextRole = normalizeAdminRole(body.role || existing.role || "admin");
      if (!new Set(["admin", "manager", "support", "super-admin"]).has(nextRole)) {
        send(response, 400, { ok: false, message: "Role must be Admin, Manager, Support/Customer, or Super Admin." });
        return;
      }
      let nextFeatureAccess = existing.featureAccess;
      if (body.featureAccess !== undefined) {
        if (isMasterAdminSession({ username: nextUsername || existing.username, role: nextRole }) ||
            !Array.isArray(body.featureAccess) ||
            body.featureAccess.some(feature => typeof feature !== "string" || !GRANTABLE_DASHBOARD_FEATURES.includes(feature))) {
          send(response, 400, { ok: false, message: "Choose valid dashboard features for a non-super-admin user. User management stays Super Admin-only." });
          return;
        }
        nextFeatureAccess = [...new Set(body.featureAccess)];
      }
      if (nextUsername && nextUsername.toLowerCase() !== existing.username.toLowerCase()) {
        const conflict = users.some(item => item.id !== id && String(item.username).toLowerCase() === nextUsername.toLowerCase());
        if (conflict) {
          send(response, 409, { ok: false, message: "That username already exists" });
          return;
        }
      }

      if (String(existing.username).toLowerCase() === String(session.username).toLowerCase() &&
          (nextRole !== normalizeAdminRole(existing.role) || body.active === false)) {
        send(response, 400, { ok: false, message: "You cannot change your own role or deactivate your own account." });
        return;
      }

      const activeSuperAdmins = users.filter(user => user.active !== false && normalizeAdminRole(user.role) === "super-admin").length;
      if (normalizeAdminRole(existing.role) === "super-admin" &&
          (nextRole !== "super-admin" || body.active === false) && activeSuperAdmins <= 1) {
        send(response, 400, { ok: false, message: "At least one active super-admin account must remain." });
        return;
      }

      const updated = {
        ...existing,
        username: nextUsername || existing.username,
        role: nextRole,
        active: body.active !== undefined ? body.active !== false : existing.active !== false,
        updatedAt: new Date().toISOString()
      };
      if (body.featureAccess !== undefined) updated.featureAccess = nextFeatureAccess;

      if (body.password) {
        if (String(body.password).length < 8) {
          send(response, 400, { ok: false, message: "Password must be at least 8 characters." });
          return;
        }
        const { hash, salt } = hashPasswordWithSalt(body.password);
        updated.passwordHash = hash;
        updated.passwordSalt = salt;
      }

      users[userIndex] = updated;
      writeAdminUsers(users);
      logActivity("admin_user_updated", {
        username: session.username,
        target: updated.username,
        role: updated.role,
        dashboardFeatures: effectiveDashboardFeatures(updated)
      }, session.username);
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

      const activeSuperAdmins = users.filter(user => user.active !== false && normalizeAdminRole(user.role) === "super-admin").length;
      if (normalizeAdminRole(removed.role) === "super-admin" && removed.active !== false && activeSuperAdmins === 0) {
        send(response, 400, { ok: false, message: "At least one active super-admin account must remain." });
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
      send(response, session ? 200 : 401, {
        authenticated: !!session,
        username: session?.username,
        role: session?.role || "admin",
        dashboardFeatures: session ? effectiveDashboardFeatures(session) : []
      });
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
        const html = `<p>Dear ${normalized.fullName || normalized.name || 'Customer'},</p><p>Thank you for submitting your travel insurance application. We will review it and contact you shortly.</p><p>Reference ID: ${insurance[0].id}</p><p>Best regards,<br/>BisFly Limited</p>`;
        notifySubmission(normalized.email, 'BisFly Limited: Insurance application received', html, 'BisFly Limited: New insurance application', `<p>A new travel insurance application was submitted.</p><p><strong>Name:</strong> ${normalized.fullName || normalized.name || 'Customer'}</p><p><strong>Email:</strong> ${normalized.email}</p><p><strong>Reference ID:</strong> ${insurance[0].id}</p>`);
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
      if (!requireSuperAdmin(response, session)) return;

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
      if (!requireSuperAdmin(response, session)) return;

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
      if (!requireSuperAdmin(response, session)) return;
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
        const html = `<p>Dear ${normalized.fullName || normalized.name || 'Customer'},</p><p>Your passport request has been received. We will contact you shortly with next steps.</p><p>Reference ID: ${passports[0].id}</p><p>Thank you,<br/>BisFly Limited</p>`;
        notifySubmission(normalized.email, 'BisFly Limited: Passport request received', html, 'BisFly Limited: New passport request', `<p>A new passport request was submitted.</p><p><strong>Name:</strong> ${normalized.fullName || normalized.name || 'Customer'}</p><p><strong>Email:</strong> ${normalized.email}</p><p><strong>Reference ID:</strong> ${passports[0].id}</p>`);
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
        const html = `<p>Dear ${normalized.contactName || 'Partner'},</p><p>Thank you for your interest in partnering with BisFly Limited. Our team will review your proposal and contact you soon.</p><p>Partnership Type: ${normalized.partnershipType}</p><p>Reference ID: ${normalized.id}</p><p>Best regards,<br/>BisFly Limited</p>`;
        notifySubmission(normalized.email, 'BisFly Limited: Partnership request received', html, 'BisFly Limited: New partnership request', `<p>A new partnership request was submitted.</p><p><strong>Company:</strong> ${normalized.companyName}</p><p><strong>Contact:</strong> ${normalized.contactName}</p><p><strong>Email:</strong> ${normalized.email}</p><p><strong>Phone:</strong> ${normalized.phone}</p><p><strong>Type:</strong> ${normalized.partnershipType}</p>`);
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

    if (parsedUrl.pathname === "/api/leads" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      if (!validateSession(token)) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      send(response, 200, readLeads());
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
      if (!requireSuperAdmin(response, session)) return;
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
      send(response, 403, { ok: false, message: "Agreements can only be generated from the admin dashboard." });
      return;
    }

    if (parsedUrl.pathname === "/api/admin/agreements/generate" && request.method === "POST") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!requireSuperAdmin(response, session)) return;

      const fields = await readBody(request);
      const requiredFields = ["fullName", "phone", "email", "dateOfBirth", "address", "packageType", "packageOption", "totalAmount", "amountDeposited", "paymentDate", "agreementDate", "description"];
      for (const field of requiredFields) {
        if (!String(fields[field] ?? "").trim()) {
          send(response, 400, { ok: false, message: `${field} is required` });
          return;
        }
      }

      const totalAmount = Number(fields.totalAmount);
      const amountDeposited = Number(fields.amountDeposited);
      const balanceAfterApproval = totalAmount - amountDeposited;
      if (![totalAmount, amountDeposited].every(Number.isFinite) || totalAmount < 0 || amountDeposited < 0 || amountDeposited > totalAmount) {
        send(response, 400, { ok: false, message: "The deposited amount must be between zero and the total package amount." });
        return;
      }
      if (!new Set(["Tour Package", "Conference Package", "Work Visa Package", "Study Package"]).has(String(fields.packageType))) {
        send(response, 400, { ok: false, message: "Select a valid package type." });
        return;
      }
      if (!new Set(["Single", "Couple", "Family of one", "Family of two", "Family of three"]).has(String(fields.packageOption))) {
        send(response, 400, { ok: false, message: "Select a valid package option." });
        return;
      }

      const agreement = {
        id: Date.now(),
        fullName: String(fields.fullName).trim(),
        phone: String(fields.phone).trim(),
        email: String(fields.email).trim(),
        dateOfBirth: String(fields.dateOfBirth),
        address: String(fields.address).trim(),
        packageType: String(fields.packageType),
        packageOption: String(fields.packageOption),
        totalAmount,
        amountDeposited,
        balanceAfterApproval,
        paymentDate: String(fields.paymentDate),
        agreementDate: String(fields.agreementDate),
        description: String(fields.description).trim(),
        generatedBy: session.username,
        status: "generated",
        createdAt: new Date().toISOString()
      };

      const agreements = readAgreements();
      agreements.unshift(agreement);
      writeAgreements(agreements);
      logActivity("agreement_generated", { id: agreement.id, client: agreement.fullName }, session.username);
      send(response, 201, { ok: true, id: agreement.id, downloadUrl: `/api/agreements/${agreement.id}/download`, message: "Agreement generated" });
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

    const submittedRecordRoute = parsedUrl.pathname.match(/^\/api\/admin\/records\/(leads|insurance|agreements|passports|partnerships|documents|clients|disclaimers|expenses|receipts)\/([^/]+)$/);
    if (submittedRecordRoute && ["PATCH", "DELETE"].includes(request.method)) {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireSuperAdmin(response, session)) return;
      const [, collectionName, recordId] = submittedRecordRoute;
      const collection = submittedRecordCollections[collectionName];
      const records = collection.read();
      const index = records.findIndex(record => String(record.id) === decodeURIComponent(recordId));
      if (index === -1) return send(response, 404, { ok: false, message: "Record not found." });

      if (request.method === "DELETE") {
        const [removed] = records.splice(index, 1);
        collection.write(records);
        removeUnusedRecordFiles(removed);
        logActivity("submitted_record_deleted", { collection: collectionName, id: removed.id }, session.username);
        return send(response, 200, { ok: true, message: "Record deleted." });
      }

      if (collectionName === "clients") {
        return send(response, 400, { ok: false, message: "Update client details through the client record form." });
      }
      const body = await readBody(request);
      const values = body.values;
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        return send(response, 400, { ok: false, message: "Provide record fields to update." });
      }
      const record = records[index];
      for (const [field, value] of Object.entries(values)) {
        if (protectedSubmittedRecordFields.has(field) || field === "allowedUsers" || !Object.prototype.hasOwnProperty.call(record, field)) {
          return send(response, 400, { ok: false, message: `The ${field} field cannot be edited.` });
        }
        if (typeof value === "string" && value.length > 10000) {
          return send(response, 400, { ok: false, message: "Record fields must be 10,000 characters or fewer." });
        }
        if (field === "allowedUserIds" && collectionName === "documents") {
          if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(Number(id)))) {
            return send(response, 400, { ok: false, message: "Choose valid users for document access." });
          }
          const users = readAdminUsers().filter(user => user.active !== false);
          const uniqueUserIds = [...new Set(value.map(Number))];
          const selectedUsers = uniqueUserIds.map(id => users.find(user => Number(user.id) === id));
          if (selectedUsers.some(user => !user)) {
            return send(response, 400, { ok: false, message: "One or more selected users are unavailable." });
          }
          record.allowedUserIds = uniqueUserIds;
          record.allowedUsers = selectedUsers.map(user => ({ id: user.id, username: user.username }));
          continue;
        }
        const existingValue = record[field];
        if (existingValue !== null && existingValue !== undefined &&
            (Array.isArray(existingValue) !== Array.isArray(value) ||
             (Array.isArray(existingValue) && !Array.isArray(value)) ||
             (!Array.isArray(existingValue) && typeof existingValue !== typeof value))) {
          return send(response, 400, { ok: false, message: `Enter a value with the same format as ${field}.` });
        }
        if (typeof value === "object" && value !== null && JSON.stringify(value).length > 10000) {
          return send(response, 400, { ok: false, message: "Record fields must be 10,000 characters or fewer." });
        }
        record[field] = value;
      }
      record.updatedAt = new Date().toISOString();
      record.updatedBy = session.username;
      collection.write(records);
      logActivity("submitted_record_updated", { collection: collectionName, id: record.id }, session.username);
      return send(response, 200, { ok: true, record });
    }

    if (parsedUrl.pathname === "/api/admin/clients" && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      return send(response, 200, readJsonArray(clientsFile));
    }

    if (parsedUrl.pathname === "/api/admin/clients" && request.method === "POST") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const parsed = await readBody(request);
      const fields = parsed.fields || {};
      const files = parsed.files || {};
      const required = ["fullName", "gender", "dateOfBirth", "address", "phone", "email", "packageType", "balanceAfterApproval", "paymentMethod"];
      for (const field of required) {
        if (!String(fields[field] ?? "").trim()) return send(response, 400, { ok: false, message: `${field} is required.` });
      }
      if (!validateDateOnly(fields.dateOfBirth)) return send(response, 400, { ok: false, message: "Enter a valid date of birth." });
      if (!validatePhone(fields.phone)) return send(response, 400, { ok: false, message: "Enter a valid phone number." });
      if (!validateEmail(fields.email) || String(fields.email).length > 180) {
        return send(response, 400, { ok: false, message: "Enter a valid client email address (maximum 180 characters)." });
      }
      const payment = parseClientPaymentSchedule(fields);
      if (payment.error) return send(response, 400, { ok: false, message: payment.error });
      const balanceAfterApproval = Number(fields.balanceAfterApproval);
      if (!Number.isFinite(balanceAfterApproval) || balanceAfterApproval < 0 || balanceAfterApproval > Number.MAX_SAFE_INTEGER) {
        return send(response, 400, { ok: false, message: "Enter a valid non-negative balance." });
      }
      const status = String(fields.status || "pending");
      if (!["ongoing", "pending", "submitted", "refused", "approved"].includes(status)) {
        return send(response, 400, { ok: false, message: "Select a valid client progress status." });
      }
      const signedAttachments = [["signedDisclaimer", "signed disclaimer"], ["signedAgreement", "signed agreement"]]
        .map(([field, label]) => ({ field, label, file: files[field] }))
        .filter(attachment => attachment.file?.data?.length);
      for (const { label, file } of signedAttachments) {
        const validationError = validateClientDocument(file, label);
        if (validationError) return send(response, file.data.length > 15_000_000 ? 413 : 400, { ok: false, message: validationError });
      }
      const submittedAttachments = [
        ["visaApplicationForm", "filled visa application form", "visaApplicationFile"],
        ["submittedSupportingDocument1", "first supporting document", "submittedSupportingDocument1File"],
        ["submittedSupportingDocument2", "second supporting document", "submittedSupportingDocument2File"]
      ].map(([field, label, recordField]) => ({ field, label, recordField, file: files[field] }));
      if (status === "submitted") {
        for (const { label, file } of submittedAttachments) {
          const validationError = validateClientDocument(file, label, 5_000_000);
          if (validationError) return send(response, file?.data?.length > 5_000_000 ? 413 : 400, { ok: false, message: validationError });
        }
      }
      const record = {
        id: crypto.randomBytes(12).toString("hex"),
        fullName: String(fields.fullName).trim().slice(0, 160),
        gender: String(fields.gender).trim().slice(0, 40),
        dateOfBirth: String(fields.dateOfBirth),
        address: String(fields.address).trim().slice(0, 500),
        phone: String(fields.phone).trim().slice(0, 40),
        email: String(fields.email).trim().slice(0, 180),
        packageType: String(fields.packageType).trim().slice(0, 120),
        paymentMethod: payment.paymentMethod,
        paymentSchedule: payment.paymentSchedule,
        initialDepositComplete: payment.initialDepositComplete,
        amountPaid: payment.amountPaid,
        paymentDate: payment.paymentDate,
        balanceAfterApproval,
        status,
        createdBy: session.username,
        createdAt: new Date().toISOString()
      };
      const createdFiles = [];
      for (const { field, file } of signedAttachments) {
        const extension = path.extname(file.filename).toLowerCase();
        const storedName = `client-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extension}`;
        fs.writeFileSync(path.join(uploadsDir, storedName), file.data, { flag: "wx" });
        createdFiles.push(storedName);
        record[field === "signedDisclaimer" ? "signedDisclaimerFile" : "signedAgreementFile"] = storedName;
      }
      if (status === "submitted") {
        for (const { field, file, recordField } of submittedAttachments) {
          const extension = path.extname(file.filename).toLowerCase();
          const storedName = `client-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extension}`;
          fs.writeFileSync(path.join(uploadsDir, storedName), file.data, { flag: "wx" });
          createdFiles.push(storedName);
          record[recordField] = storedName;
        }
      }
      const records = readJsonArray(clientsFile);
      records.unshift(record);
      const previousReceipts = readJsonArray(receiptsFile);
      let referenceNumber;
      do {
        referenceNumber = `BFL-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      } while (previousReceipts.some(item => item.referenceNumber === referenceNumber));
      const receipt = {
        id: crypto.randomBytes(12).toString("hex"),
        clientId: record.id,
        referenceNumber,
        receiptDate: new Date().toISOString().slice(0, 10),
        paymentDate: record.paymentDate,
        clientName: record.fullName,
        clientEmail: record.email,
        packageType: record.packageType,
        amountPaid: record.amountPaid,
        paymentMethod: record.paymentMethod,
        paymentSchedule: record.paymentSchedule,
        initialDepositComplete: record.initialDepositComplete,
        balanceAfterApproval: record.balanceAfterApproval,
        createdBy: session.username,
        createdAt: new Date().toISOString(),
        approvalStatus: record.initialDepositComplete ? "pending" : "pending_payment",
        approvedBy: null,
        approvedAt: null,
        emailStatus: record.initialDepositComplete ? "awaiting_approval" : "awaiting_payment_completion",
        emailError: null,
        emailSentAt: null
      };
      const receipts = [receipt, ...previousReceipts];
      try {
        writeJsonArray(receiptsFile, receipts);
        writeJsonArray(clientsFile, records);
      } catch (error) {
        writeJsonArray(receiptsFile, previousReceipts);
        for (const storedName of createdFiles) {
          const storedPath = path.join(uploadsDir, storedName);
          if (fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
        }
        throw error;
      }
      logActivity("client_created", { id: record.id, client: record.fullName, receiptId: receipt.id, referenceNumber }, session.username);
      return send(response, 201, { ok: true, client: record, receipt });
    }

    const submittedDocumentsRouteMatch = parsedUrl.pathname.match(/^\/api\/admin\/clients\/([^/]+)\/submitted-documents$/);
    if (submittedDocumentsRouteMatch && request.method === "POST") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const clientId = submittedDocumentsRouteMatch[1];
      const records = readJsonArray(clientsFile);
      const client = records.find(item => item.id === clientId);
      if (!client) return send(response, 404, { ok: false, message: "Client record not found." });
      const parsed = await readBody(request);
      const files = parsed.files || {};
      const attachments = [
        ["visaApplicationForm", "filled visa application form", "visaApplicationFile"],
        ["submittedSupportingDocument1", "first supporting document", "submittedSupportingDocument1File"],
        ["submittedSupportingDocument2", "second supporting document", "submittedSupportingDocument2File"]
      ].map(([field, label, recordField]) => ({ field, label, recordField, file: files[field] }));
      for (const { label, file } of attachments) {
        const validationError = validateClientDocument(file, label, 5_000_000);
        if (validationError) return send(response, file?.data?.length > 5_000_000 ? 413 : 400, { ok: false, message: validationError });
      }
      const previousFiles = attachments.map(({ recordField }) => client[recordField]).filter(Boolean);
      const storedFiles = [];
      try {
        for (const { file, recordField } of attachments) {
          const extension = path.extname(file.filename).toLowerCase();
          const storedName = `client-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extension}`;
          fs.writeFileSync(path.join(uploadsDir, storedName), file.data, { flag: "wx" });
          storedFiles.push(storedName);
          client[recordField] = storedName;
        }
        client.status = "submitted";
        client.updatedAt = new Date().toISOString();
        client.updatedBy = session.username;
        writeJsonArray(clientsFile, records);
      } catch (error) {
        for (const storedName of storedFiles) {
          const storedPath = path.join(uploadsDir, storedName);
          if (fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
        }
        throw error;
      }
      for (const oldFile of previousFiles) {
        const oldPath = path.join(uploadsDir, path.basename(oldFile));
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      logActivity("client_submitted_documents_uploaded", { id: client.id, client: client.fullName }, session.username);
      return send(response, 200, { ok: true, client });
    }

    if (parsedUrl.pathname.match(/^\/api\/admin\/clients\/[^/]+$/) && request.method === "PATCH") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const clientId = parsedUrl.pathname.split("/").pop();
      const records = readJsonArray(clientsFile);
      const client = records.find(item => item.id === clientId);
      if (!client) return send(response, 404, { ok: false, message: "Client record not found." });
      const body = await readBody(request);
      const isPrivileged = isMasterAdminSession(session) || isManagerSession(session);
      if (body.paymentDate !== undefined && client.paymentMethod === "installment" &&
          String(body.paymentDate) !== String(client.paymentDate)) {
        return send(response, 409, { ok: false, message: "Installment dates are part of the recorded payment schedule and cannot be changed here." });
      }
      if (body.initialDepositComplete !== undefined &&
          (body.initialDepositComplete !== true || client.paymentMethod !== "installment")) {
        return send(response, 400, { ok: false, message: "Only an installment deposit can be explicitly marked complete." });
      }
      if (body.amountPaid !== undefined && !isPrivileged && Number(body.amountPaid) !== Number(client.amountPaid)) {
        return send(response, 403, { ok: false, message: "Only a Manager or Super Admin may change the amount paid." });
      }
      const allowedFields = ["fullName", "gender", "dateOfBirth", "address", "phone", "email", "packageType", "paymentDate", "balanceAfterApproval", "status"];
      for (const field of allowedFields) {
        if (body[field] !== undefined) client[field] = String(body[field]).trim();
      }
      if (body.email !== undefined && (!validateEmail(client.email) || client.email.length > 180)) {
        return send(response, 400, { ok: false, message: "Enter a valid client email address (maximum 180 characters)." });
      }
      for (const field of ["dateOfBirth", "paymentDate"]) {
        if (body[field] !== undefined && !validateDateOnly(client[field])) {
          return send(response, 400, { ok: false, message: `Enter a valid ${field === "dateOfBirth" ? "date of birth" : "payment date"}.` });
        }
      }
      if (body.amountPaid !== undefined && isPrivileged) {
        if (client.paymentMethod === "installment" && Number(body.amountPaid) !== Number(client.amountPaid)) {
          return send(response, 409, { ok: false, message: "Installment totals are calculated from the recorded payment schedule and cannot be changed here." });
        }
        const amountPaid = Number(body.amountPaid);
        if (!Number.isFinite(amountPaid) || amountPaid <= 0 || amountPaid > Number.MAX_SAFE_INTEGER) return send(response, 400, { ok: false, message: "Amount paid must be a positive number." });
        client.amountPaid = amountPaid;
      }
      if (body.balanceAfterApproval !== undefined) {
        const balance = Number(client.balanceAfterApproval);
        if (!Number.isFinite(balance) || balance < 0 || balance > Number.MAX_SAFE_INTEGER) {
          return send(response, 400, { ok: false, message: "Balance after approval must be a valid non-negative amount." });
        }
        client.balanceAfterApproval = balance;
      }
      if (body.status !== undefined && !["ongoing", "pending", "submitted", "refused", "approved"].includes(client.status)) {
        return send(response, 400, { ok: false, message: "Select a valid client progress status." });
      }
      if (client.status === "submitted" && ![
        client.visaApplicationFile, client.submittedSupportingDocument1File, client.submittedSupportingDocument2File
      ].every(Boolean)) {
        return send(response, 409, { ok: false, message: "Upload the filled visa application and both supporting documents before setting this client to Submitted." });
      }
      if (body.initialDepositComplete === true) client.initialDepositComplete = true;
      if (client.paymentMethod !== "installment" && (body.amountPaid !== undefined || body.paymentDate !== undefined)) {
        client.paymentSchedule = [{ amount: Number(client.amountPaid), paymentDate: client.paymentDate }];
      }
      client.updatedAt = new Date().toISOString();
      client.updatedBy = session.username;
      const previousReceipts = readJsonArray(receiptsFile);
      const initialDepositComplete = client.paymentMethod === "installment" ? client.initialDepositComplete === true : true;
      const receipts = previousReceipts.map(receipt => {
        if (receipt.clientId !== client.id || !["pending", "pending_payment"].includes(receipt.approvalStatus)) return receipt;
        const approvalStatus = initialDepositComplete ? "pending" : "pending_payment";
        return {
          ...receipt,
          approvalStatus,
          emailStatus: initialDepositComplete ? "awaiting_approval" : "awaiting_payment_completion",
          clientName: client.fullName,
          clientEmail: client.email,
          packageType: client.packageType,
          amountPaid: client.amountPaid,
          balanceAfterApproval: client.balanceAfterApproval,
          paymentDate: client.paymentDate,
          paymentMethod: client.paymentMethod || receipt.paymentMethod,
          paymentSchedule: client.paymentSchedule || receipt.paymentSchedule,
          initialDepositComplete
        };
      });
      const hasUpdatedPendingReceipt = receipts.some((receipt, index) => receipt !== previousReceipts[index]);
      if (hasUpdatedPendingReceipt) writeJsonArray(receiptsFile, receipts);
      try {
        writeJsonArray(clientsFile, records);
      } catch (error) {
        if (hasUpdatedPendingReceipt) writeJsonArray(receiptsFile, previousReceipts);
        throw error;
      }
      logActivity("client_updated", {
        id: client.id,
        amountPaidChanged: body.amountPaid !== undefined,
        initialDepositComplete: body.initialDepositComplete === true
      }, session.username);
      return send(response, 200, { ok: true, client });
    }

    if (parsedUrl.pathname === "/api/admin/clients/export" && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const records = readJsonArray(clientsFile);
      const from = parsedUrl.searchParams.get("from") || "";
      const to = parsedUrl.searchParams.get("to") || "";
      const filtered = records.filter(record => (!from || record.paymentDate >= from) && (!to || record.paymentDate <= to));
      const rows = filtered.map(record => ({
        "Client name": record.fullName,
        "Gender": record.gender,
        "Date of birth": record.dateOfBirth,
        "Address": record.address,
        "Phone": record.phone,
        "Package": record.packageType,
        "Amount paid": `NGN ${Number(record.amountPaid || 0).toLocaleString("en-NG")}`,
        "Payment history": `${record.paymentMethod === "installment" ? `${(record.paymentSchedule || []).length} installments` : "Full initial payment"}; last date ${record.paymentDate}`,
        "Balance after approval": `NGN ${Number(record.balanceAfterApproval || 0).toLocaleString("en-NG")}`,
        "Progress": record.status,
        "Client documents": [
          record.signedDisclaimerFile ? "Disclaimer" : "",
          record.signedAgreementFile ? "Agreement" : "",
          record.visaApplicationFile ? "Visa" : "",
          record.submittedSupportingDocument1File ? "Support 1" : "",
          record.submittedSupportingDocument2File ? "Support 2" : ""
        ].filter(Boolean).join(", ") || "None"
      }));
      const pdf = await generateTablePdf("BisFly Limited - Client Information Report", rows.length ? rows : [{
        "Client name": "", "Gender": "", "Date of birth": "", "Address": "", "Phone": "", "Package": "", "Amount paid": "", "Payment history": "", "Balance after approval": "", "Progress": "", "Client documents": ""
      }]);
      response.setHeader("Content-Disposition", `attachment; filename="bisfly-client-report-${new Date().toISOString().slice(0, 10)}.pdf"`);
      return send(response, 200, pdf, "application/pdf");
    }

    if (parsedUrl.pathname === "/api/admin/disclaimers/template" && request.method === "POST") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const body = await readBody(request);
      const required = ["fullName", "gender", "phone", "address", "email"];
      for (const field of required) {
        if (!String(body[field] ?? "").trim()) return send(response, 400, { ok: false, message: `${field} is required.` });
      }
      if (!validateEmail(body.email)) return send(response, 400, { ok: false, message: "Enter a valid email address." });
      const relationship = String(body.secondPersonRelationship || "");
      if (relationship && !["Brother", "Sister", "Wife", "Husband", "Friend"].includes(relationship)) {
        return send(response, 400, { ok: false, message: "Select a valid relationship for the additional person." });
      }
      if (relationship && !String(body.secondPersonName || "").trim()) {
        return send(response, 400, { ok: false, message: "Enter the additional person's name." });
      }
      const disclaimer = {
        ...body,
        fullName: String(body.fullName).trim(),
        gender: String(body.gender).trim(),
        phone: String(body.phone).trim(),
        address: String(body.address).trim(),
        email: String(body.email).trim(),
        secondPersonRelationship: relationship,
        secondPersonName: String(body.secondPersonName || "").trim(),
        generatedBy: session.username
      };
      const pdf = await generateDisclaimerPdf(disclaimer);
      response.setHeader("Content-Disposition", 'attachment; filename="bisfly-client-disclaimer-template.pdf"');
      return send(response, 200, pdf, "application/pdf");
    }

    if (parsedUrl.pathname === "/api/admin/disclaimers" && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      return send(response, 200, readJsonArray(disclaimersFile));
    }

    if (parsedUrl.pathname === "/api/admin/disclaimers" && request.method === "POST") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const parsed = await readBody(request);
      const fields = parsed.fields || {};
      const signedFile = parsed.files?.signedDisclaimer;
      const required = ["fullName", "gender", "phone", "address", "email"];
      for (const field of required) {
        if (!String(fields[field] ?? "").trim()) return send(response, 400, { ok: false, message: `${field} is required.` });
      }
      if (!validateEmail(fields.email)) return send(response, 400, { ok: false, message: "Enter a valid email address." });
      if (!signedFile?.data?.length) return send(response, 400, { ok: false, message: "Upload the client-signed disclaimer file." });
      if (signedFile.data.length > 15_000_000) return send(response, 413, { ok: false, message: "Signed disclaimers must be smaller than 15 MB." });
      const extension = path.extname(signedFile.filename).toLowerCase();
      const header = signedFile.data.subarray(0, 8);
      const validFile = extension === ".pdf" ? header.subarray(0, 5).toString("ascii") === "%PDF-"
        : [".jpg", ".jpeg"].includes(extension) ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
          : extension === ".png" && header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (!validFile) return send(response, 400, { ok: false, message: "Upload a valid signed PDF, JPG, or PNG file." });
      const relationship = String(fields.secondPersonRelationship || "");
      if (relationship && !["Brother", "Sister", "Wife", "Husband", "Friend"].includes(relationship)) {
        return send(response, 400, { ok: false, message: "Select a valid relationship for the additional person." });
      }
      if (relationship && !String(fields.secondPersonName || "").trim()) {
        return send(response, 400, { ok: false, message: "Enter the additional person's name." });
      }
      const storedName = `disclaimer-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extension}`;
      fs.writeFileSync(path.join(uploadsDir, storedName), signedFile.data, { flag: "wx" });
      const disclaimer = {
        id: crypto.randomBytes(12).toString("hex"),
        fullName: String(fields.fullName).trim().slice(0, 160),
        gender: String(fields.gender).trim().slice(0, 40),
        phone: String(fields.phone).trim().slice(0, 40),
        address: String(fields.address).trim().slice(0, 500),
        email: String(fields.email).trim().slice(0, 180),
        secondPersonRelationship: relationship,
        secondPersonName: String(fields.secondPersonName || "").trim().slice(0, 160),
        signedFile: storedName,
        originalFileName: path.basename(signedFile.filename).slice(0, 180),
        generatedBy: session.username,
        createdAt: new Date().toISOString()
      };
      const records = readJsonArray(disclaimersFile);
      records.unshift(disclaimer);
      writeJsonArray(disclaimersFile, records);
      logActivity("client_disclaimer_uploaded", { id: disclaimer.id, client: disclaimer.fullName }, session.username);
      return send(response, 201, { ok: true, disclaimer });
    }

    const disclaimerTemplateMatch = parsedUrl.pathname.match(/^\/api\/admin\/disclaimers\/([^/]+)\/template$/);
    if (disclaimerTemplateMatch && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const disclaimer = readJsonArray(disclaimersFile).find(item => item.id === disclaimerTemplateMatch[1]);
      if (!disclaimer) return send(response, 404, { ok: false, message: "Disclaimer record not found." });
      const pdf = await generateDisclaimerPdf(disclaimer);
      response.setHeader("Content-Disposition", `attachment; filename="bisfly-disclaimer-${disclaimer.id}.pdf"`);
      return send(response, 200, pdf, "application/pdf");
    }

    if (parsedUrl.pathname === "/api/admin/cash-inflows" && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const from = parsedUrl.searchParams.get("from") || "";
      const to = parsedUrl.searchParams.get("to") || "";
      if (from && !validateDateOnly(from) || to && !validateDateOnly(to) || from && to && from > to) {
        return send(response, 400, { ok: false, message: "Enter a valid date range." });
      }
      const records = getClientCashInflows(from, to);
      const amountTotal = sumMoneyCents(records, "amount") / 100;
      return send(response, 200, { records, amountTotal });
    }

    if (parsedUrl.pathname === "/api/admin/cash-inflows/report" && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const from = parsedUrl.searchParams.get("from") || "";
      const to = parsedUrl.searchParams.get("to") || "";
      if (from && !validateDateOnly(from) || to && !validateDateOnly(to) || from && to && from > to) {
        return send(response, 400, { ok: false, message: "Enter a valid date range." });
      }
      const records = getClientCashInflows(from, to);
      const rows = records.map(record => ({
        "Payment date": record.paymentDate,
        "Client name": record.fullName,
        "Installment": record.installmentNumber ? `${record.installmentNumber}` : "Full payment",
        "Amount paid": `NGN ${record.amount.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        "Package": record.packageType,
        "Phone": record.phone
      }));
      const total = sumMoneyCents(records, "amount") / 100;
      const period = `${from || "All dates"} to ${to || "Present"}`;
      const pdf = await generateReportPdf("BisFly Limited - Cash Inflow Report", `Payment date range: ${period} | ${records.length} payment(s)`, Object.keys(rows[0] || { "Payment date": "", "Client name": "", "Installment": "", "Amount paid": "", "Package": "", "Phone": "" }), rows, "TOTAL AMOUNT RECEIVED", `NGN ${total.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      response.setHeader("Content-Disposition", `attachment; filename="bisfly-cash-inflow-${from || "all"}-${to || "present"}.pdf"`);
      return send(response, 200, pdf, "application/pdf");
    }

    const accountBalanceRoute = parsedUrl.pathname.match(/^\/api\/admin\/account-balance(?:\/(report))?$/);
    if (accountBalanceRoute && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireSuperAdmin(response, session)) return;
      const from = parsedUrl.searchParams.get("from") || "";
      const to = parsedUrl.searchParams.get("to") || "";
      if (!validateDateOnly(from) || !validateDateOnly(to) || from > to) {
        return send(response, 400, { ok: false, message: "Choose a valid start and end date, with the start date on or before the end date." });
      }

      const inflows = getClientCashInflows(from, to);
      const expenses = readJsonArray(expensesFile)
        .filter(record => record.expenseDate >= from && record.expenseDate <= to)
        .map(record => ({
          expenseDate: record.expenseDate,
          adminName: record.adminName || "",
          purpose: record.purpose || "",
          amount: Number(record.amount)
        }));
      if (expenses.some(record => !validateDateOnly(record.expenseDate) || !Number.isFinite(record.amount) || record.amount <= 0)) {
        throw new Error("An expense record in the selected date range contains invalid financial data.");
      }

      const inflowCents = sumMoneyCents(inflows, "amount");
      const expenseCents = sumMoneyCents(expenses, "amount");
      const netBalanceCents = inflowCents - expenseCents;
      if (!accountBalanceRoute[1]) {
        return send(response, 200, {
          from,
          to,
          totalInflows: inflowCents / 100,
          totalExpenses: expenseCents / 100,
          netBalance: netBalanceCents / 100,
          inflowCount: inflows.length,
          expenseCount: expenses.length
        });
      }

      const transactions = [
        ...inflows.map(record => ({
          date: record.paymentDate,
          type: "Cash inflow",
          description: `${record.fullName}${record.packageType ? ` · ${record.packageType}` : ""}${record.installmentNumber ? ` · Installment ${record.installmentNumber}` : " · Full payment"}`,
          amount: record.amount
        })),
        ...expenses.map(record => ({
          date: record.expenseDate,
          type: "Expense",
          description: `${record.purpose} · ${record.adminName}`,
          amount: record.amount
        }))
      ].sort((first, second) => first.date.localeCompare(second.date) || first.type.localeCompare(second.type));
      const rows = transactions.map(transaction => {
        const inflow = transaction.type === "Cash inflow" ? transaction.amount : 0;
        const expense = transaction.type === "Expense" ? transaction.amount : 0;
        return {
          "Date": transaction.date,
          "Type": transaction.type,
          "Description": transaction.description,
          "Cash in (NGN)": inflow ? `NGN ${inflow.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—",
          "Expenses (NGN)": expense ? `NGN ${expense.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—",
          "Net movement (NGN)": `${expense ? "−" : "+"}NGN ${Math.abs(inflow - expense).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        };
      });
      const summary = `Period: ${from} to ${to} | Cash inflows: NGN ${(inflowCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | Expenses: NGN ${(expenseCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | Net cash movement: NGN ${(netBalanceCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ${inflows.length} payment(s), ${expenses.length} expense(s). This report is not a bank statement or closing account balance.`;
      const pdf = await generateReportPdf(
        "BisFly Limited - Account Balance Report",
        summary,
        Object.keys(rows[0] || { "Date": "", "Type": "", "Description": "", "Cash in (NGN)": "", "Expenses (NGN)": "", "Net movement (NGN)": "" }),
        rows,
        "NET CASH MOVEMENT FOR SELECTED PERIOD",
        `NGN ${(netBalanceCents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      );
      response.setHeader("Content-Disposition", `attachment; filename="bisfly-account-balance-${from}-${to}.pdf"`);
      return send(response, 200, pdf, "application/pdf");
    }

    if (parsedUrl.pathname === "/api/admin/expenses" && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      return send(response, 200, readJsonArray(expensesFile));
    }

    if (parsedUrl.pathname === "/api/admin/expenses" && request.method === "POST") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const body = await readBody(request);
      const purpose = String(body.purpose || "").trim();
      const amount = Number(body.amount);
      const expenseDate = String(body.expenseDate || "");
      if (!purpose || purpose.length > 500 || !Number.isFinite(amount) || amount <= 0 || !validateDateOnly(expenseDate)) {
        return send(response, 400, { ok: false, message: "Enter an expense purpose, a positive amount, and a valid date." });
      }
      const expense = { id: crypto.randomBytes(12).toString("hex"), adminName: session.username, purpose, amount, expenseDate, createdAt: new Date().toISOString() };
      const records = readJsonArray(expensesFile);
      records.unshift(expense);
      writeJsonArray(expensesFile, records);
      logActivity("expense_recorded", { id: expense.id, amount: expense.amount, purpose: expense.purpose }, session.username);
      return send(response, 201, { ok: true, expense });
    }

    if (parsedUrl.pathname === "/api/admin/expenses/report" && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const from = parsedUrl.searchParams.get("from") || "";
      const to = parsedUrl.searchParams.get("to") || "";
      if (from && !validateDateOnly(from) || to && !validateDateOnly(to) || from && to && from > to) {
        return send(response, 400, { ok: false, message: "Enter a valid date range." });
      }
      const records = readJsonArray(expensesFile).filter(record => (!from || record.expenseDate >= from) && (!to || record.expenseDate <= to));
      const rows = records.map(record => ({
        "Date": record.expenseDate,
        "Admin": record.adminName,
        "Purpose": record.purpose,
        "Amount": `NGN ${Number(record.amount || 0).toLocaleString("en-NG")}`
      }));
      const total = records.reduce((sum, record) => sum + Number(record.amount || 0), 0);
      const pdf = await generateReportPdf("BisFly Limited - Expense Report", `Expense date range: ${from || "All dates"} to ${to || "Present"} | ${records.length} expense(s)`, Object.keys(rows[0] || { "Date": "", "Admin": "", "Purpose": "", "Amount": "" }), rows, "TOTAL EXPENSES", `NGN ${total.toLocaleString("en-NG")}`);
      response.setHeader("Content-Disposition", `attachment; filename="bisfly-expense-report-${from || "all"}-${to || "present"}.pdf"`);
      return send(response, 200, pdf, "application/pdf");
    }

    if (parsedUrl.pathname === "/api/admin/receipts" && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      return send(response, 200, readJsonArray(receiptsFile));
    }

    if (parsedUrl.pathname === "/api/admin/receipts" && request.method === "POST") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      return send(response, 405, { ok: false, message: "Receipts are initialized automatically when a client payment is recorded." });
    }

    const receiptRouteMatch = parsedUrl.pathname.match(/^\/api\/admin\/receipts\/([^/]+)\/(approve|pdf|send)$/);
    if (receiptRouteMatch && receiptRouteMatch[2] === "approve" && request.method === "POST") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireSuperAdmin(response, session)) return;
      const receipts = readJsonArray(receiptsFile);
      const receipt = receipts.find(item => item.id === receiptRouteMatch[1]);
      if (!receipt) return send(response, 404, { ok: false, message: "Payment receipt not found." });
      if (receipt.paymentMethod === "installment" &&
          (receipt.initialDepositComplete !== true ||
           !readJsonArray(clientsFile).some(client => client.id === receipt.clientId && client.initialDepositComplete === true))) {
        return send(response, 409, { ok: false, message: "The client’s full initial deposit must be explicitly confirmed before this receipt can be approved." });
      }
      if (receipt.approvalStatus === "approved") {
        return send(response, 409, { ok: false, message: "This receipt has already been approved. Use Retry email if delivery failed." });
      }
      if (receipt.approvalStatus !== "pending") {
        return send(response, 409, { ok: false, message: "This receipt is not awaiting approval." });
      }
      receipt.approvalStatus = "approved";
      receipt.approvedBy = session.username;
      receipt.approvedAt = new Date().toISOString();
      receipt.emailStatus = "sending";
      receipt.emailError = null;
      receipt.emailSentAt = null;
      writeJsonArray(receiptsFile, receipts);
      receipt.emailPreviewUrl = null;
      logActivity("payment_receipt_approved", { id: receipt.id, referenceNumber: receipt.referenceNumber }, session.username);
      setImmediate(() => {
        processReceiptEmail(receipt.id).catch(error => {
          console.error(`Unable to queue receipt email ${receipt.id}:`, error);
        });
      });
      return send(response, 200, {
        ok: true,
        receipt,
        delivery: { sent: false, pending: true, message: "Receipt approved. Email delivery is running in the background." }
      });
    }

    if (receiptRouteMatch && receiptRouteMatch[2] === "pdf" && request.method === "GET") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const receipt = readJsonArray(receiptsFile).find(item => item.id === receiptRouteMatch[1]);
      if (!receipt) return send(response, 404, { ok: false, message: "Payment receipt not found." });
      if (receipt.approvalStatus !== "approved") {
        return send(response, 403, { ok: false, message: "This receipt is not available until a Super Admin approves it." });
      }
      const pdf = await generateReceiptPdf(receipt);
      response.setHeader("Content-Disposition", `attachment; filename="bisfly-payment-receipt-${receipt.referenceNumber}.pdf"`);
      return send(response, 200, pdf, "application/pdf");
    }

    if (receiptRouteMatch && receiptRouteMatch[2] === "send" && request.method === "POST") {
      const session = validateSession(request.headers.authorization?.replace("Bearer ", ""));
      if (!requireAdminOperationsAccess(response, session, parsedUrl.pathname)) return;
      const receipts = readJsonArray(receiptsFile);
      const receipt = receipts.find(item => item.id === receiptRouteMatch[1]);
      if (!receipt) return send(response, 404, { ok: false, message: "Payment receipt not found." });
      if (receipt.approvalStatus !== "approved") {
        return send(response, 403, { ok: false, message: "This receipt cannot be emailed until a Super Admin approves it." });
      }
      if (receipt.emailStatus === "sending") {
        return send(response, 409, { ok: false, message: "Receipt email delivery is already in progress." });
      }
      receipt.emailStatus = "sending";
      receipt.emailError = null;
      receipt.emailSentAt = null;
      writeJsonArray(receiptsFile, receipts);
      setImmediate(() => {
        processReceiptEmail(receipt.id).catch(error => {
          console.error(`Unable to queue receipt email ${receipt.id}:`, error);
        });
      });
      return send(response, 202, {
        ok: true,
        receipt,
        delivery: { sent: false, pending: true, message: "Email delivery is running in the background." }
      });
    }

    if (parsedUrl.pathname.match(/^\/api\/agreements\/[^\/]+\/approve$/) && request.method === "POST") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!requireSuperAdmin(response, session)) return;
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
      if (!session && agreement.status !== "approved") {
        send(response, 403, "Agreement not approved yet", "text/plain; charset=utf-8");
        return;
      }
      const pdfBuffer = await generateAgreementPdf(agreement);
      response.setHeader("Content-Disposition", `attachment; filename="bisfly-agreement-${id}.pdf"`);
      send(response, 200, pdfBuffer, "application/pdf");
      return;
    }

    // Regular Leads Endpoints
    if (parsedUrl.pathname === "/api/leads" && request.method === "POST") {
      const body = await readBody(request);
      const normalized = normalizeCustomerFields(body);
      const leads = readLeads();
      leads.unshift({ ...normalized, id: Date.now(), createdAt: new Date().toISOString() });
      writeLeads(leads);
      send(response, 201, { ok: true });
      if (normalized.email) {
        const lead = leads[0];
        const html = `<p>Dear ${lead.name || lead.fullName || 'Customer'},</p><p>Thank you for contacting BisFly Limited. We received your request and will follow up soon.</p><p>Reference ID: ${lead.id}</p><p>Best regards,<br/>BisFly Limited</p>`;
        notifySubmission(normalized.email, 'BisFly Limited: We received your request', html, 'BisFly Limited: New customer request', `<p>A new customer request was submitted.</p><p><strong>Name:</strong> ${lead.name || lead.fullName || 'Customer'}</p><p><strong>Email:</strong> ${normalized.email}</p><p><strong>Phone:</strong> ${normalized.phone || 'Not provided'}</p><p><strong>Reference ID:</strong> ${lead.id}</p>`);
      }
      return;
    }

    if (parsedUrl.pathname === "/api/leads" && request.method === "DELETE") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!requireSuperAdmin(response, session)) return;
      writeLeads([]);
      send(response, 200, { ok: true });
      return;
    }

    // File Download Endpoint
    if (parsedUrl.pathname.startsWith("/uploads/")) {
      const fileName = path.basename(parsedUrl.pathname);
      const isPublicPackageImage = readPackages().some(pkg => pkg.imageFile === fileName);
      if (!isPublicPackageImage) {
        const token = request.headers.authorization?.replace("Bearer ", "");
        const session = validateSession(token);
        if (!session) {
          send(response, 401, "Unauthorized", "text/plain; charset=utf-8");
          return;
        }
        const adminDocument = readAdminDocuments().find(document => document.storedName === fileName);
        if (adminDocument && !isMasterAdminSession(session) && adminDocument.uploadedById !== session.userId && !(adminDocument.allowedUserIds || []).includes(session.userId)) {
          send(response, 403, "You do not have access to this document", "text/plain; charset=utf-8");
          return;
        }
      }
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
        const extension = path.extname(fileName).toLowerCase();
        const contentType = mimeTypes[extension] || ({
          ".pdf": "application/pdf",
          ".doc": "application/msword",
          ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ".xls": "application/vnd.ms-excel",
          ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ".csv": "text/csv; charset=utf-8"
        })[extension] || "application/octet-stream";
        response.setHeader("Content-Disposition", `${isPublicPackageImage ? "inline" : "attachment"}; filename="${fileName}"`);
        send(response, 200, data, contentType);
      });
      return;
    }

    // ==================== NEW FEATURES: SEARCH & FILTER ====================
    
    // Search in leads
    if (parsedUrl.pathname === "/api/leads/search" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      if (!validateSession(token)) return send(response, 401, { ok: false, message: "Unauthorized" });
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
      const token = request.headers.authorization?.replace("Bearer ", "");
      if (!validateSession(token)) return send(response, 401, { ok: false, message: "Unauthorized" });
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

    if (parsedUrl.pathname === "/api/admin/documents" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const documents = readAdminDocuments()
        .filter(document => isMasterAdminSession(session) || document.uploadedById === session.userId || (document.allowedUserIds || []).includes(session.userId))
        .sort((first, second) => new Date(second.uploadedAt) - new Date(first.uploadedAt));
      send(response, 200, documents);
      return;
    }

    if (parsedUrl.pathname === "/api/admin/document-access-users" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      if (!validateSession(token)) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      send(response, 200, readAdminUsers().filter(user => user.active !== false).map(sanitizeUser));
      return;
    }

    if (parsedUrl.pathname === "/api/admin/documents" && request.method === "POST") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }

      const parsed = await readBody(request);
      const fields = parsed.fields || {};
      const files = parsed.files || {};
      const file = files.document;
      if (!file?.data?.length) {
        send(response, 400, { ok: false, message: "Choose a document to upload." });
        return;
      }
      if (file.data.length > 15_000_000) {
        send(response, 413, { ok: false, message: "Documents must be smaller than 15 MB." });
        return;
      }
      const extension = path.extname(file.filename).toLowerCase();
      const allowedExtensions = new Set([".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".xls", ".xlsx", ".csv"]);
      if (!allowedExtensions.has(extension)) {
        send(response, 400, { ok: false, message: "Allowed files: PDF, JPG, PNG, DOC/DOCX, XLS/XLSX, or CSV." });
        return;
      }
      const signature = file.data.subarray(0, 8);
      const validSignature = extension === ".pdf" ? signature.subarray(0, 5).toString("ascii") === "%PDF-"
        : [".jpg", ".jpeg"].includes(extension) ? signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
          : extension === ".png" ? signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : [".docx", ".xlsx"].includes(extension) ? signature[0] === 0x50 && signature[1] === 0x4b
              : true;
      if (!validSignature) {
        send(response, 400, { ok: false, message: "File contents do not match the selected document type." });
        return;
      }

      let allowedUserIds;
      try {
        const rawAllowedUsers = JSON.parse(String(fields.allowedUserIds || "[]"));
        if (!Array.isArray(rawAllowedUsers)) throw new Error("Expected a list of users.");
        const activeUsers = readAdminUsers().filter(user => user.active !== false);
        const activeIds = new Set(activeUsers.map(user => Number(user.id)));
        allowedUserIds = [...new Set(rawAllowedUsers.map(Number))].filter(id => Number.isSafeInteger(id) && activeIds.has(id));
        if (allowedUserIds.length !== new Set(rawAllowedUsers.map(Number)).size) throw new Error("One or more selected users are not active.");
        if (allowedUserIds.length === 0) throw new Error("Select at least one user who should have access to this document.");
      } catch (error) {
        send(response, 400, { ok: false, message: error.message || "Choose valid active accounts for document access." });
        return;
      }

      const storedName = `admin-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${extension}`;
      fs.writeFileSync(path.join(uploadsDir, storedName), file.data, { flag: "wx" });
      const document = {
        id: crypto.randomBytes(12).toString("hex"),
        originalName: path.basename(file.filename).slice(0, 180),
        storedName,
        category: String(fields.category || "General").trim().slice(0, 60) || "General",
        description: String(fields.description || "").trim().slice(0, 300),
        uploadedBy: session.username,
        uploadedById: Number(session.userId),
        allowedUserIds,
        allowedUsers: allowedUserIds.map(id => {
          const user = readAdminUsers().find(account => Number(account.id) === id);
          return { id, username: user?.username || "Unknown" };
        }),
        uploadedAt: new Date().toISOString(),
        size: file.data.length,
        contentType: file.contentType || "application/octet-stream"
      };
      const documents = readAdminDocuments();
      documents.unshift(document);
      writeAdminDocuments(documents);
      logActivity("admin_document_uploaded", { name: document.originalName, category: document.category }, session.username);
      send(response, 201, { ok: true, document });
      return;
    }

    if (parsedUrl.pathname === "/api/bank-inflows" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      if (!isMasterAdminSession(session) && !isManagerSession(session)) {
        send(response, 403, { ok: false, message: "Manager or super-admin access required." });
        return;
      }
      const requestedBatch = parsedUrl.searchParams.get("batch") || "";
      const allRecords = readInflows();
      const batchIds = [...new Set(allRecords.map(record => record.batchId).filter(Boolean))];
      const selectedBatch = requestedBatch || batchIds[batchIds.length - 1] || "";
      const records = allRecords
        .filter(record => !selectedBatch || record.batchId === selectedBatch)
        .sort((first, second) => new Date(second.date) - new Date(first.date));
      const inflows = records.filter(record => (record.type || (Number(record.signedAmount ?? record.amount) >= 0 ? "inflow" : "outflow")) === "inflow");
      const outflows = records.filter(record => (record.type || (Number(record.signedAmount ?? record.amount) >= 0 ? "inflow" : "outflow")) === "outflow");
      const totalInflows = inflows.reduce((sum, record) => sum + Number(record.amount || 0), 0);
      const totalOutflows = outflows.reduce((sum, record) => sum + Number(record.amount || 0), 0);
      const batchRecords = selectedBatch
        ? allRecords.filter(record => record.batchId === selectedBatch).sort((first, second) => new Date(first.date) - new Date(second.date))
        : [];
      const balances = batchRecords.filter(record => record.balance !== null && record.balance !== undefined && Number.isFinite(Number(record.balance)));
      const openingBalance = balances.length
        ? Number(balances[0].balance) - Number(balances[0].signedAmount ?? (balances[0].type === "outflow" ? -balances[0].amount : balances[0].amount))
        : null;
      const closingBalance = balances.length ? Number(balances[balances.length - 1].balance) : null;
      const batches = batchIds.map(batchId => {
        const firstRecord = allRecords.find(record => record.batchId === batchId);
        return { id: batchId, sourceFile: firstRecord?.sourceFile || "Statement", importedAt: firstRecord?.importedAt || "" };
      });
      if (selectedBatch && !batches.some(batch => batch.id === selectedBatch)) {
        send(response, 404, { ok: false, message: "Statement batch not found." });
        return;
      }
      send(response, 200, {
        records,
        batches,
        selectedBatch,
        summary: {
          totalInflows,
          totalOutflows,
          net: totalInflows - totalOutflows,
          openingBalance,
          closingBalance,
          count: records.length,
          unmatchedCount: records.filter(record => record.status === "unmatched").length,
          matchedCount: records.filter(record => record.status === "matched").length
        }
      });
      return;
    }

    if (parsedUrl.pathname === "/api/bank-inflows/import" && request.method === "POST") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      if (!isMasterAdminSession(session) && !isManagerSession(session)) {
        send(response, 403, { ok: false, message: "Manager or super-admin access required." });
        return;
      }

      const contentType = request.headers["content-type"] || "";
      const isCsv = contentType.includes("text/csv");
      const isPdf = contentType.includes("application/pdf");
      if (!isCsv && !isPdf) {
        send(response, 415, { ok: false, message: "Upload a PDF or CSV bank statement." });
        return;
      }
      const chunks = [];
      let byteLength = 0;
      for await (const chunk of request) {
        byteLength += chunk.length;
        if (byteLength > 5_000_000) {
          send(response, 413, { ok: false, message: "Statement files must be smaller than 5 MB." });
          return;
        }
        chunks.push(chunk);
      }

      try {
        const filename = String(request.headers["x-file-name"] || (isPdf ? "fidelity-statement.pdf" : "fidelity-statement.csv"));
        const fileBuffer = Buffer.concat(chunks);
        const result = isPdf
          ? await parseBankStatementPdf(fileBuffer, filename)
          : parseBankStatementCsv(fileBuffer.toString("utf8"), filename);
        const records = readInflows();
        writeInflows([...records, ...result.accepted]);
        logActivity("bank_inflows_imported", {
          filename: filename.slice(0, 120),
          format: isPdf ? "pdf" : "csv",
          imported: result.accepted.length,
          skipped: result.skipped,
          duplicates: result.duplicates
        }, session.username);
        send(response, 200, {
          ok: true,
          imported: result.accepted.length,
          skipped: result.skipped,
          duplicates: result.duplicates,
          batchId: result.accepted[0]?.batchId || null,
          openingBalance: result.openingBalance,
          closingBalance: result.closingBalance
        });
      } catch (error) {
        send(response, 400, { ok: false, message: error.message || "Unable to process this CSV file." });
      }
      return;
    }

    if (parsedUrl.pathname === "/api/bank-inflows/export" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!session) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      if (!isMasterAdminSession(session) && !isManagerSession(session)) {
        send(response, 403, { ok: false, message: "Manager or super-admin access required." });
        return;
      }
      const batchId = parsedUrl.searchParams.get("batch") || "";
      const records = readInflows()
        .filter(record => !batchId || record.batchId === batchId)
        .sort((first, second) => new Date(first.date) - new Date(second.date));
      if (!records.length) {
        send(response, 404, { ok: false, message: "No transactions are available to download." });
        return;
      }
      const escapeCsv = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
      const lines = ["Date,Type,Inflow (NGN),Outflow (NGN),Balance (NGN),Reference,Description,Client Match,Status,Source File"];
      records.forEach(record => {
        const isOutflow = (record.type || (Number(record.signedAmount ?? record.amount) < 0 ? "outflow" : "inflow")) === "outflow";
        lines.push([
          new Date(record.date).toISOString(),
          isOutflow ? "Outflow" : "Inflow",
          isOutflow ? "" : Number(record.amount || 0).toFixed(2),
          isOutflow ? Number(record.amount || 0).toFixed(2) : "",
          record.balance ?? "",
          record.reference,
          record.description,
          record.matchedClient,
          record.status,
          record.sourceFile
        ].map(escapeCsv).join(","));
      });
      const batchKey = batchId || records[0].batchId || "all-statements";
      response.setHeader("Content-Disposition", `attachment; filename="fidelity-account-${batchKey}.csv"`);
      send(response, 200, `\uFEFF${lines.join("\r\n")}`, "text/csv; charset=utf-8");
      return;
    }

    if (parsedUrl.pathname.match(/^\/api\/bank-inflows\/[^/]+$/) && request.method === "PATCH") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!requireSuperAdmin(response, session)) return;
      const id = decodeURIComponent(parsedUrl.pathname.split("/").pop());
      const body = await readBody(request);
      const status = String(body.status || "");
      if (!["matched", "unmatched"].includes(status)) {
        send(response, 400, { ok: false, message: "Status must be matched or unmatched." });
        return;
      }
      const records = readInflows();
      const record = records.find(item => item.id === id);
      if (!record) {
        send(response, 404, { ok: false, message: "Transaction not found." });
        return;
      }
      record.status = status;
      record.matchedClient = status === "matched" ? String(body.matchedClient || "").trim().slice(0, 160) : "";
      record.updatedAt = new Date().toISOString();
      writeInflows(records);
      logActivity("bank_inflow_reconciled", { id, status }, session.username);
      send(response, 200, { ok: true, record });
      return;
    }

    // Export leads to PDF table
    if (parsedUrl.pathname === "/api/leads/export" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      if (!validateSession(token)) {
        send(response, 401, { ok: false, message: "Unauthorized" });
        return;
      }
      const leads = readLeads();
      const pdfBuffer = await generateTablePdf("BisFly Limited Leads Export", leads);
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
      const pdfBuffer = await generateTablePdf("BisFly Limited Insurance Applications Export", insurance);
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
      const pdfBuffer = await generateTablePdf("BisFly Limited Agreements Export", agreements);
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
      const pdfBuffer = await generateTablePdf("BisFly Limited Passport Requests Export", passports);
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
      const pdfBuffer = await generateTablePdf("BisFly Limited Partnerships Export", partnerships);
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
      const pdfBuffer = await generateTablePdf("BisFly Limited Packages Export", packages);
      response.setHeader("Content-Disposition", 'attachment; filename="packages-' + new Date().toISOString().split("T")[0] + '.pdf"');
      send(response, 200, pdfBuffer, "application/pdf");
      return;
    }

    // ==================== ANALYTICS & DASHBOARD ====================

    // Get analytics/statistics
    if (parsedUrl.pathname === "/api/analytics" && request.method === "GET") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const session = validateSession(token);
      if (!requireSuperAdmin(response, session)) return;
      
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
      if (!requireSuperAdmin(response, session)) return;
      
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
      if (!requireSuperAdmin(response, session)) return;

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
  const receiptsWithInterruptedEmail = readJsonArray(receiptsFile);
  let recoveredReceiptEmails = false;
  for (const receipt of receiptsWithInterruptedEmail) {
    if (receipt.emailStatus !== "sending") continue;
    receipt.emailStatus = "failed";
    receipt.emailError = "Email delivery was interrupted when the server stopped. Retry email to try again.";
    receipt.emailSentAt = null;
    recoveredReceiptEmails = true;
  }
  if (recoveredReceiptEmails) writeJsonArray(receiptsFile, receiptsWithInterruptedEmail);
  initializeAdmin();
initializeAdminUsers();
initializeEmailTransport().catch(err => console.error("Email init error:", err));

// Ensure packages file exists
if (!fs.existsSync(packagesFile)) writePackages([]);
if (!fs.existsSync(passportFile)) writePassports([]);
if (!fs.existsSync(partnershipFile)) writePartnerships([]);
if (!fs.existsSync(adminUsersFile)) writeAdminUsers([]);

server.listen(port, host, () => {
  console.log(`BisFly Limited website running at http://${host}:${port}`);
  console.log(`Admin portal available at http://${host}:${port}/admin`);
  console.log(`Admin dashboard available at http://${host}:${port}/admin-dashboard`);
  console.log(`Default Admin Username: admin | Default Password: BisFly@2026`);
});
