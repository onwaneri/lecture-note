import { useCallback, useEffect, useRef, useState } from 'react'
import { getPDF } from '../lib/db'
import { loadPDFFromBlob, type PDFDocumentProxy } from '../lib/pdf'

export interface UsePrepDocsResult {
  /** The loaded doc for a filename, or null if not yet loaded. */
  getDoc: (filename: string) => PDFDocumentProxy | null
  /** Load (or return cached) a doc by filename. */
  ensureDoc: (filename: string) => Promise<PDFDocumentProxy | null>
  /** Filename currently being fetched, if any. */
  loadingFilename: string | null
  error: string | null
}

/**
 * Lazily loads multiple source PDFs (by filename) from IDB and caches the
 * `PDFDocumentProxy` instances. The Test Prep reference pane shows slides from
 * any uploaded material, so it needs several docs alive at once — unlike the
 * single-doc lecture view.
 */
export function usePrepDocs(): UsePrepDocsResult {
  const cacheRef = useRef<Map<string, PDFDocumentProxy>>(new Map())
  // Bump to force re-render once a doc finishes loading.
  const [, setTick] = useState(0)
  const [loadingFilename, setLoadingFilename] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef<Map<string, Promise<PDFDocumentProxy | null>>>(
    new Map(),
  )

  const getDoc = useCallback(
    (filename: string) => cacheRef.current.get(filename) ?? null,
    [],
  )

  const ensureDoc = useCallback(
    async (filename: string): Promise<PDFDocumentProxy | null> => {
      const cached = cacheRef.current.get(filename)
      if (cached) return cached
      const pending = inflight.current.get(filename)
      if (pending) return pending

      const task = (async () => {
        setLoadingFilename(filename)
        try {
          const blob = await getPDF(filename)
          if (!blob) {
            setError(`Missing PDF: ${filename}`)
            return null
          }
          const doc = await loadPDFFromBlob(blob)
          cacheRef.current.set(filename, doc)
          setTick((t) => t + 1)
          return doc
        } catch (e) {
          console.error('prep doc load failed', e)
          setError(e instanceof Error ? e.message : String(e))
          return null
        } finally {
          inflight.current.delete(filename)
          setLoadingFilename((cur) => (cur === filename ? null : cur))
        }
      })()
      inflight.current.set(filename, task)
      return task
    },
    [],
  )

  useEffect(() => {
    const cache = cacheRef.current
    return () => {
      for (const doc of cache.values()) doc.destroy()
      cache.clear()
    }
  }, [])

  return { getDoc, ensureDoc, loadingFilename, error }
}
