/**
 * DATA API v2 QUERY PLAN (P0 package B; consumed by package D). Pure types plus one pure helper: shared by the browser,
 * the formula-to-query translator (src/fx/query) and the server. Keep it free of React, the DOM and the `@/` alias.
 *
 * The full semantics (null handling, text case rules, sort order of blanks, coercions, cursors) are specified in
 * docs/dev/query-v2.md. Every rule there is checked by the parity test in src/fx/query/parity.test.ts, which compares
 * the formula engine with the reference executor (src/fx/query/reference.ts) on a generated corpus.
 *
 * Additive: the v1 `Query` / `Condition` in http.ts are unchanged. A v2 condition is a separate type because its
 * primitives are STRICT (see ConditionV2), unlike the v1 ones.
 */
import type { QueryValue } from './http.ts'
import type { ColumnType } from './contracts.ts'

/* ------------------------------------------------------------------ schema seen by the translator */

/**
 * How a column's values behave in formulas. `date` = calendar date (the browser holds it as local midnight);
 * `datetime` = an instant. Columns of kind `other` are never used in a pushed-down condition or sort.
 */
export type ColumnKind = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'other'

export interface TableSchemaInfo {
  /** column name -> kind; must list every column a row carries (system columns included) */
  columns: Record<string, ColumnKind>
  /**
   * The client holds every row of this table and there are at most `rowCount` of them. When true and
   * rowCount <= the caller's threshold, a formula that cannot be pushed down may run in the browser (warning,
   * not error).
   */
  fullyLoaded?: boolean
  rowCount?: number
}

export interface SchemaInfo {
  /** data-source tables by the name formulas use */
  tables: Record<string, TableSchemaInfo>
}

/** ColumnType (platform) -> ColumnKind (formulas). */
export function columnKind(type: ColumnType): ColumnKind {
  switch (type) {
    case 'text': case 'multiline': case 'email': case 'url': case 'phone': case 'choice': case 'lookup': case 'autonumber':
      return 'text'
    case 'number': case 'decimal': case 'currency':
      return 'number'
    case 'boolean': return 'boolean'
    case 'date': return 'date'
    case 'datetime': return 'datetime'
    default: return 'other'
  }
}

/* ------------------------------------------------------------------ conditions */

/**
 * A literal in a v2 condition. Plain JSON scalars for text, number and boolean columns; dates are tagged so they are
 * never confused with text:
 *  - `{ $date: 'YYYY-MM-DD' }` for `date` columns (calendar date, no time zone);
 *  - `{ $datetime: '2026-11-18T09:30:00.000Z' }` for `datetime` columns (an instant, ISO 8601 UTC, millisecond precision).
 * The translator always produces the tag that matches the column kind, never a bare string for a date column.
 */
export type QueryLiteral = string | number | boolean | { $date: string } | { $datetime: string }

/** Strict comparison operators. */
export type CompareOpV2 = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'

/**
 * Condition AST v2. Two-valued: every node is true or false for every row, never "unknown".
 *
 * Primitives are STRICT: a NULL cell makes `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `in`, `contains`, `startsWith`, `endsWith`
 * and `cmpCol` FALSE (also `ne`, and also when either column of `cmpCol` is NULL). Formula-engine quirks around blanks
 * (Blank() = 0, Blank() = "", Blank() < 5, ...) are encoded by the translator with explicit `isNull` branches, so the
 * server never needs to know them. `not` negates the two-valued result (SQL: NOT COALESCE(x, false)).
 *
 * Text (`text` columns): comparisons ignore case by default: both sides are lower-cased with the Unicode default case
 * mapping (JavaScript toLowerCase; PostgreSQL lower() in a UTF-8 database whose LC_CTYPE is not "C"), then compared by
 * code point (ordering ops: COLLATE "C"). `exact: true` compares the original text (case-sensitive), used by `exactin`.
 * `''` is a value like any other text for strict primitives (it is not NULL).
 *
 * Numbers compare numerically, booleans only with eq/ne/in, dates by calendar day (`date`) or by instant (`datetime`).
 */
export type ConditionV2 =
  | { and: ConditionV2[] }
  | { or: ConditionV2[] }
  | { not: ConditionV2 }
  | { const: boolean }
  /** the cell is NULL (text columns: '' is NOT null; the translator adds `eq ''` where the engine treats it as blank) */
  | { col: string; op: 'isNull' }
  /** strict comparison with a literal of the column's kind */
  | { col: string; op: CompareOpV2; value: QueryLiteral; exact?: true }
  /** strict membership: the cell equals one of the literals (same rules as eq); an empty list is false */
  | { col: string; op: 'in'; value: QueryLiteral[]; exact?: true }
  /** text columns only: the cell contains / starts with / ends with the text (ignoring case unless exact). '' matches every non-null cell */
  | { col: string; op: 'contains' | 'startsWith' | 'endsWith'; value: string; exact?: true }
  /** strict comparison of two columns of the same kind (both non-null); text columns: eq/ne only */
  | { col: string; op: 'cmpCol'; cmp: CompareOpV2; other: string; exact?: true }

/* ------------------------------------------------------------------ plan */

/**
 * One sort key. Order of values (ascending), which is the formula engine's order with blanks normalised:
 *  - number: NULL counts as 0;  boolean: false < true, NULL counts as false;
 *  - text: lower-cased, code point order, NULL counts as '' (so blanks come first);
 *  - date / datetime: by instant, NULL before every date (first ascending, last descending).
 * Ties are always broken by the table's natural order, ascending, even for descending keys:
 * (createdOn asc, id asc) - see QueryPlan.
 */
export interface SortKeyV2 { col: string; dir: 'asc' | 'desc' }

export type MeasureFn = 'sum' | 'avg' | 'min' | 'max' | 'count'

/**
 * An aggregate measure. sum/avg/min/max: over the non-NULL values of a number column of the group.
 * Empty input (no non-NULL value): sum 0, min 0, max 0, avg NULL. count: number of rows of the group (with
 * `filter`: rows where the filter is true; `col` unused).
 */
export interface MeasureV2 { name: string; fn: MeasureFn; col?: string; filter?: ConditionV2 }

export interface AggregateV2 {
  /**
   * Group columns. Rows are in the same group when every group column has an equal key: text lower-cased (so
   * "Pune" and "pune" are one group), NULL is its own group (different from ''), dates by instant.
   * The output value of a group column is the value of the group's FIRST row in stream order (original case).
   * Empty list: one output row over the whole input, also when the input is empty.
   */
  groupBy: string[]
  measures: MeasureV2[]
  /**
   * Output order: groups in order of their first row in the stream (filter -> sort -> take). Then, if present, a
   * stable sort over the output columns (same value order as SortKeyV2; ties keep first-occurrence order).
   */
  sort?: SortKeyV2[]
  /** rename of a single group column in the output (Distinct produces `Value`) */
  as?: Record<string, string>
}

/**
 * A Query v2 plan: one read against one table. Stages run in this order:
 *   filter (AND search) -> sort -> take -> aggregate -> select -> count / single / page.
 *
 * Natural order: a table's rows are ordered by (createdOn asc, id asc) when there is no sort, and that order breaks
 * every tie of `sort`. The browser must keep its cached rows in the same order (for formulas evaluated locally).
 */
export interface QueryPlan {
  version: 2
  table: string
  filter?: ConditionV2
  /** rows where ANY listed text column contains `text` (ignoring case, NULL cells never match); ANDed with filter. Empty text = no restriction. */
  search?: { text: string; columns: string[] }
  sort?: SortKeyV2[]
  /** keep the first `n` rows of the sorted stream, or the last `n` (from: 'end'; output keeps stream order) */
  take?: { n: number; from: 'start' | 'end' }
  aggregate?: AggregateV2
  /** columns to return (the server always adds `id`); absent = all readable columns */
  select?: string[]
  /** return the number of result rows (after take / aggregate, before page) in `count` */
  count?: boolean
  /** return at most one row: the first result row, or none */
  single?: boolean
  /** paging over the result (rows plans without aggregate). size 0 = no rows (count only). Cursor: see query-v2.md */
  page?: { size: number; cursor?: string }
}

/** Response to a v2 query. Row values travel as in v1 (dates as ISO text); the browser converts by column type. */
export interface QueryV2Response {
  rows: Record<string, QueryValue>[]
  count?: number
  /** present when `page` was given: cursor of the next page, or null when this was the last page */
  nextCursor?: string | null
}
