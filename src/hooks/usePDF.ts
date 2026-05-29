import { useEffect, useState } from 'react'
import { loadPDFFromBytes, type PDFDocumentProxy } from '../lib/pdf'
import {
  QuotaExceededWhileSavingPDF,
  ensureSession,
  getPDF,
  savePDF,
  setLastFilename,
  setNumPages,
} from '../lib/db'
import { prettifyFilename } from '../lib/filenameUtils'

export interface LoadedPDF {
  doc: PDFDocumentProxy
  filename: string
  numPages: number
  /**
   * Raw source bytes retained so the export pipeline (`pdf-lib`) can copy
   * pages verbatim and emit a text-layer-preserving PDF. We keep our own
   * copy because pdf.js detaches its input buffer when it transfers the
   * data to its worker.
   */
  bytes: Uint8Array
}

export interface UsePDFResult {
  pdf: LoadedPDF | null
  loading: boolean
  error: string | null
  quotaWarning: boolean
  openFile: (file: File) => Promise<boolean>
  openFromLibrary: (filename: string) => Promise<boolean>
  close: () => void
  dismissQuotaWarning: () => void
}

async function loadWithRetainedBytes(
  source: Blob | File,
): Promise<{ doc: PDFDocumentProxy; bytes: Uint8Array }> {
  const buf = await source.arrayBuffer()
  const bytes = new Uint8Array(buf)
  // Hand pdf.js a defensive copy — it transfers the input to its worker
  // and the underlying buffer becomes detached.
  const doc = await loadPDFFromBytes(new Uint8Array(bytes))
  return { doc, bytes }
}

export function usePDF(): UsePDFResult {
  const [pdf, setPdf] = useState<LoadedPDF | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [quotaWarning, setQuotaWarning] = useState(false)

  async function finalizeLoad(
    doc: PDFDocumentProxy,
    filename: string,
    bytes: Uint8Array,
  ): Promise<void> {
    setPdf({ doc, filename, numPages: doc.numPages, bytes })
    await setLastFilename(filename)
    await setNumPages(filename, doc.numPages)
  }

  async function openFile(file: File): Promise<boolean> {
    setLoading(true)
    setError(null)
    try {
      const { doc, bytes } = await loadWithRetainedBytes(file)
      await ensureSession(file.name, prettifyFilename(file.name))
      await finalizeLoad(doc, file.name, bytes)
      try {
        await savePDF(file.name, file)
      } catch (saveErr) {
        if (saveErr instanceof QuotaExceededWhileSavingPDF) {
          setQuotaWarning(true)
        } else {
          console.error('savePDF failed', saveErr)
        }
      }
      return true
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : String(e))
      setPdf(null)
      return false
    } finally {
      setLoading(false)
    }
  }

  async function openFromLibrary(filename: string): Promise<boolean> {
    setLoading(true)
    setError(null)
    try {
      const blob = await getPDF(filename)
      if (!blob) {
        setError('Library entry missing PDF bytes.')
        return false
      }
      const { doc, bytes } = await loadWithRetainedBytes(blob)
      await ensureSession(filename, prettifyFilename(filename))
      await finalizeLoad(doc, filename, bytes)
      return true
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : String(e))
      setPdf(null)
      return false
    } finally {
      setLoading(false)
    }
  }

  function close(): void {
    if (pdf) pdf.doc.destroy()
    setPdf(null)
  }

  function dismissQuotaWarning(): void {
    setQuotaWarning(false)
  }

  useEffect(() => {
    return () => {
      if (pdf) pdf.doc.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    pdf,
    loading,
    error,
    quotaWarning,
    openFile,
    openFromLibrary,
    close,
    dismissQuotaWarning,
  }
}
