# 🚀 BisFly Platform - Quick Autostart Guide

## ⚡ Quickest Way to Start (Pick One)

### Option 1️⃣: Double-Click (Easiest)
**In the outputs folder, double-click one of these files:**

1. **`START_SERVER.bat`** ← Recommended for Windows
   - Shows a window with startup info
   - See status messages and errors clearly
   - Auto-closes when server stops

2. **`START_SERVER_HIDDEN.vbs`** ← Runs silently
   - No command window shown
   - Server runs in background
   - Output logged to `server.log`

3. **`START_SERVER.ps1`** ← For PowerShell users
   - Colorful output
   - Requires PowerShell execution policy
   - Shows detailed status

---

## 🎯 Which File to Use?

| Use Case | File | Why |
|----------|------|-----|
| **First time starting** | `START_SERVER.bat` | See what's happening, easy to troubleshoot |
| **Regular daily startup** | `START_SERVER_HIDDEN.vbs` | Clean, no window clutter |
| **Development/testing** | `START_SERVER.bat` | See all messages and errors |
| **PowerShell fan** | `START_SERVER.ps1` | Nice colored output |
| **Autostart on boot** | `AUTOSTART_SETUP.md` | Read full guide for Task Scheduler |

---

## 🎬 Try It Now - 3 Steps

### Step 1: Open File Explorer
- Press `Win + E`
- Navigate to: `C:\Users\USER\Documents\Codex\2026-06-09\files-mentioned-by-the-user-log\outputs`

### Step 2: Double-Click START_SERVER.bat
- **Windows will show a command window**
- **You'll see startup messages**
- **Server starts on port 8082**

### Step 3: Access the Platform
- **Public Website**: http://localhost:8082
- **Admin Panel**: http://localhost:8082/admin
- **Login**: admin / BisFly@2026

**That's it! The server is running! 🎉**

---

## 🔄 Set Up Autostart (Optional)

### If You Want It to Start Automatically When Windows Boots:

1. Read: [AUTOSTART_SETUP.md](AUTOSTART_SETUP.md) (Full guide with 3 methods)

2. Quick method (Task Scheduler):
   ```
   Win + R → taskschd.msc → Create Basic Task
   Trigger: At startup
   Action: START_SERVER.bat or START_SERVER_HIDDEN.vbs
   ```

---

## 📊 Server Running Checklist

After starting the server, verify it's working:

- [ ] Command window shows "Server listening on port 8082"
- [ ] No error messages in the window
- [ ] Can access http://localhost:8082 in browser
- [ ] Admin panel loads at http://localhost:8082/admin
- [ ] Can login with admin / BisFly@2026

**If all checked ✅ - Server is ready to use!**

---

## 🐛 Troubleshooting

### "Node.js is not installed"
- Install from: https://nodejs.org/
- Restart your computer after installation

### "port 8082 already in use"
- Another process is using port 8082
- Find: `netstat -ano | findstr :8082`
- Kill it or wait for it to close
- Or change port in `server.js` line 1570

### "Command window closes immediately"
- An error occurred during startup
- Try `START_SERVER.bat` to see the error message
- Check that all files are in the outputs folder
- Verify npm packages are installed: `npm install`

### "Can't access http://localhost:8082"
- Wait 5-10 seconds for server to fully start
- Try http://localhost:8082/admin instead
- Check if server is actually running (see window)
- Try clearing browser cache (Ctrl+Shift+Delete)

---

## 📁 Files in This Folder

```
✅ START_SERVER.bat          ← Windows batch file (easy, recommended)
✅ START_SERVER.ps1          ← PowerShell version (colored output)
✅ START_SERVER_HIDDEN.vbs   ← Silent VBScript (background mode)
✅ AUTOSTART_SETUP.md        ← Full autostart guide (Task Scheduler, etc)
✅ server.js                 ← Backend API server
✅ admin-dashboard.html      ← Admin interface
✅ index.html                ← Public website
... (and many more files)
```

---

## 🎯 Next Steps

### After Server Starts:

1. **Explore Admin Dashboard**
   - Login at http://localhost:8082/admin
   - View all features and data

2. **Test Features**
   - Check analytics
   - Try search and filter
   - Export data to CSV
   - Manage packages and users

3. **Read Documentation**
   - [README.md](README.md) - Project overview
   - [API_DOCUMENTATION.md](API_DOCUMENTATION.md) - API reference
   - [TESTING_GUIDE.md](TESTING_GUIDE.md) - Test procedures

---

## ⏰ Keep Server Running

### Option A: Keep Command Window Open
- Leave the command window running
- Server keeps working
- Close window to stop server

### Option B: Run Hidden (Recommended)
- Use `START_SERVER_HIDDEN.vbs`
- Server runs in background
- Minimize distractions
- Check logs anytime: Look for `server.log` file

### Option C: Autostart on Boot
- Follow [AUTOSTART_SETUP.md](AUTOSTART_SETUP.md)
- Server starts automatically when Windows boots
- Always available when you need it

---

## 💡 Pro Tips

### View Server Logs
```bash
# Check what the server is doing
tail -f server.log
# Or in Windows: Open server.log in Notepad
```

### Check Port Status
```bash
# Verify server is listening on port 8082
netstat -ano | findstr :8082
```

### Restart Server Quickly
1. Close the command window (or kill the process)
2. Double-click `START_SERVER.bat` again
3. Server restarts fresh

### Stop Server Cleanly
1. Close the command window
2. Wait 2-3 seconds for graceful shutdown
3. Server stops completely

---

## 📞 Need Help?

**Contact BisFly:**
- Email: bisflytravels@gmail.com
- WhatsApp: +234 705 193 5203
- Admin: http://localhost:8082/admin

---

## ✅ Summary

| Task | How | Time |
|------|-----|------|
| **Start server** | Double-click `START_SERVER.bat` | 10 sec |
| **Access admin** | Go to http://localhost:8082/admin | 5 sec |
| **Login** | Use admin / BisFly@2026 | 5 sec |
| **Setup autostart** | Read AUTOSTART_SETUP.md | 10 min |
| **Stop server** | Close command window | 2 sec |

---

**🎉 You're all set! Start with `START_SERVER.bat` and enjoy the BisFly platform!**

*For more details, see [AUTOSTART_SETUP.md](AUTOSTART_SETUP.md)*
