/**
 * Which palette a diagram should be drawn in, light or dark.
 *
 * Diagrams bake their colours into the SVG they produce, so unlike math (which
 * renders in `currentColor` and follows the theme for free) they have to be
 * told, and re-drawn when the answer changes. Shared by the Preview pipeline
 * and the editor's live preview so one theme switch cannot leave a dark note
 * holding a diagram drawn for a light one.
 */
import { useEffect, useMemo, useState } from 'react'

import { THEMES, resolveAuto } from './themes'
import { useStore } from '../store'

export function useDiagramThemeMode(): 'light' | 'dark' {
  const themeId = useStore((s) => s.themeId)
  const themeFamily = useStore((s) => s.themeFamily)
  const themeMode = useStore((s) => s.themeMode)
  // Track the OS-level preference so `mode: 'auto'` themes still pick the right
  // palette when the system toggles between light and dark.
  const [prefersDark, setPrefersDark] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  )
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent): void => setPrefersDark(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  return useMemo(() => {
    const resolvedId =
      themeMode === 'auto' ? resolveAuto(themeFamily, prefersDark, themeId) : themeId
    return THEMES.find((t) => t.id === resolvedId)?.mode ?? 'light'
  }, [themeId, themeFamily, themeMode, prefersDark])
}

/**
 * The same answer, read off the document instead of the store.
 *
 * `App` keeps `html[data-theme-mode]` current for every theme, including the
 * `auto` ones that follow the OS, so this is the resolved mode without needing
 * a React context. For the code paths that assemble editor extensions outside a
 * component, where a hook cannot go.
 */
export function documentDiagramMode(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.themeMode === 'dark' ? 'dark' : 'light'
}
