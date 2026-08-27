$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required. Install the current LTS from https://nodejs.org/en/download and reopen PowerShell."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm was not found. Reinstall Node.js from https://nodejs.org/en/download."
}
$major = [int]((node --version).TrimStart("v").Split(".")[0])
if ($major -lt 22) { throw "Node.js 22 or newer is required." }

npm install
npm run setup:chromium
npm run setup
Write-Host "Platform setup complete. Run: npm run init"
