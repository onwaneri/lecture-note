import { rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'

/**
 * Tiny markdown → PDF layout. Hand-rolled because we want to draw real text
 * (so AI tools can extract it) without pulling html2canvas / a heavier
 * markdown lib into the bundle. Supports: # / ## / ### headings, paragraphs,
 * bullet / ordered lists, blockquotes, fenced code blocks, horizontal rules,
 * and inline **bold** / *italic* / `code` / [text](url).
 *
 * Links render as styled coloured text; v1 does not emit clickable annotations.
 */

export interface LayoutFonts {
  body: PDFFont
  bold: PDFFont
  italic: PDFFont
  mono: PDFFont
}

export interface PageBox {
  page: PDFPage
  width: number
  height: number
  marginTop: number
  marginBottom: number
  marginLeft: number
  marginRight: number
}

export interface LayoutState {
  page: PageBox
  /** Baseline cursor — decreases as we go down the page. */
  y: number
  fonts: LayoutFonts
  /**
   * Caller-supplied callback to mint a fresh page (already with header
   * drawn, ready to receive body content). Must return the new page box.
   */
  addNewPage: () => PageBox
}

const INK = rgb(0.16, 0.16, 0.13)
const MUTED = rgb(0.42, 0.4, 0.38)
const INDIGO = rgb(0.155, 0.275, 0.7)
const CODE_BG = rgb(0.95, 0.945, 0.93)
const RULE = rgb(0.89, 0.87, 0.82)

const BODY_SIZE = 11
const H1_SIZE = 18
const H2_SIZE = 14
const H3_SIZE = 12
const CODE_SIZE = 10
const LINE_HEIGHT_MUL = 1.45

type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; items: string[] }
  | { type: 'ordered'; items: string[] }
  | { type: 'blockquote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'hr' }

interface InlineRun {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
  link?: string
}

interface VisualRun {
  text: string
  font: PDFFont
  size: number
  color: RGB
}

/** Public entry point — renders the whole markdown body into the layout. */
export function renderMarkdown(md: string, state: LayoutState): LayoutState {
  const trimmed = md.trim()
  if (!trimmed) {
    drawStubLine(state, 'No notes for this slide.')
    return state
  }

  const blocks = parseBlocks(md)
  for (const block of blocks) {
    state = renderBlock(block, state)
  }
  return state
}

function renderBlock(block: Block, state: LayoutState): LayoutState {
  switch (block.type) {
    case 'heading':
      return renderHeading(block, state)
    case 'paragraph':
      return renderParagraph(block.text, state)
    case 'bullet':
      return renderList(block.items, false, state)
    case 'ordered':
      return renderList(block.items, true, state)
    case 'blockquote':
      return renderBlockquote(block.text, state)
    case 'code':
      return renderCodeBlock(block.text, state)
    case 'hr':
      return renderHR(state)
  }
}

// ── Parsing ────────────────────────────────────────────────────────────────

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }

    // Fenced code
    if (/^```/.test(line)) {
      i++
      const buf: string[] = []
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // skip closing fence
      blocks.push({ type: 'code', text: buf.join('\n') })
      continue
    }

    // Heading
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length as 1 | 2 | 3,
        text: headingMatch[2].trim(),
      })
      i++
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'blockquote', text: buf.join('\n') })
      continue
    }

    // Bullet list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''))
        i++
      }
      blocks.push({ type: 'bullet', items })
      continue
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''))
        i++
      }
      blocks.push({ type: 'ordered', items })
      continue
    }

    // Paragraph — gobble continuation lines until blank or a block-starting prefix.
    const buf: string[] = [line]
    i++
    while (i < lines.length) {
      const next = lines[i]
      if (next.trim() === '') break
      if (/^(#{1,3}\s|>\s?|[-*]\s+|\d+\.\s+|```)/.test(next)) break
      if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(next)) break
      buf.push(next)
      i++
    }
    blocks.push({ type: 'paragraph', text: buf.join(' ') })
  }
  return blocks
}

function parseInline(text: string): InlineRun[] {
  // Order matters: scan for backtick code first (consumes any chars), then
  // **bold**, then *italic*/_italic_, then [text](url).
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/g
  const runs: InlineRun[] = []
  let last = 0
  for (const m of text.matchAll(pattern)) {
    const idx = m.index ?? 0
    if (idx > last) {
      runs.push(plainRun(text.slice(last, idx)))
    }
    const tok = m[0]
    if (tok.startsWith('`')) {
      runs.push({
        text: tok.slice(1, -1),
        bold: false,
        italic: false,
        code: true,
      })
    } else if (tok.startsWith('**')) {
      runs.push({
        text: tok.slice(2, -2),
        bold: true,
        italic: false,
        code: false,
      })
    } else if (tok.startsWith('*') || tok.startsWith('_')) {
      runs.push({
        text: tok.slice(1, -1),
        bold: false,
        italic: true,
        code: false,
      })
    } else if (tok.startsWith('[')) {
      const linkMatch = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(tok)
      if (linkMatch) {
        runs.push({
          text: linkMatch[1],
          bold: false,
          italic: false,
          code: false,
          link: linkMatch[2],
        })
      } else {
        runs.push(plainRun(tok))
      }
    }
    last = idx + tok.length
  }
  if (last < text.length) runs.push(plainRun(text.slice(last)))
  return runs.length > 0 ? runs : [plainRun(text)]
}

function plainRun(text: string): InlineRun {
  return { text, bold: false, italic: false, code: false }
}

// ── Layout primitives ──────────────────────────────────────────────────────

function chooseFont(run: InlineRun, fonts: LayoutFonts): PDFFont {
  if (run.code) return fonts.mono
  if (run.bold) return fonts.bold
  if (run.italic) return fonts.italic
  return fonts.body
}

function runColor(run: InlineRun): RGB {
  if (run.link) return INDIGO
  if (run.code) return INDIGO
  return INK
}

function wrapRuns(
  runs: InlineRun[],
  fonts: LayoutFonts,
  size: number,
  maxWidth: number,
): VisualRun[][] {
  const lines: VisualRun[][] = []
  let line: VisualRun[] = []
  let lineWidth = 0

  for (const run of runs) {
    const font = chooseFont(run, fonts)
    const runSize = run.code ? size * (CODE_SIZE / BODY_SIZE) : size
    const color = runColor(run)
    const words = run.text.split(/(\s+)/) // keep whitespace as separate tokens

    for (const word of words) {
      if (!word) continue
      const wWidth = safeWidth(font, word, runSize)
      const isWhitespace = /^\s+$/.test(word)
      if (lineWidth + wWidth > maxWidth && line.length > 0) {
        // Soft wrap at this word boundary.
        lines.push(line)
        line = []
        lineWidth = 0
        if (isWhitespace) continue // skip leading whitespace on new line
      }
      line.push({ text: word, font, size: runSize, color })
      lineWidth += wWidth
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}

/**
 * pdf-lib's standard fonts (WinAnsi-encoded) throw on characters outside the
 * encoding (em-dash, curly quotes, etc.). Substitute common offenders so the
 * export doesn't blow up on real-world notes.
 */
function sanitizeForStandardFont(text: string): string {
  return text
    .replace(/—/g, '--')
    .replace(/–/g, '-')
    .replace(/…/g, '...')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    // Anything else outside latin-1 → '?'. Better than throwing.
    .replace(/[^\x00-\xFF]/g, '?')
}

function safeWidth(font: PDFFont, text: string, size: number): number {
  try {
    return font.widthOfTextAtSize(sanitizeForStandardFont(text), size)
  } catch {
    return 0
  }
}

function drawLine(
  page: PDFPage,
  line: VisualRun[],
  x: number,
  y: number,
): void {
  let cx = x
  for (const run of line) {
    const safeText = sanitizeForStandardFont(run.text)
    if (safeText.length > 0) {
      page.drawText(safeText, {
        x: cx,
        y,
        font: run.font,
        size: run.size,
        color: run.color,
      })
    }
    cx += safeWidth(run.font, safeText, run.size)
  }
}

function lineHeightFor(size: number): number {
  return size * LINE_HEIGHT_MUL
}

function ensureRoom(state: LayoutState, needed: number): LayoutState {
  if (state.y - needed < state.page.marginBottom) {
    state.page = state.addNewPage()
    state.y = state.page.height - state.page.marginTop
  }
  return state
}

function advance(state: LayoutState, dy: number): LayoutState {
  state.y -= dy
  return state
}

// ── Block renderers ───────────────────────────────────────────────────────

function drawStubLine(state: LayoutState, text: string): void {
  const size = BODY_SIZE
  const lh = lineHeightFor(size)
  ensureRoom(state, lh)
  state.page.page.drawText(sanitizeForStandardFont(text), {
    x: state.page.marginLeft,
    y: state.y - size,
    font: state.fonts.italic,
    size,
    color: MUTED,
  })
  advance(state, lh)
}

function renderHeading(
  block: { level: 1 | 2 | 3; text: string },
  state: LayoutState,
): LayoutState {
  const size = block.level === 1 ? H1_SIZE : block.level === 2 ? H2_SIZE : H3_SIZE
  const lh = lineHeightFor(size)
  // Small leading gap above headings (except at top of page).
  if (state.y < state.page.height - state.page.marginTop - 1) {
    advance(state, lh * 0.35)
  }
  const maxW =
    state.page.width - state.page.marginLeft - state.page.marginRight
  const runs = parseInline(block.text).map((r) => ({
    ...r,
    bold: true, // headings are always bold regardless of inline markers
  }))
  const lines = wrapRuns(runs, state.fonts, size, maxW)
  for (const line of lines) {
    ensureRoom(state, lh)
    drawLine(state.page.page, line, state.page.marginLeft, state.y - size)
    advance(state, lh)
  }
  // Trailing gap below heading.
  advance(state, lh * 0.25)
  return state
}

function renderParagraph(text: string, state: LayoutState): LayoutState {
  const size = BODY_SIZE
  const lh = lineHeightFor(size)
  const maxW =
    state.page.width - state.page.marginLeft - state.page.marginRight
  const runs = parseInline(text)
  const lines = wrapRuns(runs, state.fonts, size, maxW)
  for (const line of lines) {
    ensureRoom(state, lh)
    drawLine(state.page.page, line, state.page.marginLeft, state.y - size)
    advance(state, lh)
  }
  advance(state, lh * 0.4) // paragraph spacing
  return state
}

function renderList(
  items: string[],
  ordered: boolean,
  state: LayoutState,
): LayoutState {
  const size = BODY_SIZE
  const lh = lineHeightFor(size)
  const bulletIndent = 18
  const maxW =
    state.page.width - state.page.marginLeft - state.page.marginRight - bulletIndent

  items.forEach((raw, idx) => {
    const marker = ordered ? `${idx + 1}.` : '•'
    const runs = parseInline(raw)
    const lines = wrapRuns(runs, state.fonts, size, maxW)
    lines.forEach((line, lineIdx) => {
      ensureRoom(state, lh)
      if (lineIdx === 0) {
        state.page.page.drawText(sanitizeForStandardFont(marker), {
          x: state.page.marginLeft,
          y: state.y - size,
          font: state.fonts.body,
          size,
          color: INK,
        })
      }
      drawLine(
        state.page.page,
        line,
        state.page.marginLeft + bulletIndent,
        state.y - size,
      )
      advance(state, lh)
    })
  })
  advance(state, lh * 0.3)
  return state
}

function renderBlockquote(text: string, state: LayoutState): LayoutState {
  const size = BODY_SIZE
  const lh = lineHeightFor(size)
  const indent = 14
  const ruleX = state.page.marginLeft + 2
  const maxW =
    state.page.width - state.page.marginLeft - state.page.marginRight - indent
  const paragraphs = text.split(/\n\n+/)

  const blockStartY = state.y
  for (const para of paragraphs) {
    const runs = parseInline(para.replace(/\n/g, ' '))
    const lines = wrapRuns(runs, state.fonts, size, maxW)
    for (const line of lines) {
      ensureRoom(state, lh)
      drawLine(
        state.page.page,
        line.map((r) => ({ ...r, color: MUTED })),
        state.page.marginLeft + indent,
        state.y - size,
      )
      advance(state, lh)
    }
    advance(state, lh * 0.3)
  }
  // Draw the left rule retroactively across the same vertical span. If a
  // page break happened mid-blockquote this only covers the final page;
  // good enough for v1.
  state.page.page.drawRectangle({
    x: ruleX,
    y: state.y + lh * 0.3,
    width: 1.5,
    height: blockStartY - state.y - lh * 0.3,
    color: INDIGO,
  })
  return state
}

function renderCodeBlock(text: string, state: LayoutState): LayoutState {
  const size = CODE_SIZE
  const lh = lineHeightFor(size)
  const padX = 8
  const padY = 8
  const lines = text.split('\n')
  // For each line: ensure room, draw a background swatch behind the line +
  // the mono text. Doing it per-line keeps page-break handling trivial.
  for (let i = 0; i < lines.length; i++) {
    ensureRoom(state, lh)
    const isFirst = i === 0
    const isLast = i === lines.length - 1
    const bgY = state.y - size - (isLast ? padY * 0.4 : 0)
    const bgHeight = lh + (isFirst ? padY * 0.4 : 0) + (isLast ? padY * 0.4 : 0)
    state.page.page.drawRectangle({
      x: state.page.marginLeft,
      y: bgY,
      width:
        state.page.width - state.page.marginLeft - state.page.marginRight,
      height: bgHeight,
      color: CODE_BG,
    })
    const safe = sanitizeForStandardFont(lines[i])
    state.page.page.drawText(safe, {
      x: state.page.marginLeft + padX,
      y: state.y - size,
      font: state.fonts.mono,
      size,
      color: INK,
    })
    advance(state, lh)
  }
  advance(state, lh * 0.5)
  return state
}

function renderHR(state: LayoutState): LayoutState {
  ensureRoom(state, 12)
  advance(state, 4)
  state.page.page.drawRectangle({
    x: state.page.marginLeft,
    y: state.y - 1,
    width:
      state.page.width - state.page.marginLeft - state.page.marginRight,
    height: 1,
    color: RULE,
  })
  advance(state, 12)
  return state
}
