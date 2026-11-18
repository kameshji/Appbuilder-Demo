# Release process, signing and the installers

How a release package is built, signed, installed and updated (P0 package L, decision D25). For administrators the same
features are described in [Installation](../admin/installation.md), [Upgrades](../admin/upgrades.md) and
[Operations](../admin/operations.md).

## Build a release

```bash
npm run release                       # typecheck + web build, then the package
npm run release -- --skip-build       # use the existing dist/
npm run release -- --version 0.6.0-rc.1 --out /tmp/rel --trust-key /path/vendor.pub
```

`scripts/release/build.mjs` writes `release/appbuilder-<version>/` and `release/appbuilder-<version>.zip` (+ `.zip.sha256`):

| Content | How |
| --- | --- |
| `dist/` | the single-file web app from `npm run build` |
| `server/**`, `src/fx`, `src/platform`, `src/model` (only what is imported) | found by following the imports from `server/main.ts` (static and literal dynamic imports, plus files read with `new URL('./x', import.meta.url)`). The build fails on an import of a test file, of the browser-only `@/` alias, of a computed dynamic import, or of a package that is not a production dependency |
| `node_modules/` | `npm ci --omit=dev --ignore-scripts` from `package-lock.json`, then `npm prune` to the packages the server imports (about 120 packages instead of 240); `.bin` links removed. `licenses/node_modules.tsv` lists each package, its licence and its folder (with its own licence file) |
| `package.json`, `package-lock.json` | the release's own (`dependencies` = the server's) |
| `scripts/install/**`, `scripts/setup-postgres.*` | the installers and the manifest (not `scripts/install/tests`) |
| `release.json`, `VERSION` | version, git commit (`-dirty` when built from uncommitted changes), build date, schema version, Node.js range |
| `release-keys.json` | the vendor's public keys from `scripts/release/release-keys.json`, plus `--trust-key` files |
| `RELEASE-NOTES.md` | the CHANGELOG section of the version, else `Unreleased` |
| `THIRD-PARTY-NOTICES.md`, `SECURITY.md`, `README.txt` | |
| `SHA256SUMS` | SHA-256 of every other file |

No tests, docs, images, dev tools or source maps. About 45 MB unpacked, 11 MB zipped.

**Not compiled.** The release runs the same TypeScript files the test suite runs, through Node's type stripping (Node
22.18+), so there is no second build of the server whose equivalence would have to be proven. The cost is that Node.js
22.18 or newer is required (the installers bring 24 LTS).

**Reproducible.** Files are listed in byte order, modes are fixed (0644, 0755 for `.sh`), every timestamp is the commit
time (`SOURCE_DATE_EPOCH` overrides it), and the ZIP writer (`server/core/update/zip.ts`) writes fixed entry dates and no
extra fields. Building the same commit twice gave byte-identical ZIPs (checked: identical SHA-256). The `npm ci` step needs
the registry (or its cache).

## Signing

The vendor signs `SHA256SUMS` with an **Ed25519** key; the signature goes to `SHA256SUMS.sig`
(`{ "alg": "ed25519", "keyId", "signature" }`, key id = first 16 hex characters of SHA-256 over the public key).

1. **Once: make the key** on a trusted machine, outside the repository (the script refuses a folder inside it):

   ```bash
   npm run release:keygen -- --out /media/offline-usb/appbuilder-keys --comment "Appbuilder release key 2026"
   ```

   It asks for a passphrase (12+ characters) and writes `appbuilder-release-<id>.key` (encrypted PKCS#8 PEM, AES-256-CBC,
   mode 0600) and `.pub`, and prints the entry to add to `scripts/release/release-keys.json`. Commit that entry (public key
   only). Keep the `.key` file and the passphrase apart, each with a backup copy (for example an encrypted USB stick in a
   safe and a password manager).
2. **Every release**: `npm run release`, then

   ```bash
   npm run release:sign -- release/appbuilder-<version> --key /media/offline-usb/appbuilder-keys/appbuilder-release-<id>.key
   ```

   (passphrase asked, or `APPBUILDER_RELEASE_KEY_PASSPHRASE`). It checks the folder against `SHA256SUMS` first, signs,
   verifies the signature with the keys the release itself lists (so a release signed with a key it does not carry is
   refused), and writes the ZIP again. Publish the ZIP and its SHA-256.
3. **Rotating the key**: add the new public key to `release-keys.json` next to the old one, ship one release signed with
   the **old** key that carries both, then sign with the new key and later remove the old entry. Installs only trust keys
   their installed release carries, so a release signed only by a new key is refused until an install has a release that
   lists it.
4. **A lost or leaked key**: there is no revocation list (no phone-home). Ship a release signed with a remaining trusted key
   that no longer lists the bad one; installs that cannot be updated that way are updated by running the new release's
   installer (which replaces the app folder without a signature check against the old keys) after checking the ZIP's
   SHA-256 out of band.

**Trust anchors.** The updater verifies a new package against the keys of the release that is **installed**
(`<root>/app/release-keys.json`), never against keys inside the new package. For a first install there is nothing
installed to trust: the administrator checks the ZIP's published SHA-256, and `appbuilder version` / the installer print
the key id the release carries. `release-keys.json` is empty in the repository today: until the vendor makes a key,
releases are unsigned and installs accept unsigned updates (and say so).

## The installers

| File | |
| --- | --- |
| `scripts/install/manifest.txt` | the pinned third-party downloads: URL (https only), SHA-256 or SHA-512, version, licence; apt key fingerprints. `scripts/install/manifest.test.ts` checks it |
| `scripts/install/windows/install.ps1`, `uninstall.ps1`, `AppbuilderSetup.psm1` | the Windows installer; the module holds the pure functions (manifest, versions, checksums, SCRAM verifier, role SQL, environment file, WinSW XML, Caddyfile, ACL plan, ZIP filter) |
| `scripts/install/linux/install.sh`, `uninstall.sh` | the Linux installer |
| `scripts/install/prepare-offline.mjs` | the offline bundle |
| `server/core/update/` | release metadata, checksums and signatures (`release.ts`), ZIP (`zip.ts`), the updater (`apply.ts`), the command-line tools (`cli.ts`: `version`, `verify-release`, `update`, `diagnostics`, `health`, `db-check`, `seed-config`), install layout (`layout.ts`), Admin console > Updates (`routes.ts`) |
| `server/core/diagnostics/` | file log (`logger.ts`), health (`health.ts`), usage (`usage.ts`), redaction (`redact.ts`), the bundle (`bundle.ts`), routes |

`seed-config` is how the installers hand the generated database password to the server without a person typing it: the
password goes to `node server/main.ts seed-config --workspace <dir> --test` on **standard input**; the command tests the
login, creates `.secret-key` if needed and writes `server.json` with the password sealed by the same `SecretBox` the setup
screen uses. The server then boots with the database configured and the wizard asks only for the administrator.

## What was tested

| | How | Result |
| --- | --- | --- |
| Release build | `npm run release` twice | byte-identical ZIP; the server starts from the folder |
| Linux installer | `bash scripts/install/tests/linux-e2e.sh ubuntu:24.04` (also `ubuntu:22.04`, `debian:12`): a clean systemd container, three releases built and signed with a throwaway key; install (PostgreSQL 17 from PGDG), headless first-run setup, backup (pg_dump), restore with `appbuilder restore`, update, update to a broken release (automatic rollback), tampered and unsigned packages refused, re-run with HTTPS for the LAN (Caddy from its apt repository, sign-in through it, `Secure` cookie), CLI diagnostics bundle without secrets, uninstall keeping data, reinstall over it, uninstall with `--remove-data` | passes on all three; install about 40 to 50 s |
| Windows installer | `pwsh` 7 on Linux: parse of every script, PSScriptAnalyzer with the Windows PowerShell 5.1 compatibility rules, Pester tests of the module's functions (`scripts/install/windows/tests/Installer.Tests.ps1`; the SCRAM verifier is checked against the Node.js implementation), and a full `-WhatIf` run of `install.ps1` and `uninstall.ps1` from a built release with the Windows-only commands stubbed (`Install.DryRun.Tests.ps1`, `APPBUILDER_RELEASE_DIR=release/appbuilder-<version>`) | passes. **Not run on Windows.** |
| Updater and diagnostics | `server/core/update/update.test.ts`, `server/core/diagnostics/*.test.ts` (unit and HTTP against PostgreSQL) | pass |

### First run on Windows: what to check

1. `install.ps1` under **Windows PowerShell 5.1** (not only 7) on Windows 10/11 and Server 2019/2022: the native command
   wrappers (stderr handling), `Expand-Archive`, the TLS 1.2 download.
2. `initdb` into `C:\ProgramData\Appbuilder\pgdata` with `--pwfile`, then `pg_ctl register` and `sc.exe config ... obj= "NT
   SERVICE\appbuilder-postgresql"`: the service starts under the virtual account, can read `pgsql\bin` and write `pgdata`.
3. WinSW 2.12 `install` with `<delayedAutoStart/>`, then `sc.exe config Appbuilder obj= "NT SERVICE\Appbuilder"`; the
   service starts, writes `C:\ProgramData\Appbuilder\logs\Appbuilder.*.log`, and **stops gracefully** (WinSW sends Ctrl+C:
   the server log shows "SIGINT: shutting down").
4. The ACLs after install (`icacls C:\ProgramData\Appbuilder /T` for a few files): only SYSTEM, Administrators,
   `NT SERVICE\Appbuilder`; `admin\` without the service account; `server.json` and `.secret-key` inherited correctly
   (they are written before the service exists).
5. `seed-config` receives the password through the PowerShell pipe (Windows PowerShell 5.1 encodes piped strings with
   `$OutputEncoding`, ASCII; the password alphabet is ASCII) and `db-check` works on a re-run.
6. The health wait (`Invoke-WebRequest` on a 503 throws in 5.1: the script reads the response body from the exception).
7. `-Https Lan`: Caddy as `NT SERVICE\Appbuilder-Caddy` binds 443, `XDG_DATA_HOME` puts its CA under
   `C:\ProgramData\Appbuilder\caddy\data`, `skip_install_trust` keeps it from touching the trust store, the root certificate
   is imported into LocalMachine\Root, and a second PC reaches `https://<name>/` after trusting the CA; the firewall rule
   is limited to LocalSubnet on Domain/Private profiles.
8. `appbuilder.cmd update <zip>` as administrator: `sc.exe stop/start`, the folder renames succeed (no process keeps
   `app` open), `icacls /reset /T` on the new folder, rollback on a broken release.
9. `uninstall.ps1` (keeps data and the PostgreSQL service; reinstall picks them up) and `-RemoveData`.
10. A full offline install from a bundle made by `prepare-offline.mjs --os windows`; timing on a typical office PC (the
    target is well under an hour; the downloads are about 450 MB).
