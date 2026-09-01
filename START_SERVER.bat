@echo off
REM BisFly Travel Platform - Server Startup Script
REM This script starts the Node.js server on port 8082

echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║                                                            ║
echo ║          BisFly Travel Platform - Server Starting         ║
echo ║                                                            ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ✗ Error: Node.js is not installed or not in PATH
    echo.
    echo Please install Node.js from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo ✓ Node.js detected
echo.

REM Navigate to the outputs directory
cd /d "%~dp0"

REM Check if package.json exists
if not exist "package.json" (
    echo ✗ Error: package.json not found
    echo Please run this script from the outputs directory
    pause
    exit /b 1
)

REM Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo ✗ Error: npm install failed
        pause
        exit /b 1
    )
    echo.
)

REM Start the server
echo Starting server on port 8082...
echo.
echo ═══════════════════════════════════════════════════════════
echo.
echo   🚀 Access the platform at:
echo.
echo   📱 Public Website:   http://localhost:8082
echo   🔐 Admin Panel:      http://localhost:8082/admin
echo.
echo   🔑 Login Credentials:
echo   Username: admin
echo   Password: BisFly@2026
echo.
echo ═══════════════════════════════════════════════════════════
echo.

call npm start

REM If npm start exits, show a message
echo.
echo ✗ Server stopped. Press any key to exit.
pause
