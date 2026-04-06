import { useState, useEffect, useCallback } from 'react'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

interface UpdateState {
  available: boolean
  version: string | null
  notes: string | null
  downloading: boolean
  progress: number
  error: string | null
}

export function useUpdater() {
  const [state, setState] = useState<UpdateState>({
    available: false,
    version: null,
    notes: null,
    downloading: false,
    progress: 0,
    error: null,
  })
  const [update, setUpdate] = useState<Update | null>(null)

  // Check for updates on mount (with a short delay to not block startup)
  useEffect(() => {
    const timer = setTimeout(() => {
      check().then(u => {
        if (u) {
          setUpdate(u)
          setState(prev => ({
            ...prev,
            available: true,
            version: u.version,
            notes: u.body ?? null,
          }))
        }
      }).catch(err => {
        console.error('[Updater] Check failed:', err)
      })
    }, 5000)
    return () => clearTimeout(timer)
  }, [])

  const install = useCallback(async () => {
    if (!update) return
    setState(prev => ({ ...prev, downloading: true, progress: 0, error: null }))
    try {
      let downloaded = 0
      let total = 0
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started' && event.data.contentLength) {
          total = event.data.contentLength
        }
        if (event.event === 'Progress') {
          downloaded += event.data.chunkLength
          const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0
          setState(prev => ({ ...prev, progress: pct }))
        }
      })
      await relaunch()
    } catch (err: any) {
      console.error('[Updater] Install failed:', err)
      setState(prev => ({ ...prev, downloading: false, error: err?.message ?? 'Update failed' }))
    }
  }, [update])

  const dismiss = useCallback(() => {
    setState(prev => ({ ...prev, available: false }))
  }, [])

  return { ...state, install, dismiss }
}
