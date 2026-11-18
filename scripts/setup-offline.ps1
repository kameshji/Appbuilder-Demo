# Sets up Appbuilder on Windows: checks tools, clones or updates the repo, installs and builds it,
# then starts the server and opens it in the browser.
#   .\setup-offline.ps1 [-Path "$HOME\Appbuilder-Demo"] [-Repo "https://github.com/kameshji/Appbuilder-Demo.git"]
param(
  [string]$Path = "$HOME\Appbuilder-Demo",
  [string]$Repo = 'https://github.com/kameshji/Appbuilder-Demo.git'
)

$ErrorActionPreference = 'Stop'
$Url = 'http://localhost:5174'

function Fail([string]$Message) {
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

# 1. Check the tools.
Write-Host '[1/5] Checking Node.js and git ...'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js was not found. Install Node.js 22.18 or newer (LTS) from https://nodejs.org and run this script again.'
}
$nodeVersion = (node --version)
$nodeParts = ($nodeVersion -replace '^v', '').Split('.')
$nodeMajor = [int]$nodeParts[0]; $nodeMinor = [int]$nodeParts[1]
# The server is TypeScript run directly by Node (type stripping), available from Node 22.18.
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 18)) { Fail "Node.js $nodeVersion is too old. Install Node.js 22.18 or newer." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail 'git was not found. Install Git for Windows from https://git-scm.com and run this script again.'
}
Write-Host "  Node.js $nodeVersion, $(git --version)"

# 2. Clone, or update an existing copy.
Write-Host "[2/5] Repository: $Path"
if (-not (Test-Path $Path)) {
  Write-Host "  Cloning $Repo ..."
  git clone $Repo $Path
  if ($LASTEXITCODE -ne 0) { Fail 'git clone failed. Check the repository URL and your internet connection.' }
} elseif (-not (Test-Path (Join-Path $Path '.git'))) {
  Fail "$Path exists but is not a git checkout. Choose another -Path or move that folder away."
} else {
  Write-Host '  Updating with git pull --ff-only ...'
  git -C $Path pull --ff-only
  if ($LASTEXITCODE -ne 0) { Write-Host '  WARNING: could not update (offline, or local changes). Continuing with the existing copy.' -ForegroundColor Yellow }
}

Set-Location $Path

# 3. Install packages (npm ci when the lock file exists).
Write-Host '[3/5] Installing packages ...'
if (Test-Path 'package-lock.json') {
  npm.cmd ci
} else {
  npm.cmd install
}
if ($LASTEXITCODE -ne 0) { Fail 'Package install failed. See the npm output above.' }

# 4. Build the app.
Write-Host '[4/5] Building the app ...'
npm.cmd run build
if ($LASTEXITCODE -ne 0) { Fail 'Build failed. See the output above.' }

# 5. Start the server in its own window and open the browser.
Write-Host '[5/5] Starting the server ...'
Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $Path
Start-Sleep -Seconds 3
Start-Process $Url
Write-Host "Appbuilder is running at $Url. Close the server window to stop it."
