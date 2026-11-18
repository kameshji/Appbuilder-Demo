# Audit log

Appbuilder records security-relevant and data-changing actions in the database table **`ab_audit`**. **There is no
screen and no API to read it yet.** You read it with SQL, using a database client (the `mysql` command, MySQL Workbench,
HeidiSQL and so on) and an account that can `SELECT` from the Appbuilder database.

## The table

| Column | Meaning |
| --- | --- |
| `id` | Increasing number. |
| `at` | When it happened, **in UTC**, to the millisecond. Convert to local time yourself. |
| `user_id` | The id of the acting user (`ab_users.id`), or empty for events with no signed-in user (failed or throttled sign-in, setup). |
| `action` | What happened, see below. |
| `table_id` | The table concerned, when there is one (for example `t_orders`). |
| `row_id` | The row concerned, for single-row actions. |
| `details` | Extra facts as JSON text (up to about 60,000 characters). |

## What is recorded

| Area | Actions |
| --- | --- |
| Sign-in | `auth.login`, `auth.login_failed` (details: the email entered), `auth.login_throttled` (email), `auth.logout`, `auth.password_changed`, `auth.password_failed` (wrong current password during a change) |
| First-run | `setup.database`, `setup.admin` |
| Users | `user.create`, `user.update` (including disable/enable and role changes), `user.delete`, `user.password` (an administrator set a password) |
| Roles | `role.create`, `role.update`, `role.delete` |
| Rows | `row.insert`, `row.update`, `row.delete` |
| Tables and columns | `table.create`, `table.update`, `table.delete`, `table.import`, `table.link`, `table.move`, `column.add`, `column.update`, `column.remove` |
| Data files | `file.add`, `file.replace`, `file.delete` |
| Attachments | `attachment.upload`, `attachment.delete` |
| Connections | `connection.create`, `connection.update`, `connection.default`, `connection.delete` |
| Apps and packages | `app.create`, `app.duplicate`, `app.delete`, `app.import`, `solution.create`, `solution.import`, `solution.delete` |

This list comes from the code and a run of a live server; the test suite checks that sign-in, failed sign-in, row
insert/update/delete, import and attachment upload produce entries.

## What is not recorded

Be aware of these gaps before you rely on the log for an investigation:

- **Reading data is never logged.** Nobody can tell from the audit log who looked at which rows, exported a CSV or
  downloaded a file.
- **Row updates record only which columns changed, not the old or new values.** You can see that someone changed `Status`
  on row X, not what it was before.
- **Bulk deletes record how many rows, not which.**
- **Role changes record only that privileges changed**, not the before and after.
- **Opening an app, changing app contents, and saving app edits** are not listed above except create, duplicate, delete
  and import. Check app history in another way if that matters.
- **A failure to write an audit entry does not stop the action.** The server logs a warning in its console and carries on,
  so a database problem can leave gaps.
- **The log is not tamper-proof.** It is an ordinary table. Anyone with write access to the database (including the
  Appbuilder database user itself, and so any Maker-level flaw that reached SQL) can edit or delete entries. If you need
  a trustworthy trail, copy it regularly to a system the database users cannot write to.
- **No retention rule.** Nothing deletes old entries. The table grows without limit.

## Useful queries

Run them against the Appbuilder database. `JSON_EXTRACT` works on MariaDB 10.2+ and MySQL 5.7+.

Latest 100 events, with the person's name and email:

```sql
SELECT a.at, u.email, a.action, a.table_id, a.row_id, a.details
FROM ab_audit a LEFT JOIN ab_users u ON u.id = a.user_id
ORDER BY a.id DESC LIMIT 100;
```

Failed and throttled sign-ins in the last 7 days, by the email entered:

```sql
SELECT JSON_UNQUOTE(JSON_EXTRACT(details, '$.email')) AS email_entered, action, COUNT(*) AS n, MAX(at) AS last_at
FROM ab_audit
WHERE action IN ('auth.login_failed', 'auth.login_throttled') AND at > UTC_TIMESTAMP() - INTERVAL 7 DAY
GROUP BY email_entered, action ORDER BY n DESC;
```

Many failures for one email, or failures for emails that do not exist, suggest guessing. Remember the throttle allows
8 failures per 15 minutes per email and address.

Everything one user did:

```sql
SELECT a.at, a.action, a.table_id, a.row_id, a.details
FROM ab_audit a JOIN ab_users u ON u.id = a.user_id
WHERE u.email = 'someone@example.com' ORDER BY a.id DESC LIMIT 500;
```

Everything that happened to one table or row:

```sql
SELECT at, user_id, action, row_id, details FROM ab_audit WHERE table_id = 't_orders' ORDER BY id DESC LIMIT 200;
```

Who changed users, roles or connections (the changes that matter most):

```sql
SELECT a.at, u.email AS by_user, a.action, a.details
FROM ab_audit a LEFT JOIN ab_users u ON u.id = a.user_id
WHERE a.action LIKE 'user.%' OR a.action LIKE 'role.%' OR a.action LIKE 'connection.%' OR a.action LIKE 'setup.%'
ORDER BY a.id DESC LIMIT 200;
```

Count of events by action this month:

```sql
SELECT action, COUNT(*) FROM ab_audit WHERE at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01') GROUP BY action ORDER BY 2 DESC;
```

A user id that no longer appears in `ab_users` belongs to a deleted user.

## Keeping it in check

Review it on a schedule you can keep (weekly is realistic): user, role, connection and setup changes, and failed
sign-ins. To limit growth you can delete old rows yourself, after saving a copy:

```sql
DELETE FROM ab_audit WHERE at < UTC_TIMESTAMP() - INTERVAL 400 DAY;
```

Decide your own retention period with your compliance needs in mind; Appbuilder does not make that decision. The audit
table is included in a normal database dump ([Backup and restore](backup-and-restore.md)).

## Not supported yet

An audit viewer in the portal, export, retention settings, recording read access, old/new values, tamper-evidence or
forwarding to a log server.
