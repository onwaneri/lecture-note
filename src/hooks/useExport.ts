import { useCallback, useState } from 'react'
import { exportInterleavedPDF } from '../lib/exportPDF'
import type { PDFDocumentProxy } from '../lib/pdf'

interface UseExportArgs {
  doc: PDFDocumentProxy | null
  numPages: number
  filename: string | null
  sessionName: string
  notes: Map<number, string>
  sourceBytes: Uint8Array | null
}

export function useExport({
  doc,
  numPages,
  filename,
  sessionName,
  notes,
  sourceBytes,
}: UseExportArgs) {
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(
    null,
  )

  const run = useCallback(async () => {
    if (!doc || !filename || !sourceBytes) return
    setExporting(true)
    setProgress({ current: 0, total: numPages })
    try {
      await exportInterleavedPDF({
        sourceBytes,
        doc,
        numPages,
        notes,
        sessionName,
        filename,
        onProgress: (current, total) => setProgress({ current, total }),
      })
    } catch (e) {
      console.error('export failed', e)
      alert('Export failed — see console for details.')
    } finally {
      setExporting(false)
      setProgress(null)
    }
  }, [doc, numPages, filename, sessionName, notes, sourceBytes])

  return { run, exporting, progress }
}
