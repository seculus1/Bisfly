# BisFly Travel Platform - PowerShell Startup Script
# This script starts the Node.js server on port 8082

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║                                                            ║" -ForegroundColor Cyan
Write-Host "║          BisFly Travel Platform - Server Starting         ║" -ForegroundColor Cyan
Write-Host "║                                                            ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
$nodeCheck = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCheck) {
    Write-Host "✗ Error: Node.js is not installed or not in PATH" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Node.js from: https://nodejs.org/" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "✓ Node.js detected" -ForegroundColor Green
Write-Host ""

# Navigate to script directory
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Definition)

# Check if package.json exists
if (-not (Test-Path "package.json")) {
    Write-Host "✗ Error: package.json not found" -ForegroundColor Red
    Write-Host "Please run this script from the outputs directory" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# Install dependencies if needed
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ Error: npm install failed" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host ""
}

# Start the server
Write-Host "Starting server on port 8082..." -ForegroundColor Yellow
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  🚀 Access the platform at:" -ForegroundColor Green
Write-Host ""
Write-Host "  📱 Public Website:   http://localhost:8082" -ForegroundColor Cyan
Write-Host "  🔐 Admin Panel:      http://localhost:8082/admin" -ForegroundColor Cyan
Write-Host ""
Write-Host "  🔑 Login Credentials:" -ForegroundColor Green
Write-Host "  Username: admin" -ForegroundColor Yellow
Write-Host "  Password: BisFly@2026" -ForegroundColor Yellow
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""

npm start

Write-Host ""
Write-Host "✗ Server stopped" -ForegroundColor Red
Read-Host "Press Enter to exit"
