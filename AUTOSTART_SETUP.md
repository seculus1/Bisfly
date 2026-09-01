# BisFly Platform - Windows Task Scheduler Autostart Setup Guide

## 🎯 How to Set Up Autostart on Windows

This guide will help you automatically start the BisFly server when Windows boots up.

### Method 1: Using Task Scheduler (Recommended)

#### Step 1: Open Task Scheduler
1. Press `Win + R`
2. Type: `taskschd.msc`
3. Click OK

#### Step 2: Create a New Task
1. In the right panel, click **Create Basic Task**
2. Name: `BisFly Server Autostart`
3. Description: `Automatically start BisFly Travel Platform server on system startup`
4. Click **Next**

#### Step 3: Set Trigger
1. Select **When the computer starts**
2. Click **Next**

#### Step 4: Set Action
1. Select **Start a program**
2. Click **Next**

#### Step 5: Configure Program
1. **Program/script**: `C:\Windows\System32\cmd.exe`
2. **Add arguments (optional)**: 
   ```
   /c cd /d "C:\Users\USER\Documents\Codex\2026-06-09\files-mentioned-by-the-user-log\outputs" && npm start
   ```
   (Replace `C:\Users\USER\...` with your actual path)
3. **Start in (optional)**:
   ```
   C:\Users\USER\Documents\Codex\2026-06-09\files-mentioned-by-the-user-log\outputs
   ```
4. Click **Next**

#### Step 6: Review and Finish
1. Check the summary
2. Click **Finish**

#### Step 7: Configure Task Properties (Optional)
1. Right-click the created task: **BisFly Server Autostart**
2. Click **Properties**
3. Go to **General** tab:
   - Check: **Run whether user is logged in or not**
   - Check: **Run with highest privileges** (if admin)
4. Go to **Conditions** tab:
   - Uncheck: **Stop the task if it runs longer than** (to keep it running)
5. Click **OK**

---

### Method 2: Using Startup Folder

#### Step 1: Create a Shortcut
1. Right-click on `START_SERVER.bat` in the outputs folder
2. Select **Send to** → **Desktop (create shortcut)**

#### Step 2: Move to Startup Folder
1. Press `Win + R`
2. Type: `shell:startup`
3. Press Enter
4. Copy the shortcut from Desktop to this Startup folder

#### Step 3: Verify
1. Restart your computer
2. Server should start automatically

---

### Method 3: Using a Scheduled Task Script (PowerShell)

#### Step 1: Create PowerShell Script
Save this as `SetupAutostart.ps1` in the outputs folder:

```powershell
# Run as Administrator
# PowerShell -ExecutionPolicy Bypass -File SetupAutostart.ps1

$taskName = "BisFly Server Autostart"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Definition
$startScript = Join-Path $scriptPath "START_SERVER.bat"

# Remove existing task if it exists
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Create trigger and action
$trigger = New-ScheduledTaskTrigger -AtStartup
$action = New-ScheduledTaskAction -Execute $startScript -WorkingDirectory $scriptPath

# Register the task
Register-ScheduledTask -TaskName $taskName `
    -Trigger $trigger `
    -Action $action `
    -RunLevel Highest `
    -Description "Automatically start BisFly Travel Platform server on system startup"

Write-Host "✓ Autostart task created successfully!" -ForegroundColor Green
Write-Host "The BisFly server will start automatically when Windows boots." -ForegroundColor Green
```

#### Step 2: Run the Setup
1. Open PowerShell as Administrator
2. Navigate to the outputs folder
3. Run: `PowerShell -ExecutionPolicy Bypass -File SetupAutostart.ps1`

---

## 🔍 Verify Autostart is Working

### Check Task Scheduler
1. Open Task Scheduler (`Win + R`, type `taskschd.msc`)
2. Look for **BisFly Server Autostart** in the task list
3. Right-click and select **Run** to test immediately

### Check Running Processes
```bash
# In PowerShell or Command Prompt
Get-Process node
# Should show Node.js process running
```

### Access the Platform
After autostart runs:
- **Public Website**: http://localhost:8082
- **Admin Panel**: http://localhost:8082/admin

---

## 🆘 Troubleshooting

### Task doesn't run at startup
- Ensure the path in the task is correct
- Run Task Scheduler as Administrator
- Check that Node.js is in the system PATH
- Verify the outputs folder path exists

### Server starts but immediately closes
- Check the `START_SERVER.bat` file has correct paths
- Run manually to see error messages
- Verify Node.js and npm are installed: `node --version`, `npm --version`

### Can't find the task
- Open Task Scheduler (Win + R → `taskschd.msc`)
- Navigate to: **Task Scheduler Library**
- Search for "BisFly"

### Port 8082 already in use
- Find what's using the port:
  ```powershell
  netstat -ano | findstr :8082
  ```
- Kill the process or change the port in `server.js`

---

## 📝 Manual Startup (When Autostart Not Available)

If you can't set up autostart, you can start the server manually:

### Option 1: Use Batch File
1. Navigate to the outputs folder
2. Double-click: `START_SERVER.bat`

### Option 2: Use PowerShell
1. Open PowerShell
2. Navigate to: `cd "C:\Users\USER\Documents\Codex\2026-06-09\files-mentioned-by-the-user-log\outputs"`
3. Run: `npm start`

### Option 3: Use Command Prompt
1. Open Command Prompt
2. Navigate to: `cd "C:\Users\USER\Documents\Codex\2026-06-09\files-mentioned-by-the-user-log\outputs"`
3. Run: `npm start`

---

## ⚙️ Advanced Configuration

### Run in Background (No Window)
To run the server without showing a window, use VBScript:

Create `START_SERVER_HIDDEN.vbs` in the outputs folder:
```vbscript
Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd.exe /c npm start", 0, False
```

Then use this `.vbs` file in the Task Scheduler instead of `.bat`

### Restart on Failure
In Task Scheduler task Properties:
1. Go to **Actions** tab
2. Click **New...**
3. Set up additional action to restart if needed

### Logging
To log server output:
```
/c cd /d "C:\path\to\outputs" && npm start > server.log 2>&1
```

---

## 🚀 Quick Test

After setting up autostart:

1. Restart your computer
2. Wait 10-30 seconds for the server to start
3. Open your browser
4. Visit: `http://localhost:8082/admin`
5. Login with: `admin` / `BisFly@2026`
6. If it loads, autostart is working! ✅

---

## 📞 Support

If you have issues with autostart:
- Email: bisflytravels@gmail.com
- WhatsApp: +234 705 193 5203
- Check the [TESTING_GUIDE.md](TESTING_GUIDE.md) for more help

---

**Status**: ✅ Ready for Autostart Configuration  
**Last Updated**: 2026-08-14
