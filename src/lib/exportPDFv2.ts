import {
  PDFDocument,
  PageSizes,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib'
import type { PDFDocumentProxy } from './pdf'
import { addOutline, type OutlineEntry } from './exportOutline'
import {
  renderMarkdown,
  type LayoutFonts,
  type LayoutState,
  type PageBox,
} from './exportMarkdownLayout'

export interface ExportOptions {
  /**
   * Raw source PDF bytes. pdf-lib uses these to copy slide pages verbatim so
   * the output retains the original text layer and vector graphics.
   */
  sourceBytes: Uint8Array
  /**
   * The pdf.js document — only used here for `numPages` (cheap source of
   * truth that matches what's rendered in the app). We could ask pdf-lib
   * directly, but accepting the proxy keeps the call-site signature stable.
   */
  doc: PDFDocumentProxy
  numPages: number
  notes: Map<number, string>
  sessionName: string
  filename: string
  onProgress?: (pageIndex: number, total: number) => void
}

const NOTES_MARGIN = 56 // pt — comfy editorial margin on all four sides
const HEADER_BASELINE_FROM_TOP = 36 // pt from page top
const HEADER_RULE_GAP = 8 // pt below header text
const HEADER_TOP_PADDING = 18 // gap between header rule and body content
const MUTED = rgb(0.42, 0.4, 0.38)
const RULE = rgb(0.89, 0.87, 0.82)

export async function exportInterleavedPDF(
  options: ExportOptions,
): Promise<void> {
  const { sourceBytes, numPages, notes, sessionName, filename, onProgress } =
    options

  // Defensive copy — pdf-lib mutates its input on .load() in some
  // configurations, and the bytes we receive may be re-used by the caller.
  const src = await PDFDocument.load(new Uint8Array(sourceBytes), {
    updateMetadata: false,
  })
  const out = await PDFDocument.create()
  out.setTitle(sessionName || filename.replace(/\.pdf$/i, ''))
  out.setSubject('Lecture notes')
  out.setProducer('LectureNote')
  out.setCreator('LectureNote')

  const fonts: LayoutFonts = {
    body: await out.embedFont(StandardFonts.Helvetica),
    bold: await out.embedFont(StandardFonts.HelveticaBold),
    italic: await out.embedFont(StandardFonts.HelveticaOblique),
    mono: await out.embedFont(StandardFonts.Courier),
  }

  const outlineEntries: OutlineEntry[] = []
  const totalToCopy = Math.min(numPages, src.getPageCount())

  for (let i = 0; i < totalToCopy; i++) {
    onProgress?.(i, totalToCopy)

    // 1) Slide page — copied verbatim from source.
    const [copied] = await out.copyPages(src, [i])
    out.addPage(copied)
    const slidePageIndex = out.getPageCount() - 1

    // 2) Notes page(s).
    const headerText = buildHeader(sessionName, i, totalToCopy)
    const notesStartIndex = out.getPageCount()
    renderNotesForSlide({
      out,
      fonts,
      markdown: notes.get(i) ?? '',
      header: headerText,
    })

    outlineEntries.push({
      title: sessionName
        ? `Slide ${pad2(i + 1)} — ${sessionName}`
        : `Slide ${pad2(i + 1)}`,
      pageIndex: slidePageIndex,
      children: [{ title: 'Notes', pageIndex: notesStartIndex }],
    })
  }

  onProgress?.(totalToCopy, totalToCopy)

  if (outlineEntries.length > 0) {
    addOutline(out, outlineEntries)
  }

  const bytes = await out.save()
  const outName =
    (sessionName
      ? sessionName.replace(/[\\/:*?"<>|]/g, '_')
      : filename.replace(/\.pdf$/i, '')) + '_notes.pdf'
  triggerDownload(bytes, outName)
}

function renderNotesForSlide(args: {
  out: PDFDocument
  fonts: LayoutFonts
  markdown: string
  header: string
}): void {
  const { out, fonts, markdown, header } = args
  const firstPage = newNotesPage(out, header, fonts)
  const state: LayoutState = {
    page: firstPage,
    y: firstPage.height - firstPage.marginTop,
    fonts,
    addNewPage: () => newNotesPage(out, header, fonts),
  }
  renderMarkdown(markdown, state)
}

function newNotesPage(
  out: PDFDocument,
  headerText: string,
  fonts: LayoutFonts,
): PageBox {
  const page = out.addPage(PageSizes.A4)
  const { width, height } = page.getSize()
  drawHeader(page, headerText, fonts.mono, width, height)
  return {
    page,
    width,
    height,
    marginTop:
      HEADER_BASELINE_FROM_TOP + HEADER_RULE_GAP + HEADER_TOP_PADDING,
    marginBottom: NOTES_MARGIN,
    marginLeft: NOTES_MARGIN,
    marginRight: NOTES_MARGIN,
  }
}

function drawHeader(
  page: PDFPage,
  text: string,
  monoFont: PDFFont,
  width: number,
  height: number,
): void {
  const safe = text.replace(/[^\x00-\xFF]/g, '?')
  page.drawText(safe, {
    x: NOTES_MARGIN,
    y: height - HEADER_BASELINE_FROM_TOP,
    font: monoFont,
    size: 9,
    color: MUTED,
  })
  page.drawRectangle({
    x: NOTES_MARGIN,
    y: height - HEADER_BASELINE_FROM_TOP - HEADER_RULE_GAP,
    width: width - NOTES_MARGIN * 2,
    height: 0.5,
    color: RULE,
  })
}

function buildHeader(
  sessionName: string,
  slideIndex: number,
  totalPages: number,
): string {
  const slide = `${pad2(slideIndex + 1)} / ${pad2(totalPages)}`
  return sessionName
    ? `${sessionName} - Slide ${slide} - Notes`
    : `Slide ${slide} - Notes`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function triggerDownload(bytes: Uint8Array, filename: string): void {
  // Copy into a fresh Uint8Array<ArrayBuffer> so the Blob constructor's TS
  // typing accepts it (recent lib.dom rejects Uint8Array<ArrayBufferLike>).
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const blob = new Blob([copy], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Defer revoke so the click finalizes first.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
