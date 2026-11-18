# Decision log

Why things are the way they are. Newest last. Each entry: decision, why, consequences, status.
Add an entry whenever a choice would surprise a new developer or would be expensive to reverse.

## D1. Own the experience, not Microsoft's artifacts (Nov 2026)
**Decision.** Rebuild the maker experience of Power Apps (formula per property, reactive canvas, metadata-driven tables,
role security, trigger/action flows) as our own product. No Microsoft code, docs text, icons, colours or names.
**Why.** The value for small businesses is the experience; the Microsoft stack is licensed per user and cloud-bound.
**Consequences.** Apps are not compatible with Power Apps (no import/export). Function names are familiar but our own.
**Status.** Active.

## D2. React + TypeScript everywhere, not Flutter (Nov 2026)
**Decision.** Studio, runtime and server are TypeScript; UI is React with shadcn-style components.
**Why.** The formula engine must run in the Studio, the running app, the server and (later) flows; one language means one
engine. The formula editor needs DOM text-editing tooling. Flutter would only win for native-widget mobile apps.
**Consequences.** Desktop and Android packaging will be shells (Tauri / Capacitor) around the same web runtime.
**Status.** Active. Packaging not built yet.

## D3. Own formula engine ("Fx"), Power Fx only as behavioural reference (Nov 2026)
**Decision.** A TypeScript engine with Excel-style syntax and familiar function names, written from documented behaviour.
**Why.** Microsoft's Power Fx is MIT-licensed but C#-only and heavy to embed in a browser and Android WebView.
**Consequences.** Simplifications: no full static type inference, one locale for syntax, `;` chaining only in action
properties, two-argument and multi-pair IfError, enum names shadow variables (Size, Icon, Layout...). 151 built-in functions (see docs/reference/formulas.md),
user-defined functions and named formulas. Behaviour differences must be documented in the formula reference.
**Status.** Active.

## D4. Desktop-first, landscape only (Nov 2026)
**Decision.** Apps are designed at 1920×1080 or 2560×1440 and adapt to any landscape window with anchors and auto-layout
containers. No portrait or phone layouts.
**Why.** Target users run business apps on desktops and laptops.
**Status.** Active.

## D5. Use existing component libraries behind adapters (Nov 2026)
**Decision.** Controls wrap shadcn/Radix components and other permissive libraries (Recharts, react-day-picker, cmdk,
react-useanimations). Only the control registry imports them.
**Why.** Speed and quality; replaceable later. Only MIT/Apache/BSD dependencies ship in the product.
**Status.** Active. Third-party notices must ship with every release.

## D6. Data and security live on the server (phase 3, Nov 2026)
**Decision.** A local Node server owns data access. It authenticates users (scrypt passwords, HttpOnly session cookie)
and enforces role privileges (RBAC), row filters and own-row scope (RLS) and column access (CLS) on every request.
**Why.** Browser-side rules are a simulation; anything sold to a business must enforce access on the server.
**Consequences.** The browser-only demo mode remains for the hosted demo page and simulates the same rules (not secure).
**Status.** Active.

## D7. MySQL is the default store; other sources are connectors (phase 3)
**Decision.** MySQL/MariaDB holds the system tables (`ab_*`) and new user tables. Data files (CSV/XLSX/JSON) and Google
Sheets are connectors behind one interface. SQL is kept portable to MySQL 5.7+/8.x and MariaDB 10.4+.
**Why.** Small-business shared hosting offers MySQL + PHP; the same schema can then be served by a PHP gateway.
**Status.** Active. Verified on MariaDB 10.11 in tests; MySQL 8.4 verification pending on the owner's PC.

## D8. Data files are copies, device-only, and travel only inside solutions (phase 3)
**Decision.** (Owner's design.) A picked file is copied into `workspace/files`; the original is never modified; one
table per sheet. To take file data online it must be packaged in a solution, and importing offers database tables or
file. "Move to database" converts a file table to MySQL keeping its name.
**Status.** Active.

## D9. Optimistic writes from the browser (phase 3)
**Decision.** Patch/Collect/Remove update the screen immediately after client-side pre-validation; the server decides;
refusals roll back and raise an error event.
**Why.** The formula engine is synchronous; making action formulas await the server is a large engine change.
**Consequences.** A step after a refused write (e.g. Navigate after Patch) has already run. Forms wait for the server
before reporting success.
**Status.** Active; awaiting-actions planned.

## D10. Row cap instead of query delegation, for now (phase 3)
**Decision.** Apps load up to 5,000 rows per table and warn when truncated; formulas filter in memory.
**Why.** Pushing formula filters down to the database needs the delegation layer (Query AST from Fx), not built yet.
**Status.** Temporary.

## D11. Attachment ids start with `att_` (phase 3)
**Decision.** Server and demo mode generate `att_<random>`; cells store the id (or a JSON array of ids).
**Why.** The runtime must recognise attachment cells without schema look-ups in every control.
**Status.** Active.

## D12. Hosted next via a PHP gateway implementing Data API v1 (planned)
**Decision.** For shared hosting, reimplement `/api/v1` in PHP over the same `ab_*` schema instead of running Node.
**Why.** Typical shared hosting has PHP + MySQL and no long-running Node processes.
**Status.** Planned.
