# GST calculation specification: DRAFT for the accountant's review

Status: **DRAFT, NOT SIGNED OFF.** Document version **0.1-draft**, written 20 November 2026 by package G of Phase 3
([p3-spec.md](p3-spec.md) section 4). Every source below was read on **20 November 2026** unless the source entry says
otherwise.

> **This is not tax advice, and nothing in it may be relied on until it is signed off.**
>
> - **Who must review it:** a practising chartered accountant chosen by the owner, who reviews, corrects and signs off
>   this document in section 12. Until that sign-off is recorded in [decisions.md](../decisions.md), the ledger and GST
>   package (package L) may not start: no code, no tables, no rate data ([p3-spec.md](p3-spec.md) section 4.3).
> - **Every rule, rate, threshold and date** in this document must be checked by that person against the law in force
>   on the day of the review. The author is software, not a tax professional. Marks of VERIFIED below mean only "read
>   today in an official source"; they do not mean "correctly understood" or "still current".
> - **GST law changes often.** Rates, thresholds, forms and procedures are changed by notifications, sometimes with a
>   few days' notice (the rate structure changed on 22 September 2025 and again for some goods on 1 February 2026; see
>   section 4). A consolidated text on a government website can be months behind the latest notification.
> - The software described here records and computes; it does not decide what the law requires for a particular
>   business. That stays with the business and its accountant.
> - Do not call the product "GST compliant" or "GST-ready" because this document exists
>   ([legal-essentials.md](../launch/legal-essentials.md) section 7).

## 0. How to read this document

### 0.1 Marks

Every statement about the law carries one mark:

| Mark | Meaning |
| --- | --- |
| **VERIFIED** | Read today in an official or primary source listed in 0.3 (an Act, Rule, notification, Council minutes, a government portal). The source may still be out of date: see its "as on" date. |
| **SECONDARY** | Taken from a non-official source (named). Must be checked against the official text. |
| **UNVERIFIED** | From general knowledge or a search summary only; could be wrong or out of date. The accountant must confirm or supply the correct value. |

Statements about what the software will do carry **DESIGN**: a proposal of this draft, not a statement of law. Each
DESIGN rule that depends on the law names the legal rule it serves, and the accountant may change it.

Rule numbers (`G3.4`) are stable identifiers: each numbered rule can be implemented and tested on its own, and the
ledger package's tests will name them.

### 0.2 Notation

Amounts are in rupees (₹) with Indian digit grouping (₹1,00,000 is one lakh; ₹5,00,00,000 is five crore). "Taxable
value" is the value on which GST is computed. CGST = central tax, SGST = State tax, UTGST = Union territory tax, IGST =
integrated tax. "The business" is the customer of our software who issues the documents. Examples assume the business
is registered in Madhya Pradesh unless they say otherwise; state names and codes in examples are illustrative.

### 0.3 Sources read

| Id | Source | URL actually read | Notes |
| --- | --- | --- | --- |
| S1 | Central Goods and Services Tax Act, 2017, consolidated text "As on the 11th June, 2026" (India Code, Legislative Department) | https://www.indiacode.nic.in/indiacode/bitstream/123456789/15689/1/A2017-12.pdf | Lists amending Acts up to the Finance Act, 2026 (4 of 2026). Changes after 11 June 2026 are not in it. |
| S2 | CGST Act on the CBIC tax information portal, "Last Updated: 28-September-2022" | https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/documents/Central_Goods_and_Services_Tax_Act__2017_28-September-2022.html | Used only for enforcement dates printed under sections (for example s.170 "Enforced w.e.f. 1st July, 2017"). Older than S1. |
| S3 | Integrated Goods and Services Tax Act, 2017, consolidated "As on 23rd May, 2025", copy hosted by the Maharashtra GST Department | https://www.mahagst.gov.in/public/uploads/mvatservices/1760513935IGST_Act.pdf | A State government copy of the official consolidation. Amendments after 23 May 2025 (for example by the Finance Act, 2026) are **not** checked. The India Code copy (https://indiacode.nic.in/bitstream/123456789/7773/1/igst-act.pdf) answered with a redirect and was not read. |
| S4 | CGST Rules, 2017, rules 46, 47, 48, 49, 50, 51, 53, 54, 55 on the CBIC tax information portal | https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html (and `rule47_v1.00.html` ... `rule55_v1.00.html` in the same folder) | The latest amendment footnote seen is Notification 20/2024-CT (rule 46). Later amendments of these rules, if any, are not shown. Rule 46A and rule 47A pages answered HTTP 500 and were not read. |
| S5 | CGST Rules, rules 5 and 7 (composition) | https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter2/rule5_v1.00.html and `.../chapter2/rule7_v1.00.html` | As S4. |
| S6 | CGST Rules, rule 138 (e-way bill) | https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter16/rule138_v1.00.html | As S4. |
| S7 | Minutes of the 56th meeting of the GST Council, held 3 September 2025 | https://www.gstcouncil.gov.in/sites/default/files/Minutes/minutes_56th_gstcm.pdf | Decisions on rate rationalisation, effective dates, compensation cess, post-sale discounts. Minutes record recommendations; the law changes only by the notifications or Acts that follow. |
| S8 | Gazette of India: Notification 19/2025-Central Tax (Rate), 19/2025-Integrated Tax (Rate) and 19/2025-Union Territory Tax (Rate), all dated 31 December 2025 | https://egazette.gov.in/WriteReadData/2025/268978.pdf | Amends Notification 9/2025-CT(Rate) dated 17 September 2025 (G.S.R. 641(E)) and its IGST and UTGST twins. Shows the schedule headings of 9/2025. The principal notification 9/2025-CT(Rate) itself was **not** read. |
| S9 | Notification 10/2023-Central Tax, 10 May 2023 (e-invoice threshold) | https://gstcouncil.gov.in/sites/default/files/2024-05/10ct_eng.pdf (listed at https://gstcouncil.gov.in/node/4365) | |
| S10 | Notification 13/2020-Central Tax, 21 March 2020 (e-invoice class of persons, original text) | https://www.gstcouncil.gov.in/sites/default/files/2024-05/notfctn-13-central-tax-english-2020.pdf | Original text only; amended several times since (see 8.1). |
| S11 | GSTN advisory "Time Limit for Reporting e-Invoice on the IRP Portal: Lowering of Threshold to AATO 10 Crores and Above", 5 November 2024 | https://www.mahagst.gov.in/public/uploads/gstnadvisory/1760531580_293%20Advisory%20Time%20Limit%20for%20Reporting%20e%20Invoice%20on%20the%20IRP%20Portal%20%20Lowering%20of%20Threshold%20to%20AATO%2010%20Crores%20and%20Above.pdf | A copy "Downloaded from Goods & Services Tax Portal", hosted by the Maharashtra GST Department. |
| S12 | Notification 78/2020-Central Tax, 15 October 2020 (HSN digits on invoices) | https://www.gstcouncil.gov.in/sites/default/files/2024-05/notfctn-78-central-tax-english-2020.pdf | |
| S13 | E-invoice portal home page | https://einvoice1.gst.gov.in/ | Read for a notice on 6-digit HSN codes only. |
| S14 | E-way bill portal home page | https://ewaybillgst.gov.in/ | Read for the ₹50,000 statement and its "Latest Updates" list. |

Sources that were tried and **not** reached or not read: `cbic-gst.gov.in/CGST-bill-e.html` (HTTP 404); the CBIC tax
information portal through the normal web fetcher (its TLS certificate chain could not be verified; the pages above were
downloaded without certificate checking, and their text agrees with S1 where both cover the same section); CGST rules
46A and 47A (HTTP 500); the principal rate notifications 9/2025-CT(Rate) and 9/2025-IT(Rate); the services rate
notification 11/2017-CT(Rate) as amended; the reverse charge notifications 13/2017-CT(Rate) and 4/2017-CT(Rate) as
amended; Notification 14/2019-CT (composition threshold); Notification 66/2017-CT (advances for goods); the GSTR-1 and
GSTR-3B forms and their notified formats; the e-invoice schema (FORM GST INV-01) and its validation rules on the IRP
documentation pages; the GST Council newsletters (seen only as search results).

### 0.4 Coverage of p3-spec section 4.1

Exit check 14 requires every heading of [p3-spec.md](p3-spec.md) section 4.1 to be covered:

| p3-spec 4.1 heading | Where in this document |
| --- | --- |
| 1. Tax types and place of supply, goods and services, intra-state, inter-state, exports, SEZ | Section 3 |
| 2. HSN and SAC codes and rates as data (table shape, effective dates, who maintains) | Sections 2.4, 4.1 to 4.3, 11.2 |
| 3. Rounding | Section 5.2 |
| 4. Reverse charge | Section 6.1 |
| 5. Credit notes and debit notes | Sections 5.4, 7.4, 9.3 |
| 6. Composition scheme | Section 6.2 |
| 7. E-invoice and e-way bill as configurable values; this phase generates neither | Section 8 |
| 8. Invoice numbering rules | Section 7.6 |
| 9. Tax invoice, bill of supply, delivery challan, commercial document | Sections 7.1 to 7.5 |
| 10. What the software will NOT do | Section 1.2 |
| 11. Worked-example table, at least 30 cases | Section 5.5 (32 cases, all "to be confirmed by the accountant") |
| 12. Open questions for the accountant, numbered | Section 11.1 |

## 1. Scope of the first version

### 1.1 What the first version computes and records (DESIGN)

- **G1.1** For one registered business (one GSTIN, see G2.1): tax on outward documents (tax invoice, bill of supply,
  credit note, debit note, receipt voucher, refund voucher, delivery challan) and the records of inward documents
  (purchase invoices, purchase credit and debit notes, self-invoices and payment vouchers under reverse charge).
- **G1.2** The tax type (CGST + SGST/UTGST, or IGST) from the place of supply, by the decision table of section 3; the
  software stops and asks for a human decision in every case the table marks STOP.
- **G1.3** The tax amounts per line and per document, by the rounding rules of section 5.
- **G1.4** The GST postings in the ledgers (output tax, input tax credit, reverse charge, round-off) by the journals of
  section 9.
- **G1.5** Export of summaries the business's accountant uses to prepare returns (section 10).
- **G1.6** Fields to record, and print, numbers produced elsewhere: the IRN, its acknowledgement number and date, the
  signed QR code image, the e-way bill number and date (section 8).

### 1.2 What the first version does NOT do (DESIGN, stated plainly)

- **G1.7** It does not prepare, file or upload any return (GSTR-1, GSTR-1A, GSTR-3B, GSTR-4, CMP-08, GSTR-9 or any other).
- **G1.8** It does not generate an IRN, sign or obtain an e-invoice QR code, or generate, extend or cancel an e-way bill
  through the government systems. It has no connection to the GST portal, the IRP, the e-way bill portal, a GSP or an ASP.
- **G1.9** It does not compute TDS under section 51 or TCS under section 52 of the CGST Act, and does not record them
  beyond a free-text note.
- **G1.10** It does not reconcile with GSTR-2A, GSTR-2B or the Invoice Management System, and does not decide whether
  input tax credit may be claimed in a period (only an eligibility flag per purchase line, G6.10).
- **G1.11** It does not handle: more than one GSTIN per install, Input Service Distributor documents, job work
  challans' return tracking, e-commerce operator supplies (sections 9(5) and 52), online information and database
  access services from abroad, imports of goods (bill of entry), exports with payment of IGST and refund claims, deemed
  exports, refunds of any kind, advance rulings, interest, late fees, penalties, the anti-profiteering rules, foreign
  currency invoices, or the place-of-supply special cases listed in G3.9.
- **G1.12** It gives no tax advice and makes no statement that a business or a document complies with the law.

## 2. Data the software needs

Rule: **rates, thresholds and dates are data with an "effective from" date (and "effective to" where it ends), entered or
imported by the business's administrator from a source the accountant approved. They are never constants in code.**
(DESIGN; [p3-spec.md](p3-spec.md) section 4.1 item 2.) The product ships no rate data until the accountant has approved
the source and the shape (p3-spec 4.1 item 2).

### 2.1 The business's registration (master data, maintained by the business)

- **G2.1** Registration: GSTIN, legal name, trade name, principal place of business (address, State, State code),
  additional places of business, registration type, effective date of registration, date of cancellation if any, and the
  aggregate turnover of each past financial year (used by G8.1 and G7.7). DESIGN: the table allows several registrations;
  the first version allows exactly one active registration per install (p3-spec 4.1 item 10). A person with more than
  one registration is treated as distinct persons for each registration (S1 s.25(4), **VERIFIED**), so a second GSTIN
  would need its own number series, ledgers and returns; that is why it is out of scope.
- **G2.2** Registration types the first version recognises: `regular`, `composition` (section 10(1)/(2)),
  `composition-services` (section 10(2A)), `unregistered`. Recognised but **STOP** (the software refuses to issue tax
  documents for them): `SEZ unit`, `SEZ developer`, `casual taxable person`, `non-resident taxable person`, `ISD`,
  `TDS deductor`, `TCS collector`, `UIN holder`. (Types: general knowledge, **UNVERIFIED** as a complete list.)
- **G2.3** Composition details as data with effective dates: the date the option took effect, the category
  (manufacturer / restaurant service / other supplier / section 10(2A)) and the rate (section 6.2).
- **G2.4** LUT details as data: LUT reference number, financial year, date filed (needed before an export or SEZ
  supply without payment of IGST, G3.7). Whether an LUT is needed and valid is for the business (**UNVERIFIED** that an
  LUT is per financial year: [legal-essentials.md](../launch/legal-essentials.md) section 6 says so, secondary).

### 2.2 Customers and suppliers (master data)

- **G2.5** For each party: legal name; GSTIN or "unregistered"; registration type (regular, composition, SEZ unit, SEZ
  developer, UIN holder, unregistered, overseas); billing address with State and State code; one or more shipping
  addresses with State and State code; country; PAN (optional).
- **G2.6** GSTIN check (DESIGN): 15 characters; the first two digits are the State code and must match the party's
  State; characters 3 to 12 are a PAN. The structure and the check character are **UNVERIFIED** (general knowledge);
  the software checks only the length, the character set, and the State code prefix, and the accountant confirms whether
  the check-digit algorithm should be applied.

### 2.3 Reference data (data with effective dates, maintained by the administrator)

- **G2.7** States and Union territories: name, GST State code, `kind` (`state`, `ut_with_legislature`,
  `ut_without_legislature`), whether intra-UT supplies use UTGST, whether it is a special category State (registration
  threshold), effective from / to (codes changed when territories merged; for example Dadra and Nagar Haveli and Daman
  and Diu, **UNVERIFIED**). The list, the codes and the kinds are **UNVERIFIED**: the accountant supplies them.
- **G2.8** Units: the Unique Quantity Codes (UQC) list for rule 46(i) ("unit or Unique Quantity Code", S4, **VERIFIED**
  that the field exists); the list itself is **UNVERIFIED** and is data.
- **G2.9** Thresholds and switches (section 11.2): e-invoice turnover threshold, e-way bill consignment value, HSN digits
  by turnover, B2C-large invoice value for return summaries, registration thresholds, composition turnover limit.

### 2.4 Items and services (master data)

- **G2.10** Each item or service: name, kind (`goods` or `service`), HSN code (goods) or SAC code (services) as text,
  unit (UQC), a **tax rate reference** (a key into the rate table of 4.1, not a percentage), and a **supply class**:
  `taxable`, `nil-rated`, `exempt`, `zero-rated-capable` (taxable, but may be supplied as zero-rated to SEZ or export),
  `non-GST` (not leviable to GST, for example alcoholic liquor for human consumption, S1 s.9(1), **VERIFIED**).
  "Exempt supply" in the Act includes nil-rated, wholly exempt and non-taxable supplies (S1 s.2(47), **VERIFIED**);
  the software keeps the three apart because return summaries list them separately (**UNVERIFIED**, section 10).
- **G2.11** Optional per item: reverse charge category reference (section 6.1), "ITC normally ineligible" default for
  purchases (G6.10), cess reference (G4.4).
- **G2.12** DESIGN: on ERP-lite Items (package P) the HSN/SAC code is plain text with no rate attached until package L
  ([p3-spec.md](p3-spec.md) section 4.3); package L adds the rate reference.

### 2.5 Rules (code, not data)

- **G2.13** The decision tables of section 3, the computation and rounding of section 5, the document rules of
  section 7 and the journals of section 9 are code, each covered by tests that cite the rule number. A change in law
  that changes one of these needs a new software version; a change of rate, threshold or date needs only new data.

## 3. Determining the tax type

### 3.1 The law the table is built on

- **G3.1** Inter-State supply of goods: location of the supplier and the place of supply in two different States, two
  different Union territories, or a State and a Union territory (IGST Act s.7(1), S3, **VERIFIED**). Same for services
  (s.7(3), **VERIFIED**). Intra-State: both in the same State or Union territory (s.8(1), s.8(2), **VERIFIED**).
- **G3.2** Supplies to or by an SEZ developer or SEZ unit are inter-State, also when both are in one State (s.7(5)(b)
  and the provisos to s.8(1) and s.8(2), S3, **VERIFIED**). So they carry IGST, never CGST + SGST.
- **G3.3** Supply where the supplier is in India and the place of supply is outside India is inter-State (s.7(5)(a),
  **VERIFIED**). Export of goods or services and supplies to an SEZ developer or unit for authorised operations are
  "zero rated supply" (s.16(1), **VERIFIED**), made either under bond or LUT without payment of IGST or on payment of
  IGST (s.16(3), (4), **VERIFIED**).
- **G3.4** Intra-State supply carries CGST and SGST, or CGST and UTGST in a Union territory to which the UTGST Act
  applies (**UNVERIFIED** which UTs; G2.7). Inter-State supply carries IGST. (General structure, consistent with the
  twin CT/IT rate schedules in S8: 9% CGST against 18% IGST; **VERIFIED** for those schedules.)

### 3.2 Place of supply of goods (IGST Act s.10, S3, VERIFIED)

| Case | Place of supply | Provision |
| --- | --- | --- |
| Supply involves movement of goods (by anyone) | Location of the goods where the movement ends for delivery to the recipient | s.10(1)(a) |
| Goods delivered to the recipient or another person on the direction of a third person (bill-to / ship-to) | Principal place of business of the third person (the bill-to party) | s.10(1)(b) |
| No movement of goods | Location of the goods at delivery | s.10(1)(c) |
| Supply to a person who is not registered | The address of that person recorded in the invoice (recording the name of the State counts as recording the address); the supplier's location if no address is recorded. Applies notwithstanding (a) and (c) | s.10(1)(ca), inserted w.e.f. 1-10-2023 |
| Goods assembled or installed at site | Place of installation or assembly | s.10(1)(d) |
| Goods supplied on board a conveyance | Where the goods are taken on board | s.10(1)(e) |
| Exported goods | Location outside India | s.11(b) |

### 3.3 Place of supply of services between persons in India (IGST Act s.12, S3, VERIFIED)

- **G3.5** General rule (s.12(2)): to a registered person, the location of that person; to anyone else, the location of
  the recipient where the address on record exists, otherwise the location of the supplier. Sub-sections (3) to (14)
  carve out special services (immovable property, hotels, restaurants, training, events, transport of goods and
  passengers, telecom, banking, insurance, advertising and others).
- **G3.6** Cross-border services (supplier or recipient outside India): general rule location of the recipient, or of
  the supplier where the recipient's location is not available in the ordinary course of business (s.13(2),
  **VERIFIED**); sub-sections (3) to (13) carve out exceptions (STOP in the first version).

### 3.4 Decision table for the first version (DESIGN; each row cites the rule above)

Inputs: supplier State (from the registration), document kind, item kind (goods / service), recipient registration
type and State, bill-to and ship-to parties and States, "movement of goods: yes/no", "installed at site: yes/no",
country of the ship-to address, the service's place-of-supply category (data per SAC, default `general`).

| # | Situation | Place of supply | Tax type | Basis |
| --- | --- | --- | --- | --- |
| T1 | Goods, recipient registered, ship-to = bill-to, moved to the recipient's State = supplier State | Supplier State | CGST + SGST/UTGST | s.10(1)(a), s.8(1) |
| T2 | As T1, delivery State differs from supplier State | Delivery State | IGST | s.10(1)(a), s.7(1) |
| T3 | Goods, bill-to registered party A, ship-to another party or address B on A's direction | A's principal place of business (A's State on its GSTIN) | IGST if A's State differs from supplier State, else CGST + SGST | s.10(1)(b) |
| T4 | Goods, recipient unregistered, address (or at least State) recorded on the invoice | The recorded State | By comparison with supplier State | s.10(1)(ca) |
| T5 | Goods, recipient unregistered, no address recorded | Supplier State | CGST + SGST | s.10(1)(ca) |
| T6 | Goods, no movement (collected at the supplier's premises by a registered recipient) | Location of goods at delivery | Usually CGST + SGST | s.10(1)(c) |
| T7 | Services, `general` category, recipient registered | Recipient's location (its State on its GSTIN) | By comparison | s.12(2)(a) |
| T8 | Services, `general`, recipient unregistered with address on record | Recipient's State | By comparison | s.12(2)(b)(i) |
| T9 | Services, `general`, recipient unregistered, no address | Supplier State | CGST + SGST | s.12(2)(b)(ii) |
| T10 | Any supply to an SEZ unit or SEZ developer (recipient type) for authorised operations | As per T1 to T9 | **IGST always** (or zero-rated under LUT, G3.7) | s.7(5)(b), s.8 provisos, s.16(1)(b) |
| T11 | Goods exported (ship-to outside India) | Outside India | Zero-rated: under LUT without IGST (G3.7) | s.11(b), s.16 |
| T12 | Services, `general`, recipient outside India | Recipient's location (outside India) | Zero-rated if all conditions of "export of services" are met (the business confirms per document, G3.8) | s.13(2), s.16 |
| T13 | Goods assembled or installed at a site | Site State | By comparison | s.10(1)(d) |

- **G3.7** Zero-rated supplies (T10 optional, T11, T12): the document carries IGST 0 and the endorsement of G7.2 only if
  the registration has a valid LUT entry (G2.4) for the document's financial year; otherwise the software refuses to
  issue the zero-rated form and offers "with payment of IGST" for SEZ (T10) only. Exports with payment of IGST are out of
  scope (G1.11). DESIGN.
- **G3.8** "Export of services" has conditions in the Act (s.2(6) of the IGST Act, including payment in convertible
  foreign exchange or as permitted by the RBI, **UNVERIFIED**: definition not read). The software asks the user to
  confirm "conditions of export of services are met" per document and records who confirmed. DESIGN.
- **G3.9** **STOP cases** (the software refuses to compute and says "place of supply needs the accountant: <reason>";
  the user may enter a manual place of supply only if an administrator has enabled "manual place of supply" and gives a
  reason, which is audited). DESIGN, based on s.12(3) to (14) and s.13(3) to (13) (S3, **VERIFIED** that these special
  rules exist):
  - services directly in relation to immovable property, hotel and event accommodation (s.12(3));
  - restaurant, catering, grooming, fitness, beauty and health services (s.12(4));
  - training and performance appraisal to unregistered persons (s.12(5)(b));
  - admission to and organisation of events (s.12(6), (7));
  - transport of goods (including courier) and of passengers (s.12(8), (9)) **when the business is the supplier**
    (receiving GTA services under reverse charge is in scope, section 6.1);
  - telecommunication, DTH, banking, insurance, advertising to government (s.12(10) to (14));
  - any cross-border service whose SAC is in a special category of s.13(3) to (13);
  - supplies on board a conveyance (s.10(1)(e)), territorial waters (s.9), goods imported, bonded warehouse transactions,
    "Bill to - ship to" where the third person is outside India, and supplies where the user cannot say whether goods
    move.
- **G3.10** The place of supply is stored on the document (State code, or "96 / other country" for exports:
  **UNVERIFIED** code) and printed (rule 46(n), "place of supply along with the name of the State, in the case of a
  supply in the course of inter-State trade or commerce", S4, **VERIFIED**). DESIGN: the software prints it on every
  tax invoice, intra-State included (common practice, **UNVERIFIED** as a requirement).
- **G3.11** Bill-to / ship-to printing: rule 46(o) requires the address of delivery where it differs from the place of
  supply (S4, **VERIFIED**). For an unregistered recipient and a taxable value of ₹50,000 or more, rule 46(e) requires
  the recipient's name and address and the address of delivery with the State name and code (S4, **VERIFIED**).

## 4. Rates

### 4.1 Rate table shape (DESIGN; p3-spec 4.1 item 2)

- **G4.1** Table `TaxRates`: `code` (an HSN or SAC code or a prefix of one, text), `description`, `kind` (goods /
  services), `condition` (free text, for entries that depend on a condition in the notification, for example "with ITC"
  / "without ITC"), `igst_rate`, `cgst_rate`, `sgst_utgst_rate` (all decimals, percent), `cess_rate_ad_valorem`,
  `cess_specific_amount` and `cess_specific_unit` (nullable), `effective_from` (date), `effective_to` (date, nullable),
  `source` (notification number, date, schedule and serial number), `approved_by` and `approved_on` (the accountant's
  approval of the row's source).
- **G4.2** Validation on import: `cgst_rate + sgst_utgst_rate = igst_rate` for every row; no two rows for the same
  `code` and `condition` with overlapping dates; every row has a `source`. DESIGN.
- **G4.3** Lookup for a document line: the item's rate reference and condition, at the **document date** (invoice,
  credit note or debit note date; for a credit or debit note, the rate of the original invoice, G5.12). The longest
  matching code prefix wins. No match: STOP ("no approved rate for HSN/SAC <code> on <date>").
- **G4.4** Rate change across the time of supply: section 14 of the CGST Act decides the rate when goods or services
  are supplied, invoiced and paid on different sides of a rate change (S1 s.14 exists, **VERIFIED**; its content was
  not analysed here, **UNVERIFIED**). First version (DESIGN): if the user marks a document "supply, invoice or payment
  straddle a rate change" or the document date is within 30 days after a rate change for one of its items, the software
  asks the user to confirm the rate date; the accountant decides whether this simplification is acceptable (Q12).

### 4.2 Rate slabs in force as far as verified today

- **G4.5** Since 22 September 2025, the central tax rate notification for goods is Notification 9/2025-Central Tax
  (Rate) dated 17 September 2025 (G.S.R. 641(E)), with schedules that include "Schedule I - 2.5%", "Schedule II - 9%",
  "Schedule III - 20%" and (until 31 January 2026) "Schedule VII - 14%" of central tax; its IGST twin 9/2025-IT(Rate)
  has "Schedule II - 18%", "Schedule III - 40%" and "Schedule VII - 28%" (S8, **VERIFIED** for these headings and
  notification numbers). The Council decided rates of goods (except pan masala, gutkha, cigarettes, chewing tobacco,
  unmanufactured tobacco and bidi) and of services change from 22 September 2025, with slabs of 5% and 18% and a special
  rate of 40% (S7, decision of agenda item 5, **VERIFIED**).
- **G4.6** From 1 February 2026, Notification 19/2025-CT(Rate) moved biris into Schedule II (9% CGST), pan masala and
  tobacco products into Schedule III (20% CGST), and omitted Schedule VII (14%) (S8, **VERIFIED**). So, as far as read,
  the 28% (14% + 14%) slab for goods no longer exists after 31 January 2026.
- **G4.7** The other schedules of 9/2025-CT(Rate) (expected: lower rates for gold, precious stones and rough diamonds)
  and the rate notification for services (11/2017-CT(Rate) as amended in September 2025) were **not read**
  (**UNVERIFIED**). A further amendment, Notification 01/2026-CT(Rate) dated 30 April 2026, was seen only in a search
  summary of a GST Council newsletter (**UNVERIFIED**). The accountant supplies the full current rate data.
- **G4.8** Total GST rates that the rate table must be able to hold (DESIGN, from G4.5 to G4.7): 0%, 0.25%, 1.5%, 3%,
  5%, 18%, 40%, and historical 12% and 28% for documents dated before the changes (0.25%, 1.5% and 3% **UNVERIFIED**).
  The software does not restrict rates to a list: any rate in the table is valid if it has a source.

### 4.3 Compensation cess

- **G4.9** The Council recommended abolishing compensation cess once the obligations of the compensation cess account
  are met, and kept the tobacco products at the existing GST and cess rates until then (S7, decisions (d) and (h),
  **VERIFIED**). Those goods moved to the 40% rate from 1 February 2026 (S8, **VERIFIED**). Whether any compensation
  cess is levied on any goods after 31 January 2026 is **UNVERIFIED**. DESIGN: the rate table keeps cess columns (ad
  valorem and specific), dated, default empty; the first version computes ad valorem cess only and STOPs on a specific
  (per unit) cess until the accountant confirms the method (Q13).

### 4.4 Composite and mixed supply

- **G4.10** Law: a composite supply is treated as a supply of its principal supply; a mixed supply is treated as a
  supply of the item with the highest rate (S1 s.8, **VERIFIED**).
- **G4.11** First version (DESIGN): the software does not decide whether a bundle is composite or mixed. A bundle sold
  for one price is entered as **one line** whose item has the rate the user (advised by the accountant) chose; separate
  lines are taxed separately. Charges that are part of the supply of goods (packing, freight charged by the supplier,
  commission) are taxed as part of the value (G4.13) at the rate of the goods line they belong to, unless the
  accountant says otherwise (Q14).

### 4.5 Discounts

- **G4.12** Law: the value does not include a discount given before or at the time of supply if it is recorded in the
  invoice (s.15(3)(a), S1, **VERIFIED**); a discount given after supply is excluded only if established in terms of an
  agreement made at or before supply and linked to the invoices, and the recipient has reversed the attributable ITC
  (s.15(3)(b), S1 as on 11 June 2026, **VERIFIED**). The Council recommended omitting the agreement and invoice-linking
  condition and requiring post-sale discounts to go through a credit note under section 34 (S7, agenda item 6(f),
  **VERIFIED** as a recommendation); whether that amendment has been made and brought into force is **UNVERIFIED** (it
  is not in S1 as on 11 June 2026). Since 1 October 2025, a credit note reduces the supplier's liability only if the
  registered recipient has reversed the attributable ITC (s.34(2) proviso, S1, **VERIFIED**).
- **G4.13** DESIGN:
  - a discount on the invoice is a line field (percent or amount); the line's taxable value is after the discount;
  - a document-level discount is spread over the taxable lines in proportion to their value before discount, rounded
    to paise per line, with the remainder of the rounding put on the line with the largest value (Q15);
  - a post-sale discount is issued as a **credit note** (G7.4) with the reason `post-sale discount`; the software
    records "ITC reversal by recipient confirmed: yes / no / not applicable" as a field for the accountant; it does not
    decide whether the supplier's liability is reduced;
  - a "financial" or "commercial" credit note without GST (a price adjustment that does not change the taxable value)
    is a separate document type with no tax lines and its own series (Q16).

### 4.6 Freight, packing and other charges on the invoice

- **G4.14** Law: the value includes incidental expenses, including commission and packing, charged by the supplier to
  the recipient, and anything done by the supplier in respect of the supply at or before delivery (s.15(2)(c), S1,
  **VERIFIED**). Also included: interest, late fee or penalty for delayed payment (s.15(2)(d), **VERIFIED**), and taxes
  under other laws charged separately (s.15(2)(a), **VERIFIED**).
- **G4.15** DESIGN: "other charges" (freight, packing, insurance, handling) are entered as lines of kind `charge`
  linked to a goods line or to the whole document; they are taxable at the rate of the linked line, or for a whole-
  document charge, apportioned to lines by value (each portion at its line's rate). Late-payment interest is billed on a
  separate debit note or invoice (Q17).

### 4.7 Tax-exclusive and tax-inclusive prices

- **G4.16** DESIGN: a price list or document is either tax-exclusive (default) or tax-inclusive. For tax-inclusive
  lines: taxable value = round2(inclusive amount ÷ (1 + total rate ÷ 100)); taxes are then computed forward from the
  taxable value by G5.4 (never as "inclusive minus taxable" split in two), so CGST always equals SGST. The difference
  between the customer's inclusive amount and taxable + taxes (at most a few paise) is absorbed by the document round-off
  (G5.7). Worked example W5. The law does not prescribe this method (**UNVERIFIED** that any rule prescribes one); the
  accountant confirms (Q18).

## 5. Calculation and rounding

### 5.1 What the law says about rounding

- **G5.1** Section 170 of the CGST Act: "The amount of tax, interest, penalty, fine or any other sum payable, and the
  amount of refund or any other sum due, under the provisions of this Act shall be rounded off to the nearest rupee",
  fifty paise or more up, less than fifty paise ignored (S1, S2, **VERIFIED**; enforced from 1 July 2017 per S2). The
  text speaks of the amount payable; it does not say whether tax on each invoice or line must be in whole rupees.
  Reading it as applying to the amount payable for a return period, not to invoice lines, is an interpretation
  (**UNVERIFIED**; secondary commentaries disagree: cleartax.in says per tax head, enterslice.com says per invoice).
- **G5.2** The CGST Rules seen (S4) require the amounts of tax on the invoice but say nothing about decimals.
- **G5.3** Common practice (**UNVERIFIED**, not law): invoices show taxable value and each tax to paise; the grand total
  is often rounded to the nearest rupee with a "round off" line; CGST and SGST are computed separately at half rates so
  they are always equal. The e-invoice schema is reported to carry tax to two decimals and an invoice-level round-off
  field (SECONDARY: gimbooks.com, legalsuvidha.com; the schema was not read).

### 5.2 Calculation rules of the first version (DESIGN)

- **G5.4** Arithmetic is decimal (never binary floating point). Money has 2 decimals; quantities up to 3 decimals;
  unit prices up to 4 decimals; rates up to 3 decimals. `round2` rounds to paise **half away from zero** (0.005 becomes
  0.01; -0.005 becomes -0.01).
- **G5.5** Per line: gross = round2(quantity × unit price); discount = round2(gross × discount% ÷ 100) or the entered
  amount; **taxable value** = gross − discount (+ apportioned charges, G4.15; − apportioned document discount, G4.13).
- **G5.6** Per line, per tax component: tax = round2(taxable value × component rate ÷ 100). For intra-State lines CGST
  and SGST/UTGST are computed separately from the taxable value at their own rates (equal by G4.2), so they are equal;
  for inter-State lines IGST at the full rate. Cess, if any, the same way. **Default: tax per line**, document tax = sum
  of line taxes per component. A per-document alternative ("per rate per document": sum the taxable values of all lines
  with the same rate, then compute each component once) is a registration setting with an effective date; W6 shows the
  difference. The accountant chooses (Q1).
- **G5.7** Document total = sum of taxable values + sum of all tax components + non-taxable lines (exempt, nil, non-GST,
  G5.9). **Round-off** (registration setting, default on): the payable total is rounded to the nearest rupee by G5.1's
  rule (50 paise up); round-off = rounded total − exact total, shown as its own line and posted to the round-off account
  (G9.2). Taxes themselves are never changed by the round-off. Credit and debit notes follow the same setting. Q2.
- **G5.8** Odd amounts and the CGST/SGST split: never split an IGST-equivalent amount in two. Always compute each half
  from the taxable value (G5.6). There is no "odd paisa" to allocate. (If the accountant prefers splitting a total tax,
  the rule would be: CGST = round2(total ÷ 2) rounded down to the paisa, SGST = total − CGST; Q3.)
- **G5.9** Exempt, nil-rated, zero-rated and non-GST lines: taxable value is computed as in G5.5 but no tax lines are
  created; the line keeps its supply class for return summaries. A document with only such lines is a bill of supply
  (G7.3) unless it is a zero-rated export or SEZ invoice (G7.2).
- **G5.10** Reverse charge lines (inward): tax is computed by G5.6 on the supplier's taxable value, at the rate of the
  reverse charge entry, and recorded as payable by the business (section 6.1); the supplier's document shows no tax.
- **G5.11** Composition (outward): no tax is computed on documents (section 6.2); the period's composition tax is
  computed on turnover by G6.7.
- **G5.12** Credit and debit notes take the tax type, place of supply and rates of the original invoice (not today's),
  and compute each line by G5.5 and G5.6 on the credited or debited value. A credit note may not credit more taxable
  value or tax per component than the original invoice still has after earlier credit notes. DESIGN, Q4.
- **G5.13** Sign: credit notes are stored with positive amounts and a document type that reverses the postings; the
  return exports show them as the forms expect (section 10).

### 5.3 Advances

- **G5.14** Law: on receipt of an advance, a receipt voucher is issued (s.31(3)(d), S1, **VERIFIED**); where the rate is
  not determinable at receipt, tax is paid at 18%, and where the nature of supply is not determinable, it is treated as
  inter-State (rule 50 proviso, S4, **VERIFIED**). A refund voucher may be issued when no supply follows (s.31(3)(e),
  **VERIFIED**). GST is not payable on advances received for **goods** by most taxpayers under Notification
  66/2017-CT (**UNVERIFIED**, not read).
- **G5.15** First version (DESIGN): advances are in scope for **services** only. The receipt voucher computes tax on the
  advance treated as tax-inclusive (G4.16) at the rate of the service ordered (or 18% and IGST if unknown, per rule 50).
  The later invoice shows the full value and tax; the tax already paid on the advance is adjusted in the return, not on
  the invoice (**UNVERIFIED**, Q5). Advances for goods are recorded as plain customer advances with no tax.

### 5.4 Credit and debit notes

- **G5.16** Law (S1 s.34, **VERIFIED**): a supplier **may** issue one or more credit notes for supplies made in a
  financial year where the taxable value or tax in an invoice exceeds what is payable, goods are returned, or goods or
  services are found deficient (s.34(1)); the credit note must be declared in the return of the month of issue but not
  later than **30 November** following the end of the financial year of the supply, or the date of furnishing the
  relevant annual return, whichever is earlier (s.34(2), "thirtieth day of November" from 1 October 2022); no reduction
  of output tax if the registered recipient has not reversed the attributable ITC, or, in other cases, if the incidence
  of tax has been passed on (proviso, from 1 October 2025). A supplier **shall** issue a debit note where the taxable
  value or tax is found to be less than payable (s.34(3)); a debit note includes a supplementary invoice (Explanation).
- **G5.17** DESIGN: the software refuses a GST credit note for a supply whose financial year's 30 November deadline (a
  dated value per financial year, which the accountant may set earlier to the annual return date) has passed, and
  offers the commercial credit note of G4.13 instead. A credit note may reference several invoices of the same customer
  and financial year (s.34(1) "one or more tax invoices", **VERIFIED**); each credited line names its original invoice
  line.

### 5.5 Worked examples (all expected figures are TO BE CONFIRMED BY THE ACCOUNTANT)

Common settings unless stated: business registered in Madhya Pradesh (MP), regular registration, tax per line (G5.6),
round-off on (G5.7), tax-exclusive prices. "MP" and other States are illustrative. Rates are illustrative inputs, not
statements of the current rate of any real item.

**W1. Intra-State, one rate.** Registered customer in MP. 10 units × ₹1,250.00, 18%.
- Taxable value 10 × 1,250.00 = ₹12,500.00.
- CGST 9% = 12,500.00 × 0.09 = ₹1,125.00; SGST 9% = ₹1,125.00.
- Exact total 12,500.00 + 1,125.00 + 1,125.00 = ₹14,750.00; round-off 0.00; payable ₹14,750.00.

**W2. Inter-State, one rate.** Same as W1, customer registered in Maharashtra, goods delivered there (T2).
- Taxable ₹12,500.00; IGST 18% = ₹2,250.00; total ₹14,750.00.

**W3. Two rates on one invoice, intra-State.**
- Line A: 4 × ₹2,345.50 = ₹9,382.00 at 18%. CGST 9,382.00 × 0.09 = 844.38; SGST 844.38.
- Line B: 3 × ₹799.00 = ₹2,397.00 at 5%. CGST 2,397.00 × 0.025 = 59.925 → **59.93** (half away from zero); SGST 59.93.
- Taxable total 11,779.00; CGST 904.31; SGST 904.31; exact total 13,587.62.
- Round-off +0.38; payable ₹13,588.00.

**W4. Discount recorded on the invoice; a 50-paise total.** 20 × ₹450.00 at 18%, trade discount 7.5%, intra-State.
- Gross 9,000.00; discount 9,000.00 × 0.075 = 675.00; taxable 8,325.00.
- CGST 8,325.00 × 0.09 = 749.25; SGST 749.25.
- Exact total 9,823.50; round-off +0.50 (fifty paise goes up); payable ₹9,824.00.

**W5. Tax-inclusive price.** 1 unit at ₹999.00 inclusive of 18%, intra-State (G4.16).
- Taxable = round2(999.00 ÷ 1.18) = round2(846.6101...) = 846.61.
- CGST = round2(846.61 × 0.09) = round2(76.1949) = 76.19; SGST 76.19.
- Exact total 846.61 + 152.38 = 998.99; round-off +0.01; payable ₹999.00.
- Note: "inclusive minus taxable" would give tax 152.39, which cannot be split equally; G5.8 avoids it.

**W6. Per line versus per document (rounding edge).** Three lines, each 1 × ₹10.10 at 5%, intra-State.
- Per line (default): each line CGST 10.10 × 0.025 = 0.2525 → 0.25; three lines CGST 0.75, SGST 0.75. Exact total
  30.30 + 1.50 = 31.80; round-off +0.20; payable ₹32.00.
- Per rate per document (alternative): taxable 30.30; CGST 30.30 × 0.025 = 0.7575 → 0.76; SGST 0.76. Exact total
  31.82; round-off +0.18; payable ₹32.00.
- The two methods differ by ₹0.01 per component. Test both.

**W7. Exact half paisa (decimal arithmetic test).** 1 × ₹101.00 at 5%, intra-State.
- CGST 101.00 × 0.025 = 2.525 exactly → **2.53** (half away from zero; binary floating point gives 2.52, a bug);
  SGST 2.53.
- Exact total 106.06; round-off −0.06; payable ₹106.00.

**W8. Credit note for goods returned.** Against W1: 2 units returned.
- Credit note references W1's number and date; tax type and rate from W1 (G5.12).
- Taxable 2 × 1,250.00 = 2,500.00; CGST 225.00; SGST 225.00; total ₹2,950.00.
- W1 after the credit note: remaining creditable taxable 10,000.00, CGST 900.00, SGST 900.00.

**W9. Credit note for a post-sale discount.** Against W2 (inter-State): 5% discount on taxable value.
- Taxable credited 12,500.00 × 0.05 = 625.00; IGST 625.00 × 0.18 = 112.50; exact total 737.50; round-off +0.50;
  credit note total ₹738.00. Field "ITC reversal by recipient confirmed" must be filled before the note is posted as
  reducing output tax (G4.12, G4.13).

**W10. Debit note for an upward price revision.** Against W1: price raised by ₹50.00 per unit for all 10 units.
- Taxable 500.00; CGST 45.00; SGST 45.00; total ₹590.00.

**W11. Reverse charge, inward service.** The business receives legal services from an individual advocate in MP, fee
₹25,000.00, the reverse charge entry assumed to be 18% (Q6: confirm the entry and rate).
- Supplier's bill: ₹25,000.00, no tax.
- Business computes CGST 9% = 2,250.00 and SGST 9% = 2,250.00 payable under reverse charge, and records ITC of the same
  amounts if the eligibility flag is "eligible" (G6.10). Journal in G9.5.

**W12. Exempt line with a taxable line, intra-State, unregistered customer.**
- Line A (taxable, 18%): ₹5,000.00; CGST 450.00; SGST 450.00.
- Line B (exempt item): ₹1,200.00; no tax.
- Total 5,000.00 + 900.00 + 1,200.00 = ₹7,100.00. Document type: invoice-cum-bill of supply only if the accountant
  confirms rule 46A allows it for this case (rule 46A not read, Q7); otherwise two documents: a tax invoice for A and
  a bill of supply for B.

**W13. Composition business (manufacturer), outward.** Business opted for composition (section 10(1)), sells goods
intra-State for ₹50,000.00.
- Bill of supply: value ₹50,000.00, no tax shown, header "composition taxable person, not eligible to collect tax on
  supplies" (rule 5(1)(f)).
- For the quarter, turnover in the State ₹8,40,000.00 (sum of bills of supply, from the composition turnover report):
  composition tax CGST 0.5% = ₹4,200.00, SGST 0.5% = ₹4,200.00 (rate as data; rule 7 gives the CGST half, the SGST half
  assumed equal, Q8). Posted as an expense (G9.8).

**W14. Export of goods under LUT.** Customer in another country, ₹3,25,000.00 (rupee invoice; foreign currency out of
scope).
- IGST 0; endorsement "SUPPLY MEANT FOR EXPORT/SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND
  OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX" (rule 46 proviso); recipient name and address, delivery
  address and country of destination printed. Total ₹3,25,000.00.
- Same supply "with payment of IGST": STOP in the first version (G1.11).

**W15. Supply to an SEZ unit in the same State, with payment of IGST.** SEZ unit in MP, taxable ₹1,00,000.00 at 18%.
- IGST 18% = ₹18,000.00 (not CGST + SGST, T10); total ₹1,18,000.00; endorsement "... ON PAYMENT OF INTEGRATED TAX".

**W16. Advance for services, rate known.** Advance received ₹1,18,000.00 for a service at 18%, recipient in MP.
- Receipt voucher: taxable 1,18,000.00 ÷ 1.18 = 1,00,000.00; CGST 9,000.00; SGST 9,000.00.
- The later tax invoice for the full service ₹2,00,000.00: CGST 18,000.00, SGST 18,000.00 on the invoice; the
  ₹9,000.00 + ₹9,000.00 already paid on the advance are adjusted at return level (G5.15, Q5).

**W17. Freight charged by the supplier on the invoice.** Goods ₹40,000.00 at 18% plus freight ₹1,500.00 linked to the
goods line, intra-State.
- Taxable 41,500.00 (s.15(2)(c)); CGST 3,735.00; SGST 3,735.00; total ₹48,970.00.

**W18. Bill-to / ship-to.** Bill-to: registered customer whose GSTIN is in Gujarat; ship-to: that customer's warehouse
in MP, on its direction (T3).
- Place of supply Gujarat (s.10(1)(b)): IGST. Taxable ₹2,00,000.00 at 18%: IGST ₹36,000.00; total ₹2,36,000.00.
- Printed: delivery address in MP (rule 46(o)).

**W19. Rate change by document date.** An item whose approved rate is 12% until 21 September 2025 and 5% from
22 September 2025 (illustrative rows in the rate table). Taxable ₹10,000.00, intra-State.
- Invoice dated 21 September 2025: CGST 6% = 600.00, SGST 600.00, total ₹11,200.00.
- Invoice dated 22 September 2025: CGST 2.5% = 250.00, SGST 250.00, total ₹10,500.00.
- If the user marks "straddles a rate change", the software asks for the rate date (G4.4).

**Further cases W20 to W32** (inputs and expected outputs; same settings):

| # | Inputs | Expected output |
| --- | --- | --- |
| W20 | Business registered in a Union territory using UTGST (illustrative: Chandigarh), registered customer in the same UT, ₹10,000.00 at 18% | CGST 900.00 + UTGST 900.00; total ₹11,800.00 |
| W21 | Goods to an unregistered buyer in Rajasthan, State recorded on the invoice, ₹8,000.00 at 18%, goods shipped from MP | Place of supply Rajasthan (s.10(1)(ca)); IGST 1,440.00; total ₹9,440.00 |
| W22 | Same as W21 but no address or State recorded | Place of supply MP; CGST 720.00 + SGST 720.00; total ₹9,440.00 |
| W23 | Bill-to: registered customer in MP; ship-to: its customer in Gujarat, on its direction; ₹1,00,000.00 at 5% | Place of supply MP (s.10(1)(b)); CGST 2,500.00 + SGST 2,500.00; total ₹1,05,000.00 |
| W24 | Consulting service (`general` SAC) to a registered client in Karnataka, ₹50,000.00 at 18% | IGST 9,000.00; total ₹59,000.00 |
| W25 | Same service to an unregistered client whose address on record is in Karnataka, ₹20,000.00 | IGST 3,600.00; total ₹23,600.00 |
| W26 | Service directly related to a building in Karnataka (SAC in the `immovable property` category) | STOP: "place of supply needs the accountant" (G3.9) |
| W27 | GST credit note dated 5 December 2025 against an invoice of 15 March 2025 (financial year 2024-25; deadline 30 November 2025) | Refused (G5.17); commercial credit note offered |
| W28 | Invoice of ₹150.00 at 5% to an unregistered walk-in buyer, intra-State | Invoice issued (the first version always issues one; s.31(3)(b) permits not issuing below ₹200, not used); CGST 3.75, SGST 3.75; exact 157.50; round-off +0.50; ₹158.00 |
| W29 | Purchase from a registered MP supplier, ₹2,000.00 at 5%, ITC flag "ineligible" (for example food for staff; s.17(5) not encoded) | Supplier tax CGST 50.00 + SGST 50.00 recorded; no ITC; expense ₹2,100.00 (G9.4) |
| W30 | Invoice taxable ₹45,000.00 at 18%, intra-State, goods moved | Consignment value incl. tax ₹53,100.00 > ₹50,000: prompt for e-way bill number (G8.6). Same with taxable ₹42,000.00: value ₹49,560.00: no prompt |
| W31 | Export of services under LUT, ₹2,00,000.00, conditions confirmed (G3.8) | IGST 0; export endorsement; total ₹2,00,000.00 |
| W32 | Gift hamper sold for one inclusive price ₹1,180.00, entered as one item at 18% chosen by the user (mixed supply, s.8(b)), intra-State | Taxable 1,000.00; CGST 90.00; SGST 90.00; total ₹1,180.00 |

The accountant is asked to correct any figure, delete cases that misstate the law, and add cases until at least 30
approved cases exist ([p3-spec.md](p3-spec.md) section 4.1 item 11). The approved table becomes the acceptance test
of package L.

## 6. Reverse charge, composition, unregistered businesses, input tax credit flags

### 6.1 Reverse charge

- **G6.1** Law: the Government notifies categories of supply on which the recipient pays tax on reverse charge
  (s.9(3), S1, **VERIFIED**), and may notify a class of registered recipients who pay on specified supplies from
  unregistered suppliers (s.9(4) as substituted from 1 February 2019, **VERIFIED**). A recipient liable under s.9(3)
  or (4) issues an invoice for supplies received from an unregistered supplier and a payment voucher when paying the
  supplier (s.31(3)(f), (g), **VERIFIED**). Invoices must state whether tax is payable on reverse charge (rule 46(p),
  receipt and refund vouchers rules 50(j), 51(j), **VERIFIED**).
- **G6.2** The lists of reverse charge categories are in notifications not read today (13/2017-CT(Rate) for services,
  4/2017-CT(Rate) for goods, 10/2017-IT(Rate) for import of services, as amended; **UNVERIFIED**). Cases a small
  manufacturer commonly meets, to be confirmed and completed by the accountant (all **UNVERIFIED**): goods transport
  agency services (with an option for the GTA to pay tax itself); legal services by an advocate or firm of advocates;
  sponsorship services; services of a director to the company; security services by a non-body-corporate; renting of a
  motor vehicle in some cases; renting of commercial property by an unregistered person to a registered person; import
  of services from outside India (IGST).
- **G6.3** DESIGN: reverse charge categories are data (`ReverseChargeCategories`: code, description, goods/services,
  supplier condition, recipient condition, rate reference, effective from/to, source). A purchase line is reverse
  charge when its item or the user selects a category; the software computes the tax by G5.10, records it as payable
  and (if eligible) as ITC (G9.5), and prints "Tax payable on reverse charge: Yes" on any outward document where the
  business is the supplier of a reverse charge supply (rule 46(p)).
- **G6.4** Self-invoice and payment voucher: when the supplier is unregistered and the line is reverse charge, the
  software produces a self-invoice (its own series) and, on payment, a payment voucher (its own series). The time limit
  for the self-invoice is in rule 47A (not read, **UNVERIFIED**; reported as 30 days from receipt). Q9.

### 6.2 Composition scheme

- **G6.5** Law (S1 s.10, S5 rules 5 and 7, **VERIFIED** unless marked): a registered person with aggregate turnover in
  the preceding financial year up to a notified limit (the Act allows up to ₹1.5 crore; the notified limit for most
  States is ₹1.5 crore, **UNVERIFIED**: Notification 14/2019-CT not read) may pay tax on turnover in the State at
  prescribed rates instead of tax under s.9(1). A composition person may not make inter-State outward supplies
  (s.10(2)(c)), may not supply non-taxable goods or services (s.10(2)(b)), and may supply services other than restaurant
  service only up to 10% of turnover or ₹5 lakh, whichever is higher (second proviso to s.10(1)). The s.10(2A) option for
  service suppliers has a ₹50 lakh limit (S1). Composition persons issue a bill of supply instead of a tax invoice
  (s.31(3)(c)), print "composition taxable person, not eligible to collect tax on supplies" at the top of the bill of
  supply (rule 5(1)(f)), and pay tax under reverse charge on inward supplies where applicable (rule 5(1)(d)). An
  unregistered or composition person may not collect tax (s.32, **VERIFIED**). Input tax credit is not available to a
  composition person (s.10(4), **UNVERIFIED**: not read today).
- **G6.6** Rates of composition tax under rule 7 (central tax share, S5, **VERIFIED**): manufacturers (other than of
  notified goods) 0.5% of turnover in the State; suppliers of restaurant service (para 6(b) of Schedule II) 2.5%; other
  eligible suppliers 0.5% of the turnover of taxable supplies; section 10(2A) persons 3%. The State tax share is
  expected to be equal (**UNVERIFIED**), giving totals of 1%, 5%, 1% and 6%.
- **G6.7** DESIGN, what changes when the registration type is `composition` for a date:
  - outward documents are bills of supply only: no tax columns, no tax amounts, no "rate" printed; the header text of
    rule 5(1)(f) is printed;
  - the software refuses an outward document whose place of supply is in another State (s.10(2)(c)), and refuses a
    non-GST line (s.10(2)(b));
  - a services-turnover counter warns at 80% and refuses at 100% of the s.10(1) second proviso limit for the
    financial year (limit as data, Q10);
  - the composition tax for a period = turnover in the State for the period × the dated rate for the category, each
    component rounded by G5.4 (the return-level rounding of s.170 is left to the return); the turnover definition for
    the computation (which supplies are included) is for the accountant (Q10);
  - inward documents never create ITC; reverse charge on inward supplies still applies (rule 5(1)(d)).
- **G6.8** Changing between composition and regular registration needs a cut-off date and transition rules (stock, ITC
  reversal or claim). Out of scope for the first version: the software allows the change only from the first day of a
  financial year or period chosen by the accountant, and STOPs on documents dated across it. Q11.

### 6.3 Unregistered and small businesses

- **G6.9** Law: registration is required when aggregate turnover in a financial year exceeds ₹20 lakh (₹10 lakh in
  special category States), and a State may raise the limit to up to ₹40 lakh for suppliers of goods only (S1 s.22(1)
  and provisos, **VERIFIED**; which States adopted it, **UNVERIFIED**). Aggregate turnover includes taxable, exempt,
  export and inter-State supplies of persons with the same PAN, on an all-India basis, excluding taxes (S1 s.2(6),
  **VERIFIED**). DESIGN: when the registration type is `unregistered`, the software issues only "commercial invoices"
  with no tax and the text "not a tax invoice" (the ERP-lite document of [p3-spec.md](p3-spec.md) default 27), never
  shows GST, and keeps a turnover counter per financial year that warns at 80% of the registration threshold (data). It
  does not decide whether the business must register.

### 6.4 Input tax credit at the level of recording

- **G6.10** DESIGN: every inward tax line carries an ITC flag: `eligible`, `ineligible` (with a reason code, for example
  "blocked under s.17(5)", "personal use", "composition"), or `undecided` (default for items without a default). Only
  `eligible` lines post to input tax credit accounts; `ineligible` tax is added to the cost or expense of the line
  (G9.4). The software does not apply section 16(2) conditions (receipt, reflection in GSTR-2B, payment within 180 days),
  the section 16(4) time limit, rules 42 and 43 apportionment, or section 17(5) blocked credits; those remain with the
  accountant (**UNVERIFIED** summary of those provisions). A purchase line may be changed from `undecided` to another flag
  until the period is locked (G9.10).

## 7. Documents

### 7.1 Tax invoice: mandatory particulars (rule 46, S4, VERIFIED)

- **G7.1** The software requires or fills, and prints:
  (a) supplier name, address and GSTIN; (b) a consecutive serial number (G7.6); (c) date of issue; (d) recipient name,
  address and GSTIN or UIN if registered; (e) for an unregistered recipient and taxable value of ₹50,000 or more:
  name, address, address of delivery, State name and code; (f) the same below ₹50,000 if the recipient asks; (g) HSN or
  SAC code (digits per G7.7); (h) description; (i) quantity and unit or UQC (goods); (j) total value; (k) taxable value
  after discount or abatement; (l) rate of each tax (central, State, integrated, UT, cess); (m) amount of each tax;
  (n) place of supply with State name for inter-State supplies; (o) delivery address where different from the place of
  supply; (p) whether tax is payable on reverse charge; (q) signature or digital signature of the supplier or authorised
  representative (not required for an electronic invoice issued under the IT Act, proviso, **VERIFIED**); (r) the QR code
  with the embedded IRN when the invoice is an e-invoice under rule 48(4); (s) for a business above the e-invoice
  threshold issuing an invoice not under rule 48(4), the declaration "I/We hereby declare that though our aggregate
  turnover in any preceding financial year from 2017-18 onwards is more than the aggregate turnover notified under
  sub-rule (4) of rule 48, we are not required to prepare an invoice in terms of the provisions of the said sub-rule."
- **G7.2** Export and SEZ endorsement (rule 46 proviso as substituted, S4, **VERIFIED**): "SUPPLY MEANT FOR EXPORT/SUPPLY
  TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX" or "... UNDER BOND OR LETTER OF
  UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX", and, instead of (e), the recipient's name and address, the delivery
  address and the country of destination.
- **G7.2a** Copies (rule 48(1), (2), S4, **VERIFIED**): goods in triplicate marked ORIGINAL FOR RECIPIENT, DUPLICATE FOR
  TRANSPORTER, TRIPLICATE FOR SUPPLIER; services in duplicate (ORIGINAL FOR RECIPIENT, DUPLICATE FOR SUPPLIER); these do
  not apply to an e-invoice prepared under rule 48(4) (rule 48(6)). DESIGN: the print template prints the copies with
  these marks; for documents with an IRN entered, one copy without marks unless the business chooses otherwise.
- **G7.2b** Time of issue: goods, before or at the time of removal (movement) or delivery (s.31(1), S1, **VERIFIED**);
  services, within 30 days of the supply of service (rule 47, S4, **VERIFIED**; 45 days for insurers, banks and
  financial institutions). Continuous supply and goods sent on approval have their own rules (s.31(4), (5), (7),
  **VERIFIED**; out of scope: STOP on documents marked "continuous supply" or "sale on approval"). DESIGN: the software
  warns when a service invoice is dated more than the dated limit after the supply date entered, and never back-dates
  an invoice number (G7.6).

### 7.2 Bill of supply (rule 49, S4, VERIFIED)

- **G7.3** Issued instead of a tax invoice by a supplier of exempt goods or services or by a composition person
  (s.31(3)(c), **VERIFIED**). Particulars: supplier name, address, GSTIN; consecutive serial number (G7.6); date;
  recipient name, address and GSTIN or UIN if registered; HSN or SAC; description; value after discount or abatement;
  signature (not needed for an electronic bill of supply). The provisos of rule 46 apply to it as well. Composition:
  the header of G6.5. A bill of supply below ₹200 may be omitted (proviso to s.31(3)(c), **VERIFIED**); DESIGN: the
  first version always issues one.

### 7.3 Receipt voucher, refund voucher, payment voucher

- **G7.3a** Receipt voucher (rule 50, S4, **VERIFIED**): supplier details; serial number; date; recipient details;
  description; amount of advance; rate and amount of each tax; place of supply with State name and code for
  inter-State supplies; reverse charge yes/no; signature. Refund voucher (rule 51, **VERIFIED**): the same plus the
  number and date of the receipt voucher and the amount refunded. Payment voucher under reverse charge: rule 52
  (downloaded, contents **UNVERIFIED**: not reviewed in this draft).

### 7.4 Credit note and debit note (rule 53(1A), S4, VERIFIED)

- **G7.4** Particulars: supplier name, address, GSTIN; nature of the document; consecutive serial number (G7.6); date;
  recipient name, address, GSTIN or UIN if registered; for an unregistered recipient, name, address, delivery address,
  State name and code; serial number(s) and date(s) of the corresponding tax invoice(s) or bill(s) of supply; taxable
  value, rate and amount of tax credited or debited; signature. Revised tax invoice (rule 53(1), **VERIFIED**): only for
  the period between the effective date of registration and the date of the registration certificate (s.31(3)(a)); out
  of scope (STOP).

### 7.5 Delivery challan (rule 55, S4, VERIFIED)

- **G7.5** Used instead of an invoice for liquid gas of unknown quantity, job work, transport for reasons other than
  supply, and notified cases, and for goods sent in batches or in knocked-down condition (rule 55(1), (5)). Particulars:
  date and number (serial, at most 16 characters); consignor name, address, GSTIN if registered; consignee name, address,
  GSTIN or UIN if registered; HSN and description; quantity (provisional where not known); taxable value; tax rate and
  amount (each component) where the transport is for supply to the consignee; place of supply for inter-State movement;
  signature. Triplicate: ORIGINAL FOR CONSIGNEE, DUPLICATE FOR TRANSPORTER, TRIPLICATE FOR CONSIGNER. Where goods move for
  supply but the invoice could not be issued at removal, a tax invoice is issued after delivery (rule 55(4)). DESIGN:
  the ERP-lite delivery challan (package P) gains these fields in package L; the challan reason is a required choice.
- **G7.5a** Commercial document (DESIGN): the ERP-lite "commercial invoice" of [p3-spec.md](p3-spec.md) default 27
  stays available for unregistered businesses (G6.9) and is printed "This is not a tax invoice". After package L, a
  registered business cannot issue a commercial invoice for a taxable supply to a customer (it must be a tax invoice);
  the accountant confirms (Q19).

### 7.6 Numbering

- **G7.6** Law: invoices, bills of supply, receipt and refund vouchers, credit and debit notes and revised invoices carry
  "a consecutive serial number not exceeding sixteen characters, in one or multiple series, containing alphabets or
  numerals or special characters hyphen or dash and slash ... and any combination thereof, unique for a financial
  year" (rules 46(b), 49(b), 50(b), 51(b), 53(1)(d), 53(1A)(c), S4, **VERIFIED**). The serial numbers issued in a tax
  period are reported in GSTR-1 (rule 48(3), **VERIFIED**). DESIGN:
  - allowed characters: `A-Z a-z 0-9 - /`; length 1 to 16, checked when a series is defined (prefix + padded counter +
    suffix may not exceed 16 for the largest counter of the year);
  - one series per document type per registration per financial year by default (for example `INV/26-27/00001`);
    additional series allowed (for example per branch or for exports), each with its own counter;
  - uniqueness per registration (GSTIN) and financial year is enforced by a unique index; case-insensitive (Q20);
  - the number is taken from the number sequence **at issue**, inside the issuing transaction, so drafts have no
    number and there are no gaps from abandoned drafts; the counter restarts each financial year (a series with
    `period = financial year`, which the existing number sequence component supports, p3-spec 5.11);
  - a gap can still arise only from a database failure after the number is taken; the software lists any gap in the
    document summary report with its cause (Q21).

### 7.7 HSN digits

- **G7.7** Notification 78/2020-CT (S12, **VERIFIED**), from 1 April 2021: 4 digits of HSN where the aggregate turnover
  in the preceding financial year was up to ₹5 crore, 6 digits above ₹5 crore; a registered person up to ₹5 crore may omit
  the HSN on invoices for supplies to unregistered persons. The e-invoice portal states that 6-digit HSN codes are
  mandatory above ₹5 crore AATO and that 4-digit codes will stop being accepted (S13, **VERIFIED** as a portal notice,
  no date given). DESIGN: digits required = dated data by turnover band; the software refuses to issue a document whose
  HSN/SAC is shorter than required for the recipient type.

### 7.8 What is immutable after issue, and how corrections are made

- **G7.8** DESIGN: a document moves `draft` → `issued` (number taken, PDF frozen, postings made) → optionally
  `cancelled`. After issue, every field that appears in G7.1 to G7.5 or affects tax or postings is read-only. Allowed
  after issue: entering the IRN, acknowledgement number and date and QR image once (G8.3), the e-way bill number and date
  (G8.6), payment status, internal notes, attachments; each such change is audited.
- **G7.9** Corrections are made only by a credit note or debit note (G5.16, G7.4), never by editing. Cancellation
  (DESIGN, Q22): an issued document may be cancelled only if it has no IRN entered, no payment, no later credit or debit
  note, and its period is open; a cancelled document keeps its number, shows as cancelled with zero value in the
  document summary, and its postings are reversed by a dated reversal entry. The rules on when cancellation is
  acceptable instead of a credit note (and the IRP's own cancellation window, reported as 24 hours, **UNVERIFIED**) are
  for the accountant.
- **G7.10** Retention: the Act requires accounts to be kept (s.35) and retained (s.36) (S1, **VERIFIED** that the
  sections exist; the retention period, reported as 72 months from the due date of the annual return, **UNVERIFIED**).
  DESIGN: issued documents and postings cannot be deleted; the recycle bin does not apply to them.

## 8. E-invoicing and e-way bills (configurable, recorded only)

### 8.1 Who must e-invoice

- **G8.1** Rule 48(4): a notified class of registered persons prepares invoices with the particulars of FORM GST INV-01
  after obtaining an Invoice Reference Number by uploading them to the common portal; an invoice issued otherwise by such
  a person is not treated as an invoice (rule 48(5)) (S4, **VERIFIED**).
- **G8.2** Threshold as of the date verified: registered persons whose aggregate turnover **in any preceding financial
  year from 2017-18 onwards** exceeds **₹5 crore**, from **1 August 2023** (Notification 10/2023-CT substituting "five
  crore rupees" for "ten crore rupees" in Notification 13/2020-CT; S9, **VERIFIED**). The ₹10 crore value came from
  Notification 17/2022-CT dated 1 August 2022 (named as the last amendment in S9, **VERIFIED**). The original
  Notification 13/2020-CT set ₹100 crore, in respect of supplies to registered persons, excluding persons under rule
  54(2), (3), (4) and (4A), in force from 1 October 2020 (S10, **VERIFIED** for the original text). Intermediate history
  (₹500 crore from 1 October 2020, ₹100 crore from 1 January 2021, ₹50 crore from 1 April 2021, ₹20 crore from 1 April
  2022, ₹10 crore from 1 October 2022) is **SECONDARY** (search summaries of Tally Solutions and EY pages) or
  **UNVERIFIED**. Exempted classes added later (for example SEZ units) and whether exports are covered: **UNVERIFIED**.
- **G8.2a** Reporting window: from 1 April 2025, taxpayers with AATO of ₹10 crore and above cannot report e-invoices
  (invoices, credit notes, debit notes) older than 30 days on the IRPs; no such restriction below ₹10 crore "as of now"
  (S11, **VERIFIED**).
- **G8.3** DESIGN:
  - values as data with effective dates (section 11.2): e-invoice turnover threshold, the "any preceding financial year
    from 2017-18" rule, the reporting window and its AATO threshold, exempt registration types;
  - the registration's yearly turnovers (G2.1) decide whether the business is in the e-invoice class on a document
    date; if it is, every B2B tax invoice, credit note and debit note (and export, if the accountant confirms) is marked
    "IRN required" and cannot be marked "final for the customer" until the IRN, acknowledgement number, acknowledgement
    date and the signed QR code (as an image file or the QR text) are entered from the IRP or the business's own e-invoice
    tool; the print shows them (rule 46(r));
  - the invoice data needed by FORM GST INV-01 is exportable as a file for the business's e-invoice tool (format
    **UNVERIFIED**; the schema was not read; Q23);
  - a warning when an "IRN required" document is 20 days old without an IRN and the business is above the reporting
    window threshold (G8.2a);
  - if the business is above the threshold and issues a document not under rule 48(4) (for example to an unregistered
    customer), the software prints the declaration of rule 46(s) only if the accountant says it applies (Q24).
- **G8.4** What the IRN and QR mean for the printed invoice (**UNVERIFIED** beyond rule 46(r)): the IRN is a unique
  reference returned by the IRP for the invoice; the QR code carries the IRN and key invoice data signed by the IRP; the
  printed invoice shows the QR code (rule 46(r), **VERIFIED**) and usually the IRN and acknowledgement number and date
  (practice). The software never creates an IRN or a QR code itself.

### 8.2 E-way bill

- **G8.5** Law: every registered person who causes movement of goods of consignment value exceeding **₹50,000** in
  relation to a supply, for reasons other than supply, or due to an inward supply from an unregistered person, furnishes
  Part A of FORM GST EWB-01 before the movement starts (rule 138(1), S6, **VERIFIED**). Consignment value is the section
  15 value declared in the invoice, bill of supply or delivery challan, **including** CGST, SGST/UTGST, IGST and cess, and
  **excluding** exempt goods on a document with both exempt and taxable goods (rule 138(1) Explanation 2, **VERIFIED**).
  Inter-State movement to a job worker and inter-State handicraft goods by exempted persons need an e-way bill
  irrespective of value (provisos, **VERIFIED**). Part B (conveyance) need not be furnished for movement up to 50 km
  within the State to a transporter's place of business (rule 138(3) proviso, **VERIFIED**). The e-way bill portal states
  the ₹50,000 value (S14, **VERIFIED**). States may set different limits for intra-State movement or exempt goods and
  distances by their own notifications, and rule 138(14) lists exemptions (**UNVERIFIED**: not read).
- **G8.6** DESIGN:
  - values as data with effective dates: consignment value threshold (default ₹50,000) and per-State intra-State
    overrides (empty until the accountant supplies them);
  - for an issued invoice, bill of supply or delivery challan with "goods move: yes", the software computes the
    consignment value by G8.5 and, above the threshold (or for job work across States), shows "e-way bill required" and
    asks for the e-way bill number, date and validity date, entered from the portal; the documents print them;
  - the software records vehicle number and transporter ID as optional fields; it does not generate, extend or cancel
    e-way bills (G1.8).

## 9. Ledger postings for GST (for the accountant to confirm)

This section covers only GST-related postings. The full chart of accounts is a later document (package L's own spec).

### 9.1 Accounts the GST postings use (DESIGN; names illustrative)

| Account | Kind | Used for |
| --- | --- | --- |
| Output CGST, Output SGST, Output UTGST, Output IGST, Output Cess | liability | tax on outward documents |
| Input CGST, Input SGST, Input UTGST, Input IGST, Input Cess | asset | eligible ITC on inward documents |
| RCM CGST payable, RCM SGST payable, RCM UTGST payable, RCM IGST payable | liability | tax payable on reverse charge |
| Input CGST (RCM), Input SGST (RCM), Input UTGST (RCM), Input IGST (RCM) | asset | ITC of reverse charge tax, when eligible |
| Tax on advances (Output CGST/SGST/IGST on advances) and GST on advances suspense | liability / asset | receipt vouchers (G5.15), Q5 |
| Composition tax CGST payable, Composition tax SGST payable; Composition tax expense | liability / expense | G6.7 |
| Round-off | income/expense | G5.7 |
| Sales (by class: taxable, exempt, nil, zero-rated, non-GST), Purchases / expense accounts | income / expense | values |
| Customer and supplier accounts | asset / liability | party balances |

The setting of an Electronic Cash / Credit Ledger and the set-off of ITC against output tax are return-level steps
and are not posted by the first version (Q25).

### 9.2 Outward tax invoice

- **G9.1** W1 (intra-State): Dr Customer 14,750.00; Cr Sales 12,500.00; Cr Output CGST 1,125.00; Cr Output SGST 1,125.00.
- **G9.2** W3 (round-off): Dr Customer 13,588.00; Cr Sales 11,779.00; Cr Output CGST 904.31; Cr Output SGST 904.31;
  Cr Round-off 0.38. (A negative round-off is a debit to Round-off.)
- **G9.2a** W2 (inter-State): Dr Customer 14,750.00; Cr Sales 12,500.00; Cr Output IGST 2,250.00.
- **G9.2b** W14 (export under LUT): Dr Customer 3,25,000.00; Cr Sales (zero-rated) 3,25,000.00.

### 9.3 Credit and debit notes (outward)

- **G9.3** W8 (credit note): Dr Sales returns (or Sales) 2,500.00; Dr Output CGST 225.00; Dr Output SGST 225.00;
  Cr Customer 2,950.00. W9 adds a round-off line: Dr Sales discount 625.00; Dr Output IGST 112.50; Dr Round-off 0.50;
  Cr Customer 738.00 (Q26 on whether round-off applies to credit notes). W10 (debit note): as an invoice: Dr Customer
  590.00; Cr Sales 500.00; Cr Output CGST 45.00; Cr Output SGST 45.00.

### 9.4 Inward invoices

- **G9.4** Eligible ITC: Dr Purchases (value); Dr Input CGST; Dr Input SGST (or Dr Input IGST); Cr Supplier. Ineligible
  (W29): Dr Expense 2,100.00; Cr Supplier 2,100.00 (tax included in the expense; the tax amounts are kept on the
  document lines for reports). Purchase credit note: the reverse, and the eligible ITC reversed at the same time.

### 9.5 Reverse charge

- **G9.5** W11: Dr Legal expenses 25,000.00; Cr Supplier 25,000.00. Then Dr Input CGST (RCM) 2,250.00; Dr Input SGST
  (RCM) 2,250.00; Cr RCM CGST payable 2,250.00; Cr RCM SGST payable 2,250.00. If ITC is ineligible: Dr Legal expenses
  4,500.00 instead of the two input accounts. Whether ITC on reverse charge may be taken in the same period as the tax is
  paid (and only after payment in cash) is a return-level matter for the accountant (**UNVERIFIED**, Q27).

### 9.6 Advances (services)

- **G9.6** W16 receipt voucher: Dr Bank 1,18,000.00; Cr Customer advance 1,18,000.00; Dr GST on advances suspense
  18,000.00; Cr Output CGST 9,000.00; Cr Output SGST 9,000.00. On the final invoice of ₹2,00,000.00 + tax: the invoice is
  posted as G9.1, the advance is set off against the customer, and the suspense is reversed: Dr Output CGST 9,000.00;
  Dr Output SGST 9,000.00; Cr GST on advances suspense 18,000.00. This journal is a proposal only (Q5).

### 9.7 Composition

- **G9.7** Bill of supply W13: Dr Customer 50,000.00; Cr Sales 50,000.00 (no tax lines).
- **G9.8** Period composition tax: Dr Composition tax expense 8,400.00; Cr Composition tax CGST payable 4,200.00;
  Cr Composition tax SGST payable 4,200.00.

### 9.8 Financial year and period locking

- **G9.9** Financial year: 1 April to 31 March (**UNVERIFIED** as a GST rule; general Indian practice and the General
  Clauses Act definition, not read). Number series (G7.6), credit note deadlines (G5.17) and return summaries use the
  financial year of the document date.
- **G9.10** DESIGN: periods are calendar months. A period is `open`, `soft-locked` (only users with the Accounts admin role
  may post) or `locked` (nobody may post, issue, cancel or change ITC flags for documents dated in it). Locking is done by
  the Accounts admin role, is audited, and can be reversed only by an install administrator with a typed reason
  (audited). Documents for a locked period's supplies are issued with a current date; corrections of locked periods are
  credit or debit notes in an open period. The software proposes "lock after the GSTR-1 due date" as a reminder only; it
  does not know filing dates (Q28).

## 10. Returns: summaries as data only

- **G10.1** The software **does not prepare, validate or file any return.** It exports summaries (CSV and spreadsheet)
  that the business's accountant uses to prepare GSTR-1 and GSTR-3B (or CMP-08 / GSTR-4 for composition) in the
  accountant's own tools. Table names below follow the commonly known GSTR-1 and GSTR-3B structure (**UNVERIFIED**: the
  forms as notified and the portal's current offline-tool formats were not read; the accountant supplies the required
  columns and the software follows them).
- **G10.2** Exports for a chosen period and registration (DESIGN):

| Export | Columns |
| --- | --- |
| Outward register (one row per document line) | document type, number, date, status (issued/cancelled), recipient GSTIN or "unregistered", recipient name, recipient State code, place of supply State code, supply type (B2B, B2C, export with/without payment, SEZ with/without payment), reverse charge Y/N, HSN/SAC, description, UQC, quantity, taxable value, rate, IGST, CGST, SGST/UTGST, cess, supply class (taxable/nil/exempt/non-GST/zero-rated), IRN, IRN date, e-way bill number, original document number and date (for credit and debit notes) |
| B2B summary per document | recipient GSTIN, document number, date, document value, place of supply, reverse charge, invoice type, rate, taxable value, IGST, CGST, SGST/UTGST, cess |
| B2C large inter-State invoices | invoices to unregistered recipients with inter-State place of supply above a value threshold (data; reported as reduced from ₹2.5 lakh to ₹1 lakh in 2024, **UNVERIFIED**) |
| B2C others, aggregated | place of supply, rate, taxable value, IGST, CGST, SGST/UTGST, cess |
| Credit and debit notes, registered and unregistered | note type, number, date, original invoice number(s) and date(s), recipient GSTIN, place of supply, rate, taxable value, taxes, reason, "ITC reversal confirmed" |
| Exports and SEZ | invoice number, date, value, with/without payment, LUT reference, port code and shipping bill number and date (entered by the user, optional), rate, taxable value, IGST |
| Nil-rated, exempt and non-GST | inter-State / intra-State × registered / unregistered recipient: totals per class |
| Advances | receipt vouchers and adjustments per place of supply and rate |
| HSN summary | HSN/SAC, description, UQC, total quantity, total value, taxable value, rate, IGST, CGST, SGST/UTGST, cess; split B2B / B2C if required (**UNVERIFIED**) |
| Documents issued | per document type and series: first number, last number, total issued, cancelled, net |
| Inward register | supplier GSTIN, name, document number, date, place of supply, reverse charge, HSN/SAC, taxable value, taxes, ITC flag and reason |
| GSTR-3B helper | outward taxable (other than zero-rated, nil, exempt); outward zero-rated; nil and exempt; inward liable to reverse charge; non-GST outward; ITC: inward supplies liable to reverse charge, all other ITC, ineligible ITC; per component |
| Composition helper | turnover in the State for the period by category; composition tax computed (G6.7); inward supplies under reverse charge |

## 11. Questions and data

### 11.1 Questions for the accountant (numbered)

| # | Question | Refs | Kind |
| --- | --- | --- | --- |
| Q1 | Tax per line (default) or per rate per document? Is either required by law or by the e-invoice schema? | G5.6, W6 | practice vs law |
| Q2 | Round the payable total to the rupee by default? Is the round-off line acceptable on tax invoices and in the e-invoice? Does s.170 require whole-rupee tax on invoices? | G5.1, G5.7 | practice vs law |
| Q3 | Confirm that CGST and SGST are always computed separately from the taxable value, never as a split of a total | G5.8, W5 | practice |
| Q4 | Credit notes: rates and tax type of the original invoice; limit to the remaining creditable value; several invoices per note | G5.12, G5.17 | scoping |
| Q5 | Advances: services only; tax on advance as inclusive; adjustment at return level; the proposed suspense journal. Confirm Notification 66/2017-CT for goods | G5.14, G5.15, G9.6 | UNVERIFIED, practice |
| Q6 | Supply the current reverse charge categories (services, goods, import of services) with rates, conditions and sources | G6.2, W11 | UNVERIFIED |
| Q7 | Rule 46A (invoice-cum-bill of supply): when may taxable and exempt lines share one document? | W12 | UNVERIFIED |
| Q8 | Composition: confirm the State share equals the central share in rule 7; supply the current turnover limit (Notification 14/2019-CT or later) | G6.5, G6.6, W13 | UNVERIFIED |
| Q9 | Self-invoice and payment voucher under reverse charge: time limit (rule 47A), particulars (rule 52), and whether a monthly consolidated self-invoice is still allowed (the rule 46 proviso was omitted from 1 November 2024, S4) | G6.4 | UNVERIFIED |
| Q10 | Composition: which turnover goes into the period computation; the services limit counter | G6.7 | law |
| Q11 | Switching between composition and regular: is "only from the start of a period" acceptable for the first version? | G6.8 | scoping |
| Q12 | Section 14 (rate change and time of supply): is "rate at document date, user confirms near a change" acceptable? | G4.4, W19 | scoping |
| Q13 | Is any compensation cess still levied after 31 January 2026? If so, on what, and how is specific cess computed? | G4.9 | UNVERIFIED |
| Q14 | Freight and packing charged on the invoice: always at the rate of the linked goods line? | G4.11, G4.15, W17 | law vs practice |
| Q15 | Document-level discounts spread by value, remainder to the largest line: acceptable? | G4.13 | practice |
| Q16 | Commercial (non-GST) credit notes: allowed, and with what wording? Has the s.15(3)(b) amendment recommended by the 56th Council been made and brought into force? | G4.12, G4.13 | UNVERIFIED |
| Q17 | Late-payment interest: separate tax invoice or debit note? | G4.14 | law |
| Q18 | Tax-inclusive method (taxable = inclusive ÷ (1 + rate), taxes forward, difference to round-off) | G4.16, W5 | practice |
| Q19 | After package L, should a registered business be prevented from issuing a commercial invoice for a taxable supply? | G7.5a | scoping |
| Q20 | Are invoice numbers that differ only in letter case "unique"? (The software treats them as the same.) | G7.6 | law |
| Q21 | How should a numbering gap caused by a system failure be documented? | G7.6 | practice |
| Q22 | Cancellation versus credit note: when is cancelling an issued invoice acceptable? | G7.9 | law vs practice |
| Q23 | Which file format should the e-invoice export follow (the IRP JSON schema version)? | G8.3 | UNVERIFIED |
| Q24 | When does the rule 46(s) declaration apply for a business above the threshold? Are exports and B2C invoices covered by e-invoicing for the pilot business? | G8.2, G8.3 | UNVERIFIED |
| Q25 | Should the software post the monthly set-off of ITC against output tax and the cash payment, or leave them to the accountant's books? | 9.1 | scoping |
| Q26 | Round-off on credit and debit notes | G9.3, W9 | practice |
| Q27 | ITC on reverse charge tax: timing and conditions | G9.5 | UNVERIFIED |
| Q28 | Period locking: monthly periods and the soft and hard lock rules | G9.10 | scoping |
| Q29 | Is one GSTIN per install acceptable for the pilot customer (p3-spec 4.1 item 10)? | G2.1 | scoping |
| Q30 | Supply the State and Union territory list with GST State codes and which UTs use UTGST; the code for "other country" | G2.7, G3.10 | UNVERIFIED |
| Q31 | GSTIN check-digit: apply it? | G2.6 | UNVERIFIED |
| Q32 | Supply the UQC list | G2.8 | UNVERIFIED |
| Q33 | Confirm the STOP list of G3.9 and whether any of it is needed for the pilot (for example installation at site, GTA as supplier) | G3.9 | scoping |
| Q34 | Export of services: conditions to confirm per document (IGST Act s.2(6)) | G3.8 | UNVERIFIED |
| Q35 | Rate data: the full current schedules of 9/2025-CT(Rate) and the services rate notification as amended (including 01/2026-CT(Rate) and anything later), which source the administrator imports from, and who approves rows | G4.5 to G4.8 | UNVERIFIED |
| Q36 | E-invoice history and exempted classes (SEZ units, banks, GTA, passenger transport, multiplexes, government) as currently notified | G8.2 | SECONDARY / UNVERIFIED |
| Q37 | E-way bill: the State-specific intra-State thresholds and rule 138(14) exemptions relevant to the pilot's States | G8.5 | UNVERIFIED |
| Q38 | B2C-large threshold and the HSN summary split required in GSTR-1 today | G10.2 | UNVERIFIED |
| Q39 | Retention period for accounts and documents (s.36) | G7.10 | UNVERIFIED |
| Q40 | Financial year April to March: any GST-specific exception? | G9.9 | UNVERIFIED |
| Q41 | Section 10(4) (no ITC for composition) and the registration types list of G2.2 | G2.2, G6.5 | UNVERIFIED |
| Q42 | Did any CGST Rule cited from S4 (rules 46 to 55, 5, 7, 138) change after the amendments shown on the CBIC pages, for example by notifications of 2025 or 2026 (one report names Notification 05/2026-CT of 26 October 2026)? | 0.3 | UNVERIFIED |
| Q43 | IGST Act changes after 23 May 2025 (S3's date) | 0.3, section 3 | UNVERIFIED |
| Q44 | Add, correct and approve the worked examples until at least 30 cases are approved | 5.5 | required |

### 11.2 Values that are data, not code

Every value below is stored in a dated table (`effective_from`, `effective_to`, `source`, `approved_by`), imported or
entered by the administrator, and shown on a "GST settings" page with its source. The software ships these rows
**empty** (or as examples clearly marked "not approved") until the accountant approves them.

| Value | Value as read today | Effective from | Source and mark |
| --- | --- | --- | --- |
| Rates per HSN/SAC (all components, cess) | to be supplied | per row | Q35; slab headings in S8 VERIFIED |
| Reverse charge categories and rates | to be supplied | per row | Q6, UNVERIFIED |
| Composition rates by category (central share) | 0.5% / 2.5% / 0.5% / 3% | rule 7 as substituted w.e.f. 1 April 2020 (S5) | VERIFIED |
| Composition turnover limit | ₹1.5 crore (most States) | to be supplied | UNVERIFIED (Q8) |
| Composition services limit | 10% of turnover in the State or ₹5 lakh, whichever is higher | to be supplied | s.10(1) second proviso, VERIFIED |
| Section 10(2A) turnover limit | ₹50 lakh | to be supplied | s.10(2A), VERIFIED |
| Registration threshold | ₹20 lakh; ₹10 lakh special category; up to ₹40 lakh goods-only where a State opted | to be supplied | s.22, VERIFIED; States UNVERIFIED |
| E-invoice threshold (AATO, any preceding FY from 2017-18) | above ₹5 crore | 1 August 2023 | S9, VERIFIED |
| E-invoice 30-day reporting limit and its AATO threshold | 30 days; ₹10 crore and above | 1 April 2025 | S11, VERIFIED |
| HSN digits by turnover | 4 up to ₹5 crore (optional for B2C); 6 above | 1 April 2021 | S12, VERIFIED |
| E-way bill consignment value | above ₹50,000 (incl. tax, excl. exempt goods) | to be supplied | rule 138(1), S6 and S14, VERIFIED; State overrides UNVERIFIED |
| E-way bill Part B exemption distance | 50 km within the State to the transporter | to be supplied | rule 138(3) proviso, VERIFIED |
| Credit note deadline | 30 November after the financial year, or annual return date if earlier | 1 October 2022 (wording) | s.34(2), VERIFIED |
| Service invoice time limit | 30 days (45 for insurers, banks, financial institutions) | to be supplied | rule 47, VERIFIED |
| Unregistered recipient details threshold on invoices | ₹50,000 | to be supplied | rule 46(e), VERIFIED |
| Invoice not required below | ₹200 (not used: the software always issues) | to be supplied | s.31(3)(b), VERIFIED |
| Default rate for advances when rate unknown | 18%, treated as inter-State | to be supplied | rule 50 proviso, VERIFIED |
| B2C-large inter-State invoice value | to be supplied (reported ₹1 lakh) | to be supplied | UNVERIFIED |
| States and UTs, codes, UTGST flag, special category flag | to be supplied | per row | UNVERIFIED (Q30) |
| UQC list | to be supplied | per row | UNVERIFIED (Q32) |
| Financial year start | 1 April | n/a | UNVERIFIED (Q40) |
| Business settings: tax per line or per document, round-off on/off, manual place of supply allowed | DESIGN defaults: per line, on, off | per registration | Q1, Q2 |
| LUT per financial year | to be entered by the business | per FY | G2.4 |
| Rate change dates (for example 22 September 2025, 1 February 2026) | as rows of the rate table | per row | S7, S8, VERIFIED |

### 11.3 Count of marks in this draft

Marks placed on statements about the law in sections 1 to 10 (each mark counted once where it appears; a section
heading marked VERIFIED counts once for its whole table or list): **VERIFIED 79, SECONDARY 2, UNVERIFIED 43.** The
tables of 11.1 and 11.2 repeat these and are not counted again. DESIGN rules are not counted. VERIFIED means read in an
official text today, not that the text is the latest (see the "as on" dates in 0.3). The accountant should treat the
UNVERIFIED items first; they are all in 11.1.

## 12. Sign-off

The accountant completes this block. The orchestrator then records the decision in [decisions.md](../decisions.md)
("GST calculation specification reviewed and accepted on <date> by the owner's accountant", with this document's
version) and renames this file to `gst-spec.md` in the same change ([p3-spec.md](p3-spec.md) section 4.2). Changes the
accountant asks for are made first, and the version below is the version after those changes. Until then exit check 14
reports package L as PENDING.

```
GST CALCULATION SPECIFICATION: SIGN-OFF

Reviewed by (name):                   ______________________________
Qualification:                        Chartered Accountant, in practice
ICAI membership number:               ______________________________
Firm name and firm registration no.:  ______________________________ (optional)
Date of review:                       ____ / ____ / ________
Document reviewed:                    docs/plan/gst-spec-draft.md
Version of this document reviewed:    ______  (this draft: 0.1-draft, 20 Nov 2026)
Law checked as in force on (date):    ____ / ____ / ________

Corrections required before acceptance (rule or example number, correction):
  1. ____________________________________________________________
  2. ____________________________________________________________
  3. ____________________________________________________________
  (attach further pages as needed)

Corrections made and checked (version after corrections): ______

Questions of section 11.1 answered:   all / list of open ones: ____________
Worked examples approved (numbers):   ______________________________  (at least 30)

Decision:   [ ] Accepted   [ ] Accepted with the corrections above   [ ] Not accepted

Scope statement: I have reviewed this specification as a description of how the software
will compute and record GST for the business. This sign-off is not an opinion on any
business's tax position.

Signature: ______________________________
```
