import { useCallback, useEffect, useRef, useState } from 'react'
import { getAllNotesForFile, setNote } from '../lib/db'

export interface UseNotesResult {
  notes: Map<number, string>
  getNote: (slideIndex: number) => string
  updateNote: (slideIndex: number, markdown: string) => void
  ready: boolean
}

const SAVE_DEBOUNCE_MS = 400

export function useNotes(filename: string | null): UseNotesResult {
  const [notes, setNotes] = useState<Map<number, string>>(new Map())
  const [ready, setReady] = useState(false)
  const pendingTimers = useRef<Map<number, number>>(new Map())

  useEffect(() => {
    let cancelled = false
    setReady(false)
    setNotes(new Map())
    if (!filename) {
      setReady(true)
      return
    }
    getAllNotesForFile(filename).then((loaded) => {
      if (cancelled) return
      setNotes(loaded)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [filename])

  const getNote = useCallback(
    (slideIndex: number): string => notes.get(slideIndex) ?? '',
    [notes],
  )

  const updateNote = useCallback(
    (slideIndex: number, markdown: string) => {
      if (!filename) return
      setNotes((prev) => {
        const next = new Map(prev)
        next.set(slideIndex, markdown)
        return next
      })
      const prior = pendingTimers.current.get(slideIndex)
      if (prior !== undefined) window.clearTimeout(prior)
      const timer = window.setTimeout(() => {
        setNote(filename, slideIndex, markdown).catch((e) => {
          console.error('failed to persist note', e)
        })
        pendingTimers.current.delete(slideIndex)
      }, SAVE_DEBOUNCE_MS)
      pendingTimers.current.set(slideIndex, timer)
    },
    [filename],
  )

  useEffect(() => {
    return () => {
      for (const t of pendingTimers.current.values()) window.clearTimeout(t)
      pendingTimers.current.clear()
    }
  }, [])

  return { notes, getNote, updateNote, ready }
}
