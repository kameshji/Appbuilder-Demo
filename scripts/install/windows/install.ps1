<#
.SYNOPSIS
  Installs (or repairs) Appbuilder on a Windows PC or server: Node.js, PostgreSQL 17, the Appbuilder service, optional
  HTTPS with Caddy. Run from the unpacked release folder in an elevated Windows PowerShell 5.1 (or PowerShell 7):

    powershell -ExecutionPolicy Bypass -File .\scripts\install\windows\install.ps1

.DESCRIPTION
  Steps (each prints what it does; -WhatIf prints them without changing anything):
    1. checks Windows (10/11, Server 2016+, 64-bit), memory, disk space, administrator rights;
    2. checks every release file against SHA256SUMS;
    3. Node.js: the pinned version from manifest.txt into <InstallDir>\node (checksum verified);
    4. PostgreSQL: uses a PostgreSQL 15+ that already answers on -PgPort (asks for its superuser password once), or
       installs PostgreSQL 17 from the EDB binaries ZIP (checksum verified) as the service appbuilder-postgresql under
       its own virtual account, data in <DataDir>\pgdata, listening on 127.0.0.1 only;
    5. creates the role and database with a random password made on this PC, never shown, sealed into
       <DataDir>\workspace\server.json by Appbuilder's own code (the setup wizard then skips its database step);
    6. installs the release into <InstallDir>\app (the previous one is kept as app.previous);
    7. runs Appbuilder as the service "Appbuilder" (WinSW) under the virtual account NT SERVICE\Appbuilder, restarted on
       failure, logs rolled by size; folders get tight ACLs (data: SYSTEM, Administrators, the service account only);
    8. optional HTTPS: Caddy as the service "Appbuilder-Caddy" (-Https Lan: its own certificate authority; -Https Domain:
       automatic Let's Encrypt certificate); the firewall is opened only with -OpenFirewall;
    9. a Start-menu shortcut, the command appbuilder.cmd, and the first-run URL and setup code location.
  Re-running repairs: present and intact pieces are kept, the database password is only replaced when it stopped working.

.PARAMETER Https
  None (default): only this PC (http://localhost:5174). Lan: https://<this PC's names> for the local network.
  Domain: https://<-Domain> from the internet (ports 80 and 443 must reach this PC).
.PARAMETER Offline
  A folder made by scripts/install/prepare-offline.mjs: every download is taken from there (still checksum-verified).
.EXAMPLE
  .\scripts\install\windows\install.ps1
.EXAMPLE
  .\scripts\install\windows\install.ps1 -Https Lan -OpenFirewall
.EXAMPLE
  .\scripts\install\windows\install.ps1 -Offline D:\appbuilder-bundle -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('None', 'Lan', 'Domain')][string]$Https = 'None',
  [string]$Domain = '',
  [string]$AcmeEmail = '',
  [string[]]$LanNames = @(),
  [switch]$OpenFirewall,
  [ValidateSet('Auto', 'Install', 'Existing')][string]$Postgres = 'Auto',
  [int]$PgPort = 5432,
  [string]$PgSuperUser = 'postgres',
  [int]$Port = 5174,
  [string]$Offline = '',
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'Appbuilder'),
  [string]$DataDir = (Join-Path $env:ProgramData 'Appbuilder'),
  [switch]$Yes,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$InstallerVersion = '1'
$DryRun = [bool]$WhatIfPreference
# cmdlets must not print their own "What if" lines: this script prints every action itself
$WhatIfPreference = $false

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here 'AppbuilderSetup.psm1') -Force
$ReleaseDir = (Resolve-Path (Join-Path $here '..\..\..')).ProviderPath
$Manifest = Read-Manifest (Join-Path $here '..\manifest.txt')
$Started = Get-Date

$ServiceId = 'Appbuilder'
$ServiceAccount = "NT SERVICE\$ServiceId"
$PgServiceId = 'appbuilder-postgresql'
$PgAccount = "NT SERVICE\$PgServiceId"
$CaddyId = 'Appbuilder-Caddy'
$CaddyAccount = "NT SERVICE\$CaddyId"
$DbName = 'appbuilder'; $DbUser = 'appbuilder'
$AppDir = Join-Path $InstallDir 'app'
$NodeDir = Join-Path $InstallDir 'node'
$NodeExe = Join-Path $NodeDir 'node.exe'
$PgHome = Join-Path $InstallDir 'pgsql'
$SvcDir = Join-Path $InstallDir 'service'
$CaddyDir = Join-Path $InstallDir 'caddy'
$Workspace = Join-Path $DataDir 'workspace'
$Backups = Join-Path $DataDir 'backups'
$LogDir = Join-Path $DataDir 'logs'
$ConfigDir = Join-Path $DataDir 'config'
$PgData = Join-Path $DataDir 'pgdata'
$CaddyData = Join-Path $DataDir 'caddy'
$EnvFile = Join-Path $ConfigDir 'appbuilder.env'
$AdminDir = Join-Path $DataDir 'admin'
$PgSecretFile = Join-Path $AdminDir 'pg-superuser.dpapi'
$script:Step = 0

function Write-Step([string]$Text) { $script:Step++; Write-Host ''; Write-Host "[$script:Step] $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "  $Text" }
function Write-Warn2([string]$Text) { Write-Host "  WARNING: $Text" -ForegroundColor Yellow }
function Stop-Install([string]$Text) { Write-Host "ERROR: $Text" -ForegroundColor Red; exit 1 }

<# every change goes through Invoke-Action: printed (and skipped) in -WhatIf mode #>
function Invoke-Action([string]$Description, [scriptblock]$Action) {
  if ($DryRun) { Write-Host "  would: $Description" -ForegroundColor DarkGray; return $null }
  Write-Verbose $Description
  return & $Action
}

<# a native command; throws with its output when it fails #>
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$StdIn = $null) {
  $display = "$Exe $($Arguments -join ' ')"
  if ($DryRun) { Write-Host "  would run: $display" -ForegroundColor DarkGray; return '' }
  $r = Invoke-NativeCapture -Exe $Exe -Arguments $Arguments -StdIn $StdIn
  if ($r.ExitCode -ne 0) { throw "$display failed (exit $($r.ExitCode)): $($r.Output)" }
  return $r.Output
}

<# runs a native program, stdout+stderr captured as text. Windows PowerShell 5.1 turns redirected stderr lines into
   terminating errors when $ErrorActionPreference is Stop, so it is Continue inside this function only. #>
function Invoke-NativeCapture([string]$Exe, [string[]]$Arguments, [string]$StdIn = $null) {
  $ErrorActionPreference = 'Continue'
  if ($null -ne $StdIn -and $StdIn -ne '') { $out = $StdIn | & $Exe @Arguments 2>&1 } else { $out = & $Exe @Arguments 2>&1 }
  $code = $LASTEXITCODE
  $text = ($out | ForEach-Object { if ($_ -is [Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ } }) -join "`n"
  return [pscustomobject]@{ ExitCode = $code; Output = $text }
}

function Get-Download([string]$Key, [string]$Destination) {
  $item = Get-ManifestItem -Manifest $Manifest -Key $Key
  if ($Offline) {
    $src = Join-Path $Offline $item.FileName
    if (-not (Test-Path -LiteralPath $src)) { Stop-Install "The offline bundle $Offline has no $($item.FileName) (prepare it with scripts/install/prepare-offline.mjs)." }
    Invoke-Action "copy $src" { Copy-Item -LiteralPath $src -Destination $Destination -Force } | Out-Null
  } else {
    Invoke-Action "download $($item.Url)" {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $pp = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
      try { Invoke-WebRequest -UseBasicParsing -Uri $item.Url -OutFile $Destination -MaximumRedirection 5 } finally { $ProgressPreference = $pp }
    } | Out-Null
  }
  if (-not $DryRun) {
    if (-not (Test-FileChecksum -Path $Destination -Algorithm $item.Algorithm -Expected $item.Hash)) {
      Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
      Stop-Install "$($item.FileName): the $($item.Algorithm) checksum does not match the pinned value. The file is damaged or not the expected version; nothing was installed from it."
    }
    Write-Info "$($item.FileName): $($item.Algorithm) checksum ok"
  }
  return $item
}

function Test-TcpPort([string]$HostName, [int]$PortNumber) {
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect($HostName, $PortNumber); $c.Close(); return $true } catch { return $false }
}

function Get-Health {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 3
    return ($r.Content | ConvertFrom-Json).status
  } catch {
    $resp = $null
    if ($_.Exception.PSObject.Properties['Response']) { $resp = $_.Exception.Response }
    if ($resp) { try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); return ($sr.ReadToEnd() | ConvertFrom-Json).status } catch { return 'down' } }
    return 'down'
  }
}

function Set-FolderAcl($Entry) {
  Invoke-Native 'icacls.exe' (ConvertTo-IcaclsArguments $Entry) | Out-Null
}

function Install-WinSWService([string]$Id, [string]$Xml, [string]$Account) {
  $exe = Join-Path $SvcDir "$Id.exe"
  $xmlPath = Join-Path $SvcDir "$Id.xml"
  if (Get-Service -Name $Id -ErrorAction SilentlyContinue) {
    Invoke-Action "stop and unregister the service $Id (re-registered below)" {
      Stop-Service -Name $Id -Force -ErrorAction SilentlyContinue
      & $exe uninstall | Out-Null
      for ($i = 0; $i -lt 30 -and (Get-Service -Name $Id -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
    } | Out-Null
  }
  Invoke-Action "write $xmlPath" { [IO.File]::WriteAllText($xmlPath, $Xml, (New-Object Text.UTF8Encoding($false))) } | Out-Null
  Invoke-Native $exe @('install') | Out-Null
  # a virtual service account: no password, its own SID for ACLs, no administrator rights
  Invoke-Native 'sc.exe' @('config', $Id, 'obj=', $Account) | Out-Null
  Invoke-Native 'sc.exe' @('failureflag', $Id, '1') | Out-Null
}

# ------------------------------------------------------------------ 1. checks
Write-Step 'Checking this computer'
$isAdmin = $false
try { $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { $isAdmin = $false }
if (-not $isAdmin -and -not $DryRun) { Stop-Install 'Run this in an elevated PowerShell (right-click PowerShell > Run as administrator).' }
if (-not (Test-Path (Join-Path $ReleaseDir 'release.json'))) { Stop-Install "$ReleaseDir is not an unpacked Appbuilder release (release.json missing)." }
$os = [Environment]::OSVersion.Version
if (-not [Environment]::Is64BitOperatingSystem) { Stop-Install 'A 64-bit Windows is required.' }
if ($os.Major -lt 10 -or $os.Build -lt 14393) { if (-not $Force) { Stop-Install "Windows $os is not supported (Windows 10/11 or Server 2016 and newer). -Force tries anyway." } }
$memGb = [Math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
if ($memGb -lt 3.5) { Stop-Install "At least 4 GB of memory is needed (found $memGb GB)." }
if ($memGb -lt 7.5) { Write-Warn2 "$memGb GB of memory: 8 GB is recommended when PostgreSQL runs on the same PC for 20-50 users." }
$drive = Get-PSDrive -Name ($DataDir.Substring(0, 1))
$freeGb = [Math]::Round($drive.Free / 1GB, 1)
if ($freeGb -lt 3) { Stop-Install "At least 3 GB free disk space is needed on $($drive.Name): (found $freeGb GB)." }
if ($Https -eq 'Domain' -and -not $Domain) { Stop-Install '-Https Domain needs -Domain <public DNS name>.' }
if ($OpenFirewall -and $Https -eq 'None') { Stop-Install '-OpenFirewall only makes sense with -Https Lan or Domain: Appbuilder itself only listens on 127.0.0.1.' }
$release = Get-Content -Raw (Join-Path $ReleaseDir 'release.json') | ConvertFrom-Json
Write-Info "Windows $os, $memGb GB memory, $freeGb GB free on $($drive.Name):"
Write-Info "Installing Appbuilder $($release.version) ($($release.commit.Substring(0, [Math]::Min(12, $release.commit.Length)))) to $InstallDir, data in $DataDir"
if ($DryRun) { Write-Info 'DRY RUN (-WhatIf): nothing is changed; every action is printed.' }

# ------------------------------------------------------------------ 2. release files
Write-Step 'Checking the release files against SHA256SUMS'
$check = Test-ReleaseChecksums -ReleaseDir $ReleaseDir
if (-not $check.Ok) { Stop-Install ("Release files do not match SHA256SUMS: missing {0}, changed {1}, not listed {2} (first: {3}). Unpack the ZIP again." -f $check.Missing.Count, $check.Changed.Count, $check.Extra.Count, (@($check.Missing) + @($check.Changed) + @($check.Extra) | Select-Object -First 3) -join ', ') }
Write-Info "$($check.Files) files ok"

# ------------------------------------------------------------------ 3. folders and ACLs
Write-Step 'Folders and permissions'
foreach ($d in @($InstallDir, $SvcDir, $DataDir, $Workspace, $Backups, $LogDir, $ConfigDir, $AdminDir, (Join-Path $DataDir 'updates'))) {
  if (-not (Test-Path -LiteralPath $d)) { Invoke-Action "create $d" { New-Item -ItemType Directory -Path $d -Force | Out-Null } | Out-Null }
}
# The service accounts exist only once their services are registered (steps 5 and 8). Until then the folders are closed
# to everyone but SYSTEM and Administrators, so nothing secret is ever written into a folder others can read.
foreach ($entry in (Get-AclPlan -InstallDir $InstallDir -DataDir $DataDir -ServiceAccount '' -AdminDir $AdminDir)) { Set-FolderAcl $entry }
Write-Info "$InstallDir, $DataDir (SYSTEM and Administrators only until the services exist)"

# ------------------------------------------------------------------ 4. Node.js
Write-Step "Node.js $($Manifest['node.version'])"
$wantNode = "v$($Manifest['node.version'])"
$haveNode = ''
if (Test-Path -LiteralPath $NodeExe) { $haveNode = (& $NodeExe --version) }
if ($haveNode -eq $wantNode) { Write-Info "already installed ($NodeExe)" }
else {
  $tmp = Join-Path $env:TEMP "appbuilder-node-$PID.zip"
  $item = Get-Download -Key 'node.win-x64' -Destination $tmp
  Invoke-Action "unpack Node.js into $NodeDir" {
    $unpack = "$NodeDir.unpack"
    if (Test-Path $unpack) { Remove-Item -Recurse -Force $unpack }
    Expand-Archive -LiteralPath $tmp -DestinationPath $unpack -Force
    $inner = Get-ChildItem -LiteralPath $unpack -Directory | Select-Object -First 1
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Move-Item -LiteralPath $inner.FullName -Destination $NodeDir
    Remove-Item -Recurse -Force $unpack, $tmp
  } | Out-Null
  if (-not $DryRun) { Write-Info "$(& $NodeExe --version) in $NodeDir" }
}
if (-not $DryRun) {
  if (-not (Test-NodeVersion -Version (& $NodeExe --version) -Requirement $release.node)) { Stop-Install "Node.js $(& $NodeExe --version) does not meet $($release.node)." }
  Write-Info (Invoke-NativeCapture -Exe $NodeExe -Arguments @((Join-Path $ReleaseDir 'server\main.ts'), 'verify-release', $ReleaseDir, '--allow-unsigned')).Output
}

# ------------------------------------------------------------------ 5. PostgreSQL
Write-Step 'PostgreSQL'
$pgOurs = [bool](Get-Service -Name $PgServiceId -ErrorAction SilentlyContinue)
$portBusy = Test-TcpPort '127.0.0.1' $PgPort
$superPassword = $null
$psql = Join-Path $PgHome 'bin\psql.exe'
if ($pgOurs) {
  Write-Info "the PostgreSQL installed by Appbuilder ($PgServiceId) is present"
  if ((Get-Service $PgServiceId).Status -ne 'Running') { Invoke-Action "start $PgServiceId" { Start-Service $PgServiceId } | Out-Null }
  if (Test-Path -LiteralPath $PgSecretFile) { $superPassword = Unprotect-MachineSecret (Get-Content -Raw -LiteralPath $PgSecretFile).Trim() }
  $PgMode = 'installed'
} elseif ($portBusy -and $Postgres -ne 'Install') {
  $PgMode = 'existing'
  Write-Info "a PostgreSQL server answers on 127.0.0.1:${PgPort}: Appbuilder will use it (its own role and database)."
  # its psql: PATH, or the usual EDB folders
  $cand = @(Get-Command psql.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  $cand += @(Get-ChildItem -Path (Join-Path $env:ProgramFiles 'PostgreSQL') -Directory -ErrorAction SilentlyContinue | Sort-Object { [int]($_.Name -replace '\D', '') } -Descending | ForEach-Object { Join-Path $_.FullName 'bin\psql.exe' })
  $psql = $cand | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $psql) { Stop-Install 'psql.exe of the existing PostgreSQL was not found. Add its bin folder to PATH, or use -Postgres Install -PgPort 5433 for a separate one.' }
  if (-not $DryRun) {
    $sec = Read-Host -Prompt "Password of the PostgreSQL superuser '$PgSuperUser' (used once, not stored)" -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $superPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  }
} elseif ($portBusy -and $Postgres -eq 'Install') {
  Stop-Install "Port $PgPort is in use. Choose another with -PgPort (for example 5433)."
} elseif ($Postgres -eq 'Existing') {
  Stop-Install "No PostgreSQL answers on 127.0.0.1:$PgPort."
} else {
  $PgMode = 'installed'
  Write-Info "installing PostgreSQL $($Manifest['postgres.version']) as the service $PgServiceId (127.0.0.1:$PgPort, data in $PgData)"
  $tmp = Join-Path $env:TEMP "appbuilder-pgsql-$PID.zip"
  [void](Get-Download -Key 'postgres.win-x64' -Destination $tmp)
  Invoke-Action "unpack pgsql\bin, lib and share into $PgHome (not pgAdmin, StackBuilder, docs)" {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($tmp)
    try {
      foreach ($e in $zip.Entries) {
        if (-not (Test-PgZipEntry $e.FullName)) { continue }
        $rel = $e.FullName.Substring('pgsql/'.Length) -replace '/', '\'
        $dst = Join-Path $PgHome $rel
        $full = [IO.Path]::GetFullPath($dst)
        if (-not $full.StartsWith([IO.Path]::GetFullPath($PgHome))) { throw "unsafe path in the ZIP: $($e.FullName)" }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $full) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $full, $true)
      }
    } finally { $zip.Dispose() }
    Remove-Item -Force $tmp
  } | Out-Null
  # superuser password: random, kept DPAPI-protected (machine scope) in a file only SYSTEM and Administrators can read,
  # so that re-running the installer can repair the role and database
  $superPassword = New-RandomPassword 40
  Invoke-Action "create $PgSecretFile (SYSTEM and Administrators only)" {
    [IO.File]::WriteAllText($PgSecretFile, (Protect-MachineSecret $superPassword))
  } | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $PgData 'PG_VERSION'))) {
    Invoke-Action "initdb $PgData (UTF8, scram-sha-256)" {
      New-Item -ItemType Directory -Force -Path $PgData | Out-Null
      # initdb.exe drops administrator rights (it re-runs itself with a restricted token), so the Administrators group
      # entry does not help it: the installing user needs an explicit entry on the data folder and on the password
      # file while initdb runs. Both entries are removed again below, and ownership goes to Administrators.
      $meSid = '*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      Set-FolderAcl ([pscustomobject]@{ Path = $PgData; Rules = @(@{ Identity = '*S-1-5-32-544'; Rights = 'F' }, @{ Identity = '*S-1-5-18'; Rights = 'F' }, @{ Identity = $meSid; Rights = 'F' }) })
      $pwDir = Join-Path $DataDir "initdb-$PID"
      New-Item -ItemType Directory -Force -Path $pwDir | Out-Null
      Set-FolderAcl ([pscustomobject]@{ Path = $pwDir; Rules = @(@{ Identity = '*S-1-5-18'; Rights = 'F' }, @{ Identity = $meSid; Rights = 'F' }) })
      $pwFile = Join-Path $pwDir 'pw.tmp'
      [IO.File]::WriteAllText($pwFile, $superPassword)
      try {
        $r = Invoke-NativeCapture -Exe (Join-Path $PgHome 'bin\initdb.exe') -Arguments @('-D', $PgData, '-U', $PgSuperUser, '-E', 'UTF8', '--locale=C', '-A', 'scram-sha-256', "--pwfile=$pwFile")
        if ($r.ExitCode -ne 0) { throw "initdb failed: $($r.Output)" }
      } finally {
        Remove-Item -Force -Recurse -LiteralPath $pwDir -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $PgData) {
          Invoke-Native 'icacls.exe' @($PgData, '/setowner', '*S-1-5-32-544', '/T', '/C', '/Q') | Out-Null
          Invoke-Native 'icacls.exe' @($PgData, '/remove:g', $meSid, '/T', '/C', '/Q') | Out-Null
        }
      }
      Add-Content -LiteralPath (Join-Path $PgData 'postgresql.conf') -Value "`r`n# Appbuilder installer`r`nlisten_addresses = '127.0.0.1'`r`nport = $PgPort`r`n" -Encoding ASCII
    } | Out-Null
  }
  Invoke-Native (Join-Path $PgHome 'bin\pg_ctl.exe') @('register', '-N', $PgServiceId, '-D', $PgData, '-S', 'auto', '-w') | Out-Null
  Invoke-Native 'sc.exe' @('config', $PgServiceId, 'obj=', $PgAccount) | Out-Null
  Invoke-Native 'sc.exe' @('failure', $PgServiceId, 'reset=', '3600', 'actions=', 'restart/10000/restart/30000/restart/60000') | Out-Null
  Set-FolderAcl ([pscustomobject]@{ Path = $PgHome; Rules = @(@{ Identity = '*S-1-5-32-544'; Rights = 'F' }, @{ Identity = '*S-1-5-18'; Rights = 'F' }, @{ Identity = '*S-1-5-32-545'; Rights = 'RX' }, @{ Identity = $PgAccount; Rights = 'RX' }) })
  Set-FolderAcl ([pscustomobject]@{ Path = $PgData; Rules = @(@{ Identity = '*S-1-5-32-544'; Rights = 'F' }, @{ Identity = '*S-1-5-18'; Rights = 'F' }, @{ Identity = $PgAccount; Rights = 'F' }) })
  Invoke-Action "start $PgServiceId" { Start-Service $PgServiceId } | Out-Null
  if (-not $DryRun) {
    for ($i = 0; $i -lt 60 -and -not (Test-TcpPort '127.0.0.1' $PgPort); $i++) { Start-Sleep 1 }
    if (-not (Test-TcpPort '127.0.0.1' $PgPort)) { Stop-Install "PostgreSQL did not start (see $PgData\log and the Windows event log)." }
  }
}
$PgBin = Split-Path -Parent $psql
Write-Info "client tools: $PgBin"

# ------------------------------------------------------------------ 6. the app
Write-Step "Appbuilder $($release.version)"
$same = $false
if (Test-Path -LiteralPath (Join-Path $AppDir 'release.json')) {
  $installed = Get-Content -Raw (Join-Path $AppDir 'release.json') | ConvertFrom-Json
  if ($installed.version -eq $release.version -and $installed.commit -eq $release.commit -and (Test-ReleaseChecksums -ReleaseDir $AppDir).Ok) { $same = $true }
}
if ($same) { Write-Info 'already installed and intact' }
else {
  if ((Test-Path -LiteralPath $AppDir) -and -not $Yes -and -not $DryRun) {
    $a = Read-Host "  $AppDir holds another or a damaged release. Replace it (the old one is kept as app.previous)? [y/N]"
    if ($a -notmatch '^[Yy]') { Stop-Install 'Cancelled.' }
  }
  if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) { Invoke-Action "stop $ServiceId" { Stop-Service $ServiceId -Force } | Out-Null }
  Invoke-Action "copy the release into $AppDir (previous release kept as app.previous)" {
    $staging = Join-Path $InstallDir 'app.staging'
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    Copy-Item -LiteralPath $ReleaseDir -Destination $staging -Recurse
    $prev = Join-Path $InstallDir 'app.previous'
    if (Test-Path $AppDir) { if (Test-Path $prev) { Remove-Item -Recurse -Force $prev }; Rename-Item -LiteralPath $AppDir -NewName 'app.previous' }
    Rename-Item -LiteralPath $staging -NewName 'app'
  } | Out-Null
}

# ------------------------------------------------------------------ 7. role, database, saved login
Write-Step "Database $DbName and role $DbUser"
$main = Join-Path $AppDir 'server\main.ts'
$needPassword = $true
if (-not $DryRun -and (Test-Path -LiteralPath (Join-Path $Workspace 'server.json'))) {
  $env:APPBUILDER_WORKSPACE = $Workspace
  if ((Invoke-NativeCapture -Exe $NodeExe -Arguments @($main, 'db-check')).ExitCode -eq 0) { $needPassword = $false; Write-Info 'the saved database login works: kept' }
  else { Write-Info 'the saved database login does not work: setting a new password' }
}
if ($needPassword) {
  if (-not $superPassword -and -not $DryRun) { Stop-Install "The PostgreSQL superuser password is needed to repair the role (it was not found in $PgSecretFile)." }
  $dbPassword = New-RandomPassword 40
  $sql = New-RoleSql -Role $DbUser -Database $DbName -Verifier (New-ScramVerifier $dbPassword)
  Invoke-Action "create or update the role $DbUser and the database $DbName (psql, SQL on standard input)" {
    $env:PGPASSWORD = $superPassword
    try { $r = Invoke-NativeCapture -Exe $psql -Arguments @('-X', '-q', '-h', '127.0.0.1', '-p', [string]$PgPort, '-U', $PgSuperUser, '-d', 'postgres') -StdIn $sql }
    finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
    if ($r.ExitCode -ne 0) { throw "psql failed (exit $($r.ExitCode)): $($r.Output)" }
  } | Out-Null
  $sql = $null
  Invoke-Action "seal the password into $Workspace\server.json (Appbuilder's own code, password on standard input)" {
    $env:APPBUILDER_WORKSPACE = $Workspace
    $r = Invoke-NativeCapture -Exe $NodeExe -Arguments @($main, 'seed-config', '--workspace', $Workspace, '--db-host', '127.0.0.1', '--db-port', [string]$PgPort, '--db-name', $DbName, '--db-user', $DbUser, '--test') -StdIn $dbPassword
    if ($r.ExitCode -ne 0) { throw "seed-config failed: $($r.Output)" }
    Write-Info $r.Output
  } | Out-Null
  $dbPassword = $null
}
$superPassword = $null

# ------------------------------------------------------------------ 8. configuration and service
Write-Step 'Service Appbuilder'
$names = @()
if ($Https -eq 'Lan') {
  if ($LanNames.Count -gt 0) { $names = $LanNames }
  else {
    $names = @($env:COMPUTERNAME.ToLowerInvariant())
    try { $fqdn = [Net.Dns]::GetHostEntry('localhost').HostName.ToLowerInvariant(); if ($fqdn -and $names -notcontains $fqdn) { $names += $fqdn } } catch { Write-Verbose 'no FQDN' }
    $names += @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress })
  }
} elseif ($Https -eq 'Domain') { $names = @($Domain) }
$envMap = New-ServiceEnvironment -Port $Port -Workspace $Workspace -BackupDir $Backups -InstallRoot $InstallDir -PgBin $PgBin -Https $Https -AllowedHosts $names
Invoke-Action "write $EnvFile" { [IO.File]::WriteAllText($EnvFile, (ConvertTo-EnvFileText $envMap)) } | Out-Null
$installJson = [ordered]@{
  platform = 'windows'; root = $InstallDir; dataDir = $DataDir; workspace = $Workspace; serviceName = $ServiceId; serviceAccount = $ServiceAccount
  port = $Port; node = $NodeExe; https = $Https.ToLowerInvariant(); envFile = $EnvFile; postgres = $PgMode; pgService = $(if ($PgMode -eq 'installed') { $PgServiceId } else { '' })
  installerVersion = $InstallerVersion; installedOn = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}
Invoke-Action "write $InstallDir\install.json" { [IO.File]::WriteAllText((Join-Path $InstallDir 'install.json'), ($installJson | ConvertTo-Json), (New-Object Text.UTF8Encoding($false))) } | Out-Null
Invoke-Action "write $InstallDir\appbuilder.cmd" { [IO.File]::WriteAllText((Join-Path $InstallDir 'appbuilder.cmd'), (New-CliWrapperText), [Text.Encoding]::ASCII) } | Out-Null
$winsw = Join-Path $SvcDir "$ServiceId.exe"
if (-not (Test-Path -LiteralPath $winsw) -or -not (Test-FileChecksum -Path $winsw -Algorithm SHA256 -Expected $Manifest['winsw.win.sha256'])) {
  [void](Get-Download -Key 'winsw.win' -Destination $winsw)
}
$deps = @(); if ($PgMode -eq 'installed') { $deps = @($PgServiceId) }
$xml = New-WinSWXml -Id $ServiceId -Name 'Appbuilder' -Description 'Appbuilder server (Node.js)' -Executable $NodeExe -Arguments "`"$main`"" -WorkingDirectory $DataDir -LogPath $LogDir -Environment $envMap -DependsOn $deps
Install-WinSWService -Id $ServiceId -Xml $xml -Account $ServiceAccount
$pgAcl = @{}; if ($PgMode -eq 'installed') { $pgAcl = @{ PgAccount = $PgAccount; PgHome = $PgHome } }
foreach ($entry in (Get-AclPlan -InstallDir $InstallDir -DataDir $DataDir -ServiceAccount $ServiceAccount -AdminDir $AdminDir @pgAcl)) { Set-FolderAcl $entry }
Invoke-Action "start $ServiceId" { Start-Service $ServiceId } | Out-Null
if (-not $DryRun) {
  $st = 'down'
  for ($i = 0; $i -lt 180 -and $st -ne 'ok'; $i++) { Start-Sleep 1; $st = Get-Health }
  if ($st -ne 'ok') { Stop-Install "Appbuilder did not become healthy (last answer: $st). See $LogDir and $Workspace\logs\appbuilder.log." }
  Write-Info 'running; GET /api/v1/health: ok'
}

# ------------------------------------------------------------------ 9. HTTPS (optional)
$caFile = $null
if ($Https -ne 'None') {
  Write-Step "HTTPS with Caddy ($Https)"
  $caddyExe = Join-Path $CaddyDir 'caddy.exe'
  $haveCaddy = (Test-Path -LiteralPath $caddyExe) -and ((& $caddyExe version 2>$null | Out-String) -match [regex]::Escape("v$($Manifest['caddy.version'])"))
  if (-not $haveCaddy) {
    $tmp = Join-Path $env:TEMP "appbuilder-caddy-$PID.zip"
    [void](Get-Download -Key 'caddy.win-x64' -Destination $tmp)
    Invoke-Action "unpack caddy.exe into $CaddyDir" {
      New-Item -ItemType Directory -Force -Path $CaddyDir | Out-Null
      Expand-Archive -LiteralPath $tmp -DestinationPath "$CaddyDir.unpack" -Force
      Copy-Item -Force (Join-Path "$CaddyDir.unpack" 'caddy.exe') $caddyExe
      Copy-Item -Force (Join-Path "$CaddyDir.unpack" 'LICENSE') (Join-Path $CaddyDir 'LICENSE')
      Remove-Item -Recurse -Force "$CaddyDir.unpack", $tmp
    } | Out-Null
  }
  if (-not (Test-Path -LiteralPath $CaddyData)) { Invoke-Action "create $CaddyData" { New-Item -ItemType Directory -Force -Path $CaddyData | Out-Null } | Out-Null }
  $caddyfile = Join-Path $CaddyData 'Caddyfile'
  Invoke-Action "write $caddyfile" { [IO.File]::WriteAllText($caddyfile, (New-CaddyfileText -Mode $Https -Port $Port -Names $names -Domain $Domain -AcmeEmail $AcmeEmail), (New-Object Text.UTF8Encoding($false))) } | Out-Null
  if (-not $DryRun) { Invoke-Native $caddyExe @('validate', '--config', $caddyfile, '--adapter', 'caddyfile') | Out-Null }
  $caddyEnv = [ordered]@{ XDG_DATA_HOME = (Join-Path $CaddyData 'data'); XDG_CONFIG_HOME = (Join-Path $CaddyData 'config') }
  Invoke-Action "copy WinSW for $CaddyId" { Copy-Item -Force $winsw (Join-Path $SvcDir "$CaddyId.exe") } | Out-Null
  $cxml = New-WinSWXml -Id $CaddyId -Name 'Appbuilder HTTPS (Caddy)' -Description 'Caddy reverse proxy in front of Appbuilder' -Executable $caddyExe -Arguments "run --config `"$caddyfile`" --adapter caddyfile" -WorkingDirectory $CaddyData -LogPath $LogDir -Environment $caddyEnv -DependsOn @($ServiceId)
  Install-WinSWService -Id $CaddyId -Xml $cxml -Account $CaddyAccount
  foreach ($entry in (Get-AclPlan -InstallDir $InstallDir -DataDir $DataDir -ServiceAccount $ServiceAccount -CaddyAccount $CaddyAccount -CaddyData $CaddyData)) { if ($entry.Path -eq $CaddyData) { Set-FolderAcl $entry } }
  Invoke-Native 'icacls.exe' @($LogDir, '/grant', "${CaddyAccount}:(OI)(CI)M", '/C', '/Q') | Out-Null
  Invoke-Action "start $CaddyId" { Start-Service $CaddyId } | Out-Null
  if ($Https -eq 'Lan' -and -not $DryRun) {
    $root = Join-Path $CaddyData 'data\caddy\pki\authorities\local\root.crt'
    for ($i = 0; $i -lt 30 -and -not (Test-Path $root); $i++) { Start-Sleep 1 }
    if (Test-Path $root) {
      $caFile = Join-Path $DataDir 'appbuilder-local-ca.crt'
      Copy-Item -Force $root $caFile
      Invoke-Native 'icacls.exe' @($caFile, '/grant', '*S-1-5-32-545:R', '/C', '/Q') | Out-Null
      # this PC trusts it, so the browser here opens https://<name>/ without a warning
      Import-Certificate -FilePath $caFile -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    } else { Write-Warn2 'Caddy has not created its certificate authority yet (see the Appbuilder-Caddy logs).' }
  }
  if ($OpenFirewall) {
    Invoke-Action 'remove older Appbuilder firewall rules' { Get-NetFirewallRule -Group 'Appbuilder' -ErrorAction SilentlyContinue | Remove-NetFirewallRule } | Out-Null
    if ($Https -eq 'Lan') {
      Invoke-Action 'firewall: allow TCP 443 from the local subnet (Domain and Private networks only)' { New-NetFirewallRule -DisplayName 'Appbuilder HTTPS (LAN)' -Group 'Appbuilder' -Direction Inbound -Protocol TCP -LocalPort 443 -RemoteAddress LocalSubnet -Profile Domain, Private -Action Allow | Out-Null } | Out-Null
    } else {
      Invoke-Action 'firewall: allow TCP 80 and 443 (certificate issuance, redirect, HTTPS)' { New-NetFirewallRule -DisplayName 'Appbuilder HTTPS' -Group 'Appbuilder' -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow | Out-Null } | Out-Null
    }
  } else { Write-Info 'The firewall was not changed (-OpenFirewall opens port 443).' }
}

# ------------------------------------------------------------------ 10. shortcut and summary
Write-Step 'Start menu'
$menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Appbuilder'
Invoke-Action "create the Start-menu shortcut $menu\Appbuilder.url" {
  New-Item -ItemType Directory -Force -Path $menu | Out-Null
  [IO.File]::WriteAllText((Join-Path $menu 'Appbuilder.url'), "[InternetShortcut]`r`nURL=http://localhost:$Port/`r`n", [Text.Encoding]::ASCII)
} | Out-Null
$elapsed = [int]((Get-Date) - $Started).TotalSeconds
Write-Host ''
Write-Host "Done in $elapsed s. Appbuilder $($release.version) runs as the service '$ServiceId' ($ServiceAccount)." -ForegroundColor Green
if ($DryRun -or (Test-Path -LiteralPath (Join-Path $Workspace 'setup-code.txt'))) {
  Write-Host ''
  Write-Host '  First-run setup (on THIS PC; the setup screen refuses other computers):'
  Write-Host "    1. The one-time setup code: Get-Content '$Workspace\setup-code.txt'   (elevated PowerShell)"
  Write-Host "    2. Open http://localhost:$Port/  (Start menu > Appbuilder)"
  Write-Host '    3. The database is already connected: create the first administrator.'
}
if ($Https -eq 'Lan') { Write-Host "  Users on the network open: https://$($names[0])/"; if ($caFile) { Write-Host "  Trust $caFile on each client PC once (docs/admin/installation.md#trust-the-local-certificate)." } }
if ($Https -eq 'Domain') { Write-Host "  Users open: https://$Domain/" }
Write-Host ''
Write-Host "  Service:   Get-Service $ServiceId | Restart-Service $ServiceId     Logs: $Workspace\logs and $LogDir"
Write-Host "  Commands:  & '$InstallDir\appbuilder.cmd' version | health | update <zip> | diagnostics"
Write-Host "  Uninstall: & '$AppDir\scripts\install\windows\uninstall.ps1'   (keeps the data unless you ask otherwise)"
