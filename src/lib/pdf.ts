import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export type PDFDocumentProxy = pdfjsLib.PDFDocumentProxy
export type PDFPageProxy = pdfjsLib.PDFPageProxy

export async function loadPDFFromBytes(
  bytes: ArrayBuffer | Uint8Array,
): Promise<PDFDocumentProxy> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const loadingTask = pdfjsLib.getDocument({ data })
  return loadingTask.promise
}

export async function loadPDFFromFile(file: File): Promise<PDFDocumentProxy> {
  const buf = await file.arrayBuffer()
  return loadPDFFromBytes(buf)
}

export async function loadPDFFromBlob(blob: Blob): Promise<PDFDocumentProxy> {
  const buf = await blob.arrayBuffer()
  return loadPDFFromBytes(buf)
}

export interface RenderedPage {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

/**
 * Extract the text layer of a single page (1-based not — `index` is 0-based to
 * match the rest of the app). Returns '' for image-only / scanned slides.
 */
export async function getPageText(
  doc: PDFDocumentProxy,
  index: number,
): Promise<string> {
  try {
    const page = await doc.getPage(index + 1)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    return text
  } catch (e) {
    console.warn('getPageText failed', e)
    return ''
  }
}

export async function renderPageToCanvas(
  page: PDFPageProxy,
  scale: number,
): Promise<RenderedPage> {
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas 2d context')
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.floor(viewport.width * dpr)
  canvas.height = Math.floor(viewport.height * dpr)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  ctx.scale(dpr, dpr)
  await page.render({ canvasContext: ctx, viewport }).promise
  return { canvas, width: viewport.width, height: viewport.height }
}
