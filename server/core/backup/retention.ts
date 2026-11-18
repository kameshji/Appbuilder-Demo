/**
 * Which backups to keep (grandfather-father-son), as a pure function (retention.test.ts is table-driven).
 *
 * Scheduled backups of one scope (the install, or one environment) are kept like restic's --keep-daily/weekly/monthly:
 * walking from the newest, the newest backup of each of the last `daily` days that have a backup is kept, the newest of
 * each of the last `weekly` ISO weeks, and the newest of each of the last `monthly` months (one backup can count for
 * all three). Days, weeks and months are calendar periods in the install's time zone.
 * Automatic snapshots (before an upgrade, a delete, a restore, a server upgrade) are kept for `snapshotDays` days.
 * Manual and uploaded backups, pinned backups and the newest good backup of each scope are never pruned here.
 * Backups that failed are pruned after `snapshotDays` days too (their partial files are already gone).
 */

export interface RetentionPolicy { daily: number; weekly: number; monthly: number; snapshotDays: number }
export const DEFAULT_RETENTION: RetentionPolicy = { daily: 7, weekly: 4, monthly: 3, snapshotDays: 30 }

export interface RetentionItem {
  id: string
  /** ISO timestamp */
  createdOn: string
  trigger: string
  state: string
  pinned?: boolean
  /** install, or the environment id */
  scope: string
}

export interface RetentionDecision { keep: { id: string; reasons: string[] }[]; prune: { id: string; reason: string }[] }

/** calendar parts of an instant in a time zone */
export function localParts(iso: string, timeZone: string): { day: string; week: string; month: string } {
  const d = new Date(iso)
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>
  const y = Number(parts.year)
  const m = Number(parts.month)
  const day = Number(parts.day)
  // ISO week of that local date
  const utc = new Date(Date.UTC(y, m - 1, day))
  const dow = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() + 4 - dow)
  const wy = utc.getUTCFullYear()
  const week = Math.ceil(((utc.getTime() - Date.UTC(wy, 0, 1)) / 86400000 + 1) / 7)
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    week: `${wy}-W${String(week).padStart(2, '0')}`,
    month: `${parts.year}-${parts.month}`,
  }
}

const SCHEDULED = new Set(['schedule'])
const SNAPSHOT = new Set(['pre-upgrade', 'pre-delete', 'pre-restore', 'pre-migration'])

export function decideRetention(items: RetentionItem[], policy: RetentionPolicy, o: { timeZone: string; now?: Date }): RetentionDecision {
  const now = (o.now ?? new Date()).getTime()
  const keep = new Map<string, string[]>()
  const prune: RetentionDecision['prune'] = []
  const mark = (id: string, why: string) => keep.set(id, [...(keep.get(id) ?? []), why])
  const byScope = new Map<string, RetentionItem[]>()
  for (const it of items) byScope.set(it.scope, [...(byScope.get(it.scope) ?? []), it])
  for (const list of byScope.values()) {
    const sorted = [...list].sort((a, b) => (a.createdOn < b.createdOn ? 1 : a.createdOn > b.createdOn ? -1 : a.id < b.id ? 1 : -1))
    const good = sorted.filter((x) => x.state === 'ok')
    if (good[0]) mark(good[0].id, 'newest good backup')
    // grandfather-father-son over the scheduled backups that succeeded
    const seen = { day: new Set<string>(), week: new Set<string>(), month: new Set<string>() }
    for (const it of good.filter((x) => SCHEDULED.has(x.trigger))) {
      const p = localParts(it.createdOn, o.timeZone)
      if (seen.day.size < policy.daily && !seen.day.has(p.day)) { seen.day.add(p.day); mark(it.id, `daily ${p.day}`) }
      if (seen.week.size < policy.weekly && !seen.week.has(p.week)) { seen.week.add(p.week); mark(it.id, `weekly ${p.week}`) }
      if (seen.month.size < policy.monthly && !seen.month.has(p.month)) { seen.month.add(p.month); mark(it.id, `monthly ${p.month}`) }
    }
    for (const it of sorted) {
      if (it.pinned) { mark(it.id, 'pinned'); continue }
      if (it.state === 'running' || it.state === 'queued' || it.state === 'verifying') { mark(it.id, 'in progress'); continue }
      if (keep.has(it.id)) continue
      const ageDays = (now - new Date(it.createdOn).getTime()) / 86400000
      if (it.state === 'failed' || it.state === 'missing') {
        if (ageDays > policy.snapshotDays) prune.push({ id: it.id, reason: `${it.state}, older than ${policy.snapshotDays} days` })
        else mark(it.id, `${it.state}, kept ${policy.snapshotDays} days`)
        continue
      }
      if (SCHEDULED.has(it.trigger)) { prune.push({ id: it.id, reason: 'outside the daily, weekly and monthly backups to keep' }); continue }
      if (SNAPSHOT.has(it.trigger)) {
        if (ageDays > policy.snapshotDays) prune.push({ id: it.id, reason: `automatic backup older than ${policy.snapshotDays} days` })
        else mark(it.id, `automatic backup, kept ${policy.snapshotDays} days`)
        continue
      }
      mark(it.id, 'manual or uploaded: kept until deleted')
    }
  }
  return { keep: [...keep].map(([id, reasons]) => ({ id, reasons })), prune }
}
