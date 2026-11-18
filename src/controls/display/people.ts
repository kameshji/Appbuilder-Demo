/**
 * People in UI components (core data model, P0-N): names of users from the Users system table, so Avatar, Avatar
 * group, Person picker and the timeline show people by their user id (createdBy, owner, AssignedTo, User()).
 */
import { useMemo } from 'react'
import type { FxRecord, FxValue } from '@/contracts'
import { platform, usePlatform } from '@/platform'
import { SYS } from '@/platform/system-tables'
import { isRecord } from '../util'

/** the row id of a record value (or the text itself) */
export function recordIdOf(v: FxValue | undefined): string {
  if (v === null || v === undefined) return ''
  if (isRecord(v)) {
    const id = v.__id ?? v.id
    return typeof id === 'string' ? id : id === null || id === undefined ? '' : String(id)
  }
  return typeof v === 'string' ? v : ''
}

/** user id -> full name, from the Users system table (loaded on first use) */
export function usePeopleNames(enabled = true): Map<string, string> {
  const users = usePlatform((s) => (enabled ? s.tables.find((t) => t.id === SYS.users)?.name ?? '' : ''))
  const version = usePlatform((s) => s.dataVersion)
  return useMemo(() => {
    void version
    const out = new Map<string, string>()
    if (!users) return out
    for (const r of platform.tables.rows(users)) out.set(String(r.__id ?? r.id), String(r.FullName ?? ''))
    return out
  }, [users, version])
}

/** a person's name from a user id or a record (Users row, User(), Person picker Selected) */
export function personName(v: FxValue | undefined, names: Map<string, string>): string {
  if (v === null || v === undefined) return ''
  if (isRecord(v)) {
    const r = v as FxRecord
    const n = r.FullName ?? r.Name
    if (typeof n === 'string' && n) return n
    const id = recordIdOf(r) || (typeof r.Id === 'string' ? r.Id : '')
    return names.get(id) ?? ''
  }
  const s = String(v)
  return names.get(s) ?? s
}
