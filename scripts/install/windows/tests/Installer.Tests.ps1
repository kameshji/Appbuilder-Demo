<#
  Pester 5 tests of the Windows installer's pure functions (AppbuilderSetup.psm1). They run on Windows PowerShell 5.1
  and on PowerShell 7 (also on Linux, which is how CI and the sandbox run them):

    pwsh -NoProfile -Command "Invoke-Pester -Path scripts/install/windows/tests -Output Detailed"
#>
BeforeAll {
  Import-Module (Join-Path $PSScriptRoot '..\AppbuilderSetup.psm1') -Force
  $script:ManifestPath = Join-Path $PSScriptRoot '..\..\manifest.txt'
  function New-TempDir { $d = Join-Path ([IO.Path]::GetTempPath()) ('ab-pester-' + [Guid]::NewGuid().ToString('n')); New-Item -ItemType Directory -Path $d | Out-Null; return $d }
  function Get-Sha256Hex([string]$Path) { return Get-FileHashHex -Path $Path -Algorithm SHA256 }
}

Describe 'manifest' {
  It 'has every Windows download, https only, with well-formed checksums and a licence' {
    $m = Read-Manifest $script:ManifestPath
    foreach ($k in @('node.win-x64', 'postgres.win-x64', 'winsw.win', 'caddy.win-x64')) {
      $i = Get-ManifestItem -Manifest $m -Key $k
      $i.Url | Should -Match '^https://'
      $i.FileName | Should -Not -BeNullOrEmpty
      $i.Algorithm | Should -BeIn @('SHA256', 'SHA512')
    }
    foreach ($p in @('node', 'postgres', 'winsw', 'caddy')) { $m["$p.licence"] | Should -Not -BeNullOrEmpty; $m["$p.version"] | Should -Match '^\d+\.\d+' }
    (Get-ManifestItem -Manifest $m -Key 'caddy.win-x64').Algorithm | Should -Be 'SHA512'
  }
  It 'refuses plain http and malformed checksums' {
    { Get-ManifestItem -Manifest @{ 'x.url' = 'http://example.com/a.zip'; 'x.sha256' = ('a' * 64) } -Key 'x' } | Should -Throw '*https*'
    { Get-ManifestItem -Manifest @{ 'x.url' = 'https://example.com/a.zip'; 'x.sha256' = 'abc' } -Key 'x' } | Should -Throw '*malformed*'
    { Get-ManifestItem -Manifest @{ 'x.url' = 'https://example.com/a.zip' } -Key 'x' } | Should -Throw '*checksum*'
  }
}

Describe 'versions' {
  It 'orders semantic versions with pre-releases' -TestCases @(
    @{ A = '1.0.0'; B = '1.0.0'; R = 0 }, @{ A = 'v22.18.0'; B = '22.18'; R = 0 }, @{ A = '0.5.0-dev'; B = '0.5.0'; R = -1 },
    @{ A = '0.5.0-dev.10'; B = '0.5.0-dev.2'; R = 1 }, @{ A = '0.10.0'; B = '0.9.9'; R = 1 }, @{ A = '0.5.0-rc.1'; B = '0.5.0-dev.9'; R = 1 },
    @{ A = '24.22.3'; B = '24.22.10'; R = -1 }
  ) {
    param($A, $B, $R)
    Compare-AppVersion $A $B | Should -Be $R
  }
  It 'checks the Node.js requirement' {
    Test-NodeVersion -Version 'v24.22.3' -Requirement '>=22.18' | Should -BeTrue
    Test-NodeVersion -Version 'v22.18.0' -Requirement '>=22.18' | Should -BeTrue
    Test-NodeVersion -Version 'v22.17.1' -Requirement '>=22.18' | Should -BeFalse
    Test-NodeVersion -Version 'v20.19.0' | Should -BeFalse
  }
}

Describe 'checksums' {
  It 'verifies a file against SHA-256 and SHA-512 and refuses a changed one' {
    $d = New-TempDir
    $f = Join-Path $d 'a.bin'
    [IO.File]::WriteAllText($f, 'hello')
    Test-FileChecksum -Path $f -Algorithm SHA256 -Expected '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' | Should -BeTrue
    Test-FileChecksum -Path $f -Algorithm SHA512 -Expected '9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043' | Should -BeTrue
    Test-FileChecksum -Path $f -Algorithm SHA256 -Expected ('0' * 64) | Should -BeFalse
    Test-FileChecksum -Path (Join-Path $d 'missing') -Algorithm SHA256 -Expected ('0' * 64) | Should -BeFalse
    Remove-Item -Recurse -Force $d
  }
  It 'checks a release folder against SHA256SUMS: missing, changed and extra files' {
    $d = New-TempDir
    New-Item -ItemType Directory -Path (Join-Path $d 'server') | Out-Null
    [IO.File]::WriteAllText((Join-Path $d 'release.json'), '{}')
    [IO.File]::WriteAllText((Join-Path $d 'server\main.ts'), 'x')
    $lines = @('release.json', 'server/main.ts') | ForEach-Object { '{0}  {1}' -f (Get-Sha256Hex (Join-Path $d ($_ -replace '/', '\'))), $_ }
    [IO.File]::WriteAllText((Join-Path $d 'SHA256SUMS'), (($lines -join "`n") + "`n"))
    $r = Test-ReleaseChecksums -ReleaseDir $d
    $r.Ok | Should -BeTrue
    $r.Files | Should -Be 2
    [IO.File]::AppendAllText((Join-Path $d 'server\main.ts'), 'changed')
    [IO.File]::WriteAllText((Join-Path $d 'planted.js'), 'evil')
    Remove-Item (Join-Path $d 'release.json')
    $r = Test-ReleaseChecksums -ReleaseDir $d
    $r.Ok | Should -BeFalse
    @($r.Changed) | Should -Be @('server/main.ts')
    @($r.Missing) | Should -Be @('release.json')
    @($r.Extra) | Should -Be @('planted.js')
    Remove-Item -Recurse -Force $d
  }
}

Describe 'secrets' {
  It 'makes random passwords of the asked length from the safe alphabet' {
    $a = New-RandomPassword 40; $b = New-RandomPassword 40
    $a.Length | Should -Be 40
    $a | Should -Match '^[A-HJ-NP-Za-km-z2-9]{40}$'
    $a | Should -Not -Be $b
  }
  It 'computes the SCRAM-SHA-256 verifier PostgreSQL computes (fixed salt)' {
    # same input and salt as the Node.js implementation in install.sh: the two must agree
    $salt = [byte[]](1..16)
    $v = New-ScramVerifier -Password 'correct horse battery staple' -Salt $salt
    $v | Should -Match '^SCRAM-SHA-256\$4096:AQIDBAUGBwgJCgsMDQ4PEA==\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$'
    $v | Should -Be (Get-Content -Raw (Join-Path $PSScriptRoot 'scram-expected.txt')).Trim()
    (New-ScramVerifier -Password 'x') | Should -Not -Be (New-ScramVerifier -Password 'x')
  }
  It 'role SQL holds the verifier, never the password, and refuses bad names' {
    $pw = 'Pw-' + (New-RandomPassword 20)
    $sql = New-RoleSql -Role 'appbuilder' -Database 'appbuilder' -Verifier (New-ScramVerifier $pw)
    $sql | Should -Not -Match ([regex]::Escape($pw))
    $sql | Should -Match "CREATE ROLE `"appbuilder`" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'SCRAM-SHA-256"
    $sql | Should -Match 'REVOKE ALL ON DATABASE "appbuilder" FROM PUBLIC'
    $sql | Should -Match 'DO \$\$ BEGIN'
    { New-RoleSql -Role 'App"; DROP' -Database 'appbuilder' -Verifier (New-ScramVerifier 'x') } | Should -Throw
    { New-RoleSql -Role 'appbuilder' -Database 'appbuilder' -Verifier "x'; DROP ROLE postgres; --" } | Should -Throw
  }
}

Describe 'configuration text' {
  It 'service environment: loopback only, proxy settings only with HTTPS' {
    $e = New-ServiceEnvironment -Port 5174 -Workspace 'C:\ProgramData\Appbuilder\workspace' -BackupDir 'C:\ProgramData\Appbuilder\backups' -InstallRoot 'C:\Program Files\Appbuilder' -PgBin 'C:\Program Files\Appbuilder\pgsql\bin'
    $e['APPBUILDER_HOST'] | Should -Be '127.0.0.1'
    $e.Contains('APPBUILDER_TRUST_PROXY') | Should -BeFalse
    $e['APPBUILDER_SETUP_CODE_FILE'] | Should -Match 'setup-code\.txt$'
    $l = New-ServiceEnvironment -Port 5174 -Workspace 'W' -BackupDir 'B' -InstallRoot 'R' -Https Lan -AllowedHosts @('pc1', 'pc1.corp.local', '192.168.1.10')
    $l['APPBUILDER_ALLOWED_HOSTS'] | Should -Be 'pc1,pc1.corp.local,192.168.1.10'
    $l['APPBUILDER_TRUST_PROXY'] | Should -Be '1'
    $text = ConvertTo-EnvFileText $l
    $text | Should -Match "(?m)^PORT=5174`r$"
    $text | Should -Not -Match 'PASSWORD'
    { ConvertTo-EnvFileText ([ordered]@{ A = "x`ny" }) } | Should -Throw
  }
  It 'WinSW XML: well-formed, escaped, restart on failure, rolled logs, dependencies' {
    $x = New-WinSWXml -Id 'Appbuilder' -Name 'Appbuilder' -Description 'a & b <c>' -Executable 'C:\Program Files\Appbuilder\node\node.exe' -Arguments '"C:\Program Files\Appbuilder\app\server\main.ts"' -WorkingDirectory 'C:\ProgramData\Appbuilder' -LogPath 'C:\ProgramData\Appbuilder\logs' -Environment ([ordered]@{ PORT = '5174'; X = 'a"b' }) -DependsOn @('appbuilder-postgresql')
    $doc = [xml]$x
    $doc.service.id | Should -Be 'Appbuilder'
    $doc.service.description | Should -Be 'a & b <c>'
    $doc.service.arguments | Should -Be '"C:\Program Files\Appbuilder\app\server\main.ts"'
    @($doc.service.env)[1].value | Should -Be 'a"b'
    $doc.service.depend | Should -Be 'appbuilder-postgresql'
    @($doc.service.onfailure).Count | Should -Be 3
    $doc.service.log.mode | Should -Be 'roll-by-size'
    $doc.service.log.keepFiles | Should -Be '8'
    $doc.service.stopparentprocessfirst | Should -Be 'true'
    $x | Should -Not -Match 'serviceaccount'
  }
  It 'Caddyfile for the LAN (internal CA) and for a domain (Let''s Encrypt, HSTS)' {
    $lan = New-CaddyfileText -Mode Lan -Port 5174 -Names @('pc1', '192.168.1.10')
    $lan | Should -Match 'https://pc1, https://192\.168\.1\.10 \{'
    $lan | Should -Match 'tls internal'
    $lan | Should -Match 'skip_install_trust'
    $lan | Should -Match 'reverse_proxy 127\.0\.0\.1:5174'
    $dom = New-CaddyfileText -Mode Domain -Port 5174 -Domain 'apps.example.com' -AcmeEmail 'it@example.com'
    $dom | Should -Match '(?m)^apps\.example\.com \{'
    $dom | Should -Match 'Strict-Transport-Security'
    $dom | Should -Match 'email it@example\.com'
    $dom | Should -Not -Match 'tls internal'
    { New-CaddyfileText -Mode Domain -Port 1 -Domain 'not a name' } | Should -Throw
    { New-CaddyfileText -Mode Lan -Port 1 -Names @('a b') } | Should -Throw
  }
  It 'the command wrapper changes to the install folder (never inside app, which the updater renames)' {
    $w = New-CliWrapperText
    $w | Should -Match 'cd /d "%~dp0"'
    $w | Should -Match '"%~dp0node\\node.exe" "%~dp0app\\server\\main.ts" %\*'
  }
}

Describe 'permissions plan' {
  It 'data: SYSTEM, Administrators and the service account only; the admin folder: no service account' {
    $plan = Get-AclPlan -InstallDir 'C:\P\Appbuilder' -DataDir 'C:\D\Appbuilder' -ServiceAccount 'NT SERVICE\Appbuilder' -AdminDir 'C:\D\Appbuilder\admin' -PgAccount 'NT SERVICE\appbuilder-postgresql' -PgHome 'C:\P\Appbuilder\pgsql' -PgData 'C:\D\Appbuilder\pgdata' -CaddyAccount 'NT SERVICE\Appbuilder-Caddy' -CaddyData 'C:\D\Appbuilder\caddy'
    $byPath = @{}; foreach ($e in $plan) { $byPath[$e.Path] = $e }
    $ids = { param($p) @($byPath[$p].Rules | ForEach-Object { '{0}={1}' -f $_.Identity, $_.Rights }) }
    (& $ids 'C:\D\Appbuilder') | Should -Be @('*S-1-5-32-544=F', '*S-1-5-18=F', 'NT SERVICE\Appbuilder=M')
    (& $ids 'C:\D\Appbuilder\config') | Should -Be @('*S-1-5-32-544=F', '*S-1-5-18=F', 'NT SERVICE\Appbuilder=R')
    (& $ids 'C:\D\Appbuilder\admin') | Should -Be @('*S-1-5-32-544=F', '*S-1-5-18=F')
    (& $ids 'C:\D\Appbuilder\pgdata') | Should -Be @('*S-1-5-32-544=F', '*S-1-5-18=F', 'NT SERVICE\appbuilder-postgresql=F')
    (& $ids 'C:\D\Appbuilder\caddy') | Should -Be @('*S-1-5-32-544=F', '*S-1-5-18=F', 'NT SERVICE\Appbuilder-Caddy=M')
    (& $ids 'C:\P\Appbuilder') | Should -Be @('*S-1-5-32-544=F', '*S-1-5-18=F', '*S-1-5-32-545=RX', 'NT SERVICE\Appbuilder=RX')
    (& $ids 'C:\P\Appbuilder\pgsql') | Should -Contain 'NT SERVICE\appbuilder-postgresql=RX'
    # nobody else on the data folder: no Users, no Everyone, no Authenticated Users
    foreach ($p in @('C:\D\Appbuilder', 'C:\D\Appbuilder\config', 'C:\D\Appbuilder\admin', 'C:\D\Appbuilder\pgdata')) {
      (& $ids $p) -join ';' | Should -Not -Match 'S-1-5-32-545|S-1-1-0|S-1-5-11'
    }
  }
  It 'before the service exists: Administrators and SYSTEM only' {
    $plan = Get-AclPlan -InstallDir 'C:\P' -DataDir 'C:\D' -ServiceAccount '' -AdminDir 'C:\D\admin'
    @($plan | Where-Object { $_.Path -eq 'C:\D' })[0].Rules.Count | Should -Be 2
  }
  It 'icacls arguments: inheritance cut, rules replaced, inherited by children' {
    $a = ConvertTo-IcaclsArguments ([pscustomobject]@{ Path = 'C:\D'; Rules = @(@{ Identity = '*S-1-5-18'; Rights = 'F' }, @{ Identity = 'NT SERVICE\Appbuilder'; Rights = 'M' }) })
    $a | Should -Be @('C:\D', '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '/grant:r', 'NT SERVICE\Appbuilder:(OI)(CI)M', '/C', '/Q')
  }
}

Describe 'PostgreSQL ZIP filter' {
  It 'takes the server and client programs, not pgAdmin, StackBuilder, docs or headers' -TestCases @(
    @{ N = 'pgsql/bin/postgres.exe'; R = $true }, @{ N = 'pgsql/bin/libpq.dll'; R = $true }, @{ N = 'pgsql/lib/plpgsql.dll'; R = $true },
    @{ N = 'pgsql/share/timezone/UTC'; R = $true }, @{ N = 'pgsql/pgAdmin 4/runtime/pgAdmin4.exe'; R = $false }, @{ N = 'pgsql/StackBuilder/bin/stackbuilder.exe'; R = $false },
    @{ N = 'pgsql/bin/wxbase3212u_vc_x64_custom.dll'; R = $false }, @{ N = 'pgsql/bin/stackbuilder.exe'; R = $false }, @{ N = 'pgsql/doc/postgresql/html/index.html'; R = $false },
    @{ N = 'pgsql/include/libpq-fe.h'; R = $false }, @{ N = 'pgsql/bin/'; R = $false }, @{ N = '../evil.exe'; R = $false }
  ) {
    param($N, $R)
    Test-PgZipEntry $N | Should -Be $R
  }
}
