/**
 * Core data model on the client (P0 package N): the collaboration API both backends offer (PlatformApi['collab']).
 * Server mode: /api/v1/collab/* and the data API on the system tables (remote-collab.ts). Demo mode: the same rules over
 * the browser workspace (demo-collab.ts). Security is the server's; the client only shows what it is given.
 */
import type { FxValue } from '../contracts.ts'

export interface TimelineItem {
  kind: 'comment' | 'activity' | 'file' | 'event'
  id: string
  /** ISO time */
  at: string
  by: string | null
  byName: string | null
  assignedName?: string | null
  data: Record<string, unknown>
}

export interface TimelinePage {
  table: string
  row: string
  title: string
  items: TimelineItem[]
  nextCursor: string | null
  following: boolean
  followers: number
  tags: { id: string; name: string; color: string | null }[]
  canComment: boolean
}

export interface TaskItem {
  id: string
  Subject: string
  Type: string
  Status: string
  Priority: string | null
  DueOn: string | null
  AssignedTo: string | null
  AssignedTeam: string | null
  regardingTable: string | null
  regardingId: string | null
  regardingLabel?: string
  regardingTableName?: string
  createdOn: string
  createdBy: string | null
}

export interface MentionItem {
  id: string
  Comment: string | null
  IsRead: boolean
  createdOn: string
  regardingTable: string | null
  regardingId: string | null
  regardingLabel?: string
  regardingTableName?: string
  Body: string | null
  Link: string | null
  byName: string | null
}

export interface PersonOption { id: string; name: string; email: string }

export interface CollabApi {
  /** one record's feed (newest first); PlatformError('not-found') when the user cannot read the record */
  timeline(rowId: string, o?: { table?: string; cursor?: string | null; limit?: number }): Promise<TimelinePage>
  /** body: the limited rich text (mentions as <span data-mention="userId">@Name</span>) */
  addComment(input: { rowId: string; table?: string; body: string; parent?: string; link?: string }): Promise<string>
  editComment(id: string, body: string): Promise<void>
  deleteComment(id: string): Promise<void>
  addActivity(input: { rowId?: string | null; table?: string; subject: string; type?: string; description?: string; dueOn?: string | null; assignedTo?: string | null; priority?: string; link?: string }): Promise<string>
  updateActivity(id: string, changes: Record<string, FxValue>): Promise<void>
  deleteActivity(id: string): Promise<void>
  follow(rowId: string, on: boolean, table?: string): Promise<void>
  tag(rowId: string, tag: string, on: boolean, table?: string): Promise<void>
  /** a file about a record: a Documents row with the file as its first version */
  attachFile(rowId: string, file: File, table?: string): Promise<void>
  /** people who may be @mentioned on the record (they can read it) */
  mentionable(rowId: string, q: string, table?: string): Promise<PersonOption[]>
  /** people for pickers (active users of this environment) */
  people(q?: string): Promise<PersonOption[]>
  myTasks(o?: { all?: boolean }): Promise<TaskItem[]>
  mentions(): Promise<MentionItem[]>
  markMentionRead(id: string): Promise<void>
  /** demo mode only: the next number of a sequence (server mode: column defaults and before-events assign numbers) */
  nextNumber(name: string): Promise<string>
  /** demo mode: the same, synchronously (formulas); absent in server mode */
  nextNumberNow?(name: string): string
  /** live topics of the collaboration tables (subscribe to refresh a timeline) */
  topics(): string[]
}
