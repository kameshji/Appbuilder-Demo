# Query v2: formula-to-query translation and plan semantics

Status: P0 package B (library and tests). The Data API v2 endpoint, the PostgreSQL translation and the client data layer that
use it are package D. This page is the contract between them: the PostgreSQL side must give exactly the rows, values and order
described here. Every rule is executable in `/home/claude/appbuilder-demo/src/fx/query/reference.ts` (the reference executor) and is
checked against the formula engine by `/home/claude/appbuilder-demo/src/fx/query/parity.test.ts`.

| File | What |
| --- | --- |
| `src/platform/query.ts` | Types: `SchemaInfo`, `ColumnKind`, `QueryLiteral`, `ConditionV2`, `SortKeyV2`, `MeasureV2`, `AggregateV2`, `QueryPlan`, `QueryV2Response`; `columnKind(ColumnType)` |
| `src/fx/query/translate.ts` | `analyze(formula, schema, options)`: formula -> plans + residual + diagnostics |
| `src/fx/query/conditions.ts` | Comparison recipes (engine blank rules -> strict primitives) |
| `src/fx/query/reference.ts` | `executePlan(plan, rows, tableSchema)`: the reference semantics |
| `src/fx/query/cursor.ts` | Keyset cursor `encodeCursor` / `decodeCursor`, sort-key normalisation |
| `src/fx/query/explain.ts` | `explain()` text for the Studio, `bindResult`, `residualScope` |
| `src/fx/query/testdata.ts`, `*.test.ts` | Sample tables, the generated corpus, parity / unit / cursor tests |

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
| `Distinct(T, Col)` | `aggregate { groupBy: [Col], as: { Col: 'Value' } }` |
| `DropColumns(AddColumns(GroupBy(T, "A", "G"), "N", CountRows(G), "S", Sum(G, X), "K", CountIf(G, c)), "G")` | `aggregate` with measures |
| `Sort(Distinct(...), Value)`, sorts over aggregate output | `aggregate.sort` |
| `ShowColumns(T, ...)`, `DropColumns(T, ...)`, `T.Col` | `select` |
| `First(...).Col`, `"n=" & CountRows(...)`, `AddColumns(Filter(...), "X", expr)` | plan + residual |

Conditions: `=`, `<>`, `<`, `>`, `<=`, `>=` between a column and an outside value or between two columns of the same kind;
`&&`, `||`, `!`, `And`, `Or`, `Not`; `IsBlank(Col)`; `StartsWith(Col, v)`, `EndsWith(Col, v)`; `"text" in Col`, `"text" exactin Col`;
`Col in [a, b]` / `Col in varTable`, `Col exactin [...]`; a boolean column alone (`Active`), a number column alone (non-zero);
constants (`true`, `varFlag`).

### What does not translate (error unless the table is small)

| Code | Example | Why / suggestion |
| --- | --- | --- |
| `not-delegable-expression` | `Len(Title) > 3`, `Price * Qty > 10`, `DateAdd(Due, 1, "Days") > Today()`, `Sum(T, Price * Qty)`, `Sort(T, Price * 2)` | calculations on a column; move them to the value side (`Due > DateAdd(Today(), -1, "Days")`) or store the value in a column |
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
| `evaluation-error` | an outside value fails (`1/0`), or would make the engine fail on every row | |
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
interface QueryV2Response { rows: Record<string, QueryValue>[]; count?: number; nextCursor?: string | null }
```

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
  plan; every rows plan paged by 7 must concatenate to the full result. At the time of writing: about 470 delegated, 180 refused,
  0 mismatches.
- `src/fx/query/translate.test.ts`: exact plans for each construct, diagnostics, small tables, explain, cursors.
- A PostgreSQL implementation should run the same corpus: analyze, execute the plans in SQL, compare with `executePlan`.
