<#
  Creates Appbuilder's PostgreSQL role and database on this Windows PC (PostgreSQL 15 or newer; 17 recommended).

  Usage (PowerShell):
    .\scripts\setup-postgres.ps1
    .\scripts\setup-postgres.ps1 -Database appbuilder -User appbuilder -Port 5432 -SuperUser postgres
    .\scripts\setup-postgres.ps1 -PsqlPath "D:\PostgreSQL\17\bin\psql.exe"

  What it does:
    1. finds psql.exe (PATH, C:\Program Files\PostgreSQL\<version>\bin, Scoop) or tells you how to install PostgreSQL;
    2. makes sure the server answers on the port (starts the postgresql-x64-<version> service when it is stopped);
    3. asks for the superuser's password and the new role's password with Read-Host -AsSecureString;
    4. creates (or updates) the login role (no superuser, CREATEDB or CREATEROLE rights) and an empty UTF8 database owned
       by it.
  Passwords are never echoed, logged, written to disk or put on a command line: the superuser password reaches psql
  through the PGPASSWORD variable of this PowerShell process only (removed right after), and the new role's password is
  turned into a SCRAM-SHA-256 verifier on this computer, so not even PostgreSQL's statement log can contain it.
#>
param(
  [string]$Database = 'appbuilder',
  [string]$User = 'appbuilder',
  [string]$PgHost = '127.0.0.1',
  [int]$Port = 5432,
  [string]$SuperUser = 'postgres',
  [string]$PsqlPath = ''
)
$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

if ($Database -cnotmatch '^[a-z_][a-z0-9_]{0,62}$') { Fail 'The database name may contain lowercase letters, digits and _ only.' }
if ($User -cnotmatch '^[a-z_][a-z0-9_]{0,62}$') { Fail 'The role name may contain lowercase letters, digits and _ only.' }
if ($SuperUser -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,62}$') { Fail 'Invalid superuser name.' }

# 1. psql.exe
function Find-Psql {
  if ($PsqlPath) { if (Test-Path $PsqlPath) { return (Resolve-Path $PsqlPath).Path } else { Fail "psql.exe not found at $PsqlPath" } }
  $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432, "$HOME\scoop\apps\postgresql\current", "$HOME\PostgreSQL") | Where-Object { $_ } | Select-Object -Unique
  $found = @()
  foreach ($r in $roots) {
    $direct = Join-Path $r 'bin\psql.exe'
    if (Test-Path $direct) { $found += Get-Item $direct }
    $base = Join-Path $r 'PostgreSQL'
    if (Test-Path $base) { $found += Get-ChildItem -Path $base -Directory | ForEach-Object { Get-Item (Join-Path $_.FullName 'bin\psql.exe') -ErrorAction SilentlyContinue } }
  }
  # newest version first (folder names are major versions: 15, 16, 17)
  $best = $found | Where-Object { $_ } | Sort-Object { $v = 0; [void][int]::TryParse($_.Directory.Parent.Name, [ref]$v); $v } -Descending | Select-Object -First 1
  if ($best) { return $best.FullName }
  return $null
}
$psql = Find-Psql
if (-not $psql) {
  Write-Host 'PostgreSQL was not found on this PC.' -ForegroundColor Yellow
  Write-Host 'Install PostgreSQL 17 with winget (the installer asks for the superuser "postgres" password; remember it):'
  Write-Host '    winget install --id PostgreSQL.PostgreSQL.17 -e --interactive'
  Write-Host 'or download the installer from https://www.postgresql.org/download/windows/ . Then run this script again.'
  exit 1
}
Write-Host "Using $psql"
$version = (& $psql --version)
Write-Host "  $version"

# 2. the server must answer on the port (local installs run as the service postgresql-x64-<version>)
function Test-Port { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect($PgHost, $Port); $c.Close(); return $true } catch { return $false } }
if (-not (Test-Port)) {
  if ($PgHost -in @('127.0.0.1', 'localhost', '::1')) {
    $svc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($svc -and $svc.Status -ne 'Running') {
      Write-Host "Starting the Windows service $($svc.Name) ..."
      try { Start-Service $svc.Name } catch { Fail "Could not start $($svc.Name) ($($_.Exception.Message)). Start it from an administrator PowerShell: Start-Service $($svc.Name)" }
      for ($i = 0; $i -lt 30 -and -not (Test-Port); $i++) { Start-Sleep 1 }
    }
  }
  if (-not (Test-Port)) { Fail "Nothing answers on ${PgHost}:$Port. Start PostgreSQL (services.msc, postgresql-x64-17) or pass -Port." }
}
Write-Host "PostgreSQL answers on ${PgHost}:$Port"

# 3. passwords (SecureString; plain text only for the moment it is needed)
function Read-Plain([string]$prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
$super = Read-Plain "Password of the PostgreSQL superuser '$SuperUser'"
$pw1 = Read-Plain "New password for the role '$User' (at least 12 characters)"
$pw2 = Read-Plain 'Repeat the password'
if ($pw1 -cne $pw2) { Fail 'The passwords do not match.' }
if ($pw1.Length -lt 12) { Fail 'The password must be at least 12 characters.' }
$pw2 = $null

# SCRAM-SHA-256 verifier: PBKDF2-HMAC-SHA256 (4096 iterations, 16-byte salt), StoredKey = SHA256(HMAC(salted, 'Client Key')),
# ServerKey = HMAC(salted, 'Server Key') -- the format PostgreSQL stores (RFC 5802 / 7677).
function New-ScramVerifier([string]$password) {
  $salt = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($salt)
  $norm = $password.Normalize([Text.NormalizationForm]::FormKC)
  $kdf = New-Object Security.Cryptography.Rfc2898DeriveBytes(([Text.Encoding]::UTF8.GetBytes($norm)), $salt, 4096, [Security.Cryptography.HashAlgorithmName]::SHA256)
  $salted = $kdf.GetBytes(32)
  $hmac = New-Object Security.Cryptography.HMACSHA256(, $salted)
  $clientKey = $hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes('Client Key'))
  $serverKey = $hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes('Server Key'))
  $stored = [Security.Cryptography.SHA256]::Create().ComputeHash($clientKey)
  $b64 = { param($x) [Convert]::ToBase64String($x) }
  return 'SCRAM-SHA-256$4096:' + (& $b64 $salt) + '$' + (& $b64 $stored) + ':' + (& $b64 $serverKey)
}
$verifier = New-ScramVerifier $pw1
$pw1 = $null
if ($verifier -notmatch '^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$') { Fail 'Could not prepare the password.' }

# 4. the SQL goes through stdin (no password or verifier on a command line)
$sql = @"
\set ON_ERROR_STOP on
SELECT current_setting('server_version_num')::int >= 150000 AS ok \gset
\if :ok
\else
  \echo 'PostgreSQL 15 or newer is needed.'
  \quit 3
\endif
DO `$`$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$User') THEN
    ALTER ROLE "$User" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$verifier';
  ELSE
    CREATE ROLE "$User" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$verifier';
  END IF;
END `$`$;
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', '$Database', '$User')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$Database') \gexec
ALTER DATABASE "$Database" OWNER TO "$User";
REVOKE ALL ON DATABASE "$Database" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE "$Database" TO "$User";
SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = '$Database' \gset
\echo 'Database $Database (encoding' :enc') is owned by $User.'
"@
$verifier = $null

Write-Host "Connecting as $SuperUser ..."
$env:PGPASSWORD = $super
try {
  $sql | & $psql -X -q -h $PgHost -p $Port -U $SuperUser -d postgres
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  $super = $null; $sql = $null
}
if ($code -ne 0) { Fail "psql reported an error (exit $code). Check the superuser password and that PostgreSQL is 15 or newer." }

Write-Host ''
Write-Host "Done. In Appbuilder's setup screen enter:" -ForegroundColor Green
Write-Host "  Host $PgHost   Port $Port   Database $Database   User $User   Password (the one you just typed)"
