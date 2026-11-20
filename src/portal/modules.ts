/**
 * Planned modules, as menu entries. ONE registry for both modes: the shell's navigation, the "Soon" badges and the
 * placeholder pages (`#soon-<key>`, ComingSoon.tsx) are all driven from here.
 *
 * To make a module real: set `status: 'live'` and give it a `route` (and build the page). The menu entry then
 * navigates to that route and loses its badge; nothing else needs to change.
 * Phases are the build phases of docs/plan/master-plan.md (section 5).
 */
import {
  Activity, Archive, AtSign, Bot, CalendarClock, CheckSquare, ClipboardCheck, FileText, Folder, Globe, LayoutDashboard, LayoutTemplate, Mail, MessagesSquare, Network,
  Printer, ScrollText, ShieldHalf, StickyNote, Workflow, type LucideIcon,
} from 'lucide-react'
import type { Route } from '@/router'

export type ShellMode = 'dev' | 'user'

export const PHASES = {
  P0: 'P0 Kernel',
  P1: 'P1 Automation',
  P2: 'P2 Reach',
  P3: 'P3 Collaboration and templates',
  P4: 'P4 Agents',
  P5: 'P5 Documents',
  P6: 'P6 Sites',
  later: 'Later (not yet in a phase)',
} as const
export type Phase = keyof typeof PHASES

export interface ModuleEntry {
  /** stable key: the route is `#soon-<key>` while the module is not built */
  key: string
  label: string
  icon: LucideIcon
  /** which shells list it (Dev mode navigation, User mode navigation) */
  modes: ShellMode[]
  status: 'soon' | 'live'
  /** where a live module's menu entry goes */
  route?: Route
  /** special entry behaviour: 'chat' opens the chat dock instead of a page */
  action?: 'chat'
  phase: Phase
  /** one line under the title */
  tagline: string
  /** 2-3 short lines on what it will do */
  details: string[]
  /** Dev mode entries for admins only */
  need?: 'maker' | 'admin'
  /** false: not a menu entry of its own (a planned part of a live module, e.g. Admin console > Backups) */
  inMenu?: false
}

export const MODULES: readonly ModuleEntry[] = [
  /* ---------------------------------------------------------------- Dev mode */
  {
    key: 'datamodel', label: 'Data model', icon: Network, modes: ['dev'], status: 'live', route: { page: 'datamodel' }, phase: 'P0', need: 'maker',
    tagline: 'A visual schema designer for your tables.',
    details: [
      'See every table, lookup and relationship on one diagram and edit them in a draft; review the plan and apply it in one step.',
      'Patterns (master-detail, hierarchy, star schema, ...), imports from Excel, databases and DBML, and model checks.',
    ],
  },
  {
    key: 'flows', label: 'Flows', icon: Workflow, modes: ['dev'], status: 'live', route: { page: 'flows' }, phase: 'P1', need: 'maker',
    tagline: 'Automate work when data changes, on a schedule or at a button press.',
    details: [
      'Built on a visual canvas by clicking: triggers (a row changes, a schedule, a button in an app, a web request, an approval decided) and steps (data, condition, loop, delay, approval, notify, email, HTTP, connector actions, child flows), with templates, drafts, versions and test runs.',
      'Every run is recorded with its inputs, outputs and errors, live; flows act with the rights of their owner, of the person who starts them, or of a service account an administrator chose.',
    ],
  },
  {
    key: 'approvals', label: 'Approvals', icon: ClipboardCheck, modes: ['dev', 'user'], status: 'live', route: { page: 'u', id: 'approvals' }, phase: 'P1',
    tagline: 'Request, approve and track decisions.',
    details: [
      'Approval requests from flows and apps land in one inbox, answered in the app, from the bell or with an email link (confirmed in the app).',
      'Policies with stages, thresholds, delegation, reminders, escalation and a full history of who decided what and when.',
    ],
  },
  {
    key: 'dashboards', label: 'Dashboards', icon: LayoutDashboard, modes: ['dev', 'user'], status: 'live', route: { page: 'u', id: 'dashboards' }, phase: 'P2',
    tagline: 'Charts and KPIs over your tables, trimmed to what each viewer may see.',
    details: [
      'Tiles (KPIs, gauges, trends, bars, Pareto, tables) over server-side aggregates, one request per refresh, live when the data changes.',
      'Date ranges with the fiscal year, filters and cross-filtering; a manufacturing template with OEE.',
    ],
  },
  {
    key: 'printtemplates', label: 'Print templates', icon: Printer, modes: ['dev'], status: 'live', route: { page: 'printtemplates' }, phase: 'P2', need: 'maker',
    tagline: 'PDF documents from records and queries, with your letterhead.',
    details: [
      'Design pages with headings, rich text, tables with totals and groups, photos, charts, barcodes and QR codes, signature lines; Hindi text is shaped correctly.',
      'Print from apps (Print, GeneratePdf, a Print button), store PDFs with the record, generate in flows and attach to emails and scheduled reports; Word templates too.',
    ],
  },
  {
    key: 'reports', label: 'Scheduled reports', icon: CalendarClock, modes: ['dev'], status: 'live', route: { page: 'reports' }, phase: 'P1',
    tagline: 'A table or a total, emailed on a schedule.',
    details: [
      'Build the query with a few clicks (columns, filters, sort, totals) or a formula; choose a time and the recipients.',
      'Each person gets an email with the first rows and a CSV file of what their own access allows.',
    ],
  },
  {
    key: 'agents', label: 'Agents', icon: Bot, modes: ['dev'], status: 'soon', phase: 'P4', need: 'maker',
    tagline: 'AI agents with instructions, allow-listed tools and knowledge.',
    details: [
      'An agent runs as the calling user and can only use the tools and data you allow; writes need human approval.',
      'Works with hosted providers or a local Ollama; every turn and tool call is audited, with budgets per install.',
    ],
  },
  {
    key: 'sites', label: 'Sites', icon: Globe, modes: ['dev'], status: 'soon', phase: 'P6', need: 'maker',
    tagline: 'External portals for suppliers and customers.',
    details: [
      'A page builder with deny-by-default data blocks and a security check before anything is published.',
      'One-time-code sign-in for external users, with their own roles.',
    ],
  },
  {
    key: 'admin', label: 'Admin console', icon: ShieldHalf, modes: ['dev'], status: 'live', route: { page: 'admin' }, phase: 'P0', need: 'admin',
    tagline: 'Environments, users, licences and the audit log in one place.',
    details: [
      'Environments, users with their roles and sign-in state, sign-in and security, email, service accounts, organisation and licence passes.',
      'The audit log, jobs and schedules, flows (kill switch), backups, server logs, health alerts and heartbeat, usage and updates.',
    ],
  },
  {
    key: 'templates', label: 'Templates', icon: LayoutTemplate, modes: ['dev'], status: 'live', route: { page: 'templates' }, phase: 'P2', need: 'maker',
    tagline: 'Ready-made UI components, screens, apps and data models.',
    details: [
      'The built-in catalogue (works offline): UI component, screen, app and data model templates, bound to your tables in one step and installed after a plan, without overwriting anything. Solution templates (manufacturing pack with OEE, quality inspection with NCR, maintenance; CRM) in P3 Collaboration and templates.',
      'ERP templates (inventory, purchase, sales, ledgers and GST) built on the platform; data import from other systems, with an optional Tally exchange.',
    ],
  },

  /* ---------------------------------------------------------------- parts of the Admin console (no menu entry) */
  {
    key: 'backups', label: 'Backups', icon: Archive, modes: ['dev'], status: 'live', route: { page: 'admin', id: 'backups' }, phase: 'P0', need: 'admin', inMenu: false,
    tagline: 'Verified backups of the install or one environment, restored in place, as a new environment, or table by table.',
    details: [
      'Nightly install backup (database, attachments, data files) kept grandfather-father-son, optional passphrase encryption and off-site copy.',
      'Automatic backups before solution upgrades, environment deletes, restores and server upgrades; a scheduled restore test; download and upload.',
    ],
  },
  {
    key: 'logs', label: 'Server logs', icon: ScrollText, modes: ['dev'], status: 'live', route: { page: 'admin', id: 'logs' }, phase: 'P0', need: 'admin', inMenu: false,
    tagline: 'The server log and health checks, readable from the browser.',
    details: [
      'Health checks (database, disk space, backup age, job queue, clock, email) and the server log with level, time and text filters.',
      'A diagnostics bundle (logs, versions, settings without secrets) to send to support.',
    ],
  },
  {
    key: 'usage', label: 'Usage', icon: Activity, modes: ['dev'], status: 'live', route: { page: 'admin', id: 'usage' }, phase: 'P0', need: 'admin', inMenu: false,
    tagline: 'Who uses this install, and how big the data is.',
    details: [
      'Active and recently signed-in users, storage sizes, tables and row counts per environment, job statistics.',
      'Later also app opens over time, flow runs and the AI budget (P1 and P4).',
    ],
  },

  /* ---------------------------------------------------------------- User mode */
  {
    key: 'tasks', label: 'Tasks', icon: CheckSquare, modes: ['user'], status: 'live', route: { page: 'u', id: 'tasks' }, phase: 'P0',
    tagline: 'Your to-dos and the work assigned to you.',
    details: [
      'Personal and team tasks with due dates, owners and reminders, as a list or a board.',
      'Tasks added on a record (its timeline) show the record they are about.',
    ],
  },
  {
    key: 'mentions', label: 'Mentions', icon: AtSign, modes: ['user'], status: 'live', route: { page: 'u', id: 'mentions' }, phase: 'P0',
    tagline: 'Comments where someone mentioned you.',
    details: ['Every @mention of you in a comment, newest first, with a link back to where it was written.'],
  },
  {
    key: 'myreports', label: 'Scheduled reports', icon: CalendarClock, modes: ['user'], status: 'live', route: { page: 'u', id: 'reports' }, phase: 'P1',
    tagline: 'Reports emailed to you on a schedule.',
    details: ['See and send the reports you receive, unsubscribe from them, or subscribe yourself to a table you can read.'],
  },
  {
    key: 'notes', label: 'Notes', icon: StickyNote, modes: ['user'], status: 'soon', phase: 'P3',
    tagline: 'Rich-text notes, private or shared.',
    details: [
      'Write notes with headings, lists, tables and images; share them with people or teams.',
      'Attach a note to any record so the context stays with the data.',
    ],
  },
  {
    key: 'chat', label: 'Chat', icon: MessagesSquare, modes: ['user'], status: 'soon', phase: 'P3', action: 'chat',
    tagline: 'Talk to your team without leaving your apps.',
    details: [
      'Channels, direct messages, mentions and file sharing.',
      'Share a record, an app or a dashboard as a card; discuss a record in its own thread; search everything.',
    ],
  },
  {
    key: 'files', label: 'Files', icon: Folder, modes: ['user'], status: 'soon', phase: 'P5',
    tagline: 'A document library with folders and versions.',
    details: [
      'Folders, versions and permissions that follow the record or folder a file belongs to.',
      'Full-text search inside documents, trimmed to what you may read.',
    ],
  },
  {
    key: 'documents', label: 'Documents / Slides / Sheets', icon: FileText, modes: ['user'], status: 'soon', phase: 'P5',
    tagline: 'Create and edit documents, presentations and spreadsheets in the browser.',
    details: [
      'Generate documents and PDFs from templates filled with your data.',
      'Full Word, PowerPoint and Excel editing through the optional office add-on.',
    ],
  },
  {
    key: 'mail', label: 'Mail', icon: Mail, modes: ['user'], status: 'soon', phase: 'later',
    tagline: 'Your email next to your apps.',
    details: [
      'Read and send mail from your company mailbox, and turn a message into a record or a task.',
      'Not scheduled yet: outgoing email notifications come first, with flows in P1 Automation.',
    ],
  },
]

export const moduleByKey = (key: string): ModuleEntry | undefined => MODULES.find((m) => m.key === key)
export const modulesFor = (mode: ShellMode): ModuleEntry[] => MODULES.filter((m) => m.modes.includes(mode) && m.inMenu !== false)
/** the route a menu entry opens (live module: its route; planned: its placeholder page) */
export const moduleRoute = (m: ModuleEntry): Route => (m.status === 'live' && m.route ? m.route : { page: 'soon', id: m.key })

/**
 * Which mode a route shows. Dev pages show in Dev mode and the launcher (#u) and app tabs (#u-<app id>) in User mode.
 * A page that both menus list (Approvals, Dashboards: #u-approvals, #u-dashboards) stays in the mode the person is in,
 * so clicking it in the Dev menu does not throw them into User mode. Settings keeps the mode; a coming-soon page stays
 * when the module is listed in the current mode, otherwise it shows in the mode that lists it.
 */
export function modeOfRoute(route: Route, current: ShellMode): ShellMode {
  if (route.page === 'u') {
    if (!('id' in route)) return 'user'
    const m = MODULES.find((x) => x.status === 'live' && x.route?.page === 'u' && 'id' in x.route && x.route.id === route.id)
    return m && m.modes.includes(current) ? current : 'user'
  }
  if (route.page === 'settings') return current
  if (route.page === 'soon') {
    const m = moduleByKey(route.id)
    return !m || m.modes.includes(current) ? current : m.modes[0]
  }
  return 'dev'
}
