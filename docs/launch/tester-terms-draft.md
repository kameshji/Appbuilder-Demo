# Tester (beta) terms: DRAFT for lawyer review

> **NOT LEGAL ADVICE. DO NOT SEND, SIGN OR RELY ON THIS DRAFT.** It was prepared without legal advice. It must not be sent
> to any tester, published, or treated as binding until a qualified lawyer has reviewed and adapted it. Laws differ by
> country (India, and possibly the EU, the UK and others), and nothing here has been checked against any of them.
> Square brackets such as [COMPANY LEGAL NAME] are placeholders for facts that are not yet decided or not yet verified.

Status: draft v0.1, 20 Nov 2026. Owner decision: [master-plan.md](../plan/master-plan.md) sections 13 and 14.

## Covering note for the lawyer

- **What this is.** Terms for an invited, controlled test of a **hosted, multi-tenant** cloud version of a low-code business
  app platform ("Appbuilder" is a working name). Testers are start-ups and companies, possibly in several countries, and may
  later subscribe per number of seats. The founder is in India.
- **Important fact.** The hosted multi-tenant product is **decided but not yet specified or built** (see
  [hosting-and-licensing.md](../plan/hosting-and-licensing.md)). Every product statement below is therefore written as
  something to confirm on the launch day (see "Facts to confirm against the product before use" at the end).
- **The owner has decided to start the test before any outside security review** and wants that stated in writing (clause 2).
  The wording is meant to be plain and unsoftened.
- **Related research.** [legal-essentials.md](legal-essentials.md) (employment constraint, entity, DPDP, GDPR, CERT-In),
  [BRIEF.md](BRIEF.md). Where this draft names a law it does so only by its common name; please check applicability.
- **Not covered.** The paid subscription terms, the privacy policy, a data processing agreement, and any on-premises
  licence. The on-premises product (one organisation per install) is a different offer and is out of scope.

## 1. What this test is

1.1 [PRODUCT NAME] (the "Service") is pre-release software run by [COMPANY LEGAL NAME] ("we", "us"), of [REGISTERED ADDRESS].
The organisation that accepts these terms is the "Tester" ("you").

1.2 The test is by invitation only. Access is personal to the invited organisation and may not be passed to others.

1.3 The purpose is to let us learn from real use and to let you judge the Service. We ask for your feedback (clause 6).

1.4 The test starts on [DATE] and ends on [END DATE / "after [N] days"], unless extended or ended earlier under clause 9.
We will tell you in writing before it ends.

1.5 The test is free. [Placeholder: state here if any fee, deposit or usage charge applies.]

1.6 Neither of us is obliged to enter a later subscription. Taking part gives you no right to a price, a discount, a
place, a feature or a continued service after the test, unless we agree that separately in writing.

## 2. Status of the Service: what has and has not been done

We want you to decide with accurate information. As of [DATE]:

2.1 **No independent security review.** The Service has not had an independent security review or penetration test. Two
internal reviews were done by the provider's own team and tools, and the provider's records list known residual risks.
See [security-review-p2.md](../internal/security-review-p2.md) and [security-model.md](../admin/security-model.md).

2.2 **Isolation between organisations is tested only by us.** Separation of one tester's data from another's has been
tested only by the provider's own tests. [Confirm on the day: the isolation test suite exists and has been run. Today the
documents state that multi-tenant isolation does not yet exist.] A failure could expose one tester's data to another.

2.3 **No load testing at scale.** The Service has not been load tested. Performance with many users is unknown.

2.4 **Parts verified only by emulation or mocks.** Some features have so far been checked only in emulation or against
mock services, not in real conditions. These categories are: (a) phone features (home-screen use, camera and barcode
scanning, offline use), checked only in browser emulation and never on a real Android or iOS phone; (b) WhatsApp
messaging, checked only against a simulated Meta service and never against a real WhatsApp Business account;
(c) operation as a hosted service over the internet, which has not been exercised. Also unverified: real mail providers.
See [p2-spec.md](../plan/p2-spec.md), "Exit check results" and "Carried forward".

2.5 **No certifications.** We do not claim any security or compliance certification or attestation. Nothing in these
terms or in our materials says that the Service meets any legal, regulatory or industry standard.

2.6 **Known limits.** Data is not encrypted at rest by the product itself [confirm for the hosting set-up]. Audit records are
not tamper-proof. Other limits are listed in the security model page linked above.

2.7 By taking part you accept that you are using software in this state.

## 3. What to put into the Service

3.1 We recommend test data or low-sensitivity data only. Assume that data you enter could be lost, corrupted or seen by
someone who should not see it.

3.2 **During the test you must not enter:** (a) health or medical data; (b) payment card data or bank login details;
(c) government identity numbers (for example national ID, tax or passport numbers); (d) data about children; (e) any data
you are legally or contractually required to keep under stricter controls; (f) other special-category or highly
sensitive data. [Lawyer: tune this list.]

3.3 You are responsible for having the right to upload any personal data you enter, and for your own legal duties as the
party that decides why and how that data is used (for example notices, consent, lawful basis, retention).

## 4. Data handling

4.1 **Roles.** As between us, you decide why and how your data is used; we process it on your behalf to run the Service
(in data-protection terms, you are the controller / data fiduciary and we are the processor / service provider).
[Lawyer: confirm under India's Digital Personal Data Protection Act, 2023, and under GDPR / UK GDPR if EU or UK testers are
invited, and under any other law that applies.]

4.2 **Location.** Your data is hosted in [REGION] by [HOSTING PROVIDER]. [Confirm.]

4.3 **Sub-processors.** [List: hosting provider; email relay; WhatsApp / Meta if you use that connector; others.]
We will tell you in writing of changes before they take effect [notice period].

4.4 **Confidentiality.** We treat your data as confidential and use it only to provide, secure and support the Service.

4.5 **Staff access.** Our staff and operators will access your data only for support or security, on request or where needed
to keep the Service running, and the access is planned to be logged. [Confirm: this is planned behaviour; an operator
console with audited access is outlined, not built.]

4.6 **Backups.** We intend to keep backups of the hosted Service [frequency and retention to be confirmed]. Backups may
fail, may be incomplete and have not been tested in a hosted setting. Do not treat them as your only copy.

4.7 **Export.** You can export your data at any time using the Service's export function. [Confirm: today an export of all
tables as CSV files exists for one install; it does not include attachment files, and a per-tenant version for the hosted
Service is not built. See [backup-and-restore.md](../admin/backup-and-restore.md).] Keep your own copy of anything you need.

4.8 **Deletion.** On your written request, and in any case within [N] days after the test ends, we will delete your data
and tell you when done. Copies in backups are removed within [N] days after that. [Confirm that deletion per tenant works,
including backups, and the recycle-bin behaviour.]

4.9 **Breach notice.** If we become aware of a personal data breach affecting your data, we will tell you without undue
delay and within [N] hours, with the information we have.

4.10 A separate data processing agreement may be needed. We will sign one on request and [may require one for EU / UK
testers]. [Lawyer.]

## 5. Your responsibilities

5.1 **Accounts.** Keep credentials secret, use two-step verification for administrators, and tell us promptly of any
suspected unauthorised access. You are responsible for what people you add do in the Service.

5.2 **Acceptable use.** You must not: (a) upload unlawful content or content you have no right to use; (b) try to access
another organisation's data or the Service's internals, or bypass any limit; (c) run load, stress or security tests without
our prior written permission; (d) interfere with the Service or other testers; (e) use the Service to send spam.

5.3 **Reporting vulnerabilities.** If you find a security problem, please report it to [SECURITY CONTACT EMAIL] and give us a
reasonable time [N days] to fix it before telling anyone else. Do not access, change or keep other organisations' data
beyond what is needed to show the problem. If you act in good faith and follow this clause, we will not take legal action
against you or end your access for the report. [Lawyer: this safe harbour is for you to word and limit.]

5.4 **Messages sent through connectors.** If you send email or WhatsApp messages through the Service, you alone are
responsible for having the recipient's consent, for approval of message templates by the provider concerned (for example
Meta), and for following the laws and platform rules that apply. The Service records opt-ins and refuses to send without
one, but this does not make you compliant. See [whatsapp.md](../dev/whatsapp.md).

5.5 **No critical use.** Do not rely on the Service for safety-critical functions, or as your only record for anything
the law or a regulator requires you to keep, during the test.

## 6. Feedback and intellectual property

6.1 You keep all rights in your data and in the apps and content you create with the Service.

6.2 We keep all rights in the Service, its software, documentation and name. You get a limited, non-transferable right to use
it during the test under these terms.

6.3 You give us a free, worldwide, perpetual licence to use any feedback or suggestions you give us, without owing you
anything. We will not publish your data or identify you as the source without your permission.

6.4 Neither of us will use the other's name or logo in publicity without written consent.

6.5 Non-public information about the Service (features, roadmap, known problems, security findings) is our confidential
information. Do not disclose it, except to your advisers under a duty of confidence. Your data and business information are
confidential to us under clause 4.4. [Lawyer: standard exceptions; consider a separate NDA.]

## 7. Availability and changes

7.1 We give no uptime commitment during the test. The Service may be slow, interrupted or unavailable without notice.

7.2 Features may change or be removed. We may need to migrate your data to another system or, with [N] days' notice and an
export window, reset the test environment.

7.3 Support is best effort by email at [SUPPORT CONTACT], during [HOURS], with no response time promised.

## 8. Warranty and liability

8.1 The Service is provided "as is" and "as available". To the extent the law allows, we give no warranty that it is secure,
error-free, available, fit for any purpose, or that data will not be lost.

8.2 To the extent the law allows, we are not liable for indirect or consequential loss, loss of profit, revenue, goodwill
or data, and our total liability for anything arising from the test is limited to [AMOUNT / the fees paid, which is zero].

8.3 Nothing in these terms excludes or limits liability that cannot be excluded or limited by law.
[Lawyer: such exclusions have limits under Indian law and under consumer and unfair-terms laws elsewhere, and liability for
data protection breaches may not be excludable or capped. Draft conservatively and advise.]

## 9. Suspension and termination

9.1 Either of us may end the test at any time by written notice [N days, or immediately for serious breach].

9.2 We may suspend access at once if we reasonably believe there is a security risk, unlawful use or a breach of clause 3 or 5.

9.3 On ending, you will have [N] days to export your data; after that clause 4.8 applies.

9.4 Clauses that by their nature should survive will survive: 2 (as a record), 3.3, 4.4, 4.8, 5.3, 6, 8, 11.

## 10. Moving to a paid subscription

10.1 A paid subscription, if offered, will be under separate terms. Pricing is expected to be per seat: [PRICE PER SEAT /
seat bands].

10.2 If you do not subscribe, your data is exported and deleted under clause 4.8 and 9.3. [Confirm.]

## 11. General

11.1 **Governing law and disputes:** [GOVERNING LAW / COURTS / ARBITRATION].
11.2 **Changes:** we may change these terms with [N] days' written notice; if you object, you may end the test.
11.3 **Entire agreement:** these terms are the whole agreement for the test and replace earlier discussions about it.
11.4 **Assignment:** you may not assign these terms; we may assign them to a successor of the business on notice.
11.5 **Notices:** by email to [CONTACT EMAIL] and to the email address you gave on sign-up.
11.6 **Electronic acceptance:** you accept by [clicking "I agree" / signing]. The person accepting confirms they may bind
the Tester organisation.
11.7 **Contracting party:** [COMPANY LEGAL NAME]. [Lawyer: see open question 1.]

## Open questions for the lawyer

1. **Which entity contracts, and when?** The company does not exist yet. [legal-essentials.md](legal-essentials.md) and
   [BRIEF.md](BRIEF.md) record that the founder is an employee serving notice, with a no-moonlighting policy until about the
   end of January 2027, and that the employment contract's IP and exclusivity clauses have not been read by a lawyer. May the
   founder contract or invite testers before an entity exists, or before the last working day? Not resolved here.
2. **DPDP Act:** what obligations arise for a hosted processor? Is a data processing agreement and cross-border transfer
   wording needed, and when? Do CERT-In reporting duties apply?
3. **GDPR / UK GDPR** if EU or UK testers are invited: representative, standard contractual clauses, Article 28 terms.
4. **Limitation of liability:** enforceability in India and in testers' countries; what cannot be excluded.
5. **NDA:** are tester organisations better served by an NDA in addition to, or instead of, these terms?
6. **Insurance:** is cyber / professional liability cover advisable before storing other companies' data?
7. **Export controls and sanctions:** screening of testers and countries.
8. **Vulnerability reporting safe harbour:** exact wording and limits.
9. **Consumer law:** exposure if individuals (not companies) sign up.
10. **E-signature and click-accept validity** in each relevant country.
11. **Record retention:** consent and acceptance records, access logs, support records.
12. **Tax on later subscriptions** (GST, cross-border, TDS): for an accountant.
13. **Is a free test with no fee still a contract** in the relevant countries, and does it need consideration wording?
14. **Hosting offer timing:** [BRIEF.md](BRIEF.md) and the launch plan lean towards not hosting for others before a later
    stage; the owner's later decision allows hosted testers earlier. Is that a risk to flag to testers or insurers?

## Facts to confirm against the product before use

Each statement must be true on the day the terms are sent. Today the documents show most of them as not built or not
verified.

| Statement in the terms | Where | What to confirm |
|---|---|---|
| Hosted multi-tenant Service exists and is the thing being tested | 1, 2 | Multi-tenancy is specified, built and running |
| Tenant isolation tests exist and pass | 2.2 | The suite exists; results recorded |
| Hosting region and provider | 4.2, 4.3 | Named in [REGION] and sub-processor list |
| Operator access is logged | 4.5 | An audited operator console exists |
| Backups taken, frequency, retention | 4.6 | Per-tenant backup and restore in the hosted set-up, with a drill |
| Export of all your data at any time | 4.7 | Per-tenant export works, incl. attachment files or a clear note that they are excluded |
| Deletion per tenant, including backups | 4.8 | Tested deletion; backup expiry time |
| Two-step verification available | 5.1 | Works in the hosted Service |
| Encryption at rest status | 2.6 | Stated truthfully for the hosting set-up |
| WhatsApp / email connectors described accurately | 5.4 | Status of real-account tests; mail provider used |
| Breach-notice and support contacts staffed | 4.9, 5.3, 7.3 | Mailboxes exist and are monitored |
