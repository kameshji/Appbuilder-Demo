/**
 * CORE DATA MODEL (P0 package N, docs/dev/core-data-model.md): the system tables every environment has out of the box,
 * their built-in row security and the reference data they are seeded with. Pure: shared by the server (provisioning,
 * security engine) and demo mode (src/platform/core.ts). Keep it free of React, the DOM, Node APIs and the `@/` alias.
 *
 * Kinds:
 *  - projection: a read-only view over install-wide or security data (users, teams, roles, notifications, logs). On the
 *    server a PostgreSQL VIEW in the environment schema (server/core/system-tables.ts); never written through the API.
 *  - table: a real table of the default database (activities, comments, documents, reference data ...).
 *  - placeholder: a real table with its final shape that a later module fills (flow runs; chat and mail tables).
 *
 * Security (systemPredicate): system tables do not take privileges from roles. Each has a `systemPolicy`; the
 * collaboration tables use the polymorphic "regarding" rule: a row about record R (regardingTable = R's table id,
 * regardingId = R's id) is visible only to users who can read R. It compiles to ONE condition the connectors put in
 * the same SQL statement: `regardingTable IN (<tables the user reads entirely>) OR (regardingTable = 'T' AND EXISTS
 * (SELECT 1 FROM T WHERE T.id = regardingId AND <T's read predicate>)) OR ...`, one branch per table with a row-level
 * predicate (grouped by table; at most MAX_REGARDING_TABLES branches, the rest fail closed).
 */
import type { Condition } from './http.ts'
import type { ColumnDef, ColumnType, SystemPolicy, SystemTableGroup, TableDef } from './contracts.ts'

/* ------------------------------------------------------------------ ids and names */

/** stable table ids (the same in every environment, so solutions and lookups can name them) */
export const SYS = {
  users: 'sys_users',
  departments: 'sys_departments',
  teams: 'sys_teams',
  teamMembers: 'sys_team_members',
  roles: 'sys_roles',
  roleAssignments: 'sys_role_assignments',
  activities: 'sys_activities',
  comments: 'sys_comments',
  mentions: 'sys_mentions',
  follows: 'sys_follows',
  tags: 'sys_tags',
  tagLinks: 'sys_tag_links',
  shares: 'sys_shares',
  notifications: 'sys_notifications',
  documents: 'sys_documents',
  documentVersions: 'sys_document_versions',
  attachmentLinks: 'sys_attachment_links',
  channels: 'sys_channels',
  channelMembers: 'sys_channel_members',
  messages: 'sys_messages',
  messageReactions: 'sys_message_reactions',
  auditEntries: 'sys_audit_entries',
  signInLog: 'sys_sign_in_log',
  jobRuns: 'sys_job_runs',
  eventRuns: 'sys_event_runs',
  flowRuns: 'sys_flow_runs',
  currencies: 'sys_currencies',
  units: 'sys_units',
  countries: 'sys_countries',
  states: 'sys_states',
  calendars: 'sys_calendars',
  holidays: 'sys_holidays',
  sequences: 'sys_number_sequences',
  settings: 'sys_settings',
} as const

export const SYSTEM_GROUP_LABELS: Record<SystemTableGroup, string> = {
  people: 'People and organisation',
  collaboration: 'Collaboration',
  files: 'Files',
  communication: 'Communication',
  logging: 'Logging',
  reference: 'Reference data',
}

export const ACTIVITY_TYPES = ['Task', 'Call', 'Meeting', 'Email', 'Note', 'Custom']
export const ACTIVITY_STATUSES = ['Open', 'In progress', 'Done', 'Cancelled']
export const ACTIVITY_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent']
/** the regarding columns of the collaboration tables */
export const REGARDING = { table: 'regardingTable', id: 'regardingId' } as const
/** at most this many tables with a row-level predicate are joined by one regarding predicate (the rest fail closed) */
export const MAX_REGARDING_TABLES = 500

export interface SystemTableSpec {
  id: string
  name: string
  displayName: string
  description: string
  group: SystemTableGroup
  kind: 'projection' | 'table' | 'placeholder'
  policy: SystemPolicy
  /** physical name in the environment schema (server) */
  source: string
  primaryColumn: string
  extensible: boolean
  /** platform columns (system columns id/createdOn/modifiedOn/createdBy/owner are added by systemTableDef) */
  columns: ColumnDef[]
  regarding?: boolean
  /** policy 'parent': the lookup column whose target row's read predicate decides */
  parent?: { column: string; table: string }
  /** columns hidden from non-administrators (directory rule) */
  adminColumns?: string[]
  /** column sets that are unique together (an index) */
  uniqueTogether?: string[][]
}

const col = (name: string, displayName: string, type: ColumnType, extra: Partial<ColumnDef> = {}): ColumnDef => ({ name, displayName, type, locked: true, ...extra })
const look = (name: string, displayName: string, table: string, extra: Partial<ColumnDef> = {}): ColumnDef => col(name, displayName, 'lookup', { lookupTable: table, ...extra })
const regardingCols = (required = true): ColumnDef[] => [
  col(REGARDING.table, 'Regarding table', 'text', { indexed: true, ...(required ? { required: true } : {}) }),
  col(REGARDING.id, 'Regarding', 'text', { indexed: true, ...(required ? { required: true } : {}) }),
]

export const SYSTEM_TABLES: SystemTableSpec[] = [
  /* ---------------------------------------------------------------- people and organisation (projections) */
  {
    id: SYS.users, name: 'Users', displayName: 'Users', group: 'people', kind: 'projection', policy: 'directory', source: SYS.users, primaryColumn: 'FullName', extensible: false,
    description: 'People who may use this environment. Read-only: accounts are managed in the Admin console.',
    columns: [
      col('FullName', 'Full name', 'text'), col('Email', 'Email', 'email'), look('Department', 'Department', 'Departments'), look('Manager', 'Manager', 'Users'),
      col('JobTitle', 'Job title', 'text'), col('Phone', 'Phone', 'phone'), col('EmployeeCode', 'Employee code', 'text'),
      col('Status', 'Status', 'choice', { choices: ['active', 'disabled'] }),
    ],
    adminColumns: ['Department', 'Manager', 'JobTitle', 'Phone', 'EmployeeCode', 'Status'],
  },
  {
    id: SYS.departments, name: 'Departments', displayName: 'Departments', group: 'people', kind: 'projection', policy: 'directory', source: SYS.departments, primaryColumn: 'Name', extensible: false,
    description: 'The department tree of the organisation (install-wide).',
    columns: [col('Code', 'Code', 'text'), col('Name', 'Name', 'text'), look('Parent', 'Parent department', 'Departments'), col('Description', 'Description', 'multiline')],
    adminColumns: ['Description'],
  },
  {
    id: SYS.teams, name: 'Teams', displayName: 'Teams', group: 'people', kind: 'projection', policy: 'directory', source: SYS.teams, primaryColumn: 'Name', extensible: false,
    description: 'Teams that count in this environment.',
    columns: [col('Code', 'Code', 'text'), col('Name', 'Name', 'text'), col('Description', 'Description', 'multiline')],
    adminColumns: ['Description'],
  },
  {
    id: SYS.teamMembers, name: 'TeamMembers', displayName: 'Team members', group: 'people', kind: 'projection', policy: 'adminOrOwn', source: SYS.teamMembers, primaryColumn: 'Team', extensible: false,
    description: 'Who belongs to which team. Administrators see every membership, everyone else their own.',
    columns: [look('Team', 'Team', 'Teams'), look('User', 'User', 'Users')],
  },
  {
    id: SYS.roles, name: 'Roles', displayName: 'Roles', group: 'people', kind: 'projection', policy: 'adminOrOwn', source: SYS.roles, primaryColumn: 'Name', extensible: false,
    description: 'Security roles of this environment. Administrators see every role, everyone else the roles they hold.',
    columns: [col('Name', 'Name', 'text'), col('Description', 'Description', 'multiline'), col('IsAdmin', 'Administrator', 'boolean'), col('IsMaker', 'Maker', 'boolean')],
  },
  {
    id: SYS.roleAssignments, name: 'RoleAssignments', displayName: 'Role assignments', group: 'people', kind: 'projection', policy: 'adminOrOwn', source: SYS.roleAssignments, primaryColumn: 'Role', extensible: false,
    description: 'Which user holds which role here. Administrators see all, everyone else their own.',
    columns: [look('User', 'User', 'Users'), look('Role', 'Role', 'Roles')],
  },

  /* ---------------------------------------------------------------- collaboration */
  {
    id: SYS.activities, name: 'Activities', displayName: 'Activities', group: 'collaboration', kind: 'table', policy: 'regarding', source: SYS.activities, primaryColumn: 'Subject', extensible: true, regarding: true,
    description: 'Tasks, calls, meetings, email logs and notes, about any record (or about nothing: a personal task).',
    columns: [
      col('Type', 'Type', 'choice', { choices: ACTIVITY_TYPES, default: 'Task', required: true, indexed: true }),
      col('Subject', 'Subject', 'text', { required: true }),
      col('Description', 'Description', 'multiline'),
      col('Status', 'Status', 'choice', { choices: ACTIVITY_STATUSES, default: 'Open', indexed: true }),
      col('Priority', 'Priority', 'choice', { choices: ACTIVITY_PRIORITIES, default: 'Normal' }),
      col('DueOn', 'Due on', 'datetime', { indexed: true }), col('StartOn', 'Starts', 'datetime'), col('EndOn', 'Ends', 'datetime'),
      look('AssignedTo', 'Assigned to', 'Users'), look('AssignedTeam', 'Assigned team', 'Teams'),
      col('CompletedOn', 'Completed on', 'datetime'), look('CompletedBy', 'Completed by', 'Users'),
      ...regardingCols(false),
      look('ParentActivity', 'Parent activity', 'Activities'),
      col('ReminderOn', 'Reminder', 'datetime'), col('Category', 'Category', 'text'),
    ],
  },
  {
    id: SYS.comments, name: 'Comments', displayName: 'Comments', group: 'collaboration', kind: 'table', policy: 'regarding', source: SYS.comments, primaryColumn: 'Body', extensible: true, regarding: true,
    description: 'Comments on any record, with threads and @mentions.',
    columns: [
      col('Body', 'Comment', 'multiline', { required: true }),
      ...regardingCols(true),
      look('ParentComment', 'Reply to', 'Comments'),
      col('EditedOn', 'Edited on', 'datetime'),
      col('MentionIds', 'Mentioned users', 'multiline'),
      col('Link', 'Link', 'text'),
    ],
  },
  {
    id: SYS.mentions, name: 'Mentions', displayName: 'Mentions', group: 'collaboration', kind: 'table', policy: 'regarding', source: SYS.mentions, primaryColumn: 'MentionedUser', extensible: false, regarding: true,
    description: 'Who was @mentioned where. Written by the platform when a comment mentions someone.',
    columns: [look('MentionedUser', 'Mentioned user', 'Users', { indexed: true }), look('Comment', 'Comment', 'Comments'), ...regardingCols(true), col('IsRead', 'Read', 'boolean', { default: 'false' }), col('ReadOn', 'Read on', 'datetime')],
  },
  {
    id: SYS.follows, name: 'Follows', displayName: 'Follows', group: 'collaboration', kind: 'table', policy: 'regarding', source: SYS.follows, primaryColumn: REGARDING.id, extensible: false, regarding: true,
    description: 'Records a user follows (the owner is the follower): they are notified of new comments.',
    columns: [...regardingCols(true)],
    uniqueTogether: [['owner', REGARDING.id]],
  },
  {
    id: SYS.tags, name: 'Tags', displayName: 'Tags', group: 'collaboration', kind: 'table', policy: 'shared', source: SYS.tags, primaryColumn: 'Name', extensible: true,
    description: 'Labels anyone can put on records.',
    columns: [col('Name', 'Name', 'text', { required: true, unique: true }), col('Color', 'Color', 'text'), col('Description', 'Description', 'multiline')],
  },
  {
    id: SYS.tagLinks, name: 'TagLinks', displayName: 'Tag links', group: 'collaboration', kind: 'table', policy: 'regarding', source: SYS.tagLinks, primaryColumn: 'Tag', extensible: false, regarding: true,
    description: 'Which tag is on which record.',
    columns: [look('Tag', 'Tag', 'Tags', { required: true }), ...regardingCols(true)],
    uniqueTogether: [['Tag', REGARDING.id]],
  },
  {
    id: SYS.shares, name: 'Shares', displayName: 'Shares', group: 'collaboration', kind: 'projection', policy: 'regarding', source: SYS.shares, primaryColumn: 'Principal', extensible: false, regarding: true,
    description: 'Record shares (read-only; share from a record).',
    columns: [...regardingCols(true), col('PrincipalType', 'Shared with (kind)', 'choice', { choices: ['user', 'team'] }), col('Principal', 'Shared with', 'text'), col('Access', 'Access', 'choice', { choices: ['read', 'update'] }), look('SharedBy', 'Shared by', 'Users')],
  },
  {
    id: SYS.notifications, name: 'Notifications', displayName: 'Notifications', group: 'collaboration', kind: 'projection', policy: 'own', source: SYS.notifications, primaryColumn: 'Title', extensible: false,
    description: 'Your in-app notifications in this environment (everyone sees only their own).',
    columns: [col('Kind', 'Kind', 'text'), col('Title', 'Title', 'text'), col('Body', 'Body', 'multiline'), col('Link', 'Link', 'text'), col('Source', 'Source', 'text'), look('Sender', 'From', 'Users'), col('SenderName', 'From (name)', 'text'), col('IsRead', 'Read', 'boolean'), col('ReadOn', 'Read on', 'datetime')],
  },

  /* ---------------------------------------------------------------- files */
  {
    id: SYS.documents, name: 'Documents', displayName: 'Documents', group: 'files', kind: 'table', policy: 'regarding', source: SYS.documents, primaryColumn: 'Name', extensible: true, regarding: true,
    description: 'File library entries; a document about a record is visible to whoever can read the record, otherwise to its owner.',
    columns: [
      col('Name', 'Name', 'text', { required: true }), col('FolderPath', 'Folder', 'text', { indexed: true }), col('DocType', 'Type', 'text'), col('SizeBytes', 'Size (bytes)', 'number'),
      look('CurrentVersion', 'Current version', 'DocumentVersions'), col('VersionNumber', 'Version', 'number'), ...regardingCols(false),
      col('File', 'File', 'file', { maxSizeMB: 25 }),
    ],
  },
  {
    id: SYS.documentVersions, name: 'DocumentVersions', displayName: 'Document versions', group: 'files', kind: 'table', policy: 'parent', source: SYS.documentVersions, primaryColumn: 'FileName', extensible: false,
    parent: { column: 'Document', table: SYS.documents },
    description: 'Versions of a document; the file bytes are in the attachment store.',
    columns: [look('Document', 'Document', 'Documents', { required: true }), col('VersionNumber', 'Version', 'number'), col('Attachment', 'Attachment id', 'text'), col('FileName', 'File name', 'text'), col('Mime', 'Type', 'text'), col('SizeBytes', 'Size (bytes)', 'number'), col('Sha256', 'SHA-256', 'text'), col('Comment', 'Comment', 'multiline')],
  },
  {
    id: SYS.attachmentLinks, name: 'AttachmentLinks', displayName: 'Attachment links', group: 'files', kind: 'table', policy: 'regarding', source: SYS.attachmentLinks, primaryColumn: 'FileName', extensible: false, regarding: true,
    description: 'Every file attached to a record (kept in step with file and image columns by the platform).',
    columns: [col('Attachment', 'Attachment id', 'text', { unique: true }), col('ColumnName', 'Column', 'text'), col('FileName', 'File name', 'text'), col('Mime', 'Type', 'text'), col('SizeBytes', 'Size (bytes)', 'number'), ...regardingCols(true)],
  },

  /* ---------------------------------------------------------------- communication (placeholders, final shape) */
  {
    id: SYS.channels, name: 'Channels', displayName: 'Channels', group: 'communication', kind: 'placeholder', policy: 'members', source: SYS.channels, primaryColumn: 'Name', extensible: true,
    description: 'Chat channels, direct conversations and record discussions (filled by chat later). Members only.',
    columns: [col('Name', 'Name', 'text', { required: true }), col('Description', 'Description', 'multiline'), col('Kind', 'Kind', 'choice', { choices: ['channel', 'direct', 'record'], default: 'channel' }), col('IsPrivate', 'Private', 'boolean', { default: 'true' }), ...regardingCols(false), col('ArchivedOn', 'Archived on', 'datetime')],
  },
  {
    id: SYS.channelMembers, name: 'ChannelMembers', displayName: 'Channel members', group: 'communication', kind: 'placeholder', policy: 'parent', source: SYS.channelMembers, primaryColumn: 'User', extensible: false,
    parent: { column: 'Channel', table: SYS.channels },
    description: 'Who is in which channel.',
    columns: [look('Channel', 'Channel', 'Channels', { required: true }), look('User', 'User', 'Users', { required: true }), col('MemberRole', 'Role', 'choice', { choices: ['member', 'owner'], default: 'member' }), col('LastReadOn', 'Last read', 'datetime'), col('Muted', 'Muted', 'boolean', { default: 'false' })],
    uniqueTogether: [['Channel', 'User']],
  },
  {
    id: SYS.messages, name: 'Messages', displayName: 'Messages', group: 'communication', kind: 'placeholder', policy: 'parent', source: SYS.messages, primaryColumn: 'Body', extensible: true,
    parent: { column: 'Channel', table: SYS.channels },
    description: 'Chat messages (members of the channel only).',
    columns: [look('Channel', 'Channel', 'Channels', { required: true }), col('Body', 'Message', 'multiline'), look('ParentMessage', 'Reply to', 'Messages'), col('EditedOn', 'Edited on', 'datetime'), col('DeletedOn', 'Deleted on', 'datetime'), ...regardingCols(false)],
  },
  {
    id: SYS.messageReactions, name: 'MessageReactions', displayName: 'Message reactions', group: 'communication', kind: 'placeholder', policy: 'parent', source: SYS.messageReactions, primaryColumn: 'Emoji', extensible: false,
    parent: { column: 'Message', table: SYS.messages },
    description: 'Reactions to chat messages.',
    columns: [look('Message', 'Message', 'Messages', { required: true }), col('Emoji', 'Emoji', 'text', { required: true })],
    uniqueTogether: [['Message', 'owner', 'Emoji']],
  },

  /* ---------------------------------------------------------------- logging (read-only) */
  {
    id: SYS.auditEntries, name: 'AuditEntries', displayName: 'Audit entries', group: 'logging', kind: 'projection', policy: 'admin', source: SYS.auditEntries, primaryColumn: 'Action', extensible: false,
    description: 'The audit log of this environment (administrators only).',
    columns: [col('Action', 'Action', 'text'), look('User', 'User', 'Users'), col('TableId', 'Table', 'text'), col('RowId', 'Row', 'text'), col('Details', 'Details', 'multiline')],
  },
  {
    id: SYS.signInLog, name: 'SignInLog', displayName: 'Sign-in log', group: 'logging', kind: 'projection', policy: 'adminOrOwn', source: SYS.signInLog, primaryColumn: 'Outcome', extensible: false,
    description: 'Sign-ins and failed attempts (administrators: everyone; others: their own). Filled when the identity sign-in log is installed.',
    columns: [look('User', 'User', 'Users'), col('Email', 'Email', 'email'), col('Outcome', 'Outcome', 'text'), col('Method', 'Method', 'text'), col('IpAddress', 'IP address', 'text'), col('UserAgent', 'Browser', 'text')],
  },
  {
    id: SYS.jobRuns, name: 'JobRuns', displayName: 'Job runs', group: 'logging', kind: 'projection', policy: 'admin', source: SYS.jobRuns, primaryColumn: 'JobType', extensible: false,
    description: 'Background jobs of this environment (administrators only).',
    columns: [col('JobType', 'Type', 'text'), col('State', 'State', 'text'), col('Attempts', 'Attempts', 'number'), col('RunAt', 'Run at', 'datetime'), col('FinishedOn', 'Finished on', 'datetime'), col('RunAs', 'Runs as', 'text'), col('Error', 'Error', 'multiline')],
  },
  {
    id: SYS.eventRuns, name: 'EventRuns', displayName: 'Event runs', group: 'logging', kind: 'projection', policy: 'admin', source: SYS.eventRuns, primaryColumn: 'Outcome', extensible: false,
    description: 'Runs of table events (administrators only).',
    columns: [col('EventId', 'Event', 'text'), col('TableId', 'Table', 'text'), col('RowId', 'Row', 'text'), col('Phase', 'Phase', 'text'), col('Outcome', 'Outcome', 'text'), col('DurationMs', 'Duration (ms)', 'number'), col('Message', 'Message', 'multiline')],
  },
  {
    id: SYS.flowRuns, name: 'FlowRuns', displayName: 'Flow runs', group: 'logging', kind: 'placeholder', policy: 'adminOrOwn', source: SYS.flowRuns, primaryColumn: 'Flow', extensible: false,
    description: 'Runs of flows (filled by Flows in P1; empty until then).',
    columns: [col('Flow', 'Flow', 'text'), col('TriggerKind', 'Trigger', 'text'), col('Status', 'Status', 'choice', { choices: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] }), col('StartedOn', 'Started', 'datetime'), col('FinishedOn', 'Finished', 'datetime'), col('DurationMs', 'Duration (ms)', 'number'), col('Error', 'Error', 'multiline'), ...regardingCols(false)],
  },

  /* ---------------------------------------------------------------- reference data (seeded, extensible) */
  {
    id: SYS.currencies, name: 'Currencies', displayName: 'Currencies', group: 'reference', kind: 'table', policy: 'reference', source: SYS.currencies, primaryColumn: 'Code', extensible: true,
    description: 'ISO 4217 currencies; the default currency (INR) is marked.',
    columns: [col('Code', 'Code', 'text', { required: true, unique: true }), col('Name', 'Name', 'text'), col('Symbol', 'Symbol', 'text'), col('DecimalPlaces', 'Decimal places', 'number'), col('ExchangeRate', 'Rate to default', 'decimal'), col('IsDefault', 'Default', 'boolean', { default: 'false' }), col('IsActive', 'Active', 'boolean', { default: 'true' })],
  },
  {
    id: SYS.units, name: 'UnitsOfMeasure', displayName: 'Units of measure', group: 'reference', kind: 'table', policy: 'reference', source: SYS.units, primaryColumn: 'Code', extensible: true,
    description: 'Units with conversion factors to the base unit of their dimension (Convert(value, from, to)).',
    columns: [col('Code', 'Code', 'text', { required: true, unique: true }), col('Name', 'Name', 'text'), col('Dimension', 'Dimension', 'choice', { choices: ['count', 'mass', 'length', 'area', 'volume', 'time'], required: true }), col('Factor', 'Factor to base', 'decimal', { required: true }), col('IsBase', 'Base unit', 'boolean', { default: 'false' })],
  },
  {
    id: SYS.countries, name: 'Countries', displayName: 'Countries', group: 'reference', kind: 'table', policy: 'reference', source: SYS.countries, primaryColumn: 'Name', extensible: true,
    description: 'ISO 3166-1 countries.',
    columns: [col('Code', 'Code', 'text', { required: true, unique: true }), col('Name', 'Name', 'text', { required: true })],
  },
  {
    id: SYS.states, name: 'States', displayName: 'States', group: 'reference', kind: 'table', policy: 'reference', source: SYS.states, primaryColumn: 'Name', extensible: true,
    description: 'States and union territories (India seeded, with GST state codes).',
    columns: [look('Country', 'Country', 'Countries'), col('CountryCode', 'Country code', 'text', { indexed: true }), col('Code', 'Code', 'text', { required: true }), col('Name', 'Name', 'text', { required: true }), col('Kind', 'Kind', 'choice', { choices: ['State', 'Union territory'] }), col('GstStateCode', 'GST state code', 'text', { indexed: true }), col('IsActive', 'Active', 'boolean', { default: 'true' })],
  },
  {
    id: SYS.calendars, name: 'Calendars', displayName: 'Calendars', group: 'reference', kind: 'table', policy: 'reference', source: SYS.calendars, primaryColumn: 'Name', extensible: true,
    description: 'Working calendars (time zone, working days and hours).',
    columns: [col('Name', 'Name', 'text', { required: true, unique: true }), col('TimeZone', 'Time zone', 'text'), col('WorkingDays', 'Working days', 'text'), col('WorkStart', 'Work starts', 'text'), col('WorkEnd', 'Work ends', 'text'), col('IsDefault', 'Default', 'boolean', { default: 'false' }), col('Description', 'Description', 'multiline')],
  },
  {
    id: SYS.holidays, name: 'Holidays', displayName: 'Holidays', group: 'reference', kind: 'table', policy: 'reference', source: SYS.holidays, primaryColumn: 'Name', extensible: true,
    description: 'Holidays of a calendar (empty: import your list as CSV).',
    columns: [look('Calendar', 'Calendar', 'Calendars'), col('Name', 'Name', 'text', { required: true }), col('HolidayDate', 'Date', 'date', { required: true, indexed: true }), col('IsOptional', 'Optional', 'boolean', { default: 'false' }), col('Region', 'Region', 'text')],
  },
  {
    id: SYS.sequences, name: 'NumberSequences', displayName: 'Number sequences', group: 'reference', kind: 'table', policy: 'reference', source: SYS.sequences, primaryColumn: 'Name', extensible: true,
    description: 'Gap-free numbering (invoices, orders): NextNumber("name") in a column default or a before-event.',
    columns: [
      col('Name', 'Name', 'text', { required: true, unique: true }), col('Prefix', 'Prefix', 'text'), col('Suffix', 'Suffix', 'text'),
      col('Padding', 'Digits', 'number', { default: '4' }), col('NextValue', 'Next value', 'number', { default: '1' }),
      col('ResetRule', 'Reset', 'choice', { choices: ['never', 'yearly', 'financialYear'], default: 'never' }), col('CurrentPeriod', 'Current period', 'text'), col('Description', 'Description', 'multiline'),
    ],
  },
  {
    id: SYS.settings, name: 'Settings', displayName: 'Settings', group: 'reference', kind: 'table', policy: 'reference', source: SYS.settings, primaryColumn: 'Key', extensible: true,
    description: 'Key/value settings of this environment, readable in formulas with Setting("key").',
    columns: [col('Key', 'Key', 'text', { required: true, unique: true }), col('Value', 'Value', 'text'), col('Description', 'Description', 'multiline')],
  },
]

export const SYSTEM_TABLE_BY_ID = new Map(SYSTEM_TABLES.map((t) => [t.id, t]))
export const isSystemTableId = (id: string | undefined): boolean => !!id && SYSTEM_TABLE_BY_ID.has(id)

const SYSTEM_COLS: ColumnDef[] = [
  { name: 'id', displayName: 'Id', type: 'text', system: true },
  { name: 'createdOn', displayName: 'Created on', type: 'datetime', system: true },
  { name: 'modifiedOn', displayName: 'Modified on', type: 'datetime', system: true },
  { name: 'createdBy', displayName: 'Created by', type: 'lookup', lookupTable: 'Users', system: true },
  { name: 'owner', displayName: 'Owner', type: 'lookup', lookupTable: 'Users', system: true },
]

/**
 * The TableDef of a system table: its platform columns plus the custom columns a maker added (`existing`, the stored
 * definition, keeps those). `name` may differ from the spec when a maker's table already had the name.
 */
export function systemTableDef(spec: SystemTableSpec, now: string, existing?: TableDef | null, name = spec.name): TableDef {
  const platform = new Set([...SYSTEM_COLS, ...spec.columns].map((c) => c.name))
  const custom = (existing?.columns ?? []).filter((c) => !platform.has(c.name) && !c.locked && !c.system)
  const def: TableDef = {
    id: spec.id, name, displayName: spec.displayName, description: spec.description, primaryColumn: spec.primaryColumn,
    columns: [...SYSTEM_COLS.map((c) => ({ ...c })), ...spec.columns.map((c) => ({ ...c })), ...(spec.extensible ? custom : [])],
    createdOn: existing?.createdOn ?? now, modifiedOn: existing?.modifiedOn ?? now,
    connectionId: 'conn_default', source: spec.source,
    system: true, systemGroup: spec.group, systemKind: spec.kind, extensible: spec.extensible, systemPolicy: spec.policy,
  }
  if (spec.kind === 'projection') def.readOnly = true
  else def.managed = true
  if (spec.regarding) def.regarding = { ...REGARDING }
  if (spec.uniqueTogether) def.uniqueTogether = spec.uniqueTogether.map((x) => [...x])
  return def
}

/** the system table of a spec in a list of tables (by stable id) */
export function systemTable(tables: TableDef[], id: string): TableDef | undefined {
  return tables.find((t) => t.id === id)
}

/** name of a system table in this environment (it may carry another name when a maker's table already had it) */
export function systemTableName(tables: TableDef[], id: string): string {
  return systemTable(tables, id)?.name ?? SYSTEM_TABLE_BY_ID.get(id)?.name ?? id
}

/* ------------------------------------------------------------------ security */

const TRUE: Condition = { const: true }
const FALSE: Condition = { const: false }
const isTrue = (c: Condition) => 'const' in c && c.const
const isFalse = (c: Condition) => 'const' in c && !c.const

function and(parts: Condition[]): Condition {
  const list: Condition[] = []
  for (const p of parts) {
    if (isFalse(p)) return FALSE
    if (!isTrue(p)) list.push(p)
  }
  return !list.length ? TRUE : list.length === 1 ? list[0] : { and: list }
}
function or(parts: Condition[]): Condition {
  const list: Condition[] = []
  for (const p of parts) {
    if (isTrue(p)) return TRUE
    if (!isFalse(p)) list.push(p)
  }
  return !list.length ? FALSE : list.length === 1 ? list[0] : { or: list }
}
const eq = (col: string, value: string): Condition => ({ col, op: 'eq', value })
const inList = (col: string, values: string[]): Condition => (values.length === 0 ? FALSE : values.length === 1 ? eq(col, values[0]) : { col, op: 'in', value: [...new Set(values)] })
const blank = (col: string): Condition => ({ col, op: 'isBlank' })

export type SystemOp = 'read' | 'update' | 'delete' | 'create' | 'share'

export interface SystemPredicateEnv {
  user: { id: string; roleIds?: string[] }
  /** the user's teams in this environment (ids) */
  teams: string[]
  tables: TableDef[]
  /** may `inner` be read inside a statement on `outer`? (same SQL store) */
  sameStore(outer: TableDef, inner: TableDef): boolean
  /** the read predicate of an ordinary (or another system) table for this user */
  readOf(table: TableDef): Condition
  isAdmin: boolean
  /** nesting guard: a regarding predicate inside another one does not expand its own regarding branches */
  depth?: number
}

/**
 * The built-in row predicate of a system table. Administrators: TRUE, except Notifications (always own rows) and the
 * write operations of projections (never writable). `share` is never allowed on system tables.
 */
export function systemPredicate(table: TableDef, op: SystemOp, env: SystemPredicateEnv): Condition {
  const spec = SYSTEM_TABLE_BY_ID.get(table.id)
  const policy = table.systemPolicy ?? spec?.policy
  if (op === 'share') return FALSE
  if (table.systemKind === 'projection' && op !== 'read') return FALSE
  const me = env.user.id
  if (policy === 'own') return op === 'read' ? eq('owner', me) : FALSE
  if (env.isAdmin) return TRUE
  switch (policy) {
    case 'directory':
      if (op !== 'read') return FALSE
      return table.id === SYS.users ? eq('Status', 'active') : TRUE
    case 'adminOrOwn':
      if (op !== 'read') return FALSE
      if (table.id === SYS.roles) return inList('id', env.user.roleIds ?? [])
      return eq('owner', me)
    case 'admin':
      return FALSE
    case 'reference':
      return op === 'read' ? TRUE : FALSE
    case 'shared':
      if (op === 'read' || op === 'create') return TRUE
      return eq('owner', me)
    case 'members':
      return membersPredicate(table, op, env)
    case 'parent':
      return parentPredicate(table, op, env)
    case 'regarding':
      return regardingPolicy(table, op, env)
  }
  return FALSE
}

/** ids of the columns a non-administrator may not see on a system table (directory rule) */
export function hiddenSystemColumns(table: TableDef, isAdmin: boolean): Set<string> {
  if (isAdmin) return new Set()
  return new Set(SYSTEM_TABLE_BY_ID.get(table.id)?.adminColumns ?? [])
}

/** may this user create rows in the system table at all (before the row check)? */
export function systemCanCreate(table: TableDef, isAdmin: boolean): boolean {
  if (table.systemKind === 'projection') return false
  const policy = table.systemPolicy ?? SYSTEM_TABLE_BY_ID.get(table.id)?.policy
  if (isAdmin) return policy !== 'own'
  if (table.id === SYS.mentions || table.id === SYS.attachmentLinks || table.id === SYS.flowRuns) return false
  return policy === 'regarding' || policy === 'shared' || policy === 'members' || policy === 'parent'
}

/** may this user see the table at all (table list, data routes)? */
export function systemTableVisible(table: TableDef, isAdmin: boolean): boolean {
  const policy = table.systemPolicy ?? SYSTEM_TABLE_BY_ID.get(table.id)?.policy
  return isAdmin || policy !== 'admin'
}

/**
 * The regarding branches: rows whose (regardingTable, regardingId) names a row the user can read.
 *  - tables the user reads entirely (predicate TRUE): one `regardingTable IN (...)` leaf;
 *  - tables with a row-level predicate in the same SQL store: `regardingTable = T AND EXISTS (T where id = regardingId
 *    AND <T's predicate>)` (a correlated semi-join: one primary-key probe per candidate row);
 *  - tables the user cannot read, or with a row-level predicate in another store: nothing (fail closed).
 * Complexity: O(tables) condition nodes; per row at most one branch matches the cheap equality and runs its probe.
 */
export function regardingCondition(collab: TableDef, env: SystemPredicateEnv): Condition {
  const whole: string[] = []
  const branches: Condition[] = []
  let joined = 0
  for (const t of env.tables) {
    if (t.id === collab.id) continue
    // collaboration rows about collaboration rows: only about activities and documents (one level deep)
    if (t.system && t.id !== SYS.activities && t.id !== SYS.documents) continue
    if (t.system && (env.depth ?? 0) > 0) continue
    const pred = t.system ? systemPredicate(t, 'read', { ...env, depth: (env.depth ?? 0) + 1 }) : env.readOf(t)
    if (isFalse(pred)) continue
    if (isTrue(pred)) {
      whole.push(t.id)
      continue
    }
    if (!env.sameStore(collab, t) || (t.missingSystem ?? []).includes('id')) continue
    if (++joined > MAX_REGARDING_TABLES) continue
    branches.push(and([eq(REGARDING.table, t.id), { semi: { col: REGARDING.id, table: t, key: 'id', where: pred, correlated: true } }]))
  }
  return or([inList(REGARDING.table, whole), ...branches])
}

const myTeamsCond = (col: string, teams: string[]): Condition => inList(col, teams)

function regardingPolicy(table: TableDef, op: SystemOp, env: SystemPredicateEnv): Condition {
  const me = env.user.id
  const about = regardingCondition(table, env)
  const unregarded = blank(REGARDING.id)
  switch (table.id) {
    case SYS.activities: {
      const mine = or([eq('AssignedTo', me), myTeamsCond('AssignedTeam', env.teams)])
      const personal = and([unregarded, or([eq('owner', me), eq('createdBy', me)])])
      if (op === 'read') return or([about, mine, personal])
      if (op === 'create') return or([unregarded, about])
      if (op === 'update') return and([or([about, mine, personal]), or([eq('createdBy', me), eq('owner', me), mine])])
      return and([or([about, personal]), or([eq('createdBy', me), eq('owner', me)])])
    }
    case SYS.documents: {
      const personal = and([unregarded, eq('owner', me)])
      if (op === 'read') return or([about, personal])
      if (op === 'create') return or([unregarded, about])
      return and([or([about, personal]), eq('owner', me)])
    }
    case SYS.comments:
      if (op === 'read' || op === 'create') return about
      return and([about, eq('createdBy', me)])
    case SYS.mentions:
      if (op === 'read') return about
      if (op === 'update') return and([about, eq('MentionedUser', me)])
      return FALSE
    case SYS.follows:
    case SYS.tagLinks:
      if (op === 'read' || op === 'create') return about
      return and([about, eq('owner', me)])
    case SYS.attachmentLinks:
    case SYS.shares:
      return op === 'read' ? about : FALSE
  }
  return op === 'read' ? about : FALSE
}

function membersPredicate(table: TableDef, op: SystemOp, env: SystemPredicateEnv): Condition {
  const me = env.user.id
  if (op === 'create') return TRUE
  const members = env.tables.find((t) => t.id === SYS.channelMembers)
  const isMember: Condition = members && env.sameStore(table, members) ? { semi: { col: 'id', table: members, key: 'Channel', where: eq('User', me) } } : FALSE
  if (op === 'read') return or([eq('owner', me), isMember])
  return eq('owner', me)
}

function parentPredicate(table: TableDef, op: SystemOp, env: SystemPredicateEnv): Condition {
  const spec = SYSTEM_TABLE_BY_ID.get(table.id)
  const parent = spec?.parent ? env.tables.find((t) => t.id === spec.parent!.table) : undefined
  if (!spec?.parent || !parent || !env.sameStore(table, parent)) return FALSE
  const parentRead = systemPredicate(parent, 'read', env)
  if (isFalse(parentRead)) return FALSE
  const viaParent: Condition = isTrue(parentRead) ? TRUE : { semi: { col: spec.parent.column, table: parent, key: 'id', where: parentRead } }
  if (op === 'read' || op === 'create') return viaParent
  return and([viaParent, eq('owner', env.user.id)])
}

/* ------------------------------------------------------------------ rich text */

/** tags kept in rich-text comments and descriptions (everything else is dropped, attributes too except href on <a>) */
export const RICH_TEXT_TAGS = ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'span']

/**
 * Sanitises the limited rich-text subset of comments: allowed tags without attributes (links keep an http(s) or
 * in-app `#` href), mention spans `<span data-mention="<userId>">@Name</span>` keep their user id. Text outside tags is
 * escaped. Pure string processing (no DOM), the same on server and client.
 */
export function sanitizeRichText(html: string, maxLength = 20000): string {
  const src = String(html ?? '').slice(0, maxLength * 2)
  let out = ''
  let i = 0
  const esc = (s: string) => s.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      out += esc(src.slice(i))
      break
    }
    out += esc(src.slice(i, lt))
    const gt = src.indexOf('>', lt)
    if (gt < 0) {
      out += esc(src.slice(lt))
      break
    }
    const raw = src.slice(lt + 1, gt).trim()
    i = gt + 1
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([\s\S]*)$/.exec(raw)
    if (!m) continue
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    if (!RICH_TEXT_TAGS.includes(tag)) continue
    if (closing) {
      out += `</${tag}>`
      continue
    }
    const attrs = m[3]
    if (tag === 'a') {
      const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(attrs)
      const h = (href?.[1] ?? href?.[2] ?? '').trim()
      out += /^(https?:\/\/|#)/i.test(h) ? `<a href="${esc(h)}" rel="noopener noreferrer" target="_blank">` : '<a>'
    } else if (tag === 'span') {
      const mention = /data-mention\s*=\s*"([A-Za-z0-9_-]{1,64})"/.exec(attrs)
      out += mention ? `<span data-mention="${mention[1]}">` : '<span>'
    } else out += tag === 'br' ? '<br>' : `<${tag}>`
  }
  return out.slice(0, maxLength)
}

/** user ids mentioned in a (sanitised) rich-text body */
export function mentionedUserIds(html: string): string[] {
  const out = new Set<string>()
  for (const m of String(html ?? '').matchAll(/data-mention="([A-Za-z0-9_-]{1,64})"/g)) out.add(m[1])
  return [...out]
}

/** plain text of a rich-text body (notifications, previews, search) */
export function richTextToPlain(html: string): string {
  return String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|blockquote|pre)>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()
}

/* ------------------------------------------------------------------ number sequences */

export interface SequenceRow { Prefix?: string | null; Suffix?: string | null; Padding?: number | null; NextValue?: number | null; ResetRule?: string | null; CurrentPeriod?: string | null }

/** the financial year label of a date: "2026-27" for April 2026 - March 2027 (start month 1-12; 1 = calendar year "2026") */
export function financialYearOf(d: Date, startMonth: number): string {
  const m = d.getMonth() + 1
  const y = d.getFullYear()
  if (startMonth <= 1) return String(y)
  const start = m >= startMonth ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/** the period a sequence counts in now ('' for never) */
export function sequencePeriod(rule: string | null | undefined, now: Date, fyStartMonth: number): string {
  if (rule === 'yearly') return String(now.getFullYear())
  if (rule === 'financialYear') return financialYearOf(now, fyStartMonth)
  return ''
}

/**
 * Formats a number of a sequence: prefix + zero-padded value + suffix. `{FY}` in the prefix or suffix becomes the
 * financial year label (2026-27), `{YYYY}` the year, `{YY}` its last two digits, `{MM}` the month.
 */
export function formatSequenceNumber(seq: SequenceRow, value: number, now: Date, fyStartMonth: number): string {
  const pad = Math.max(0, Math.min(18, Math.trunc(Number(seq.Padding ?? 4)) || 0))
  const fill = (s: string) => s.replace(/\{FY\}/g, financialYearOf(now, fyStartMonth === 1 ? 4 : fyStartMonth)).replace(/\{YYYY\}/g, String(now.getFullYear()))
    .replace(/\{YY\}/g, String(now.getFullYear() % 100).padStart(2, '0')).replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
  return `${fill(String(seq.Prefix ?? ''))}${String(value).padStart(pad, '0')}${fill(String(seq.Suffix ?? ''))}`
}

/** a column default that draws a number: `=NextNumber("Invoices")` (the server assigns it in the write's transaction) */
export const NEXT_NUMBER_DEFAULT = /^=\s*NextNumber\(\s*"((?:[^"]|"")+)"\s*\)\s*$/i
export function nextNumberDefault(def: string | undefined): string | null {
  const m = def ? NEXT_NUMBER_DEFAULT.exec(def.trim()) : null
  return m ? m[1].replace(/""/g, '"') : null
}

/* ------------------------------------------------------------------ reference data */

/** a stable UUID-shaped id for a seeded row (same in every environment and in demo mode) */
export function seedId(key: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  let h3 = 0x9e3779b9
  let h4 = 0x85ebca6b
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
    h3 = Math.imul(h3 ^ c, 0x27d4eb2d) >>> 0
    h4 = Math.imul(h4 ^ c, 0x165667b1) >>> 0
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0')
  const s = hex(h1) + hex(h2) + hex(h3) + hex(h4)
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-5${s.slice(13, 16)}-${((parseInt(s[16], 16) & 0x3) | 0x8).toString(16)}${s.slice(17, 20)}-${s.slice(20, 32)}`
}

/** [code, name, dimension, factor to base, base?] */
export const UNITS: [string, string, string, number, boolean][] = [
  ['NOS', 'Numbers', 'count', 1, true], ['PCS', 'Pieces', 'count', 1, false], ['DOZ', 'Dozen', 'count', 12, false], ['PAIR', 'Pair', 'count', 2, false], ['SET', 'Set', 'count', 1, false], ['BOX', 'Box', 'count', 1, false],
  ['KG', 'Kilogram', 'mass', 1, true], ['G', 'Gram', 'mass', 0.001, false], ['MG', 'Milligram', 'mass', 0.000001, false], ['T', 'Tonne', 'mass', 1000, false], ['QTL', 'Quintal', 'mass', 100, false], ['LB', 'Pound', 'mass', 0.45359237, false], ['OZ', 'Ounce', 'mass', 0.028349523125, false],
  ['M', 'Metre', 'length', 1, true], ['CM', 'Centimetre', 'length', 0.01, false], ['MM', 'Millimetre', 'length', 0.001, false], ['KM', 'Kilometre', 'length', 1000, false], ['IN', 'Inch', 'length', 0.0254, false], ['FT', 'Foot', 'length', 0.3048, false], ['YD', 'Yard', 'length', 0.9144, false],
  ['SQM', 'Square metre', 'area', 1, true], ['SQFT', 'Square foot', 'area', 0.09290304, false], ['SQYD', 'Square yard', 'area', 0.83612736, false], ['HA', 'Hectare', 'area', 10000, false], ['ACRE', 'Acre', 'area', 4046.8564224, false],
  ['L', 'Litre', 'volume', 1, true], ['ML', 'Millilitre', 'volume', 0.001, false], ['CBM', 'Cubic metre', 'volume', 1000, false], ['CFT', 'Cubic foot', 'volume', 28.316846592, false],
  ['HR', 'Hour', 'time', 3600, false], ['MIN', 'Minute', 'time', 60, false], ['SEC', 'Second', 'time', 1, true], ['DAY', 'Day', 'time', 86400, false],
]

/**
 * Indian states and union territories with their GST state codes, as published in the GST state code list of the
 * Nagaland Taxes Department (nagalandtax.nic.in/docs/GST/Statistics/GST_State_Code_List.pdf, checked 18 Nov 2026;
 * see docs/admin/reference-data.md). Codes 25 (Daman and Diu, July 2017 - 26 Jan 2020) and 28 (Andhra Pradesh before
 * division) are kept as inactive. [GST code, name, kind, active]
 */
export const INDIA_STATES: [string, string, 'State' | 'Union territory', boolean][] = [
  ['01', 'Jammu and Kashmir', 'Union territory', true], ['02', 'Himachal Pradesh', 'State', true], ['03', 'Punjab', 'State', true], ['04', 'Chandigarh', 'Union territory', true],
  ['05', 'Uttarakhand', 'State', true], ['06', 'Haryana', 'State', true], ['07', 'Delhi', 'Union territory', true], ['08', 'Rajasthan', 'State', true], ['09', 'Uttar Pradesh', 'State', true],
  ['10', 'Bihar', 'State', true], ['11', 'Sikkim', 'State', true], ['12', 'Arunachal Pradesh', 'State', true], ['13', 'Nagaland', 'State', true], ['14', 'Manipur', 'State', true],
  ['15', 'Mizoram', 'State', true], ['16', 'Tripura', 'State', true], ['17', 'Meghalaya', 'State', true], ['18', 'Assam', 'State', true], ['19', 'West Bengal', 'State', true],
  ['20', 'Jharkhand', 'State', true], ['21', 'Odisha', 'State', true], ['22', 'Chhattisgarh', 'State', true], ['23', 'Madhya Pradesh', 'State', true], ['24', 'Gujarat', 'State', true],
  ['25', 'Daman and Diu (July 2017 to 26 January 2020)', 'Union territory', false], ['26', 'Dadra and Nagar Haveli and Daman and Diu', 'Union territory', true],
  ['27', 'Maharashtra', 'State', true], ['28', 'Andhra Pradesh (before division)', 'State', false], ['29', 'Karnataka', 'State', true], ['30', 'Goa', 'State', true],
  ['31', 'Lakshadweep', 'Union territory', true], ['32', 'Kerala', 'State', true], ['33', 'Tamil Nadu', 'State', true], ['34', 'Puducherry', 'Union territory', true],
  ['35', 'Andaman and Nicobar Islands', 'Union territory', true], ['36', 'Telangana', 'State', true], ['37', 'Andhra Pradesh', 'State', true], ['38', 'Ladakh', 'Union territory', true],
]

export const DEFAULT_SETTINGS: [key: string, value: string, description: string][] = [
  ['FinancialYearStartMonth', '4', 'Month the financial year starts (1-12). April (4) is the Indian financial year.'],
  ['DefaultCurrency', 'INR', 'Currency code used when a record does not name one.'],
  ['DefaultCountry', 'IN', 'Country code used when a record does not name one.'],
  ['TimeZone', 'Asia/Kolkata', 'Time zone for dates without a time zone (calendars, reminders).'],
]

/** the financial year start month from a Settings row value (default April) */
export function fyStartMonth(value: unknown): number {
  const n = Math.trunc(Number(value))
  return n >= 1 && n <= 12 ? n : 4
}
