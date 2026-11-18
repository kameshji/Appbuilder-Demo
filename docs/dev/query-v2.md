# Query v2: formula-to-query translation and plan semantics

Status: implemented. P0 package B wrote the translator, the plan and the reference executor; P0 package D added computed numbers
and `Year()` to the translator, the endpoint `POST /api/v1/query` (`data-api.md`), the PostgreSQL executor (sections 12-13), the
fallback for other connectors (section 14), the client data layer and the scale check (section 15). This page is the contract: the
PostgreSQL side gives exactly the rows, values and order described here. Every rule is executable in
`/home/claude/appbuilder-demo/src/fx/query/reference.ts` (the reference executor), checked against the formula engine by
`/home/claude/appbuilder-demo/src/fx/query/parity.test.ts` and against real PostgreSQL by
`/home/claude/appbuilder-demo/server/connectors/postgres/query-v2.integration.test.ts`.

| File | What |
| --- | --- |
| `src/platform/query.ts` | Types: `SchemaInfo`, `ColumnKind`, `QueryLiteral`, `ConditionV2`, `SortKeyV2`, `MeasureV2`, `AggregateV2`, `QueryPlan`, `QueryV2Response`; `columnKind(ColumnType)` |
| `src/fx/query/translate.ts` | `analyze(formula, schema, options)`: formula -> plans + residual + diagnostics |
| `src/fx/query/conditions.ts` | Comparison recipes (engine blank rules -> strict primitives) |
| `src/fx/query/reference.ts` | `executePlan(plan, rows, tableSchema)`: the reference semantics |
| `src/fx/query/cursor.ts` | Keyset cursor `encodeCursor` / `decodeCursor`, sort-key normalisation |
| `src/fx/query/explain.ts` | `explain()` text for the Studio, `bindResult`, `residualScope` |
| `src/fx/query/validate.ts` | `checkPlan(plan, schema)`: structural validation and the columns a plan reads (column security) |
| `src/fx/query/testdata.ts`, `testdata-expr.ts`, `*.test.ts` | Sample tables, the generated corpora, parity / unit / cursor tests |
| `server/connectors/postgres/query-v2.ts` | Plan -> one PostgreSQL statement (`buildV2`) |
| `src/platform/query-cache.ts`, `query-wire.ts`, `query-local.ts` | Client cache, wire -> formula values, demo-mode executor |
| `src/runtime/delegation.ts` | The evaluator's server-mode path (see `frontend.md`) |

## 1. How a formula becomes queries

`analyze('=CountRows(Filter(Tickets, Status = "open" && Due < Today()))', schema, { scope, engine })` finds every expression over a
data-source table (a name in `schema.tables`), translates the largest delegable expression into a `QueryPlan`, and replaces it in
the formula by a binding (`__q0`, `__q1`, ...). The rest is the **residual formula**, evaluated in the browser with each binding
set to its plan's result (`bindResult`). For the example: one plan (filter + `count: true`, shape `count`), no residual.

```ts
interface AnalyzeResult {
  plan: QueryPlan | null          // plans[0].plan
  plans: PlannedQuery[]           // { id, plan, shape: 'rows' | 'record' | 'count' | 'scalar', measure?, start, end, text, bounded }
  residual: { formula: string; bindings: string[] } | null   // null: the formula IS plans[0]
  diagnostics: QueryDiagnostic[]  // { severity, code, message, start, end, text, suggestion?, table? }
  fullyDelegated: boolean         // nothing over a table is left undone or left to the browser
  clientEvaluated: boolean        // a small, fully loaded table runs in the browser (warning)
}
```

Values from outside the table are evaluated by the translator in the browser, with the caller's `scope` (controls, variables,
collections, `User()`, `Param(...)`) and `engine` (its user-defined functions and named formulas), and embedded as literals:
`Dropdown1.Selected.Value`, `User().Email`, `Today()`, `Now()`, `DateAdd(Today(), -7, "Days")`, `varMin * 2`. An expression is "from
outside" when it reads no field of the current row (no column name, no `ThisRecord`, no `As` alias). A plan is therefore only
valid for the moment it was made: re-analyse when an input changes (package D re-runs the query when the formula's dependencies
change).

**Delegation rule (decided).** An expression over a table that cannot be translated is never evaluated on a partial set of rows.
`analyze` returns an **error** diagnostic naming the sub-expression, the reason and a suggestion; the Studio shows it on the
property. Only when the table is known to be small (`TableSchemaInfo.fullyLoaded` and `rowCount <= clientRowLimit`, default 2000)
the diagnostic is a **warning** (code `client-evaluated`) and the browser evaluates the original expression. Collections are never
data sources: formulas over collections need no plan.

The residual may finish a plan's result in the browser only when that result is **bounded**: a record, a number, or rows limited by
`FirstN`/`LastN`/`First`/`LookUp` to at most `clientRowLimit`. An unbounded rows result may only be the formula's own value (a
gallery's Items, paged by package D), pass through `If`/`Switch` branches, or be mapped row by row (`AddColumns`, `ShowColumns`,
`DropColumns`, `RenameColumns`, `Table.Column`). Anything else (`Concat(Filter(T, ...), ...)`, `ForAll(T, ...)`, a user function
taking the table) is the error `unbounded-consumer`.

### What translates

| Formula | Plan |
| --- | --- |
| `T` | rows |
| `Filter(T, c1, c2, ...)`, `Filter(T As t, ...)` | `filter` (AND) |
| `Search(T, text, "Col", ...)` | `search` (text columns only); a second Search becomes a filter |
| `Sort(T, Col [, order])`, `SortByColumns(T, "A" [, order], "B" ...)` | `sort` (nested sorts prepend keys: the outer sort is primary) |
| `FirstN(T [, n])`, `LastN(T [, n])` | `take` |
| `First(T)`, `Last(T)`, `LookUp(T, c)` | `take: 1` + `single` (shape `record`) |
| `LookUp(T, c, result)` | `take: 1` rows; residual `LookUp(__q0 [As t], true, result)` |
| `CountRows(T)`, `CountIf(T, c)`, `IsEmpty(T)` | `count` / `take: 1` + residual `IsEmpty(__q0)` |
| `Sum/Average/Min/Max(T, NumberCol)` | `aggregate` with no group (shape `scalar`, measure `Value`) |
| `Sum/Average/Min/Max(T, Qty * Price)` | the same with `measure.expr` (section 4b) |
| `Distinct(T, Col)` | `aggregate { groupBy: [Col], as: { Col: 'Value' } }` |
| `DropColumns(AddColumns(GroupBy(T, "A", "G"), "N", CountRows(G), "S", Sum(G, X), "K", CountIf(G, c)), "G")` | `aggregate` with measures |
| `Sort(Distinct(...), Value)`, sorts over aggregate output | `aggregate.sort` |
| `ShowColumns(T, ...)`, `DropColumns(T, ...)`, `T.Col` | `select` |
| `First(...).Col`, `"n=" & CountRows(...)`, `AddColumns(Filter(...), "X", expr)` | plan + residual |

Conditions: `=`, `<>`, `<`, `>`, `<=`, `>=` between a column and an outside value or between two columns of the same kind;
calculations on number columns compared with values, columns or other calculations (`Qty * Price > 1000`, section 4b);
`Year(DateCol) <op> n` (a date range in the browser's time zone);
`&&`, `||`, `!`, `And`, `Or`, `Not`; `IsBlank(Col)`; `StartsWith(Col, v)`, `EndsWith(Col, v)`; `"text" in Col`, `"text" exactin Col`;
`Col in [a, b]` / `Col in varTable`, `Col exactin [...]`; a boolean column alone (`Active`), a number column alone (non-zero);
constants (`true`, `varFlag`).

### What does not translate (error unless the table is small)

| Code | Example | Why / suggestion |
| --- | --- | --- |
| `not-delegable-expression` | `Len(Title) > 3`, `Price / Qty > 2` (divisor is a column), `Price ^ 2`, `Mod(Qty, 2) = 1`, `Month(Due) = 3`, `DateAdd(Due, 1, "Days") > Today()`, `Sort(T, Price * 2)` | calculations other than + - * / Abs Round RoundUp RoundDown on number columns; move them to the value side (`Due > DateAdd(Today(), -1, "Days")`), multiply instead of dividing by a column, or store the value in a column |
| `not-delegable-predicate` | `If(Active, ...)` in a condition, `Col in "a b c"` (column inside a text), other functions | only the condition forms above |
| `numeric-text` | `Code < "5"`, `Title > ""`, `Title < Status` | ordering text against number-like text compares numbers in some rows and text in others (see 6) |
| `type-mismatch` | `Code = 10` (text vs number), `Active > false`, columns of different kinds | compare like with like |
| `unsupported-column` | a column of kind `other`; `Search` over a number column; `StartsWith` on a number | |
| `unknown-column` | `ThisRecord.Nope` | |
| `nested-table` | `Filter(T, Owner = LookUp(Customers, ...).Email)` | read the value into a variable first; nested queries are not pushed down yet |
| `per-row-query` | `ForAll(varList, CountRows(Filter(T, X = Value)))` | one query per row |
| `unbounded-consumer` | `Concat(Filter(T, ...), Title)`, `ForAll(T, ...)` | do the work in the query or bound it with `FirstN` |
| `group-rows` | `AddColumns(GroupBy(T, "A", "G"), "N", CountRows(G))` without dropping `G`, `Filter` after `GroupBy` | grouped rows are never fetched |
| `not-delegable-function` | `RemoveIf(T, ...)`, `UpdateIf(T, ...)`, ops after `FirstN` on an unbounded result | |
| `evaluation-error` | an outside value fails (`1/0`), or would make the engine fail on every row (`Price / 0`) | |
| `parse-error` | | |

Write targets are not reads: the first argument of `Patch`, `Collect`, `ClearCollect`, `Remove`, `Defaults`, `Refresh`, `Clear` is
left alone. `explain(result)` gives the Studio a step-by-step text (server part, browser part, errors).

## 2. The plan

```ts
interface QueryPlan {
  version: 2
  table: string
  filter?: ConditionV2
  search?: { text: string; columns: string[] }
  sort?: SortKeyV2[]                       // { col, dir }
  take?: { n: number; from: 'start' | 'end' }
  aggregate?: { groupBy: string[]; measures: MeasureV2[]; sort?: SortKeyV2[]; as?: Record<string, string> }
  select?: string[]
  count?: boolean
  single?: boolean
  page?: { size: number; cursor?: string }
}
```

Stages run in this order: **filter AND search -> sort -> take -> aggregate -> select -> count / single / page**.

- **Natural order.** Without `sort`, rows come in natural order **(createdOn asc, id asc)**; a table without `createdOn` uses `id`.
  Natural order also breaks every tie of `sort`, **ascending even when the sort key is descending** (the engine's sort is stable and
  a descending sort keeps tied rows in their original order). SQL: `ORDER BY <keys...>, "createdOn" ASC, id ASC`. The browser must
  keep its cached rows of a table in natural order, otherwise `First`, `LookUp`, `Distinct` order and sort ties differ.
- `take`: the first `n` rows of the sorted stream, or the last `n` (`from: 'end'`) **keeping stream order** (SQL: reverse every key
  and tie-breaker, `LIMIT n`, then reverse back). `n` is a whole number >= 0; `n = 0` is no rows.
- `aggregate` runs over the rows that survive `take` (so `Sum(FirstN(Sort(T, X), 5), Price)` sums 5 rows).
- `select`: the columns to return. The server always adds `id`; the browser keeps `id` (as `__id`) for row plans and drops `id`
  unless selected. Aggregate rows have no `id`.
- `count: true`: `response.count` is the number of result rows after take and aggregate, before paging.
- `single: true`: at most one row (the first result row).
- `page` (row plans only, not aggregates): `size` rows starting after `cursor`; `size: 0` returns no rows (count only).

## 3. Column kinds and literals

`TableSchemaInfo.columns` maps every column to a kind (`columnKind(ColumnType)`):

| ColumnType | Kind | Literal in conditions |
| --- | --- | --- |
| text, multiline, email, url, phone, choice, lookup (the target row id), autonumber | `text` | JSON string |
| number, decimal, currency | `number` | JSON number |
| boolean | `boolean` | `true` / `false` (eq, ne, in only) |
| date | `date` | `{ "$date": "YYYY-MM-DD" }` (a calendar date; no time zone) |
| datetime | `datetime` | `{ "$datetime": "2026-11-18T09:30:00.000Z" }` (an instant, ms precision) |
| image, file | `other` | never in a condition, sort or group |

The translator always emits the literal that matches the column's kind. A literal of another kind is a malformed plan (the
reference executor throws `PlanError`; the server answers 422).

**Date columns and time zones.** The browser holds a `date` cell as local midnight of that day, and formula values such as `Today()`
are local. The translator converts an instant `t` compared with a date column into calendar dates in the browser's time zone, the
way the engine compares local midnights: `Due < t` becomes `Due < ceil(t)`, `Due <= t` -> `Due <= floor(t)`, `Due > t` ->
`Due > floor(t)`, `Due >= t` -> `Due >= ceil(t)`, `Due = t` -> `Due = floor(t)` if `t` is a local midnight, otherwise false; floor
is the local calendar date of `t`, ceil is floor + 1 day unless `t` is exactly local midnight. So the server compares `date` columns
with `$date` literals as plain SQL dates and never needs the browser's time zone. `datetime` columns compare as `timestamptz`.

## 4. ConditionV2

Two-valued: every node is true or false for every row. **Primitives are strict: a NULL cell makes them false** (also `ne`), and
`not` negates that two-valued result. SQL: wrap each primitive as `COALESCE(<expr>, false)` (or write it so NULL cannot reach a
`NOT`), e.g. `{ not: { col: 'a', op: 'eq', value: 1 } }` is `NOT COALESCE(a = 1, false)`, which is TRUE for a NULL `a`.

| Node | Meaning (non-NULL cell) | PostgreSQL sketch |
| --- | --- | --- |
| `{ and: [...] }` / `{ or: [...] }` / `{ not: c }` | boolean logic; empty `and` is true, empty `or` is false | `(a AND b)`, `(a OR b)`, `NOT (c)` |
| `{ const: true \| false }` | every row / no row | `TRUE` / `FALSE` |
| `{ col, op: 'isNull' }` | the cell is NULL (text: `''` is not NULL) | `col IS NULL` |
| `{ col, op: 'eq' \| 'ne' \| 'lt' \| 'le' \| 'gt' \| 'ge', value }` | compare with the literal (kind rules below) | text: `lower(col) <op> lower($1)` (ordering: `COLLATE "C"`); others: `col <op> $1` |
| same with `exact: true` (text only) | case-sensitive text | `col <op> $1` (ordering: `COLLATE "C"`) |
| `{ col, op: 'in', value: [...] }` (`exact?`) | equal (eq rules) to one of the literals; `[]` is false | `lower(col) = ANY($1)` with lower-cased values, or `col = ANY($1)` |
| `{ col, op: 'contains' \| 'startsWith' \| 'endsWith', value }` (`exact?`) | text columns only; substring test ignoring case unless exact; `''` matches every non-NULL cell | `strpos(lower(col), lower($1)) > 0`, `left(...)=`, `right(...)=` (avoid `LIKE` escaping issues) |
| `{ col, op: 'cmpCol', cmp, other }` (`exact?`) | two columns of the same kind, both non-NULL; text: `eq`/`ne` only | `lower(a) = lower(b)`, `a < b`, ... |

Comparison rules per kind (non-NULL cell): **text** lower-cased then compared (ordering by code point); **number** numerically;
**boolean** eq/ne only; **date** by calendar day; **datetime** by instant.

**Text case rules.** "Ignoring case" means both sides are lower-cased with the Unicode default case mapping (JavaScript
`toLowerCase()`), then compared exactly. In PostgreSQL use `lower()` in a UTF-8 database whose `LC_CTYPE` is a real locale (for example
`en_US.UTF-8` or an ICU locale): with `LC_CTYPE=C`, `lower()` only folds ASCII, which would break `"Ü" = "ü"`. Ordering compares the
lower-cased strings by code point: `COLLATE "C"` on the lower-cased expression. No accent folding, no trimming: `"cafe" <> "café"`,
`" a" <> "a"`.

### How the translator encodes the engine's blank rules

The engine treats a blank cell differently per operator. The translator computes the engine's answer for a NULL cell (it is a
constant for a given literal) and adds an explicit `isNull` branch; the server only implements the strict primitives.

| Engine rule (blank = NULL cell) | Example formula | Plan |
| --- | --- | --- |
| blank = `""`, `0`, `false` and `Blank()` | `Priority = 0` | `{or: [Priority eq 0, Priority isNull]}` |
| blank text = `""` (and `IsBlank` is NULL or `""`) | `Status = Blank()`, `IsBlank(Title)` | `{or: [Status eq "", Status isNull]}` |
| blank counts as 0 in number ordering | `Priority < 3` | `{or: [Priority lt 3, Priority isNull]}`; `Priority > 3` has no NULL branch |
| blank is before every date | `Due < Date(2026,3,1)` | `{or: [Due lt $date 2026-03-01, Due isNull]}` |
| `<>` keeps blanks unless the value is blank-like | `Status <> "x"` | `{or: [Status ne "x", Status isNull]}` |
| blank reads as `""` in text tests | `StartsWith(Title, "")`, `"" in Title` | `{const: true}` |
| a boolean column used as a condition: blank is false | `!Active` | `{not: {Active eq true}}` (true for NULL) |
| two columns: blank acts as the kind's zero (`0`, `""`, `false`); dates: blank first | `Priority > Score` | `cmpCol` OR (`Priority` NULL AND `Score lt 0`) OR (`Score` NULL AND `Priority gt 0`) |

### Type coercion done by the translator (outside value vs column)

| Column | Outside value | Result |
| --- | --- | --- |
| text | text | ci comparison; ordering refused if the text is number-like (`"5"`, `" 7 "`, `"1,000"`, `"12%"`, `""`) |
| text | number, boolean | refused (`type-mismatch`) |
| text / number / boolean | date | `=` is false for every non-NULL cell; ordering refused |
| number | number; boolean (ordering: 0/1); number-like text (`"2"` -> 2, `""` -> 0) | numeric comparison |
| number | other text | `=` false; ordering refused |
| number | boolean with `=` | false |
| boolean | `true`/`false`; `"true"`/`"FALSE"` (ci); `"1"`/`"0"` | eq / ne; other values: `=` false; ordering refused |
| date / datetime | date; ISO text (`Date.parse`); a number (epoch ms) | instant, converted per 3 |
| any | `Blank()` | per the blank rules above |
| any | table / record | refused |

### 4b. Computed numbers (package D)

A calculation over the current row is a `NumExprV2` (`src/platform/query.ts`):

```ts
type NumExprV2 =
  | number                                                     // a literal; outside values are folded to literals
  | { col: string }                                            // a number (or boolean, true = 1) column; NULL reads as 0
  | { fn: 'add' | 'sub' | 'mul' | 'div'; args: [NumExprV2, NumExprV2] }
  | { fn: 'neg' | 'abs'; args: [NumExprV2] }
  | { fn: 'round' | 'roundUp' | 'roundDown'; args: [NumExprV2]; digits: number }
```

It appears in two places:

- the condition `{ op: 'cmpExpr', cmp, left: NumExprV2, right: NumExprV2 }`, which is two-valued without NULL branches: a
  calculation is never blank (the engine's `toNumber(Blank()) = 0`), and a bare number column next to a calculation compares like
  0 when blank (`compareValues` and `looseEq` both read blank as 0 against a number);
- `MeasureV2.expr` (exactly one of `col` and `expr`): `Sum(Orders, Qty * Price)`. Because the expression is never blank, every row of
  the group counts: `avg` = sum / rows, empty input gives sum/min/max 0 and avg NULL.

| Formula | Expression |
| --- | --- |
| `Qty * Price`, `Qty + 1`, `Price - Discount` | `mul` / `add` / `sub` |
| `-Qty` | `{ fn: 'sub', args: [0, Qty] }` (the engine computes `0 - x`, so `-0` never appears) |
| `Qty / 4`, `Qty / varN` | `div` by a literal; refused when the divisor reads the row (a zero in a row the engine never evaluates, behind `&&`, would fail differently); `x / 0` is `evaluation-error` |
| `Price%` | `div` by 100 |
| `Abs(x)`, `Round(x, d)`, `RoundUp(x, d)`, `RoundDown(x, d)` | `abs`, `round`... with `digits` a whole number from outside the row (`Math.trunc`, |d| <= 100) |
| `Qty * "2"`, `Qty * Blank()`, `Qty * true` | the outside value through the engine's `toNumber` (2, 0, 1); a Date or a non-number text is refused |
| `Qty * 2 = true` | `{ const: false }` (a number never equals a boolean); `<` reads true/false as 1/0 |

Semantics: IEEE double arithmetic in the engine's order; a non-finite intermediate result or a division by zero fails the
whole query (HTTP 422 "That result isn't a valid number" / "Can't divide by zero"), as the formula fails. Rounding works on the
shortest decimal form of the double (JavaScript `String(x)`), like the engine's `Round`: PostgreSQL computes it as
`round(abs(x)::text::numeric, d)` (float8 output is the same shortest round-trip form), with the engine's floating-point branch
for |x| >= 1e21 or 0 < |x| < 1e-6.

`Year(Due) <op> n` (date or datetime column, n a number, number-like text or blank) becomes a range of the column in the browser's
time zone: `Year(Due) = 2026` is `Due >= 2026-01-01 and Due < 2027-01-01`; `<`, `<=`, `>`, `>=` round n to the year boundary; a
fraction never equals a year; a blank cell compares as 0 (`withNull`). `Month`, `Day`, `Weekday` and other date parts are not
ranges and stay refused.

### 4c. Lookup paths: `via` (core data model, package N)

`{ via: { col, table, where, orMissing? } }`: the row's lookup column `col` points at a row of `table` (by id) for which
`where` holds. The translator produces it for a path through a lookup: `createdBy.FullName = "Ada"` is
`{ via: { col: 'createdBy', table: 'sys_users', where: { col: 'FullName', op: 'eq', value: 'Ada' } } }`. `orMissing`
(set when `where` holds for a blank row) also matches a blank lookup and an id whose row is missing or unreadable: the
engine reads the fields of such a row as blank, so `IsBlank(createdBy.FullName)` holds for them. The validator checks that `col` is a lookup to `table` (`TableSchemaInfo.lookups`
and `RelatedSchema`).

- PostgreSQL: `col IN (SELECT id FROM <table> WHERE <where> AND <table's read predicate for the caller>)`; column
  security applies to the target's columns (a hidden column in `where` is refused like on the main table). A target in
  another store is refused, never evaluated in memory.
- Reference executor: `ExecuteOptions.related` gives the target's rows (`RelatedRows`).
- `explain` prints it as `createdBy (sys_users) where ...` (`or blank` with `orMissing`).

## 5. Sorting

Each `SortKeyV2 { col, dir }` orders by a **normalised key**, which is how the engine orders values with blanks:

| Kind | Key (ascending) | NULL | PostgreSQL |
| --- | --- | --- | --- |
| number | numeric | as 0 | `COALESCE(col, 0)` |
| boolean | false < true | as false | `COALESCE(col::int, 0)` |
| text | lower-cased, code point order | as `''` (first) | `COALESCE(lower(col), '') COLLATE "C"` |
| date | calendar day | before every date (first ascending, last descending) | `COALESCE(col, '-infinity'::date)` |
| datetime | instant | before every instant | `COALESCE(col, '-infinity'::timestamptz)` |

Do not rely on `NULLS FIRST/LAST`: normalise as above so blanks tie with `0` / `''` / `false` exactly like the engine, then break ties
by natural order ascending. `Sort(Sort(T, A), B)` = keys `[B, A]`.

## 6. Aggregates

- Group key per column: text lower-cased (`"Pune"` and `"pune"` are one group), number, boolean, date/datetime by value; **NULL is
  its own group**, different from `''`.
- The output value of a group column is the value in the group's **first row** of the stream (original case). Output rows are in
  order of each group's first row in the stream (filter -> sort -> take); `aggregate.sort` then sorts them stably (ties keep that
  order). SQL sketch: number the stream with `row_number() OVER (ORDER BY <sort keys>, createdOn, id) AS rn`, `GROUP BY lower(col)`
  (or the column) with `(array_agg(col ORDER BY rn))[1]` for the value and `ORDER BY <aggregate.sort keys>, min(rn)`.
- `as`: output name of a group column (`Distinct` names its column `Value`).
- Measures over the group's rows: `sum`, `avg`, `min`, `max` over the non-NULL values of a number column; with no non-NULL value
  `sum`, `min`, `max` are **0** and `avg` is NULL (SQL: `COALESCE(sum(x), 0)`, `COALESCE(min(x), 0)`, `avg(x)`). `count` is the
  number of rows, or rows where `filter` is true (`count(*) FILTER (WHERE ...)`).
- `groupBy: []`: exactly one output row, also over no rows (`Sum` of nothing is 0, `Average` of nothing is blank).
- Numbers are IEEE doubles in the browser; the engine sums in stream order. A `numeric` column summed exactly by PostgreSQL can
  differ in the last digits from the engine's floating-point sum (`0.1 + 0.2`). Return `double precision` for measures; a PostgreSQL parity run
  should compare measures with a small relative tolerance (1e-9).

## 7. Search

`search: { text, columns }` keeps rows where **any** listed text column contains `text` ignoring case; NULL cells never match;
empty `text` keeps every row. It is ANDed with `filter`. The translator only lists text columns.

## 8. Paging and the keyset cursor

Row plans page with `page: { size, cursor? }`. The order is total: the sort keys (normalised, section 5) then `createdOn asc, id
asc`. `nextCursor` points just after the last row of the page, or is null on the last page. The next request repeats the plan with
`page.cursor`. Because a cursor is a position in the order, not an offset, rows inserted or deleted before it do not shift the next
page (stable keyset pagination).

Cursor format (`encodeCursor` / `decodeCursor`): `"c2." + base64url(UTF-8 JSON)` of

```json
{ "s": "Status:asc,Due:desc", "k": ["open", "2026-03-01"], "c": "2026-01-01T08:00:00.000Z", "i": "019..." }
```

- `s`: the plan's sort spec (`col:dir` joined by `,`, `""` when unsorted); a cursor for another spec is rejected (`CursorError`, HTTP 422).
- `k`: the last row's normalised key per sort key: number for number (NULL -> 0), boolean (0/1) and datetime (epoch ms); string for
  text (lower-cased, NULL -> `""`) and date (`YYYY-MM-DD`); `null` for a NULL date or datetime (before every value).
- `c`, `i`: the row's `createdOn` (ISO, or null) and `id`.

Seek predicate: rows strictly after the cursor in the total order. With mixed directions write it expanded, using the same
normalised expressions as `ORDER BY` (`K1` .. `Kn`, then `createdOn`, `id`; `>` for ascending keys, `<` for descending):

```sql
  (K1 > $k1)
  OR (K1 = $k1 AND K2 < $k2)                    -- K2 descending
  OR (K1 = $k1 AND K2 = $k2 AND "createdOn" > $c)
  OR (K1 = $k1 AND K2 = $k2 AND "createdOn" = $c AND id > $i)
```

(When every key is ascending, a row comparison `(K1, K2, "createdOn", id) > ($k1, $k2, $c, $i)` is equivalent.) Cursors are opaque to
the browser, which only passes them back. Aggregates are not paged (they are bounded by the number of groups; use `count`).

## 9. Response

```ts
interface QueryV2Response { rows: Record<string, QueryValue>[]; count?: number; nextCursor?: string | null; truncated?: boolean }
```

`truncated` is only ever set by the fallback of connectors that cannot run plans (section 14).

Row values travel as in v1 (dates as `YYYY-MM-DD`, datetimes as ISO); the browser converts by column type (date -> local midnight).
`bindResult(plannedQuery, response)` turns a response into the binding's formula value: rows -> the table, record -> the first row or
blank, count -> `count`, scalar -> the measure of the single aggregate row. Evaluate the residual with
`engine.evaluate(residual.formula, residualScope(bindings, scope))`.

## 10. Known edge cases

- **Number-like text in a text sort.** The engine compares two texts that both look like numbers as numbers (`"9" < "10"`); a plan
  sorts text columns as text (`"10" < "9"`). Comparisons that would hit this are refused (`numeric-text`), but sorting a text column
  is translated, so a text column holding numbers sorts differently on the server. Store numbers in number columns.
  (`translate.test.ts` "known deviation" pins this.) The engine's own order is not consistent for mixed number-like and other text.
- **Code units vs code points.** JavaScript compares strings by UTF-16 code unit, `COLLATE "C"` by code point: they differ only
  between characters above U+FFFF (emoji) and U+E000..U+FFFF. Ignored.
- **Case mapping** differences between JavaScript and the database's ICU/libc version (rare characters, e.g. Turkish dotless i in
  some locales) are possible; use a neutral locale.
- **Outside values are evaluated once** per analysis (the engine would evaluate `Now()` once per row).
- **Floating-point sums** may differ in the last digits (section 6).
- **Rows must carry every column** (NULL when blank): the engine resolves a field missing from a row record in the outer scope.
- **Date cells** must be local midnight in the browser (as `remote.ts` converts them), or `date` comparisons differ.

## 11. Tests

- `src/fx/query/parity.test.ts`: a deterministic corpus (seed 20261118, 650 formulas over sample tables with NULLs, `''`, mixed case,
  number-like text, zero/negative/decimal numbers, true/false/blank, dates, instants and createdOn ties). For every fully delegated
  formula the engine's value over all rows must equal the residual evaluated over the reference executor's results (the executor
  gets the rows in reverse to prove it applies natural order itself); every refused formula must have an error diagnostic and no
  plan; every rows plan paged by 7 must concatenate to the full result. With package D: 477 delegated, 173 refused, 0 mismatches;
  plus the computed-number corpus (`testdata-expr.ts`, 220 formulas, 215 delegated, 0 mismatches).
- `src/fx/query/translate.test.ts`: exact plans for each construct, diagnostics, small tables, explain, cursors.
- `server/connectors/postgres/query-v2.integration.test.ts`: both corpora on real PostgreSQL (section 15), EXPLAIN checks
  (section 13), the documented deviations, limits and errors. `server/core/query-v2.integration.test.ts`: the endpoint over HTTP
  with RBAC, row filters and column security. `server/routes/meta/query-v2-fallback.test.ts`: the fallback.

## 12. PostgreSQL executor (package D)

`POST /api/v1/query { plan }` (`data-api.md`). The DataService validates the plan (`checkPlan`, 422 on any malformed part, node and
size limits as for v1 conditions), checks column-level security on every column the plan reads (403 naming the column, the same
message as v1), takes the caller's row predicate (`rowPredicate(def, 'read')`: RBAC scope plus role row filters) and hands both to
the connector's `queryV2`, which builds ONE statement (`server/connectors/postgres/query-v2.ts`) and runs it inside a short
transaction with `SET LOCAL statement_timeout` (15 s, `APPBUILDER_QUERY_TIMEOUT_MS`; 503 with a readable message) and
`extra_float_digits = 1`.

- **Security inside the statement.** The row predicate is a v1 `Condition`, translated by the v1 builder (`buildWhere`, v1 blank
  and case rules) into the same `WHERE` (`COALESCE(<v1>, FALSE) AND <v2 filter> AND <search>`) with the same parameter list. A user
  without read access gets `FALSE`: no rows, count 0, `Sum` 0. Counts and aggregates therefore only see rows the caller may read.
- **Sort keys everywhere.** Every v2 comparison on a column compares its normalised sort key K (section 5:
  `COALESCE(lower(col), '') COLLATE "C"`, `COALESCE(num, 0)`, `COALESCE(bool::int, 0)`, `COALESCE(date, '-infinity')`) and adds
  `col IS NOT NULL` for strictness, so one btree index on `(K, N, id)` serves equality, `in`, ranges, `startsWith` (`LIKE 'p%'` on a
  "C" key), sorting and keyset seeks. N = `COALESCE("createdOn", '-infinity')`, ties by `"id" COLLATE "C"`. `contains` and search
  are `K LIKE '%...%'` (escaped), which a trigram index can serve. Lowercasing is `fold()` of the v1 builder (ICU root collation when
  available), so v1 and v2 agree.
- **Row plans.** `SELECT <columns>, <cursor keys> FROM t WHERE ... [AND seek] ORDER BY K..., N, id LIMIT size + 1` (one more row
  says whether there is a next page; `nextCursor` is built from the SQL-computed keys of the last row, `cursorFromKeys`). With
  `count`: `SELECT c.__count, p.* FROM (SELECT count(*) ...) c LEFT JOIN LATERAL (<page>) p ON TRUE`, or, when the filter scans anyway
  (search, `contains`, calculations) and this is the first page, `count(*) OVER ()` in the page query (one pass). `take` wraps the
  stream in a subquery (reversed keys and `LIMIT n` for `from: 'end'`) that exposes its keys as `__k<i>`. `page.size = 0`: only the count.
  The seek is the expanded OR form of section 8 plus a redundant bound on the leading key (`K1 <= $k1` for a descending key), so the
  index scan starts at the cursor; when every key is ascending it is a row comparison.
- **Aggregates.** No groups: `SELECT <measures> FROM t WHERE ...` (always one row). Groups over the natural order (no sort, no take):
  one pass `GROUP BY` the group keys (text lowercased, NULL its own group) with the measures and `min(N)`, then a hash join back to the
  rows with that createdOn and `DISTINCT ON` the lowest id: the group's first row gives the original-case values and the group order.
  Groups over a sorted or taken stream number it with `row_number()` and join on each group's first number. Measures are cast to
  `double precision` (count to `int`); `aggregate.sort` keys are the output columns' sort keys, ties by first row.
- **Limits.** `page.size` <= 500 (422); an unpaged rows plan returns at most 5,000 rows (422 "ask for it page by page"); an aggregate
  at most 5,000 groups (422); `in` at most 1,000 values; 2,000 condition nodes, depth 32.
- **Errors.** Division by zero (22012) and overflow / underflow (22003) are 422 with the engine's messages; a cursor for another sort,
  or a forged one, is 422; the statement timeout (57014) is 503.

## 13. Indexes

Created by the PostgreSQL connector (`server/connectors/postgres/sql.ts`) with the table and kept in step by column changes:

| Index | Columns | When |
| --- | --- | --- |
| `ix_<table>_natural` | `(N, id COLLATE "C")` | every table (unsorted pages, every tie-break). Managed tables created before package D get it in the background (`CREATE INDEX CONCURRENTLY`, once per server start) on their first v2 query |
| `kx_<table>_<col>` | `(K(col), N, id)` | lookup columns, unique columns, columns marked **indexed** |
| `kd_<table>_<col>` | `(K(col) DESC, N, id)` | columns marked indexed: a descending sort still breaks ties ascending, which a backward scan of `kx` cannot give |
| `tg_<table>_<col>` | GIN `(K(col)) gin_trgm_ops` | text columns marked indexed, when the `pg_trgm` extension is installed or the database user may install it (it is a trusted extension); otherwise searches scan |

Makers mark a column **Indexed** in the column editor (server mode); the API field is `ColumnDef.indexed` (`PATCH
/tables/:id/columns/:name { indexed: true }` creates or drops the indexes in the column change's transaction). Long text
(`multiline`), files and images are never indexed. The v1 lowercased indexes (`ix_`, `uq_`) stay: uniqueness, lookups and the v1
row filters use them. `query-v2.integration.test.ts` checks with `EXPLAIN` that equality, `in`, prefixes, ranges, sorted pages, deep
cursors in both directions, lookups, unique columns and unsorted pages use these indexes, and that substring search uses the trigram
index.

### Documented deviations (each pinned by a test in `query-v2.integration.test.ts`)

- A text column holding numbers sorts as text on the server (section 10).
- PostgreSQL raises an error for float underflow (`1e-200 * 1e-200`), where JavaScript gives 0: the query fails with 422.
- Sums and averages of decimals may differ in the last digits (summation order); parity compares measures to 12 significant digits.
- In the floating-point branch of `Round` (|x| >= 1e21 or < 1e-6) PostgreSQL computes `floor(|x| * 10^d + 0.5)` where JavaScript uses
  `Math.round`; they differ only when `|x| * 10^d` is the double just below 0.5 (theoretical; not pinned).

## 14. Other connectors

MySQL (external connections), data files and Google Sheets have no `queryV2`. The DataService reads at most
`QUERY_FALLBACK_ROW_CAP` (5,000) rows the caller may see through the connector's own path (MySQL pushes the row filter down; files and
Sheets filter in memory), converts them to formula values (date cells at local midnight), runs the reference executor (data files
and Sheets keep file / sheet order as their natural order: `executePlan(..., { inputOrder: true })`) and sets `truncated: true` on the
answer when the read hit the cap. Counts, sums and pages then cover only those rows; the browser warns (Studio data warnings, a banner
on the portal grid). Move such a table to the default database to query all of it. Tested by
`server/routes/meta/query-v2-fallback.test.ts`.

## 15. Parity and scale (package D)

**Parity on PostgreSQL** (`query-v2.integration.test.ts`, the sample tables loaded into a fresh schema, every delegated formula
executed plan by plan through the connector, the wire rows converted as the browser converts them, the residual finished by the
engine, every rows plan also paged by 7):

| Corpus | Formulas | Delegated and run on PostgreSQL | Row plans paged | Mismatches |
| --- | ---: | ---: | ---: | ---: |
| translator corpus (`testdata.ts`) | 650 | 477 | 245 | 0 |
| computed numbers and `Year()` (`testdata-expr.ts`) | 220 | 215 | 73 | 0 |

The same run passes with `TZ=Asia/Kolkata`, `TZ=America/Los_Angeles` and `TZ=Pacific/Chatham`. The reference executor's own parity
test runs both corpora against the engine without a database.

**Scale check** (`scripts/bench/seed-million.mjs`): table *BigOrders*, 1,000,000 rows (Title, City, Status, Amount indexed; Qty, Note
not), loaded with server-side batched `INSERT ... SELECT generate_series` (50,000 rows per statement; 88 s with the key and trigram
indexes in place), then `POST /api/v1/query` over HTTP, median of 5 runs after a warm-up. Hardware: the development sandbox, 2 vCPUs
(Intel Xeon 2.1 GHz), 7.8 GB RAM, PostgreSQL 16.15 with default settings (`shared_buffers` 128 MB, `work_mem` 4 MB), table and
indexes 1.5 GB, the server and the database on the same machine.

| Query | Rows back | Median ms | Max ms |
| --- | ---: | ---: | ---: |
| First page (100 rows, natural order) + exact count | 100 (count 1,000,000) | 42 | 53 |
| Filtered page, indexed column (City = "Pune North", 0.1%) | 100 | 5 | 7 |
| Filtered page, indexed column (Status = "Won", 25%) + count | 100 (count 250,000) | 188 | 212 |
| Filtered page, non-indexed column (Qty = 7, 2%) | 100 | 6 | 7 |
| Filtered page, non-indexed text (Note contains "abc") | 100 | 20 | 22 |
| Search "order 4242" in Title, City (indexed: trigram) + count | 100 (count 111) | 32 | 37 |
| Search "abc12" in Note (not indexed) + count | 34 (count 34) | 1013 | 1424 |
| Sorted page (Amount desc), first page | 100 | 7 | 8 |
| Sorted page (Amount desc), deep cursor (90% into the order) | 100 | 7 | 8 |
| Exact count, whole table | 0 (count 1,000,000) | 51 | 54 |
| Exact count, Due in 2024 (indexed range) | 0 (count 146,400) | 80 | 96 |
| Grouped aggregate: by City, count + sum(Amount) | 11 | 402 | 435 |
| Grouped aggregate: by Status, sum(Amount * Qty) | 4 | 524 | 583 |
| Sum over the whole table (no groups) | 1 | 85 | 96 |

What changed to get there: the deep cursor of a descending sort took 3.3 s before the descending key index and the leading-key bound
(the scan had to sort everything after the cursor); grouped aggregates took 3.3 s with `row_number()` over every row before the
natural-order path; search with a count took 1.4 s before the one-pass count and the trigram index. What is still slow: a substring
search with an exact count over a text column that is not indexed scans all rows (about 1 s here: lowercasing 1,000,000 values);
marking the column indexed makes it the 32 ms row above. Lower page sizes do not help a count; counting a broad filter (25% of the
table) costs about 0.2 s.

`scripts/bench/browser-check.mjs` then drives the built app in headless Chrome against the same server: the portal grid and an app
`DataTable`, `Gallery`, `Dropdown` and labels over the 1,000,000 rows (exact counts, paging on scroll, server sort and search,
`CountRows(Filter(...))`, `Sum(Filter(...), Amount * Qty)`, type-ahead), the seeded Contacts app as an administrator and as a
restricted Sales rep, the Studio diagnostics, and demo mode from `dist/index.html`. All 29 checks pass.
