/**
 * Which app store the runtime components (ScreenView, RenderNode, RunSurface, Toasts) read. Default: the shared
 * store (Studio, Preview, the standalone player). An app tab in User mode wraps its RunApp in a provider with its
 * own store (createAppStore), so several apps can be mounted at once without sharing runtime state.
 */
import { createContext, useContext } from 'react'
import { useStore as useZustand } from 'zustand'
import { appStore, type AppStore, type StudioState } from './store'

export const AppStoreContext = createContext<AppStore>(appStore)

/** the store of the surrounding app (provider) or the shared store */
export function useAppStoreApi(): AppStore {
  return useContext(AppStoreContext)
}

/** select from the surrounding app's store */
export function useAppStore<U>(selector: (s: StudioState) => U): U {
  return useZustand(useContext(AppStoreContext), selector)
}
