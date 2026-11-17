# Starts an installed Appbuilder server in its own window and opens it in the browser.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$url = 'http://localhost:5174'

Write-Host "Starting Appbuilder in $root ..."
Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $root
Start-Sleep -Seconds 3
Start-Process $url
Write-Host "Opened $url. Close the server window to stop Appbuilder."
