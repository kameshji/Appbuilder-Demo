/**
 * Lazy loading of the animated icons' Lottie data. Every icon is its own module
 * (react-useanimations/lib/<id>.mjs); import.meta.glob turns each into a separate lazy import
 * (inlined into the HTML by vite-plugin-singlefile, but only evaluated on first use).
 */
import { useEffect, useState } from 'react'
import type { Animation } from 'react-useanimations'

const globbed = import.meta.glob<Animation>('../../../node_modules/react-useanimations/lib/*.mjs', { import: 'default' })

const loaders = new Map<string, () => Promise<Animation>>()
for (const [path, load] of Object.entries(globbed)) {
  const m = /\/([^/]+)\.mjs$/.exec(path)
  if (m) loaders.set(m[1], load)
}

const loaded = new Map<string, Animation>()
const pending = new Map<string, Promise<Animation | null>>()

/** The animation if it is already loaded. */
export const loadedAnimation = (id: string): Animation | undefined => loaded.get(id)

export function loadAnimation(id: string): Promise<Animation | null> {
  const hit = loaded.get(id)
  if (hit) return Promise.resolve(hit)
  let p = pending.get(id)
  if (!p) {
    const load = loaders.get(id)
    p = load
      ? load().then(
          (a) => {
            loaded.set(id, a)
            return a
          },
          () => null,
        )
      : Promise.resolve(null)
    pending.set(id, p)
  }
  return p
}

/** Animation data for an icon id: undefined while loading, null when it cannot be loaded. */
export function useAnimation(id: string): Animation | null | undefined {
  const [, force] = useState(0)
  const [failed, setFailed] = useState<string | null>(null)
  const hit = loaded.get(id)
  useEffect(() => {
    if (loaded.has(id)) return
    let live = true
    void loadAnimation(id).then((a) => {
      if (!live) return
      if (a) force((n) => n + 1)
      else setFailed(id)
    })
    return () => {
      live = false
    }
  }, [id])
  return hit ?? (failed === id ? null : undefined)
}
