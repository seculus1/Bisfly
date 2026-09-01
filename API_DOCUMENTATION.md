# BisFly Travel Platform - API Documentation

## Overview
Complete REST API reference for the BisFly Travel Platform server running on port 8082.

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
9. [Error Handling](#errors)

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

## 👥 **USER MANAGEMENT** {#users}

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
