# Tasks: reminders, repeats, shares and the My tasks screen (P3 package T)

Server: `server/core/tasks/service.ts` (hooks into `collab.ts`, registered in `services.ts`). Pure arithmetic:
`src/platform/recurrence.ts`. Screen: `src/portal/TasksPage.tsx`. Shared fields: `src/portal/ScheduleFields.tsx`. Data model:
[core-data-model.md](core-data-model.md). Exit check: `scripts/exit-check/p3-tasks.mjs`.

## Reminders

Job `tasks.reminders` (built-in schedule `sched_task_reminders`, every minute). It selects open Tasks and Events (not Notes) whose
`ReminderOn` has passed (within the last 7 days) and that were not sent for that `ReminderOn` (`ReminderSentOn` empty or older),
and notifies the assignee, else the assigned team, else the owner (kind `task`, link `#u-tasks`). Safe to run twice or after a
restart: the notification carries the idempotency key `task-reminder:<id>:<ReminderOn>` (the in-app row is `ON CONFLICT DO NOTHING`,
email is skipped when handled), and the row is then stamped `ReminderSentOn`. Changing `ReminderOn` re-arms it. Time is injected
(`runReminders({ now })`), so tests and the exit check never wait.

**Read-only install**: both jobs return "skipped" while `APPBUILDER_READ_ONLY=1` (`installReadOnly()` in the service is the marked
hook the hosting gate replaces). Reminders missed meanwhile are sent when writing resumes, up to 7 days late.

## Overdue digest

Job `tasks.digest` (hourly, `sched_task_digest`). From 08:00 until 20:00 in a person's own time zone (notification settings, else
the environment `TimeZone` setting, else Asia/Kolkata) each person gets at most ONE notification a day: "Tasks: N overdue, M due
today" with up to five lines. Tasks assigned to a team are not listed. The marker `tasks.digest:<date>:<user>` in `ab_counters`
prevents repeats; old markers are pruned.

## Repeating tasks

`Activities.Recurrence` holds JSON: `{ frequency: daily|weekly|monthly, interval 1..365, weekdays?, day?, time, timeZone, until? }`
(validated and normalised by `parseRecurrence`; invalid is a 422 in plain words; only Tasks may repeat). When a repeating task
becomes Done, `afterWrite` (same unit of work as the write) creates the next one: due date counted from the completed task's
due date (not the day it was ticked off), slots already in the past skipped, `until` ends the series, wall-clock time kept across
daylight saving, the reminder keeps its lead time, same assignee, owner and creator. Exactly once: the write holds the row lock,
the hook checks for a child (`RecurrenceParent = id`), and a UNIQUE partial index backs it up. The new task does not send an
"assigned" notification.

## Shares

See [core-data-model.md](core-data-model.md). The screen's "Share with a person" writes `ActivityShares` through the data API; the
server decides (only the owner). "Shared with me" lists activities that have a share row for me or my teams.

## The shared schedule fields

`ScheduleFields` (layout `report`: When / weekday / day / time / zone; layout `repeat`: Every N, weekdays, day, time, zone, until)
and `RecipientFields` live in `src/portal/ScheduleFields.tsx` and are used by Reports, Snapshots and the task repeat editor, with
the same words and behaviour. Test ids: `<prefix>-schedule`, `-frequency`, `-time`, `-recipients`, `-add-recipient`.

## Phone width

The page follows [phone.md](phone.md): 44 px complete buttons and fields below the `md` breakpoint, native `date` and
`datetime-local` pickers, the board shows one status at a time under 600 px (a status switch above it), the detail panel is a
bottom sheet. Completing and reopening are buttons, not swipes.
