# Security policy

Thank you for helping keep Appbuilder and its users safe.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately to: **[SECURITY CONTACT - TO BE FILLED IN BY THE PROJECT OWNER, for example security@your-domain.example]**

If a private reporting feature (such as GitHub's "Report a vulnerability") is enabled for the repository, you can use that
instead. Until the owner has filled in the contact above, there is no monitored address; reports sent anywhere else may
not reach the maintainers.

Please include:

- what you found and why it matters (what an attacker gains);
- the steps to reproduce it, with the version (the commit you tested) and how it was installed;
- any proof of concept, logs or screenshots;
- whether you want to be credited.

Please do not include real personal data, and do not test against systems you do not own.

## What to expect

[RESPONSE TIMES - TO BE CONFIRMED BY THE PROJECT OWNER. Suggested: acknowledgement within 5 working days, an initial
assessment within 14 days, and coordinated disclosure after a fix is available.]

We ask you to give us reasonable time to fix a problem before you publish details.

## Supported versions

Only the **latest version on the `main` branch** is supported and receives security fixes. Older commits and forks
do not. There are no numbered releases yet.

## Scope

In scope:

- The Appbuilder server (`server/`): authentication, sessions, roles and privileges (including row and column
  restrictions), request checks, secret storage, connection handling, file and attachment handling, audit logging.
- The web portal and runtime (`src/`): for example cross-site scripting, or any way to see or change data that the signed-in
  user's roles do not allow.
- The install and setup scripts (`scripts/`) and the documentation in `docs/admin/` where they lead to an insecure setup.

Out of scope:

- Findings that need an attacker who already is an administrator, or who already has access to the database, the
  workspace folder (including `.secret-key`) or the operating-system account that runs the server. Appbuilder does not
  defend against those.
- Running the server on a non-default listening address or on a shared network, and anything that relies on the missing
  TLS support: this is documented as unsupported (see `docs/admin/security-model.md`).
- Weaknesses already listed under "Explicit limitations" in `docs/admin/security-model.md`, unless you found a way to make
  them worse than described.
- Denial of service by sending very large or very many requests from a user who is allowed to use the application.
- Vulnerabilities in third-party software (Node.js, MySQL, Google services, npm packages) that are not specific to how
  Appbuilder uses them; report those to their maintainers. Do tell us if an Appbuilder dependency needs updating.
- Social engineering, physical attacks, and issues in demo mode, which has no authentication by design.

## Safe harbour

We will not pursue action against people who make a good-faith effort to follow this policy, avoid harming other users,
and do not access or keep more data than needed to show the problem. [LEGAL WORDING - TO BE CONFIRMED BY THE PROJECT OWNER.]

## Hardening your own installation

See `docs/admin/hardening-checklist.md` and `docs/admin/security-model.md`.
