' BisFly Travel Platform - Hidden Autostart Script
' This VBScript runs the server without showing a window
' Usage: Double-click this file to start the server silently

Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' Get the directory where this script is located
scriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

' Change to the script directory
objShell.CurrentDirectory = scriptDir

' Run npm start silently (0 = hidden window)
' The output will go to a log file
objShell.Run "cmd.exe /c npm start > server.log 2>&1", 0, False

' Show a notification (optional - comment out if not needed)
objShell.Popup "BisFly server started successfully!" & vbCrLf & "Access: http://localhost:8082/admin", 5, "BisFly Platform", 64
