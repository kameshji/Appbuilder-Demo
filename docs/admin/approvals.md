# Approvals: administration

What administrators set up and look after for approvals. Makers: [guide/maker/approvals.md](../guide/maker/approvals.md);
approvers: [help/quick-start-approver.md](../help/quick-start-approver.md); design: [dev/approvals.md](../dev/approvals.md).

## Settings (Approvals page > Policies, administrators)

| Setting | Default | |
| --- | --- | --- |
| Approvals: view | no role | Roles whose members see every approval request about records they can read (auditors, team leads). Without it people see only requests they made or were asked to decide. |
| Keep decided requests | forever (0) | Decided requests older than this many days are deleted by the job "Approval retention" (02:41 daily) with their history. Keep them as long as your audit rules require. |
| Email answer links valid | 72 hours | How long the Approve / Reject buttons in an email work. |

Administrators of an environment see the **All** tab of the Approvals page, may cancel any request and reassign any open
assignment (audited).

## Email

Approval emails need the email relay with a **public address** (Admin console > Email): the buttons point to
`<public address>/#u-approvals?link=...`. Out of the box the notification kind **Approvals** is emailed right away; you
can lock it on (Admin console > Email > defaults). Digests and do-not-disturb hours hold an approval email like any other
(a held or digested email has an "Open" button instead of the answer buttons).

**Why the links are safe.** Opening a link answers nothing: it opens a confirmation page in Appbuilder, which needs the
person to be signed in (they sign in first if needed), as the person the email was sent to. Only the button on that page
answers (a POST with the session). Each link works once, expires, and stops working when the request was decided,
reassigned or delegated. The secret part of the link is after `#`, so mail scanners that open links never send it to
the server. A restore makes all unused links invalid.

## Delegation and out of office

People delegate their own approvals on the Approvals page > **Delegations** (from, until, optionally only some
policies). Administrators can delegate for someone else (for example when a person is suddenly away): type their email
in "For". When a delegation starts, what waits for the person moves to the delegate; when it ends, what is still open
goes back. Every move is in the request's history and the audit log (`approval.delegation.create`, `.cancel`).

## Escalation and stuck requests

Policies decide what happens when a request is overdue (ask the manager, a named person, the next stage, approve or
reject automatically, expire); automatic decisions are recorded with the actor "System". A request where nobody could be
asked (no approver, no manager, no administrator other than the requester) expires at once and says why. To unblock a
request by hand: open it (tab **All**), **Reassign** the open assignment, or **Cancel** it; the requester can make a
new one. Decisions are never changed afterwards.

## Audit

Every action is in the request's history (who, when, what, with the reason for routing decisions) and in the
environment's audit log: `approval.request`, `approval.approved`, `approval.rejected`, `approval.completed`,
`approval.cancelled`, `approval.expired` (with the record they are about, so they also show in the record's audit),
`approval.reassign`, `approval.delegation.*`, `approval.policy.*`, `approval.settings`. The history tables are also in
the core data model (group Approvals) for reports, with the same visibility rules.

## Retention, backups, environments

Requests are environment data: in backups, not in solutions, not in environment copies (policies and settings are
copied). After a restore, open requests stay open; the flows that waited for them were cancelled by the restore; people
still asked get one reminder.
