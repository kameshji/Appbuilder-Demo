# Hosting support in the server (H-A, H-C)

What the server does for many installs on one machine, and the rules for code added later. Operator view:
[docs/admin/hosting.md](../admin/hosting.md). Design: [docs/plan/hosting-spec.md](../plan/hosting-spec.md).

## Files

| File | What |
| --- | --- |
| `server/core/hosting/settings.ts` | every hosting setting from the environment (`hostingSettings`), the hosted profile's defaults (`applyHostingDefaults`), the instance env file, the "inside the instance folder" check, `hostingFor(services)` / `configureHosting` / `lockedPublicUrl` |
| `server/core/hosting/cookies.ts` | the `__Host-` prefix at the HTTP boundary |
| `server/core/hosting/read-only.ts` | the read-only state, the route and job classification, the gate, the stored setting |
| `server/core/hosting/routes.ts` | `GET /api/v1/install/read-only`, and the job runner hook; called by `createRouter` |
| `server/core/hosting/cli.ts` | `migrate`, `admin invite`, `read-only`, `hosting-check`, `health` over the socket |
| `server/main.ts` | loads the instance env, applies the defaults, dispatches the commands, listens on the socket or port, pool size, start-up check, shutdown order |
| `src/portal/ReadOnlyBanner.tsx` | the banner under the top bar (mounted in `Shell.tsx`) |

One process holds one install, so the settings come from `process.env`. Test suites that run several apps in one
process attach settings to an app: `configureHosting(app.services, hostingSettings({ ... }))`. `createApp({ env })` does
not attach them by itself.

## Rules for new code

- **Links.** Never build an absolute address from the request (`Host`, `X-Forwarded-*`). Use
  `identity(services).mail.brand().publicUrl`: it is the locked `APPBUILDER_PUBLIC_URL` when set, else the address in
  Admin console > Email. In the browser, `location.origin` is the public address (the page was loaded through the proxy).
- **Cookies.** Name them `ab_<name>` and set them with `sessionCookie` (`router.ts`) or `setCookie` (`identity/util.ts`);
  the router turns them into `__Host-ab_<name>` when needed and reads only those. A WebSocket upgrade handler must call
  `adaptCookiesIn(req)` first (`server/main.ts` does for `/api/v1/live`).
- **Outbound.** Every connection to a host a person typed goes through `server/core/net-policy.ts` (`hostProblem`,
  `assertOutboundHost`) or `actions/outbound.ts` (`safeRequest`, `resolveAllowed`). `hosting.test.ts` lists every server
  file that opens a connection; a new one fails the test until it is reviewed and added with its reason.
- **Writes outside the workspace.** A new folder setting must stay inside `APPBUILDER_INSTANCE_DIR` when it is set; add it
  to `writePathProblems`. Background loops take their interval from a setting (no hard-coded host, port or interval).
- **Routes.** Every non-GET route is refused while read-only unless its key (`'POST /pattern/:param'`, as registered,
  without `/api/v1`) is in `READ_ONLY_ALLOWED`; a GET route that writes must be listed in `READ_ONLY_REFUSED_GETS`.
  `read-only.integration.test.ts` requests every registered route while read-only and checks both lists name existing
  routes. Allow a route only if it writes no business data: signing in, a read that uses POST, an export, account
  recovery.
- **Job types.** Every registered job type needs an entry in `JOB_READ_ONLY` (`run` or `pause`, with the reason); the same
  test fails for a type without one. `run` only for work that writes no business data and is needed while read-only.

## The read-only state

`createReadOnlyGate` combines three sources, first wins: the environment (`APPBUILDER_READ_ONLY`), the stored setting
(`ab.settings` key `hosting.readOnly`, written by `appbuilder read-only on|off` with an audit entry
`install.read_only_on|off`), the licence client (`gate.setLicence`, package H-G). The stored setting is read again at
most every 5 seconds (`READ_ONLY_REFRESH_MS`), so a command takes effect in a running server within 5 seconds.

- **Router** (`router.ts`, after the route is matched and the setup and loopback checks, before the session and the body):
  `await readOnly.check(method, routeKey, res)`. Refused: 503, `Retry-After: 300`, body
  `{ readOnly: { reason, since }, error: { code: 'install_read_only' | 'licence_read_only', message } }`. 503 because the
  phone outbox keeps 5xx items waiting and retries them; a 4xx would mark them rejected.
- **Job runner** (`jobs.ts`, `setReadOnly`): while read-only a tick reaps lost jobs as always, runs the scheduler only for
  schedules whose job type runs read-only (the others keep their due slot: on resume the misfire policy decides, as after
  downtime), skips the outbox dispatch and the tick hooks (table events, flows, approval sweeps wait in the outbox), and
  claims only job types that run read-only. Queued jobs are never dropped.

| Job type | Read-only |
| --- | --- |
| `mail.send` | runs (sign-in codes, reset links, invitations) |
| `backup.run`, `backup.restore-test`, `backup.health` | run (export always works) |
| `ops.health_watch`, `ops.health_daily`, `ops.heartbeat` | run |
| `table-event.after`, `rollup.recompute`, `rollup.reconcile`, `formula.backfill`, `index.sync` | pause |
| `flow.advance`, `flow.resume`, `flow.timeout`, `flow.schedule`, `flow.retention`, `flow.digest` | pause |
| `approval.notify`, `approval.decided`, `approval.retention` | pause |
| `tasks.reminders`, `tasks.digest`, `collab.notify`, `collab.orphan-sweep` | pause |
| `notifications.digest`, `notifications.delivery-retention`, `whatsapp.notify`, `whatsapp.retention` | pause |
| `report.run`, `dashboard.snapshot`, `print.bulk`, `print.sweep`, `model.summary.refresh` | pause |
| `attachments.delete-files`, `attachments.sweep`, `data.recycle-purge`, `chat.retention` | pause |
| `outbox.retention`, `audit.retention`, `identity.signin-log.retention`, `identity.mail-log.retention`, `actions.retention` | pause |

The live hub is not affected: sockets stay open; their messages (subscribe, presence, Studio locks, ping) write nothing.

## Listening and stopping

`APPBUILDER_SOCKET` makes `server/main.ts` call `server.listen(path)`, after removing a stale socket file (one that
refuses connections), then `chmod` it to `APPBUILDER_SOCKET_MODE`. A request over a Unix socket has no peer address, so
`loopbackOnly` routes refuse it. The order at start: instance env, settings check (exit 78 on a problem), file log,
database and migrations and the job worker (`createApp`), then the listener. On `SIGTERM`/`SIGINT`: `server.close()` and
`closeIdleConnections()`, `app.close()` (live hub, job worker with 10 s grace, database), exit; forced after
`APPBUILDER_SHUTDOWN_MS`.

## Tests

`server/core/hosting/hosting.test.ts` (settings, cookies, outbound policy, no database), `read-only.integration.test.ts`
(every route, every job type, the outbox, exports), `cli.integration.test.ts` (the commands with a server running),
`main.integration.test.ts` (`node server/main.ts` as a hosted install over TCP 127.0.0.1:5271 and, on Linux and macOS, a
Unix socket; skipped on Windows with a printed reason).
