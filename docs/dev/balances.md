# Synchronous balances (P3 package P)

A **balance table** keeps, per key, the running sum of a signed quantity of the rows of another table (the
**movements**), in the same transaction as every movement, and refuses a movement that would take a balance below its
floor. The ERP-lite pack's stock on hand (`StockBalances`, keyed by item and location, fed by `StockMovements`) is the
first user; anything of the same shape (cash per till, leave days per person and year, seats per event) can use it.

Why not a rollup: rollups are recomputed after the commit by jobs ([events-and-jobs.md](events-and-jobs.md)), so two
issues of the last unit can both commit before any recompute sees them. Why not a before-event: an event cannot write
another table, and two events reading the same balance see the same value. The balance is updated under a lock inside
the writer's transaction instead.

## The declaration

`TableDef.balance` on the balance table (`src/platform/contracts.ts`, `BalanceDef`):

```json
{ "movements": "StockMovements", "quantity": "Quantity", "column": "OnHand",
  "keys": [{ "column": "Item", "from": "Item" }, { "column": "Location", "from": "Location" }],
  "floor": 0, "minColumn": "SafetyStock", "label": "Stock", "message": "optional, with {label} {keys} {floor} {available} {requested} {Item}" }
```

| Key | Meaning |
| --- | --- |
| `movements` | the movements table (name or id) |
| `quantity` | its signed quantity column (number, decimal, currency; not a rollup) |
| `column` | the balance table's running balance column (number, decimal, currency; not computed) |
| `keys` | 1 to 4 pairs: the balance column `column` equals the movements column `from` (same type, same lookup table) |
| `floor` | the lowest allowed balance; default 0; `null` = no floor (a synchronous sum that may go negative) |
| `minColumn` | optional per-key minimum on the balance row (blank: the floor) |
| `label`, `message` | the refusal's wording; default: `Stock of Hex bolt M10 at Main store would go below zero: available 3, requested 5.` (key values are shown by the display column of their lookup table) |

Both tables must be in the default database. A declaration that no longer fits (a column removed or retyped) refuses
every write of the movements table with the reason, rather than letting the balance drift (`balanceProblem`).

**Where it is set.** Packs only in this round: a solution pack declares it on a slot as `create.balance` with tokens
([solution-templates.md](solution-templates.md) section 3); solution packages carry it (validated by `sanitizeBalance`
in `server/routes/meta/util.ts`); an environment copy copies it with `ab_tables`. There is no table-designer setting
yet. No metadata table and no schema step: the declaration lives in `ab_tables.def`.

## How a write runs (`server/core/balances/engine.ts`, hooks in `server/core/data.ts`)

Every DataService write is one unit of work (one transaction on the default database, READ COMMITTED). For a table that
feeds balances (one small metadata query per write finds them):

1. **Before the change** the movement rows concerned are locked and read: `SELECT id, keys, quantity ... FOR UPDATE`
   (update: the row; delete and CSV replace: the target rows). Nobody else can change or delete them until commit.
2. The write happens as before (events, validation rules, security, the connector).
3. **After the change** the same rows are read again (insert: the row as built). The difference per balance key
   (`after - before`, in fixed point with 6 decimals) is applied in sorted key order: `pg_advisory_xact_lock(hashtext
   (balance table), hashtext(key))`, then the balance row `SELECT ... FOR UPDATE`, then `UPDATE` (or `INSERT` of the
   missing key's row). A key whose balance goes **down** below its floor or minimum throws 422 with the message (field:
   the quantity column); the unit rolls back, the movement and every other balance step with it.
4. Each changed balance row gets its outbox row (op `insert` or `update`, all columns in the snapshot), so flows
   (the reorder alert), the realtime hub and the run log see it like any change.

**Recycle bin**: a soft delete leaves the balance (deleted rows do not count); a **restore** adds them back inside the
restore's unit (refused when that would go below the floor). **Bulk delete and CSV import** apply one step per key for
the whole operation. Set blank of a key lookup is an update and moves the balance off that key. A movement whose key
column is blank or whose quantity is blank moves nothing.

**Why it is correct under concurrency.** The advisory lock serialises every mover of one key for the rest of its
transaction (also two first movements of a key that has no row yet), and READ COMMITTED gives each statement after the
lock the latest committed balance, so the check `old + delta >= floor` is made against a value no other transaction can
change before this one commits or rolls back. Keys are locked in sorted order, so two movers never wait on each other in
a cycle through balance locks. Test: 20 parallel issues of the last 10 units, exactly 10 succeed
(`server/core/balances/balances.integration.test.ts`, also through the ERP-lite pack and `scripts/exit-check/p3-erp.mjs`).

The balance table's rows are **kept by the platform**: users (administrators included) cannot add, import or delete
them through the data API (403 with a plain message), and values sent for its key and balance columns are ignored like
computed columns. Other columns (a reorder level, a bin) are ordinary. Read it like any table: Query v2 as the viewer,
row and column security apply.

## Limits

- **External connectors**: both tables must be on the default database (refused otherwise).
- **Writes outside the platform** (SQL, another tool, a restored backup of one table) are not seen; `reconcile(table)`
  in the engine rebuilds a balance table from its movements under a table lock (used by the tests). There is no
  scheduled reconcile job yet (it would be a new job type; see the read-only classification).
- **Cost per movement**: one metadata query; for update and delete one locked read before and one read after; per key
  one advisory lock, one locked select and one update (or insert). A CSV import of N rows does one step per distinct key.
- **Deadlocks**: a unit of work that writes several movements of different keys in separate writes (a flow writing a
  transfer pair in one job) takes key locks in write order; PostgreSQL detects a cycle with another such unit and
  answers 409 "The database is busy, try again" to one of them.
- A refused movement names the available quantity of that key even to a person who cannot read the balance table.
- An upgrade of a pack does not change the declaration of a table that exists (the table keeps its setting).
