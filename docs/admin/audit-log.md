# Audit log

Appbuilder records security-relevant and data-changing actions in the database table **`ab_audit`**. Administrators read
it in **Admin console > Audit log**: newest first, 50 entries per page, filtered by action (one action, or a whole group
such as `auth.*`), by user and by date (shown in your browser's time zone). Click a details cell to see all of it. The
same data comes from `GET /api/v1/audit` (administrators only; see `docs/dev/data-api.md`). Reading the log is not itself
recorded. For anything the viewer cannot do (joins, counts, exports), use SQL with a database client (`psql`, pgAdmin, DBeaver and so on) and an account that can `SELECT` from the Appbuilder
database. Each [environment](environments.md) has its own log, the table `env_<id>.ab_audit` (Default: `env_default.ab_audit`);
the viewer shows the one of the environment you work in. Users are in `ab.users`.

**Install-level log.** Install administrators have a second tab in the viewer, **Install** (`GET /api/v1/install/audit`), over
the table `ab.audit`: what concerns the install rather than one environment. It has the same columns as below, without
`table_id`/`row_id` and with `environment_id` (the environment the action was about). Actions: `environment.create`
(details: id, name, type, schema, `copyFrom`/`copy`, `sampleData`, `ms`), `environment.create_failed`, `environment.update`
(`changes` before/after), `environment.lock`, `environment.unlock`, `environment.delete` (name, type, schema, what happened to
the folder), `environment.delete_failed`, `environment.access_grant` (user, email, `isEnvAdmin`), `environment.access_revoke`,
`environment.migrate_failed`, `install.admin_grant`, `install.admin_revoke`, `install.user_create`, `install.user_disable`,
`install.user_enable`, `install.user_delete`, `solution.deploy` (solution, version, from, to), `schema.migrate`.

## The table

| Column | Meaning |
| --- | --- |
| `id` | Increasing number. |
| `at` | When it happened, **in UTC**, to the millisecond. Convert to local time yourself. |
| `user_id` | The id of the acting user (`ab.users.id`), or empty for events with no signed-in user (failed or throttled sign-in, setup, schema migration). |
| `action` | What happened, see below. |
| `table_id` | The table concerned, when there is one (for example `t_orders`). |
| `row_id` | The row concerned, for single-row actions. |
| `details` | Extra facts as JSON text (up to about 60,000 characters). |

## What is recorded

| Area | Actions |
| --- | --- |
| Sign-in | `auth.login` (details `mustChangePassword: true` when the user must change an admin-set password), `auth.login_failed` (details: the email entered), `auth.login_throttled` (email; `perEmail: true, waitSeconds` for the per-account brake), `auth.logout`, `auth.password_changed` (`forced: true` when it was a required change), `auth.password_failed` (wrong current password during a change) |
| First-run and upgrades | `setup.database`, `setup.admin`, `setup.code_rejected` (a wrong or missing setup code), `schema.migrate` (details `{ from, to, steps }`, written when the schema step changed something) |
| Users | `user.profile` (a person changed their own display name: id, email, `changes.name` before/after), `user.create` (details: id, email, name, roleIds, status, `passwordSet`), `user.update` (details include `changes`: before/after of name, email, status and roleIds), `user.disable` / `user.enable`, `user.roles` (before/after role ids), `user.delete` (with the roles and status the user had), `user.password` (an administrator set a password: `reset: true` and `mustChangePassword: true` when it was someone else's) |
| Roles | `role.create`, `role.update`, `role.delete`; each with `changes`: before/after of name, description, isAdmin, isMaker, apps, and per table `privileges.<tableId>` (the whole privilege before and after, `null` when there was none) |
| Rows | `row.insert`, `row.update`, `row.delete` (several rows: details `{ count, deleted, ids }`, the ids of at most 1,000 rows, then `idsTruncated: true`; also for the rows a *replace* import deleted, with `import: true`) |
| Tables and columns | `table.create`, `table.update`, `table.delete`, `table.import`, `table.link` (with `missingSystem` or `addedSystemColumns` when it applies), `table.move`, `table.assign_owner` (owner, rows), `column.add`, `column.update`, `column.remove` (`unmappedOnly: true` on linked tables) |
| Data files | `file.add`, `file.replace`, `file.delete` |
| Attachments | `attachment.upload`, `attachment.delete` |
| Connections | `connection.create`, `connection.update`, `connection.default`, `connection.delete` |
| Apps and packages | `app.create`, `app.duplicate`, `app.delete`, `app.import`, `solution.create`, `solution.import` (an import as copies), `solution.install` and `solution.upgrade` (an import or deployment with stable ids: version, `fromVersion`, counts of new/changed/removed, the items, `destructive`, `backup: none` or `taken`), `solution.delete` |

This list comes from the code and a run of a live server; the test suite checks that sign-in, failed sign-in, row
insert/update/delete, import and attachment upload produce entries.

## What is not recorded

Be aware of these gaps before you rely on the log for an investigation:

- **Reading data is never logged.** Nobody can tell from the audit log who looked at which rows, exported a CSV or
  downloaded a file.
- **Row updates record only which columns changed, not the old or new values.** You can see that someone changed `Status`
  on row X, not what it was before.
- **Bulk deletes list at most 1,000 row ids** per entry (the count is always complete). The deleted values are not kept.
- **Opening an app, changing app contents, and saving app edits** are not listed above except create, duplicate, delete
  and import. Check app history in another way if that matters.
- **A failure to write an audit entry does not stop the action.** The server logs an `ERROR audit write failed (<action>):
  <reason>` line in its console and carries on, so a database problem can leave gaps; watch the console for these lines.
- **The log is not tamper-proof.** It is an ordinary table. Anyone with write access to the database (including the
  Appbuilder database user itself, and so any Maker-level flaw that reached SQL) can edit or delete entries. If you need
  a trustworthy trail, copy it regularly to a system the database users cannot write to.
- **No retention rule.** Nothing deletes old entries. The table grows without limit.

## Useful queries

Run them against the Appbuilder database (PostgreSQL; `details` is `jsonb`, so `details->>'email'` reads a field).

Latest 100 events, with the person's name and email:

```sql
SELECT a.at, u.email, a.action, a.table_id, a.row_id, a.details
FROM env_default.ab_audit a LEFT JOIN ab.users u ON u.id = a.user_id
ORDER BY a.id DESC LIMIT 100;
```

Failed and throttled sign-ins in the last 7 days, by the email entered:

```sql
SELECT details->>'email' AS email_entered, action, count(*) AS n, max(at) AS last_at
FROM env_default.ab_audit
WHERE action IN ('auth.login_failed', 'auth.login_throttled') AND at > now() - interval '7 days'
GROUP BY email_entered, action ORDER BY n DESC;
```

Many failures for one email, or failures for emails that do not exist, suggest guessing. Remember the throttle allows
8 failures per 15 minutes per email and address.

Everything one user did:

```sql
SELECT a.at, a.action, a.table_id, a.row_id, a.details
FROM env_default.ab_audit a JOIN ab.users u ON u.id = a.user_id
WHERE u.email = 'someone@example.com' ORDER BY a.id DESC LIMIT 500;
```

Everything that happened to one table or row:

```sql
SELECT at, user_id, action, row_id, details FROM env_default.ab_audit WHERE table_id = 'tbl_...' ORDER BY id DESC LIMIT 200;
```

Who changed users, roles or connections (the changes that matter most):

```sql
SELECT a.at, u.email AS by_user, a.action, a.details
FROM env_default.ab_audit a LEFT JOIN ab.users u ON u.id = a.user_id
WHERE a.action LIKE 'user.%' OR a.action LIKE 'role.%' OR a.action LIKE 'connection.%' OR a.action LIKE 'setup.%'
ORDER BY a.id DESC LIMIT 200;
```

Count of events by action this month:

```sql
SELECT action, count(*) FROM env_default.ab_audit WHERE at >= date_trunc('month', now()) GROUP BY action ORDER BY 2 DESC;
```

A user id that no longer appears in `ab.users` belongs to a deleted user.

## Keeping it in check

Review it on a schedule you can keep (weekly is realistic): user, role, connection and setup changes, and failed
sign-ins. To limit growth you can delete old rows yourself, after saving a copy:

```sql
DELETE FROM env_default.ab_audit WHERE at < now() - interval '400 days';
```

Decide your own retention period with your compliance needs in mind; Appbuilder does not make that decision. The audit
table is included in a normal database dump ([Backup and restore](backup-and-restore.md)).

## Not supported yet

An audit viewer in the portal, export, retention settings, recording read access, old/new values, tamper-evidence or
forwarding to a log server.
