<#
  Creates the Appbuilder database and its own MySQL user on this PC.
  You type the new user's password yourself (it is never shown, logged or saved by this script);
  enter the same password later in Appbuilder's setup screen.

  Usage (PowerShell):
    .\scripts\setup-mysql.ps1
    .\scripts\setup-mysql.ps1 -MySqlHome "C:\Users\me\MySQL" -Database appbuilder -User appbuilder
#>
param(
  [string]$MySqlHome = "$HOME\MySQL",
  [string]$Database = 'appbuilder',
  [string]$User = 'appbuilder',
  [int]$Port = 3306
)
$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

if ($Database -notmatch '^[A-Za-z0-9_]{1,64}$') { Fail "Database name may only contain letters, digits and _" }
if ($User -notmatch '^[A-Za-z0-9_]{1,32}$') { Fail "User name may only contain letters, digits and _" }

$bin = Get-ChildItem -Path $MySqlHome -Directory -Filter 'mysql-*' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $bin) { Fail "No mysql-* folder found in $MySqlHome. Pass -MySqlHome." }
$mysql = Join-Path $bin.FullName 'bin\mysql.exe'
if (-not (Test-Path $mysql)) { Fail "mysql.exe not found at $mysql" }

# 1. Make sure the server is running
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  $start = Join-Path $MySqlHome 'start-mysql.cmd'
  if (-not (Test-Path $start)) { Fail "MySQL is not running on port $Port and $start does not exist. Start it yourself, then re-run." }
  Write-Host "Starting MySQL with $start ..."
  Start-Process -FilePath $start -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and -not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { Fail "MySQL did not start. See $MySqlHome\mysqld.log" }
}
Write-Host "MySQL is listening on 127.0.0.1:$Port"

# 2. Ask for the new user's password (twice), without echoing it
function Read-Plain([string]$prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$pw1 = Read-Plain "New password for MySQL user '$User' (min 10 characters)"
$pw2 = Read-Plain "Repeat the password"
if ($pw1 -ne $pw2) { Fail "Passwords do not match." }
if ($pw1.Length -lt 10) { Fail "Password must be at least 10 characters." }
$escaped = $pw1.Replace('\', '\\').Replace("'", "''")

# 3. Run the SQL as root through stdin (the password never appears on a command line)
$sql = @"
CREATE DATABASE IF NOT EXISTS ``$Database`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$User'@'localhost' IDENTIFIED BY '$escaped';
CREATE USER IF NOT EXISTS '$User'@'127.0.0.1' IDENTIFIED BY '$escaped';
ALTER USER '$User'@'localhost' IDENTIFIED BY '$escaped';
ALTER USER '$User'@'127.0.0.1' IDENTIFIED BY '$escaped';
GRANT ALL PRIVILEGES ON ``$Database``.* TO '$User'@'localhost';
GRANT ALL PRIVILEGES ON ``$Database``.* TO '$User'@'127.0.0.1';
FLUSH PRIVILEGES;
"@
Write-Host "Connecting as root (press Enter at the root password prompt if root has no password) ..."
$sql | & $mysql -h 127.0.0.1 -P $Port -u root -p --batch
if ($LASTEXITCODE -ne 0) { Fail "The SQL did not run (exit $LASTEXITCODE)." }
$pw1 = $null; $pw2 = $null; $escaped = $null; $sql = $null

Write-Host ""
Write-Host "Done. In Appbuilder's setup screen use:" -ForegroundColor Green
Write-Host "  Host 127.0.0.1   Port $Port   Database $Database   User $User   Password (the one you just typed)"
