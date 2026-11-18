<#
  Runs install.ps1 and uninstall.ps1 of a built release with -WhatIf, on any OS: the Windows-only commands are replaced by
  stubs defined here (a script called with & sees its caller's functions first), so the real control flow, the pure
  functions and every printed action are exercised. Nothing is changed. Needs a release folder:

    npm run release
    $env:APPBUILDER_RELEASE_DIR = 'release/appbuilder-0.5.0'
    pwsh -NoProfile -Command "Invoke-Pester -Path scripts/install/windows/tests -Output Detailed"
#>
BeforeDiscovery {
  $script:Rel = $env:APPBUILDER_RELEASE_DIR
  $script:HaveRelease = [bool]($script:Rel -and (Test-Path (Join-Path $script:Rel 'release.json')))
}

Describe 'install.ps1 -WhatIf (stubbed Windows commands)' -Skip:(-not $script:HaveRelease) {
  BeforeAll {
    $script:Rel = (Resolve-Path $env:APPBUILDER_RELEASE_DIR).ProviderPath
    $script:Root = Join-Path ([IO.Path]::GetTempPath()) ('ab-dry-' + [Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $script:Root | Out-Null
    # stubs for commands that only exist on Windows (or would touch this machine)
    function global:Get-CimInstance { [pscustomobject]@{ TotalPhysicalMemory = 16GB } }
    function global:Get-Service { $null }
    function global:Get-PSDrive { [pscustomobject]@{ Name = 'C'; Free = 100GB } }
    function global:Get-NetIPAddress { @([pscustomobject]@{ IPAddress = '192.168.1.20' }) }
    $env:TEMP = [IO.Path]::GetTempPath()
    if (-not $env:COMPUTERNAME) { $env:COMPUTERNAME = 'TESTPC' }
    if (-not $env:ProgramData) { $env:ProgramData = Join-Path $script:Root 'ProgramData' }
  }
  AfterAll {
    foreach ($f in 'Get-CimInstance', 'Get-Service', 'Get-PSDrive', 'Get-NetIPAddress') { Remove-Item "function:global:$f" -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $script:Root -ErrorAction SilentlyContinue
  }

  It 'prints every step of a full install with HTTPS for the LAN and changes nothing' {
    $inst = Join-Path $script:Root 'Program Files/Appbuilder'
    $data = Join-Path $script:Root 'ProgramData/Appbuilder'
    $out = & (Join-Path $script:Rel 'scripts/install/windows/install.ps1') -WhatIf -Force -Yes -Https Lan -LanNames @('pc1', '192.168.1.20') -OpenFirewall -InstallDir $inst -DataDir $data *>&1 | Out-String
    $out | Should -Match 'DRY RUN'
    $out | Should -Match 'files ok'
    $out | Should -Match 'would: download https://nodejs\.org/dist/v[\d.]+/node-v[\d.]+-win-x64\.zip'
    $out | Should -Match 'would: download https://get\.enterprisedb\.com/postgresql/postgresql-17\.\d+-1-windows-x64-binaries\.zip'
    $out | Should -Match 'would run: .*initdb|would: initdb'
    $out | Should -Match 'would run: .*pg_ctl\.exe register -N appbuilder-postgresql'
    $out | Should -Match 'would run: sc\.exe config appbuilder-postgresql obj= NT SERVICE\\appbuilder-postgresql'
    $out | Should -Match 'would: create or update the role appbuilder'
    $out | Should -Match 'would: seal the password into'
    $out | Should -Match 'would: download https://github\.com/winsw/winsw/releases/download/v2\.12\.0/WinSW\.NET461\.exe'
    $out | Should -Match 'would run: sc\.exe config Appbuilder obj= NT SERVICE\\Appbuilder'
    $out | Should -Match 'would run: icacls\.exe .*Appbuilder /inheritance:r /grant:r \*S-1-5-32-544:\(OI\)\(CI\)F'
    $out | Should -Match 'would: download https://github\.com/caddyserver/caddy/releases/download/v[\d.]+/caddy_[\d.]+_windows_amd64\.zip'
    $out | Should -Match 'would: firewall: allow TCP 443 from the local subnet'
    $out | Should -Match 'would: create the Start-menu shortcut'
    $out | Should -Match "Get-Content '.*setup-code\.txt'"
    $out | Should -Not -Match 'ERROR'
    Test-Path $inst | Should -BeFalse
    Test-Path $data | Should -BeFalse
  }

  It 'without HTTPS it does not touch the firewall, and -OpenFirewall alone is refused' {
    $inst = Join-Path $script:Root 'P2'
    $data = Join-Path $script:Root 'D2'
    $out = & (Join-Path $script:Rel 'scripts/install/windows/install.ps1') -WhatIf -Force -Yes -InstallDir $inst -DataDir $data *>&1 | Out-String
    $out | Should -Not -Match 'firewall'
    $out | Should -Not -Match 'Caddy'
    $out = & (Join-Path $script:Rel 'scripts/install/windows/install.ps1') -WhatIf -Force -OpenFirewall -InstallDir $inst -DataDir $data *>&1 | Out-String
    $out | Should -Match 'OpenFirewall only makes sense'
  }

  It 'offline: every download comes from the bundle folder' {
    $bundle = Join-Path $script:Root 'bundle'
    New-Item -ItemType Directory -Path $bundle | Out-Null
    $out = & (Join-Path $script:Rel 'scripts/install/windows/install.ps1') -WhatIf -Force -Yes -Offline $bundle -InstallDir (Join-Path $script:Root 'P3') -DataDir (Join-Path $script:Root 'D3') *>&1 | Out-String
    $out | Should -Match 'has no node-v[\d.]+-win-x64\.zip'
    foreach ($f in 'node-v24.22.3-win-x64.zip', 'postgresql-17.12-1-windows-x64-binaries.zip', 'WinSW.NET461.exe') { [IO.File]::WriteAllText((Join-Path $bundle $f), 'x') }
    $out = & (Join-Path $script:Rel 'scripts/install/windows/install.ps1') -WhatIf -Force -Yes -Offline $bundle -InstallDir (Join-Path $script:Root 'P3') -DataDir (Join-Path $script:Root 'D3') *>&1 | Out-String
    $out | Should -Match 'would: copy .*node-v24\.22\.3-win-x64\.zip'
    $out | Should -Not -Match 'would: download'
  }

  It 'uninstall -WhatIf keeps the data by default; -RemoveData needs the exact confirmation' {
    $out = & (Join-Path $script:Rel 'scripts/install/windows/uninstall.ps1') -WhatIf -InstallDir (Join-Path $script:Root 'P4') -DataDir (Join-Path $script:Root 'D4') *>&1 | Out-String
    $out | Should -Match 'Kept: '
    $out = & (Join-Path $script:Rel 'scripts/install/windows/uninstall.ps1') -WhatIf -RemoveData -Confirmation 'DELETE WRONG' -InstallDir (Join-Path $script:Root 'P4') -DataDir (Join-Path $script:Root 'D4') *>&1 | Out-String
    $out | Should -Match 'Not confirmed'
    $out = & (Join-Path $script:Rel 'scripts/install/windows/uninstall.ps1') -WhatIf -RemoveData -Confirmation "DELETE $($env:COMPUTERNAME)" -InstallDir (Join-Path $script:Root 'P4') -DataDir (Join-Path $script:Root 'D4') *>&1 | Out-String
    $out | Should -Match 'would: delete .*D4'
  }
}
