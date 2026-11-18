<#
.SYNOPSIS
  Removes Appbuilder installed by install.ps1. Run in an elevated PowerShell:

    & 'C:\Program Files\Appbuilder\app\scripts\install\windows\uninstall.ps1'

.DESCRIPTION
  Default: stops and removes the services Appbuilder and Appbuilder-Caddy, the firewall rules (group "Appbuilder"),
  the Start-menu entry and the program folder. KEEPS the data folder (workspace, backups, logs) and, when the installer
  installed PostgreSQL, the database service appbuilder-postgresql with its program files (<InstallDir>\pgsql) and data
  (<DataDir>\pgdata), so that installing again picks everything up.

  -RemoveData also deletes the data folder and the PostgreSQL that the installer installed (service, program files,
  pgdata). An existing PostgreSQL that the installer only used keeps running; the appbuilder database and role in it are
  dropped only when you give its superuser password. You must type DELETE <COMPUTERNAME> to confirm: there is no undo.
  Make a backup and copy it elsewhere first.
.EXAMPLE
  .\uninstall.ps1 -WhatIf
.EXAMPLE
  .\uninstall.ps1 -RemoveData
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'Appbuilder'),
  [string]$DataDir = (Join-Path $env:ProgramData 'Appbuilder'),
  [switch]$RemoveData,
  [string]$Confirmation = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$DryRun = [bool]$WhatIfPreference
$WhatIfPreference = $false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $here 'AppbuilderSetup.psm1') -Force

function Invoke-Action([string]$Description, [scriptblock]$Action) {
  if ($DryRun) { Write-Host "  would: $Description" -ForegroundColor DarkGray; return }
  Write-Host "  $Description"
  & $Action
}

$isAdmin = $false
try { $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { $isAdmin = $false }
if (-not $isAdmin -and -not $DryRun) { Write-Host 'ERROR: run this in an elevated PowerShell.' -ForegroundColor Red; exit 1 }
$info = $null
$infoPath = Join-Path $InstallDir 'install.json'
if (Test-Path -LiteralPath $infoPath) { $info = Get-Content -Raw -LiteralPath $infoPath | ConvertFrom-Json }
$pgOurs = ($info -and $info.postgres -eq 'installed')

if ($RemoveData) {
  $want = "DELETE $($env:COMPUTERNAME)"
  Write-Host "This deletes $DataDir (workspace, attachments, backups, the encryption key)$(if ($pgOurs) { ' and the PostgreSQL installed for Appbuilder with all its data' }). There is no undo." -ForegroundColor Yellow
  if (-not $Confirmation) { $Confirmation = Read-Host "Type '$want' to continue" }
  if ($Confirmation -cne $want) { Write-Host 'Not confirmed: nothing was removed.' -ForegroundColor Red; exit 1 }
}

# copy this script's module out of the program folder before deleting it (the script runs from inside it)
foreach ($id in @('Appbuilder-Caddy', 'Appbuilder')) {
  $svc = Get-Service -Name $id -ErrorAction SilentlyContinue
  if ($svc) {
    Invoke-Action "stop and remove the service $id" {
      Stop-Service -Name $id -Force -ErrorAction SilentlyContinue
      $exe = Join-Path $InstallDir "service\$id.exe"
      if (Test-Path -LiteralPath $exe) { & $exe uninstall | Out-Null } else { & sc.exe delete $id | Out-Null }
    }
  }
}
if (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue) {
  Invoke-Action 'remove the firewall rules of the group Appbuilder' { Get-NetFirewallRule -Group 'Appbuilder' -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
}
$menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Appbuilder'
Invoke-Action "remove $menu" { Remove-Item -Recurse -Force -LiteralPath $menu -ErrorAction SilentlyContinue }
$ca = Join-Path $DataDir 'appbuilder-local-ca.crt'
if (Test-Path -LiteralPath $ca) {
  Invoke-Action 'remove the local certificate authority from this PC''s trusted roots' {
    $thumb = (New-Object Security.Cryptography.X509Certificates.X509Certificate2($ca)).Thumbprint
    Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Thumbprint -eq $thumb } | Remove-Item
  }
}

if ($RemoveData) {
  if ($pgOurs) {
    $pg = 'appbuilder-postgresql'
    if (Get-Service -Name $pg -ErrorAction SilentlyContinue) {
      Invoke-Action "stop and remove the service $pg" {
        Stop-Service -Name $pg -Force -ErrorAction SilentlyContinue
        & (Join-Path $InstallDir 'pgsql\bin\pg_ctl.exe') unregister -N $pg | Out-Null
      }
    }
  } elseif ($info) {
    Write-Host '  The existing PostgreSQL stays. To drop the appbuilder database and role in it, run as its superuser:' -ForegroundColor Yellow
    Write-Host '    DROP DATABASE appbuilder WITH (FORCE); DROP ROLE appbuilder;'
  }
  Invoke-Action "delete $InstallDir" { Set-Location $env:SystemRoot; Remove-Item -Recurse -Force -LiteralPath $InstallDir }
  Invoke-Action "delete $DataDir" { Remove-Item -Recurse -Force -LiteralPath $DataDir }
  Write-Host 'Appbuilder and its data are removed.' -ForegroundColor Green
} else {
  Invoke-Action "delete $InstallDir (except pgsql, which the kept database service still runs)" {
    Set-Location $env:SystemRoot
    Get-ChildItem -LiteralPath $InstallDir -Force | Where-Object { $_.Name -ne 'pgsql' } | Remove-Item -Recurse -Force
  }
  Write-Host "Appbuilder is removed. Kept: $DataDir$(if ($pgOurs) { ' and the database service appbuilder-postgresql' }). Installing again picks them up." -ForegroundColor Green
}
