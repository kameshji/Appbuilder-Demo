# Tasks for makers and administrators

What people see is described in [Tasks](../../help/tasks.md). Notes for the people who run an install:

- **Reminders and the morning summary** run as two built-in jobs (every minute and every hour). They do not need setting up. If
  the install is read-only they wait, and reminders missed are sent when it is writable again (up to 7 days late).
- The morning summary uses each person's time zone from their notification settings; without one it uses the environment setting
  `TimeZone`, and `Asia/Kolkata` when that is not set either.
- **Repeating tasks** create the next task when the current one is marked Done. Only tasks repeat, not notes.
- **Sharing** is by the task's owner, with people. Administrators can read everything, as for all collaboration data.
- Tasks, shares and comments are per environment.
