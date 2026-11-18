/**
 * Formula-to-query translation (Query v2). Pure library shared by the browser and the server; see
 * docs/dev/query-v2.md. Types of the plan live in src/platform/query.ts.
 */
export { analyze, type AnalyzeOptions, type AnalyzeResult, type PlannedQuery, type QueryDiagnostic, type ResultShape } from './translate.ts'
export { explain, describePlan, describeCondition, bindResult, residualScope } from './explain.ts'
export { executePlan, evaluateConditionV2, naturalCompare, PlanError, type ReferenceResult } from './reference.ts'
export { encodeCursor, decodeCursor, sortKeyValue, compareKeys, sortSpec, CursorError, type DecodedCursor, type KeyValue } from './cursor.ts'
export type { DiagCode } from './conditions.ts'
