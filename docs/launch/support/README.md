# Support planning pack (pre-launch)

Written for a solo founder supporting on-prem customers of the self-hosted Appbuilder platform (v0.5.0). There is no customer yet, so every case here is
**expected**, not observed. Everything about the product comes from the repo docs and code; planned features are labelled planned (see
`docs/launch/BRIEF.md`). Items marked "verify" or "verify with engineering" were not confirmed.

## Files

| File | What it is |
| --- | --- |
| [support-model.md](support-model.md) | Tiers, channels, severities, hours, escalation, update policy, backup responsibilities, onboarding, cost per customer, first-hire triggers. Prices of third-party tools are unverified. |
| [support-use-cases.md](support-use-cases.md) | **187** expected cases in 18 groups, each with symptom, cause, diagnosis, resolution, prevention, severity, minutes, product gap and roadmap phase. Ends with the top 15. |
| [macros.md](macros.md) | 40 reply templates (English and Hinglish), incident templates and a post-incident review template. |
| [runbooks.md](runbooks.md) | A first-thirty-minutes card and 12 runbooks, with a consolidated verify list. |
| [../../help/index.md](../../help/index.md) | End-user help centre (13 pages plus two one-page quick-starts). The approver quick-start is a clearly marked DRAFT. |

## Product gaps, by support impact (with roadmap phase where known)

1. No tested recovery when the **last administrator** loses their second step; no CLI password reset (SIG-11, Runbook 5).
2. **No undo or recycle bin**; deleted rows return only through a backup restore (DAT-12, GAP-11, Runbook 10).
3. **No point-in-time recovery**; the nightly backup is the recovery point (BKP group).
4. The audit log has **no before/after values** and does not record reads (SEC-18).
5. **No alert** when health fails or the backup goes stale; the founder only finds out when asked (backup warning appears in the product only after 36 hours).
6. **Releases are unsigned** (`release-keys.json` is empty) (INS group, support-model update policy).
7. **Windows installer and `restore --force` are untested**; Linux is the tested path (INS, BKP, Runbook 3).
8. **Phone layout**: the BRIEF lists it as planned (P2) but the guide describes phone design sizes (APP-05).
9. **No Hindi UI** (GAP-10); only English screens.
10. SMTP relay has **no XOAUTH2**, so Microsoft 365 and Gmail accounts without app passwords cannot send (NOT/NET groups).
11. **Webhooks can only be created through the API**; no screen (INT group).
12. No tool to **re-own** deleted-owner rows (SEC-15); roles are additive with no deny rule (SEC group).
13. Approvals, dashboards, chat, WhatsApp, PDF are not built (P1 to P3); customers will ask in the first month.

## Feedback to engineering: documentation problems

Each item says where it is and what a support person needs. Count: **22**. The ten most important are marked (top 10).

1. (top 10) **Admin lockout recovery is not documented or tested** for the sole administrator with two-step verification on. File: `docs/admin/sign-in-and-identity.md`. Needed: a supported offline path.
2. (top 10) **No documented way to reset a password from the command line.** Same file. Needed: a CLI command or a stated "none".
3. (top 10) **Windows restore and disaster-recovery are described as tested on Linux only** (`docs/admin/disaster-recovery.md`), while installation targets Windows first. Needed: a Windows test and wording that says so.
4. (top 10) **`release-keys.json` is empty**, so the signature check in `docs/dev/release-process.md` never fires. Needed: a key before the first customer update, and customer-facing text on what "unsigned" means.
5. (top 10) **Where the PostgreSQL and WinSW logs live on Windows** is not given next to the troubleshooting steps (`docs/admin/troubleshooting.md`). Needed for the first call.
6. (top 10) **No stated supported-browser list** in `docs/guide` or `docs/admin`. Needed to answer "does it work in Edge or on Android Chrome".
7. (top 10) **Phone layout status conflicts**: BRIEF says planned (P2); guide describes phone design sizes. Needed: one sentence of truth in the guide.
8. (top 10) **Retention and pinning rules are spread over several pages** (backup-and-restore, operations). Needed: one table of what is pruned and when, and what pins a backup (verify with engineering; not confirmed as a contradiction).
9. (top 10) **Version-skipping and upgrade compatibility rules were not found.** The 'current and previous version supported' policy in the support model is a proposal, not the product's (verify with engineering).
10. (top 10) **Request id is not shown in the UI**, but logs filter by request id (`docs/admin/troubleshooting.md`). Users cannot give support a copyable id. Needed: show it in error panels.
11. The **audit log** document lists events but not whether values or read access are recorded; support learned it from the code and had to say so (SEC-18).
12. **Quiet hours and digest behaviour** for approvals and scheduled reports are not stated (does a report respect quiet hours?). Help pages avoid claiming it.
13. **Email suppression**: no documented way to remove an address from the manual suppression list from the UI, and no bounce handling.
14. **Re-authentication window** (10 minutes): not stated whether it works with password only when the only second step is TOTP and policy blocks turning it off (Runbook 5 step 4).
15. **Flows kill switch**: where an administrator stops a misbehaving flow quickly is not documented while flows are in progress.
16. **Date, time-zone and locale behaviour** of reports and digests is not specified (which zone does "8 am" mean?).
17. **Secret rotation** steps for the `.secret-key` and connection secrets are not written down end to end.
18. **`user-mode-tabs.png`** shows Tasks with a SOON badge although `src/portal/modules.ts` marks Tasks, Mentions and Scheduled reports live. Retake it.
19. **No screenshot** exists for the sign-in screen, the bell panel in the current theme, the Tasks board or Scheduled reports in User mode (the help pages reference only existing images).
20. **Guide pages are maker-first**; there is no end-user page. `docs/help/` is a first draft that engineering should check against the UI.
21. **Sizing and disk guidance** (attachments, logs, backups) is not given as numbers, so "disk full" is hard to prevent.
22. **Customer-facing error wording** is listed nowhere; the help pages quote strings from `src/portal` and `src/controls` and these will go stale. Needed: one source of strings.

## What was not verified

- Windows paths, service names and behaviour were read from the docs, not run.
- PostgreSQL log location, supported browsers, time-zone behaviour, secret rotation steps, the flows kill switch.
- Prices and limits of remote-support tools and WhatsApp Business: read from third-party pages on 19 November 2026; check the vendors before buying.
- The help pages were written from source strings and docs, not from a running UI, so button names inside makers' own apps may differ.
- Handling-time numbers in the use cases and the cost per customer are estimates.

## Rules this pack follows

- Written only inside `docs/launch/support/` and `docs/help/`. Nothing committed, no code or existing docs changed.
- No commercial support starts before the founder's employment situation allows it (stated in the support model).
