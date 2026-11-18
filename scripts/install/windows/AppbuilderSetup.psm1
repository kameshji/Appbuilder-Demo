<#
  Appbuilder Windows installer: the pure functions (no side effects, unit-tested by tests/Installer.Tests.ps1 with Pester)
  and small action helpers that honour the installer's dry-run mode. PowerShell 5.1 compatible: no ?? or ?: operators,
  no && / ||, no pipeline chain operators, no PowerShell 7 only cmdlets.
#>
Set-StrictMode -Version 2.0

# well-known SIDs (names are localised on non-English Windows; SIDs are not)
$script:SidAdministrators = 'S-1-5-32-544'
$script:SidSystem = 'S-1-5-18'
$script:SidUsers = 'S-1-5-32-545'

function Join-WinPath {
  <# Windows path join without touching the file system (Join-Path checks that the drive exists, which also breaks the
     tests on Linux) #>
  param([Parameter(Mandatory)][string]$Parent, [Parameter(Mandatory)][string]$Child)
  return $Parent.TrimEnd('\', '/') + '\' + $Child.TrimStart('\', '/')
}

#region manifest, versions, checksums

function Read-Manifest {
  <# key=value lines of scripts/install/manifest.txt -> hashtable (comments and blank lines skipped) #>
  param([Parameter(Mandatory)][string]$Path)
  $m = @{}
  foreach ($raw in [IO.File]::ReadAllLines($Path)) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    $i = $line.IndexOf('=')
    if ($i -gt 0) { $m[$line.Substring(0, $i)] = $line.Substring($i + 1) }
  }
  return $m
}

function Get-ManifestItem {
  <# one download of the manifest: Url, FileName, Algorithm (SHA256 or SHA512), Hash; refuses http:// #>
  param([Parameter(Mandatory)][hashtable]$Manifest, [Parameter(Mandatory)][string]$Key)
  $url = $Manifest["$Key.url"]
  if (-not $url) { throw "manifest.txt has no $Key.url" }
  if (-not $url.StartsWith('https://')) { throw "manifest.txt: $Key.url is not an https:// URL" }
  $algo = 'SHA256'; $hash = $Manifest["$Key.sha256"]
  if ($Manifest.ContainsKey("$Key.sha512")) { $algo = 'SHA512'; $hash = $Manifest["$Key.sha512"] }
  if (-not $hash) { throw "manifest.txt has no checksum for $Key" }
  $expectedLength = 64; if ($algo -eq 'SHA512') { $expectedLength = 128 }
  if ($hash -notmatch "^[0-9a-fA-F]{$expectedLength}$") { throw "manifest.txt: the $algo checksum of $Key is malformed" }
  $name = [IO.Path]::GetFileName(([Uri]$url).AbsolutePath)
  return [pscustomobject]@{ Key = $Key; Url = $url; FileName = $name; Algorithm = $algo; Hash = $hash.ToLowerInvariant() }
}

function ConvertTo-VersionParts {
  param([string]$Version)
  $v = $Version.Trim()
  if ($v.StartsWith('v')) { $v = $v.Substring(1) }
  $plus = $v.IndexOf('+'); if ($plus -ge 0) { $v = $v.Substring(0, $plus) }
  $dash = $v.IndexOf('-')
  $main = $v; $pre = ''
  if ($dash -ge 0) { $main = $v.Substring(0, $dash); $pre = $v.Substring($dash + 1) }
  $nums = @(0, 0, 0)
  $parts = $main.Split('.')
  for ($i = 0; $i -lt 3 -and $i -lt $parts.Length; $i++) { $n = 0; [void][int]::TryParse($parts[$i], [ref]$n); $nums[$i] = $n }
  return @{ Main = $nums; Pre = $pre }
}

function Compare-AppVersion {
  <# semantic-version order: -1, 0, 1 (pre-releases before the release; numeric identifiers numerically) #>
  param([Parameter(Mandatory)][string]$A, [Parameter(Mandatory)][string]$B)
  $x = ConvertTo-VersionParts $A; $y = ConvertTo-VersionParts $B
  for ($i = 0; $i -lt 3; $i++) {
    if ($x.Main[$i] -lt $y.Main[$i]) { return -1 }
    if ($x.Main[$i] -gt $y.Main[$i]) { return 1 }
  }
  if ($x.Pre -eq '' -and $y.Pre -eq '') { return 0 }
  if ($x.Pre -eq '') { return 1 }
  if ($y.Pre -eq '') { return -1 }
  $p = $x.Pre.Split('.'); $q = $y.Pre.Split('.')
  for ($i = 0; $i -lt [Math]::Max($p.Length, $q.Length); $i++) {
    if ($i -ge $p.Length) { return -1 }
    if ($i -ge $q.Length) { return 1 }
    $pn = 0; $qn = 0
    $pIsNum = [int]::TryParse($p[$i], [ref]$pn); $qIsNum = [int]::TryParse($q[$i], [ref]$qn)
    if ($pIsNum -and $qIsNum) { if ($pn -ne $qn) { if ($pn -lt $qn) { return -1 } else { return 1 } }; continue }
    if ($pIsNum -ne $qIsNum) { if ($pIsNum) { return -1 } else { return 1 } }
    $c = [string]::CompareOrdinal($p[$i], $q[$i])
    if ($c -ne 0) { if ($c -lt 0) { return -1 } else { return 1 } }
  }
  return 0
}

function Test-NodeVersion {
  <# node --version output against a ">=22.18" requirement #>
  param([Parameter(Mandatory)][string]$Version, [string]$Requirement = '>=22.18')
  if ($Requirement -notmatch '^>=\s*([\d.]+)$') { return $true }
  return ((Compare-AppVersion $Version $Matches[1]) -ge 0)
}

function Get-FileHashHex {
  param([Parameter(Mandatory)][string]$Path, [ValidateSet('SHA256', 'SHA512')][string]$Algorithm = 'SHA256')
  $alg = [Security.Cryptography.HashAlgorithm]::Create($Algorithm)
  $fs = [IO.File]::OpenRead($Path)
  try { $bytes = $alg.ComputeHash($fs) } finally { $fs.Dispose(); $alg.Dispose() }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Test-FileChecksum {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Algorithm, [Parameter(Mandatory)][string]$Expected)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  return ((Get-FileHashHex -Path $Path -Algorithm $Algorithm) -eq $Expected.ToLowerInvariant())
}

function Test-ReleaseChecksums {
  <# a release folder against its SHA256SUMS: Ok, Missing, Changed, Extra (SHA256SUMS and SHA256SUMS.sig themselves excluded) #>
  param([Parameter(Mandatory)][string]$ReleaseDir)
  $sumsPath = Join-Path $ReleaseDir 'SHA256SUMS'
  $missing = New-Object System.Collections.Generic.List[string]
  $changed = New-Object System.Collections.Generic.List[string]
  $extra = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath $sumsPath)) { $missing.Add('SHA256SUMS'); return [pscustomobject]@{ Ok = $false; Files = 0; Missing = $missing; Changed = $changed; Extra = $extra } }
  $listed = @{}
  foreach ($line in [IO.File]::ReadAllLines($sumsPath)) {
    if ($line.Trim() -eq '') { continue }
    if ($line -notmatch '^([0-9a-f]{64}) [ *](.+)$') { throw "Malformed line in SHA256SUMS: $line" }
    $listed[$Matches[2]] = $Matches[1]
  }
  foreach ($rel in $listed.Keys) {
    $p = Join-Path $ReleaseDir ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $missing.Add($rel) }
    elseif ((Get-FileHashHex -Path $p) -ne $listed[$rel]) { $changed.Add($rel) }
  }
  $root = (Resolve-Path -LiteralPath $ReleaseDir).ProviderPath.TrimEnd('\', '/')
  foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File -Force) {
    $rel = $f.FullName.Substring($root.Length + 1) -replace '\\', '/'
    if ($rel -eq 'SHA256SUMS' -or $rel -eq 'SHA256SUMS.sig') { continue }
    if (-not $listed.ContainsKey($rel)) { $extra.Add($rel) }
  }
  $ok = ($missing.Count -eq 0 -and $changed.Count -eq 0 -and $extra.Count -eq 0)
  return [pscustomobject]@{ Ok = $ok; Files = $listed.Count; Missing = $missing; Changed = $changed; Extra = $extra }
}

#endregion

#region secrets

function New-RandomPassword {
  <# URL-safe random password from the OS CSPRNG (never written anywhere by this function) #>
  param([int]$Length = 40)
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $out = New-Object Text.StringBuilder
  $buf = New-Object byte[] 1
  try {
    while ($out.Length -lt $Length) {
      $rng.GetBytes($buf)
      # rejection sampling: no modulo bias
      if ($buf[0] -lt (256 - (256 % $alphabet.Length))) { [void]$out.Append($alphabet[$buf[0] % $alphabet.Length]) }
    }
  } finally { $rng.Dispose() }
  return $out.ToString()
}

function New-ScramVerifier {
  <# PostgreSQL SCRAM-SHA-256 verifier (RFC 5802/7677): the password itself never reaches the server or its logs #>
  param([Parameter(Mandatory)][string]$Password, [byte[]]$Salt = $null, [int]$Iterations = 4096)
  if (-not $Salt) { $Salt = New-Object byte[] 16; $r = [Security.Cryptography.RandomNumberGenerator]::Create(); $r.GetBytes($Salt); $r.Dispose() }
  $norm = $Password.Normalize([Text.NormalizationForm]::FormKC)
  $kdf = New-Object Security.Cryptography.Rfc2898DeriveBytes(([Text.Encoding]::UTF8.GetBytes($norm)), $Salt, $Iterations, [Security.Cryptography.HashAlgorithmName]::SHA256)
  $salted = $kdf.GetBytes(32)
  $hmac = New-Object Security.Cryptography.HMACSHA256(, $salted)
  $clientKey = $hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes('Client Key'))
  $serverKey = $hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes('Server Key'))
  $sha = [Security.Cryptography.SHA256]::Create()
  $stored = $sha.ComputeHash($clientKey)
  $sha.Dispose(); $hmac.Dispose(); $kdf.Dispose()
  return 'SCRAM-SHA-256$' + $Iterations + ':' + [Convert]::ToBase64String($Salt) + '$' + [Convert]::ToBase64String($stored) + ':' + [Convert]::ToBase64String($serverKey)
}

function New-RoleSql {
  <# psql script (sent on stdin) that creates or updates the login role and its UTF8 database; holds only the verifier #>
  param([Parameter(Mandatory)][string]$Role, [Parameter(Mandatory)][string]$Database, [Parameter(Mandatory)][string]$Verifier)
  if ($Role -cnotmatch '^[a-z_][a-z0-9_]{0,62}$' -or $Database -cnotmatch '^[a-z_][a-z0-9_]{0,62}$') { throw 'Role and database names may contain lowercase letters, digits and _ only.' }
  if ($Verifier -notmatch '^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$') { throw 'Not a SCRAM-SHA-256 verifier.' }
  $dollar = '$$'
  return @"
\set ON_ERROR_STOP on
SELECT current_setting('server_version_num')::int >= 150000 AS ok \gset
\if :ok
\else
  \echo 'PostgreSQL 15 or newer is needed.'
  \quit 3
\endif
DO $dollar BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$Role') THEN
    ALTER ROLE "$Role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$Verifier';
  ELSE
    CREATE ROLE "$Role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$Verifier';
  END IF;
END $dollar;
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', '$Database', '$Role')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$Database') \gexec
ALTER DATABASE "$Database" OWNER TO "$Role";
REVOKE ALL ON DATABASE "$Database" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE "$Database" TO "$Role";
"@
}

function Protect-MachineSecret {
  <# DPAPI, machine scope: only readable on this computer; the file it goes into is ACL'd to SYSTEM and Administrators #>
  param([Parameter(Mandatory)][string]$Text)
  Add-Type -AssemblyName System.Security
  $bytes = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($Text), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  return [Convert]::ToBase64String($bytes)
}

function Unprotect-MachineSecret {
  param([Parameter(Mandatory)][string]$Protected)
  Add-Type -AssemblyName System.Security
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($Protected), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  return [Text.Encoding]::UTF8.GetString($bytes)
}

#endregion

#region configuration text

function New-ServiceEnvironment {
  <# the service's environment: also written as appbuilder.env for the command-line tools #>
  param(
    [Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Workspace, [Parameter(Mandatory)][string]$BackupDir,
    [Parameter(Mandatory)][string]$InstallRoot, [string]$PgBin = '', [ValidateSet('None', 'Lan', 'Domain')][string]$Https = 'None', [string[]]$AllowedHosts = @()
  )
  $e = [ordered]@{
    NODE_ENV = 'production'
    PORT = [string]$Port
    APPBUILDER_HOST = '127.0.0.1'
    APPBUILDER_WORKSPACE = $Workspace
    APPBUILDER_BACKUP_DIR = $BackupDir
    APPBUILDER_INSTALL_ROOT = $InstallRoot
    APPBUILDER_SETUP_CODE_FILE = (Join-WinPath $Workspace 'setup-code.txt')
  }
  if ($PgBin) { $e['APPBUILDER_PG_BIN'] = $PgBin }
  if ($Https -ne 'None') {
    $e['APPBUILDER_ALLOWED_HOSTS'] = ($AllowedHosts -join ',')
    $e['APPBUILDER_TRUST_PROXY'] = '1'
  }
  return $e
}

function ConvertTo-EnvFileText {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Environment)
  $lines = @('# Appbuilder service environment (written by the installer; re-running it rewrites this file).', '# The service reads the same values from its WinSW configuration; restart it after a change.')
  foreach ($k in $Environment.Keys) {
    $v = [string]$Environment[$k]
    if ($v -match '[\r\n]') { throw "Environment value of $k contains a line break." }
    $lines += "$k=$v"
  }
  return (($lines -join "`r`n") + "`r`n")
}

function ConvertTo-XmlText {
  param([string]$Text)
  return [Security.SecurityElement]::Escape($Text)
}

function New-WinSWXml {
  <# WinSW 2.12 service definition: restart on failure, size-rolled logs, graceful stop, environment #>
  param(
    [Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Description,
    [Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string]$Arguments, [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string]$LogPath, [System.Collections.IDictionary]$Environment = @{}, [string[]]$DependsOn = @()
  )
  $sb = New-Object Text.StringBuilder
  [void]$sb.AppendLine('<?xml version="1.0" encoding="utf-8"?>')
  [void]$sb.AppendLine('<!-- written by the Appbuilder installer; re-running it rewrites this file -->')
  [void]$sb.AppendLine('<service>')
  [void]$sb.AppendLine("  <id>$(ConvertTo-XmlText $Id)</id>")
  [void]$sb.AppendLine("  <name>$(ConvertTo-XmlText $Name)</name>")
  [void]$sb.AppendLine("  <description>$(ConvertTo-XmlText $Description)</description>")
  [void]$sb.AppendLine("  <executable>$(ConvertTo-XmlText $Executable)</executable>")
  [void]$sb.AppendLine("  <arguments>$(ConvertTo-XmlText $Arguments)</arguments>")
  [void]$sb.AppendLine("  <workingdirectory>$(ConvertTo-XmlText $WorkingDirectory)</workingdirectory>")
  [void]$sb.AppendLine('  <startmode>Automatic</startmode>')
  [void]$sb.AppendLine('  <delayedAutoStart/>')
  foreach ($d in $DependsOn) { [void]$sb.AppendLine("  <depend>$(ConvertTo-XmlText $d)</depend>") }
  foreach ($k in $Environment.Keys) { [void]$sb.AppendLine("  <env name=`"$(ConvertTo-XmlText $k)`" value=`"$(ConvertTo-XmlText ([string]$Environment[$k]))`"/>") }
  [void]$sb.AppendLine('  <onfailure action="restart" delay="10 sec"/>')
  [void]$sb.AppendLine('  <onfailure action="restart" delay="30 sec"/>')
  [void]$sb.AppendLine('  <onfailure action="restart" delay="60 sec"/>')
  [void]$sb.AppendLine('  <resetfailure>1 hour</resetfailure>')
  [void]$sb.AppendLine('  <stoptimeout>30 sec</stoptimeout>')
  [void]$sb.AppendLine('  <stopparentprocessfirst>true</stopparentprocessfirst>')
  [void]$sb.AppendLine("  <logpath>$(ConvertTo-XmlText $LogPath)</logpath>")
  [void]$sb.AppendLine('  <log mode="roll-by-size">')
  [void]$sb.AppendLine('    <sizeThreshold>10240</sizeThreshold>')
  [void]$sb.AppendLine('    <keepFiles>8</keepFiles>')
  [void]$sb.AppendLine('  </log>')
  [void]$sb.AppendLine('</service>')
  return $sb.ToString()
}

function New-CaddyfileText {
  <# Lan: Caddy's own CA (tls internal) for the given names/IPs; Domain: automatic Let's Encrypt certificate #>
  param([Parameter(Mandatory)][ValidateSet('Lan', 'Domain')][string]$Mode, [Parameter(Mandatory)][int]$Port, [string[]]$Names = @(), [string]$Domain = '', [string]$AcmeEmail = '')
  $lines = @('# Appbuilder reverse proxy (written by the Appbuilder installer; re-running it rewrites this file)', '{')
  # Caddy runs as a virtual service account: it cannot (and must not) add its CA to the machine's trust store itself
  $lines += '	skip_install_trust'
  if ($Mode -eq 'Domain' -and $AcmeEmail) { $lines += "	email $AcmeEmail" }
  $lines += '}'
  if ($Mode -eq 'Domain') {
    if ($Domain -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$') { throw "Not a DNS name: $Domain" }
    $lines += "$Domain {"
    $lines += '	header Strict-Transport-Security "max-age=31536000"'
  } else {
    if (-not $Names -or $Names.Count -eq 0) { throw 'LAN mode needs at least one host name or address.' }
    foreach ($n in $Names) { if ($n -notmatch '^[A-Za-z0-9.:-]+$') { throw "Not a host name or address: $n" } }
    $lines += ((($Names | ForEach-Object { "https://$_" }) -join ', ') + ' {')
    $lines += '	tls internal'
  }
  $lines += '	encode zstd gzip'
  $lines += "	reverse_proxy 127.0.0.1:$Port"
  $lines += '}'
  return (($lines -join "`n") + "`n")
}

function New-CliWrapperText {
  <# appbuilder.cmd in the install folder: runs from that folder (%~dp0), never from inside app, which the updater renames #>
  return @"
@echo off
rem Appbuilder command-line tools (written by the installer): appbuilder version^|health^|update^|diagnostics^|restore^|verify-release
setlocal
cd /d "%~dp0"
"%~dp0node\node.exe" "%~dp0app\server\main.ts" %*
exit /b %ERRORLEVEL%
"@
}

#endregion

#region permissions

function Get-AclPlan {
  <#
    Who may do what, folder by folder (inheritance from the parent is cut; the rules apply to sub-folders and files):
      install folder   Administrators, SYSTEM: full; Users: read and run; the service account: read and run
      data folder      Administrators, SYSTEM: full; the service account: modify     (workspace, backups, logs, updates)
      config folder    Administrators, SYSTEM: full; the service account: read        (appbuilder.env)
      admin folder     Administrators, SYSTEM only                                     (the PostgreSQL superuser secret)
      pgsql (program)  as the install folder, plus PostgreSQL's service account: read and run
      pgdata           Administrators, SYSTEM: full; PostgreSQL's service account: full
      caddy data       Administrators, SYSTEM: full; Caddy's service account: modify
    ServiceAccount '' (before the service exists): Administrators and SYSTEM only (Users keep read on the install folder).
  #>
  param(
    [Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)][string]$DataDir, [AllowEmptyString()][string]$ServiceAccount = '',
    [string]$AdminDir = '', [string]$PgAccount = '', [string]$PgHome = '', [string]$PgData = '', [string]$CaddyAccount = '', [string]$CaddyData = ''
  )
  $admins = '*' + $script:SidAdministrators
  $system = '*' + $script:SidSystem
  $users = '*' + $script:SidUsers
  $base = @(@{ Identity = $admins; Rights = 'F' }, @{ Identity = $system; Rights = 'F' })
  $svc = { param($rights) if ($ServiceAccount) { ,@(@{ Identity = $ServiceAccount; Rights = $rights }) } else { ,@() } }
  $plan = @(
    [pscustomobject]@{ Path = $InstallDir; Rules = @($base + @(@{ Identity = $users; Rights = 'RX' }) + (& $svc 'RX')) }
    [pscustomobject]@{ Path = $DataDir; Rules = @($base + (& $svc 'M')) }
    [pscustomobject]@{ Path = (Join-WinPath $DataDir 'config'); Rules = @($base + (& $svc 'R')) }
  )
  if ($AdminDir) { $plan += [pscustomobject]@{ Path = $AdminDir; Rules = @($base) } }
  if ($PgAccount -and $PgHome) {
    $plan += [pscustomobject]@{ Path = $PgHome; Rules = @($base + @(@{ Identity = $users; Rights = 'RX' }, @{ Identity = $PgAccount; Rights = 'RX' }) + (& $svc 'RX')) }
  }
  if ($PgAccount -and $PgData) {
    $plan += [pscustomobject]@{ Path = $PgData; Rules = @($base + @(@{ Identity = $PgAccount; Rights = 'F' })) }
  }
  if ($CaddyAccount -and $CaddyData) {
    $plan += [pscustomobject]@{ Path = $CaddyData; Rules = @($base + @(@{ Identity = $CaddyAccount; Rights = 'M' })) }
  }
  return $plan
}

function ConvertTo-IcaclsArguments {
  <# one plan entry -> icacls.exe arguments: remove inherited entries, replace grants, inherit to children #>
  param([Parameter(Mandatory)]$Entry)
  $a = @($Entry.Path, '/inheritance:r')
  foreach ($r in $Entry.Rules) { $a += '/grant:r'; $a += ('{0}:(OI)(CI){1}' -f $r.Identity, $r.Rights) }
  $a += '/C'; $a += '/Q'
  return $a
}

#endregion

#region PostgreSQL ZIP

function Test-PgZipEntry {
  <# which entries of the EDB binaries ZIP are unpacked: the server and client programs, not pgAdmin, StackBuilder, docs, headers #>
  param([Parameter(Mandatory)][string]$Name)
  $n = $Name -replace '\\', '/'
  if ($n -notmatch '^pgsql/(bin|lib|share)/') { return $false }
  if ($n -match '^pgsql/bin/(wx[^/]*\.dll|stackbuilder\.exe|pgAdmin[^/]*)$') { return $false }
  if ($n.EndsWith('/')) { return $false }
  return $true
}

#endregion

Export-ModuleMember -Function *
