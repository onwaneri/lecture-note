import {
  getAllNotesForFile,
  getPDF,
  getSession,
  getThumbnail,
  setThumbnail,
} from './db'
import { loadPDFFromBlob, loadPDFFromBytes, renderPageToCanvas } from './pdf'
import { exportInterleavedPDF } from './exportPDF'

const THUMB_TARGET_WIDTH = 360 // CSS px; rendered at ~1x so encoded PNG stays small

export async function exportLectureByFilename(
  filename: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const blob = await getPDF(filename)
  if (!blob) throw new Error('PDF not in library')
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  // pdf.js detaches its input — pass a defensive copy so the original
  // `bytes` (used by pdf-lib for the export) stays intact.
  const doc = await loadPDFFromBytes(new Uint8Array(bytes))
  try {
    const [notes, session] = await Promise.all([
      getAllNotesForFile(filename),
      getSession(filename),
    ])
    await exportInterleavedPDF({
      sourceBytes: bytes,
      doc,
      numPages: doc.numPages,
      notes,
      sessionName: session?.sessionName ?? '',
      filename,
      onProgress,
    })
  } finally {
    doc.destroy()
  }
}

/**
 * Returns a cached page-1 PNG dataURL for the lecture, generating one if
 * needed by rendering the first page of the stored PDF. Returns null if the
 * PDF blob is missing or rendering fails.
 */
export async function ensureThumbnail(
  filename: string,
): Promise<string | null> {
  const cached = await getThumbnail(filename)
  if (cached) return cached

  const blob = await getPDF(filename)
  if (!blob) return null

  let doc: Awaited<ReturnType<typeof loadPDFFromBlob>> | null = null
  try {
    doc = await loadPDFFromBlob(blob)
    const page = await doc.getPage(1)
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = THUMB_TARGET_WIDTH / baseViewport.width
    const { canvas } = await renderPageToCanvas(page, scale)
    const dataURL = canvas.toDataURL('image/png')
    await setThumbnail(filename, dataURL)
    return dataURL
  } catch (e) {
    console.warn('thumbnail generation failed for', filename, e)
    return null
  } finally {
    if (doc) doc.destroy()
  }
}
