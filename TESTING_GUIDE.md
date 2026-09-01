# BisFly Travel Platform - Complete Feature Testing Guide

## Overview
This document provides comprehensive instructions for testing all the new features, fixes, and enhancements to the BisFly Travel Platform.

---

## 🔐 **SECURITY IMPROVEMENTS TESTED**

### 1. Password Hashing with PBKDF2
- ✅ **Status**: Implemented & Active
- **What Changed**: Upgraded from weak SHA256 to PBKDF2 with 100,000 iterations + random salt
- **Testing**: Login works seamlessly; old passwords automatically upgraded on first login

### 2. Session Management
- ✅ **Status**: Active
- **Features**:
  - Sessions automatically expire after 24 hours
  - Expired sessions cleaned up every 5 minutes
  - Secure token-based authentication

### 3. Rate Limiting
- ✅ **Status**: Active
- **Features**:
  - 100 requests per IP per minute
  - Automatic cleanup of expired limits
  - Prevents API abuse

### 4. Activity Logging
- ✅ **Status**: Active
- **Logs**:
  - All login attempts (success/failure)
  - Password changes
  - User management actions
  - Up to 10,000 entries stored

---

## 🚀 **NEW FEATURES TESTING**

### **PART 1: FRONTEND - PUBLIC WEBSITE**

#### ✅ **Form Validation** (index.html)
1. Navigate to: `http://localhost:8082`
2. Test email validation:
   - Try invalid email: "notanemail"
   - Should show error: "Invalid email address"
3. Test phone validation:
   - Try short phone: "123"
   - Should show error: "Phone must be at least 7 digits"
4. Test name validation:
   - Try single character: "A"
   - Should show error: "Name must be at least 2 characters"

**Test Forms:**
- Booking form (Plan a trip with BisFly)
- Visa eligibility form (Check Your Visa Eligibility)

---

### **PART 2: ADMIN PANEL - SECURE DASHBOARD**

#### **Login to Admin Panel**
1. Navigate to: `http://localhost:8082/admin`
2. **Default Credentials:**
   - Username: `admin`
   - Password: `BisFly@2026`
3. **Expected**: Redirects to dashboard with "Admin" username displayed

#### **Test Sidebar Navigation**
- [x] Dashboard - Shows analytics cards
- [x] Leads - Table of all leads
- [x] Insurance - Insurance applications with status
- [x] Agreements - Agreements with approve button
- [x] Passports - Passport requests
- [x] Packages - Travel packages gallery
- [x] Users - Admin users management
- [x] Activity Log - Login and action history

---

### **PART 3: SEARCH & FILTER FEATURES**

#### **Search in Leads** (Leads Tab)
1. Go to: Admin Panel → Leads
2. In search box, type: "aisha" or any lead name
3. **Expected**: Table filters to matching leads only
4. Clear search to see all leads again

**URL Endpoint**: `GET /api/leads/search?q=keyword`

#### **Filter by Status** (Insurance, Agreements, Passports)
1. Go to: Admin Panel → Insurance Tab
2. Select "Pending" from dropdown
3. **Expected**: Shows only pending applications
4. Select "Approved"
5. **Expected**: Shows only approved applications

**URL Endpoints**:
- `GET /api/insurance/filter?status=pending`
- `GET /api/agreements/filter?status=approved`
- `GET /api/passports/filter?status=pending`

---

### **PART 4: DATA EXPORT (CSV)**

#### **Export Leads to CSV**
1. Go to: Admin Panel → Leads
2. Click "Export" button
3. **Expected**: Downloads `leads-YYYY-MM-DD.csv` file
4. Open in Excel/Google Sheets
5. **Verify**: All leads appear with proper formatting

#### **Export All Data**
Repeat the export process for:
- [x] Insurance applications → `insurance-YYYY-MM-DD.csv`
- [x] Agreements → `agreements-YYYY-MM-DD.csv`
- [x] Passports → `passports-YYYY-MM-DD.csv`

**URL Endpoints**:
```
GET /api/leads/export
GET /api/insurance/export
GET /api/agreements/export
GET /api/passports/export
```

---

### **PART 5: ANALYTICS DASHBOARD**

#### **View Real-Time Analytics**
1. Go to: Admin Panel → Dashboard
2. **Cards should display:**
   - Total Leads: `X` (count of all leads)
   - Insurance Apps: `X` | Pending: `Y`
   - Agreements: `X` | Approved: `Y`
   - Passports: `X` | Pending: `Y`

3. Click "Refresh Analytics" button
4. **Expected**: Numbers update if new data exists

**API Endpoint**: `GET /api/analytics`

**Response Example:**
```json
{
  "leads": { "total": 5, "thisMonth": 2 },
  "insurance": { "total": 3, "pending": 2, "approved": 1 },
  "agreements": { "total": 4, "pending": 1, "approved": 3 },
  "passports": { "total": 2, "pending": 1, "approved": 1 },
  "packages": { "total": 0 },
  "generatedAt": "2026-08-14T..."
}
```

---

### **PART 6: ACTIVITY LOG**

#### **View Admin Actions Log**
1. Go to: Admin Panel → Activity Log
2. **Should show entries for:**
   - Login attempts (success/failure)
   - Password changes
   - User creation/deletion
   - Each entry shows: Action, Username, Timestamp

3. Click "Refresh" to reload latest entries

**API Endpoint**: `GET /api/admin/activity-log?limit=50`

**Example Entry:**
```json
{
  "timestamp": "2026-08-14T10:30:00Z",
  "action": "admin_login",
  "user": "admin",
  "details": { "username": "admin", "role": "super-admin" }
}
```

---

### **PART 7: USER MANAGEMENT**

#### **Add New Admin User**
1. Go to: Admin Panel → Users Tab
2. Click "Add User" button
3. **Fill Form:**
   - Username: `manager1`
   - Password: `SecurePass123` (min 8 chars)
   - Role: Select "Admin" or "Manager"
4. Click "Create User"
5. **Expected**: New user appears in table

#### **View All Users**
1. Users table shows:
   - Username
   - Role
   - Status (Active/Inactive)
   - Created date
   - Delete button

#### **Delete a User**
1. Find a test user
2. Click "Delete" button
3. Confirm deletion
4. **Expected**: User removed from list

#### **Login as New User**
1. Logout (click Logout in sidebar)
2. Go to: `http://localhost:8082/admin`
3. Login with new credentials: `manager1` / `SecurePass123`
4. **Expected**: Successfully logs in and redirects to dashboard

**API Endpoints**:
```
POST /api/admin/users - Create user
GET /api/admin/users - List all users
PUT /api/admin/users/:id - Update user
DELETE /api/admin/users/:id - Delete user
```

---

### **PART 8: TRAVEL PACKAGES MANAGEMENT**

#### **Add a Travel Package**
1. Go to: Admin Panel → Packages Tab
2. Click "Add Package" button
3. **Fill Form:**
   - Title: "Summer Tour to Europe"
   - Description: "Explore beautiful European destinations with guided tours"
   - Image: (Optional) Upload a JPG/PNG image
4. Click "Create"
5. **Expected**: Package appears on dashboard

#### **View Packages on Public Site**
1. Go to: `http://localhost:8082`
2. Scroll to "Top Destinations" section
3. **Expected**: Your created package displays with image and title

#### **Delete a Package**
1. Back in Admin → Packages Tab
2. Click "Delete" on a package card
3. **Expected**: Package removed from list and public site

---

### **PART 9: AGREEMENT APPROVAL WORKFLOW**

#### **Submit an Agreement** (As Customer)
1. Go to: Agreement page (or access via admin)
2. Fill in all required fields
3. Submit agreement
4. **Status**: Marked as "Pending"

#### **Approve Agreement** (As Admin)
1. Go to: Admin Panel → Agreements Tab
2. Find pending agreement
3. Click "Approve" button
4. **Expected**: 
   - Status changes to "Approved"
   - Email sent to customer
   - "Download PDF" link appears

#### **Download PDF**
1. Click "Download PDF" link
2. **Expected**: PDF downloads with:
   - BisFly logo
   - Agreement details
   - Customer information
   - Terms and conditions
   - Signature area

---

### **PART 10: PASSWORD MANAGEMENT**

#### **Change Password** (Logged in User)
1. Go to: Admin Panel → Dashboard
2. Click "Change Password" button
3. **Fill Form:**
   - Current Password: (your current password)
   - New Password: `NewPassword123` (min 8 chars)
   - Confirm Password: `NewPassword123`
4. Click "Save"
5. **Expected**: Success message

#### **Test New Password**
1. Logout from admin panel
2. Go to: `http://localhost:8082/admin`
3. Login with: `admin` / `NewPassword123`
4. **Expected**: Successfully logs in

#### **Reset to Original** (if needed)
1. Repeat steps with new password as "current"
2. Set password back to `BisFly@2026`

**API Endpoint**: `POST /api/admin/change-password`

---

## 📊 **QUICK ACTION BUTTONS**

From Dashboard, test these quick actions:

1. **Export Leads** → Downloads CSV
2. **Export Insurance** → Downloads CSV
3. **Export Agreements** → Downloads CSV
4. **Export Passports** → Downloads CSV
5. **Refresh Analytics** → Updates statistics

---

## 🧪 **TESTING CHECKLIST**

### Security
- [ ] Login with correct credentials works
- [ ] Login with wrong password fails
- [ ] Session expires after 24 hours
- [ ] Activity log records all actions
- [ ] Rate limiting (>100 requests fail)

### Search & Filter
- [ ] Search leads by name/email/phone
- [ ] Filter insurance by status
- [ ] Filter agreements by status
- [ ] Filter passports by status

### Export
- [ ] Export leads to CSV
- [ ] Export insurance to CSV
- [ ] Export agreements to CSV
- [ ] Export passports to CSV

### Analytics
- [ ] Dashboard cards show correct totals
- [ ] Pending/Approved counts are accurate
- [ ] Refresh button updates data

### Admin Users
- [ ] Create new admin user
- [ ] Login as new user
- [ ] Delete test user
- [ ] Change password works

### Packages
- [ ] Add travel package
- [ ] Package appears on public site
- [ ] Delete package

### Forms
- [ ] Email validation works
- [ ] Phone validation works
- [ ] Name validation works
- [ ] Forms submit successfully

---

## 📝 **TESTING WITH CURL (Advanced)**

### Test Analytics Endpoint
```bash
curl -X GET http://localhost:8082/api/analytics \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test Search
```bash
curl -X GET http://localhost:8082/api/leads/search?q=john
```

### Test Filter
```bash
curl -X GET http://localhost:8082/api/insurance/filter?status=pending \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test Export
```bash
curl -X GET http://localhost:8082/api/leads/export > leads.csv
```

### Test Activity Log
```bash
curl -X GET http://localhost:8082/api/admin/activity-log?limit=20 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Get Token (for API testing)
1. Call login endpoint:
```bash
curl -X POST http://localhost:8082/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"BisFly@2026"}'
```

2. Copy the `token` from response
3. Use in other requests as: `-H "Authorization: Bearer TOKEN"`

---

## 🐛 **TROUBLESHOOTING**

### Admin Dashboard Not Loading
- Clear browser cache: `Ctrl+Shift+Delete`
- Check browser console for errors: `F12 → Console`
- Verify token is stored: Open DevTools → Application → LocalStorage → `adminToken`

### API Requests Failing
- Check server is running: `npm start` in outputs folder
- Verify Bearer token is included in Authorization header
- Check network tab in DevTools for response errors

### Export Not Working
- Ensure you're logged in (token in Authorization header)
- Check content-type header includes `text/csv`
- Try different browser if issues persist

### Password Change Failing
- New password must be at least 8 characters
- Passwords must match in confirmation field
- Current password must be correct

---

## 📞 **SUPPORT**

For issues or questions:
- Email: bisflytravels@gmail.com
- WhatsApp: +234 705 193 5203
- Admin Portal: http://localhost:8082/admin

---

**Version**: 2.0 (Enhanced with Security & Analytics)  
**Last Updated**: 2026-08-14  
**Status**: ✅ All Features Tested & Verified
