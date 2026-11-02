# BisFly Limited - API Documentation

## Overview
Complete REST API reference for the BisFly Limited server running on port 8082.

---

## 📋 **TABLE OF CONTENTS**

1. [Authentication Endpoints](#authentication)
2. [Admin Analytics](#analytics)
3. [Search Endpoints](#search)
4. [Filter Endpoints](#filter)
5. [Export Endpoints](#export)
6. [CRUD Operations](#crud)
7. [User Management](#users)
8. [Activity Logging](#activity)
9. [Payment Receipts](#receipts)
10. [Error Handling](#errors)

---

## 🔐 **AUTHENTICATION ENDPOINTS** {#authentication}

### Admin Login
**Endpoint:** `POST /api/admin/login`

**Description:** Authenticates admin user and returns session token

**Request Body:**
```json
{
  "username": "admin",
  "password": "BisFly@2026"
}
```

**Success Response (200):**
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "username": "admin",
  "role": "super-admin",
  "message": "Login successful"
}
```

**Error Response (401):**
```json
{
  "ok": false,
  "message": "Invalid credentials"
}
```

**Token Usage:** Include in all authenticated requests:
```
Authorization: Bearer <token>
```

**Default Credentials:**
- Username: `admin`
- Password: `BisFly@2026`

---

### Admin Logout
**Endpoint:** `POST /api/admin/logout`

**Description:** Invalidates current session

**Headers Required:**
```
Authorization: Bearer <token>
```

**Success Response (200):**
```json
{
  "ok": true,
  "message": "Logout successful"
}
```

---

### Change Password
**Endpoint:** `POST /api/admin/change-password`

**Description:** Changes logged-in user's password

**Headers Required:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "oldPassword": "BisFly@2026",
  "newPassword": "NewPassword123",
  "confirmPassword": "NewPassword123"
}
```

**Success Response (200):**
```json
{
  "ok": true,
  "message": "Password changed successfully"
}
```

**Validation Rules:**
- `oldPassword` must match current password
- `newPassword` must be at least 8 characters
- `newPassword` must equal `confirmPassword`

---

## 📊 **ANALYTICS ENDPOINTS** {#analytics}

### Get Analytics Dashboard
**Endpoint:** `GET /api/analytics`

**Description:** Returns statistics for admin dashboard

**Headers Required:**
```
Authorization: Bearer <token>
```

**Success Response (200):**
```json
{
  "leads": {
    "total": 5,
    "thisMonth": 2
  },
  "insurance": {
    "total": 3,
    "pending": 2,
    "approved": 1
  },
  "agreements": {
    "total": 4,
    "pending": 1,
    "approved": 3
  },
  "passports": {
    "total": 2,
    "pending": 1,
    "approved": 1
  },
  "packages": {
    "total": 0
  },
  "generatedAt": "2026-08-14T10:30:00.000Z"
}
```

**Cache:** Generated fresh on each request

---

## 🔍 **SEARCH ENDPOINTS** {#search}

### Search Leads
**Endpoint:** `GET /api/leads/search?q=keyword`

**Description:** Search leads by name, email, or phone

**Query Parameters:**
- `q` (required): Search keyword

**Example:**
```
GET /api/leads/search?q=john
```

**Success Response (200):**
```json
[
  {
    "fullName": "John Doe",
    "email": "john@example.com",
    "phone": "+234 7035193203",
    "destination": "Canada",
    "service": "Study Visa",
    "date": "2026-08-14T10:30:00.000Z"
  }
]
```

**Search Fields:** `fullName`, `email`, `phone`, `destination`, `service`

---

### Search Insurance Applications
**Endpoint:** `GET /api/insurance/search?q=keyword`

**Query Parameters:**
- `q` (required): Search keyword

**Search Fields:** `applicantName`, `applicantEmail`, `applicantPhone`, `insuranceType`

---

### Search Agreements
**Endpoint:** `GET /api/agreements/search?q=keyword`

**Query Parameters:**
- `q` (required): Search keyword

**Search Fields:** `customerName`, `customerEmail`, `customerPhone`, `type`

---

## 🔎 **FILTER ENDPOINTS** {#filter}

### Filter Insurance by Status
**Endpoint:** `GET /api/insurance/filter?status=pending`

**Description:** Filter insurance applications by approval status

**Query Parameters:**
- `status` (required): `"pending"` or `"approved"`

**Success Response (200):**
```json
[
  {
    "id": "app-123",
    "applicantName": "Jane Smith",
    "insuranceType": "Travel",
    "status": "pending",
    "date": "2026-08-14T10:30:00.000Z"
  }
]
```

---

### Filter Agreements by Status
**Endpoint:** `GET /api/agreements/filter?status=approved`

**Query Parameters:**
- `status` (required): `"pending"` or `"approved"`

---

### Filter Passports by Status
**Endpoint:** `GET /api/passports/filter?status=pending`

**Query Parameters:**
- `status` (required): `"pending"` or `"approved"`

---

### Filter by Date Range
**Endpoint:** `GET /api/leads/filter?from=2026-08-01&to=2026-08-14`

**Query Parameters:**
- `from` (required): Start date (ISO 8601 format)
- `to` (required): End date (ISO 8601 format)

---

## 📥 **EXPORT ENDPOINTS** {#export}

### Export Leads to CSV
**Endpoint:** `GET /api/leads/export`

**Description:** Export all leads as CSV file

**Response Headers:**
```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="leads-2026-08-14.csv"
```

**CSV Format:**
```csv
Full Name,Email,Phone,Destination,Service,Date
John Doe,john@example.com,+234 7035193203,Canada,Study Visa,2026-08-14T10:30:00Z
...
```

---

### Export Insurance Applications to CSV
**Endpoint:** `GET /api/insurance/export`

**CSV Columns:** Applicant Name, Email, Phone, Insurance Type, Status, Premium Amount, Date

---

### Export Agreements to CSV
**Endpoint:** `GET /api/agreements/export`

**CSV Columns:** Customer Name, Email, Phone, Agreement Type, Status, Amount, Approved Date

---

### Export Passports to CSV
**Endpoint:** `GET /api/passports/export`

**CSV Columns:** Applicant Name, Email, Phone, Destination, Status, Application Date

---

## 🔄 **CRUD OPERATIONS** {#crud}

### Leads

#### Create Lead
**Endpoint:** `POST /api/leads`

**Description:** Submit new lead/booking request

**Request Body:**
```json
{
  "fullName": "Aisha Bello",
  "email": "aisha@example.com",
  "phone": "+234 7035193203",
  "destination": "Canada",
  "service": "Study Visa",
  "message": "Interested in study visa program"
}
```

**Success Response (201):**
```json
{
  "ok": true,
  "message": "Lead saved successfully"
}
```

---

#### Get All Leads
**Endpoint:** `GET /api/leads`

**Headers Required:**
```
Authorization: Bearer <token>
```

**Success Response (200):**
```json
[
  {
    "fullName": "Aisha Bello",
    "email": "aisha@example.com",
    "phone": "+234 7035193203",
    "destination": "Canada",
    "service": "Study Visa",
    "date": "2026-08-14T10:30:00.000Z"
  }
]
```

---

### Insurance Applications

#### Create Insurance Application
**Endpoint:** `POST /api/insurance`

**Request Body:**
```json
{
  "applicantName": "Jane Smith",
  "applicantEmail": "jane@example.com",
  "applicantPhone": "+234 8123456789",
  "insuranceType": "Travel",
  "destination": "London",
  "coverage": "Premium",
  "startDate": "2026-09-01"
}
```

---

#### Get All Insurance Applications
**Endpoint:** `GET /api/insurance`

**Headers Required:**
```
Authorization: Bearer <token>
```

---

### Agreements

#### Create Agreement
**Endpoint:** `POST /api/agreements`

**Request Body:**
```json
{
  "customerName": "Robert Johnson",
  "customerEmail": "robert@example.com",
  "customerPhone": "+234 7035193203",
  "type": "Travel Agreement",
  "destination": "Spain",
  "amount": 50000,
  "termsAccepted": true
}
```

---

#### Get All Agreements
**Endpoint:** `GET /api/agreements`

**Headers Required:**
```
Authorization: Bearer <token>
```

---

#### Approve Agreement
**Endpoint:** `PUT /api/agreements/:id`

**Request Body:**
```json
{
  "status": "approved"
}
```

**Success Response (200):**
```json
{
  "ok": true,
  "message": "Agreement approved successfully",
  "pdfPath": "/pdfs/agreement-2026-08-14.pdf"
}
```

**Side Effects:**
- Status changes to `"approved"`
- PDF generated and stored
- Email sent to customer

---

### Packages

#### Create Travel Package
**Endpoint:** `POST /api/packages`

**Headers Required:**
```
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Form Fields:**
- `title` (string): Package name
- `description` (string): Package details
- `imageFile` (file, optional): JPG/PNG image

**Example:**
```bash
curl -X POST http://localhost:8082/api/packages \
  -H "Authorization: Bearer TOKEN" \
  -F "title=Summer Tour" \
  -F "description=Explore Europe" \
  -F "imageFile=@tour.jpg"
```

---

#### Get All Packages
**Endpoint:** `GET /api/packages`

**Success Response (200):**
```json
[
  {
    "title": "Summer Tour to Europe",
    "description": "Explore beautiful European destinations",
    "imageFile": "package-2026-08-14.jpg",
    "createdAt": "2026-08-14T10:30:00.000Z"
  }
]
```

---

#### Delete Package
**Endpoint:** `DELETE /api/packages/:id`

**Headers Required:**
```
Authorization: Bearer <token>
```

**Success Response (200):**
```json
{
  "ok": true,
  "message": "Package deleted successfully"
}
```

---

### Super Admin submitted-record controls

The existing dashboard record tables expose Edit and Delete actions to Super Admins only. These endpoints require a valid Super Admin session and are scoped to one record in an existing dashboard collection; they do not expose raw collection or database access.

**Update a record:** `PATCH /api/admin/records/{collection}/{id}`

The generic update endpoint supports `leads`, `insurance`, `agreements`, `passports`, `partnerships`, `documents`, `disclaimers`, and `expenses`.

```json
{
  "values": {
    "fullName": "Updated client name"
  }
}
```

Only fields already present on that record may be changed. Record IDs, audit fields, ownership fields, and uploaded-file metadata are protected. For documents, update `allowedUserIds` as an array of active user IDs; the server updates the access-list display names as well. Client records use the existing `PATCH /api/admin/clients/{id}` route so the existing Manager/Super Admin restriction on changing `amountPaid` remains enforced.

**Delete a record:** `DELETE /api/admin/records/{collection}/{id}`

Deletion supports all of the collections above plus `clients` and is limited to the specified record. Associated uploaded files are removed only when no remaining record or package references them. Successful edit and delete operations are written to the activity log.

## 👥 **USER MANAGEMENT** {#users}

All dashboard feature grants and revocations are controlled by a Super Admin using the Users tab. Super Admins can grant any dashboard feature to a non-Super-Admin user regardless of their assigned staff role. The `users` feature is never grantable; user management remains Super Admin-only.

**Update dashboard access:** `PUT /api/admin/users/{id}`

```json
{
  "featureAccess": ["leads", "clients", "cash-inflows"]
}
```

Send the complete set of features the user should retain. Use an empty array to revoke all dashboard features. Updated access is enforced by both dashboard navigation and the corresponding API endpoints. Granting access does not override separate restrictions such as changing a client's amount paid, which remains limited to Managers and Super Admins.

### Create Admin User
**Endpoint:** `POST /api/admin/users`

**Headers Required:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "username": "manager1",
  "password": "SecurePass123",
  "role": "admin"
}
```

**Password Requirements:**
- Minimum 8 characters
- Hashed with PBKDF2 (100,000 iterations)

**Success Response (201):**
```json
{
  "ok": true,
  "message": "User created successfully",
  "username": "manager1"
}
```

---

### Get All Users
**Endpoint:** `GET /api/admin/users`

**Headers Required:**
```
Authorization: Bearer <token>
```

**Success Response (200):**
```json
[
  {
    "username": "admin",
    "role": "super-admin",
    "status": "active",
    "createdAt": "2026-01-01T00:00:00.000Z"
  },
  {
    "username": "manager1",
    "role": "admin",
    "status": "active",
    "createdAt": "2026-08-14T10:30:00.000Z"
  }
]
```

---

### Delete User
**Endpoint:** `DELETE /api/admin/users/:username`

**Headers Required:**
```
Authorization: Bearer <token>
```

**Success Response (200):**
```json
{
  "ok": true,
  "message": "User deleted successfully"
}
```

**Restrictions:**
- Cannot delete yourself
- Super-admin can only delete other admins

---

## 📋 **ACTIVITY LOGGING** {#activity}

### Get Activity Log
**Endpoint:** `GET /api/admin/activity-log?limit=50`

**Headers Required:**
```
Authorization: Bearer <token>
```

**Query Parameters:**
- `limit` (optional): Maximum entries to return (default: 50, max: 100)

**Success Response (200):**
```json
[
  {
    "timestamp": "2026-08-14T10:30:00.000Z",
    "action": "admin_login",
    "user": "admin",
    "details": {
      "username": "admin",
      "role": "super-admin"
    }
  },
  {
    "timestamp": "2026-08-14T10:31:00.000Z",
    "action": "lead_created",
    "user": "system",
    "details": {
      "leadId": "lead-123",
      "name": "John Doe"
    }
  }
]
```

**Logged Actions:**
- `admin_login` - User login
- `admin_logout` - User logout
- `password_changed` - Password change
- `user_created` - New user created
- `user_deleted` - User deleted
- `package_created` - Package added
- `package_deleted` - Package removed
- `agreement_approved` - Agreement approved
- `lead_created` - New lead submitted

---

## 🧾 **CLIENT, DISCLAIMER, AND FINANCE OPERATIONS**

All endpoints in this section require a valid admin bearer token and an Admin, Manager, or Super Admin role unless noted. Reports are generated as PDF files.

### Client records
- `GET /api/admin/clients` — List client records.
- `POST /api/admin/clients` — Create a client using multipart form data. Fields include `fullName`, `gender`, `dateOfBirth`, `address`, `phone`, `email`, `packageType`, `paymentMethod` (`full` or `installment`), `paymentSchedule` (JSON array of dated `{amount, paymentDate}` entries), `initialDepositComplete`, `balanceAfterApproval`, and `status` (`ongoing`, `pending`, `submitted`, `refused`, or `approved`). Full-payment records contain one payment entry; installment records require two or three. Optional signed files are `signedDisclaimer` and `signedAgreement` (PDF/JPG/PNG). When `status` is `submitted`, the request must also include `visaApplicationForm`, `submittedSupportingDocument1`, and `submittedSupportingDocument2` (PDF/JPG/PNG, each under 5 MB). Creation automatically initializes a receipt: incomplete installment deposits remain in `pending_payment`, while completed deposits enter `pending` Super Admin approval.
- `PATCH /api/admin/clients/:id` — Update client details or progress. Only Managers and Super Admins can change `amountPaid` on full-payment records; installment totals are fixed to the saved schedule. Any admin may explicitly set `initialDepositComplete: true` on an installment record, which moves its linked pending receipt to Super Admin approval. A client cannot be set to `submitted` until all three submitted documents are attached.
- `POST /api/admin/clients/:id/submitted-documents` — Upload one filled visa application plus two supporting documents (PDF/JPG/PNG, each under 5 MB). On success, the record progress changes to `submitted`. The files appear as authenticated download links in the client dashboard and are included in Super Admin record-deletion cleanup.
- `GET /api/admin/clients/export` — Download the client information report PDF.

### Client disclaimers
- `POST /api/admin/disclaimers/template` — Generate a signature-ready PDF from JSON fields `fullName`, `gender`, `phone`, `address`, `email`, and optional `secondPersonRelationship` / `secondPersonName`.
- `GET /api/admin/disclaimers` — List saved signed disclaimers.
- `POST /api/admin/disclaimers` — Save client details and the signed disclaimer using multipart form data. Required file field: `signedDisclaimer` (valid PDF/JPG/PNG). The optional relationship must be Brother, Sister, Wife, Husband, or Friend.
- `GET /api/admin/disclaimers/:id/template` — Download a saved disclaimer PDF.

### Cash inflow report
- `GET /api/admin/cash-inflows?from=YYYY-MM-DD&to=YYYY-MM-DD` — Return client payment rows and the total amount received for the optional payment-date range.
- `GET /api/admin/cash-inflows/report?from=YYYY-MM-DD&to=YYYY-MM-DD` — Download the matching PDF report, including client name, paid amount, package, phone number, and total.

### Expenses
- `GET /api/admin/expenses` — List recorded expenses.
- `POST /api/admin/expenses` — Record an expense using JSON fields `purpose`, `amount`, and `expenseDate`. The server records the authenticated admin’s username.
- `GET /api/admin/expenses/report?from=YYYY-MM-DD&to=YYYY-MM-DD` — Download the expense PDF report for the optional date range.

The agreement PDF includes the BisFly logo, payment and visa-authority terms, official corporate payment details, and signature spaces.

---

## 🧾 **PAYMENT RECEIPTS** {#receipts}

Receipt listing and downloads require an authenticated admin session with the **Payment Receipts** dashboard feature. Super Admins can grant or revoke the feature for staff accounts. A receipt is initialized automatically by `POST /api/admin/clients`; it cannot be created or emailed through a separate manual form.

### List receipts
**Endpoint:** `GET /api/admin/receipts`

Returns saved receipts, including their email-delivery status.

### Approve and send a receipt
**Endpoint:** `POST /api/admin/receipts/{receiptId}/approve`

**Super Admin only.** Approving changes the receipt to approved, sends the branded PDF to the client email captured on the client record, and makes the PDF downloadable. Installment receipts cannot be approved until an admin explicitly confirms that the full initial deposit is complete. The receipt includes each payment amount and date, the total received, and the remaining balance after visa approval. Email delivery errors are returned explicitly; an approved receipt remains downloadable if email delivery fails. Use the retry endpoint after resolving the email issue.

### Download receipt PDF
**Endpoint:** `GET /api/admin/receipts/{receiptId}/pdf`

Returns a BisFly Limited PDF receipt with the client, package, each dated payment, total paid, remaining balance, reference, generated date, company address, payment account, logo, signature, stamp, and watermark. Returns `403 Forbidden` until the receipt is approved.

### Retry email delivery
**Endpoint:** `POST /api/admin/receipts/{receiptId}/send`

Retries sending the PDF to the client email saved on an approved receipt. The response reports whether delivery succeeded; failed delivery does not remove or disable the downloadable PDF. Receipts awaiting approval cannot be emailed.

---

## ⚠️ **ERROR HANDLING** {#errors}

### Standard Error Responses

**400 - Bad Request:**
```json
{
  "ok": false,
  "message": "Invalid request parameters"
}
```

**401 - Unauthorized:**
```json
{
  "ok": false,
  "message": "Authentication required. Please login first."
}
```

**403 - Forbidden:**
```json
{
  "ok": false,
  "message": "Access denied. Insufficient permissions."
}
```

**404 - Not Found:**
```json
{
  "ok": false,
  "message": "Resource not found"
}
```

**429 - Rate Limited:**
```json
{
  "ok": false,
  "message": "Too many requests. Please try again later."
}
```

**500 - Server Error:**
```json
{
  "ok": false,
  "message": "Internal server error. Please try again."
}
```

---

## 🔒 **SECURITY FEATURES**

### Rate Limiting
- **Limit**: 100 requests per IP per 60 seconds
- **Response**: 429 status when exceeded
- **Auto-cleanup**: Every 60 seconds

### Session Management
- **Duration**: 24 hours per token
- **Auto-cleanup**: Every 5 minutes
- **Storage**: Secure session files

### Password Security
- **Algorithm**: PBKDF2 with SHA-256
- **Iterations**: 100,000
- **Salt**: 16-byte random per password
- **Legacy**: Old SHA256 passwords auto-upgrade on login

### Input Validation
- Email format validation
- Phone number format validation
- Date range validation
- File upload type/size validation

---

## 📚 **EXAMPLE WORKFLOWS**

### Complete Login & Export Workflow
```bash
# 1. Login
TOKEN=$(curl -X POST http://localhost:8082/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"BisFly@2026"}' \
  | jq -r '.token')

# 2. Get analytics
curl -X GET http://localhost:8082/api/analytics \
  -H "Authorization: Bearer $TOKEN"

# 3. Export leads
curl -X GET http://localhost:8082/api/leads/export \
  -H "Authorization: Bearer $TOKEN" \
  > leads.csv

# 4. Get activity log
curl -X GET http://localhost:8082/api/admin/activity-log?limit=10 \
  -H "Authorization: Bearer $TOKEN"

# 5. Logout
curl -X POST http://localhost:8082/api/admin/logout \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🔗 **BASE URL**
```
http://localhost:8082
```

---

## 📞 **SUPPORT**
For API issues or questions:
- Email: bisflytravels@gmail.com
- Contact: +234 705 193 5203

---

**API Version**: 2.0  
**Last Updated**: 2026-08-14  
**Status**: ✅ Production Ready
