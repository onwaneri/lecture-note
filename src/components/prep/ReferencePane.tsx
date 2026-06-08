import { useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import {
  getAllChatsForFile,
  getAllNotesForFile,
  setNote,
  type ChatTurnRecord,
  type PrepDocRef,
} from '../../lib/db'
import { renderPageToCanvas } from '../../lib/pdf'
import type { UsePrepDocsResult } from '../../hooks/usePrepDocs'
import type { SurfaceRequest } from './PrepStudy'

marked.setOptions({ breaks: true, gfm: true })
function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string
}

interface ReferencePaneProps {
  documents: PrepDocRef[]
  prepDocs: UsePrepDocsResult
  surface: SurfaceRequest | null
  onCollapse: () => void
}

// Pre-render tiles this far outside the viewport so scrolling stays smooth —
// mirrors SlideThumbStrip's IntersectionObserver pre-loading.
const PRELOAD_MARGIN = '600px 0px 600px 0px'
const RESIZE_DEBOUNCE_MS = 160
const HIGHLIGHT_MS = 1800

export function ReferencePane({
  documents,
  prepDocs,
  surface,
  onCollapse,
}: ReferencePaneProps) {
  const [activeFilename, setActiveFilename] = useState<string>(
    documents[0]?.filename ?? '',
  )
  const [numPages, setNumPages] = useState(0)
  const [aspect, setAspect] = useState<number | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [stageWidth, setStageWidth] = useState(0)
  const [nudge, setNudge] = useState<SurfaceRequest | null>(null)
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null)

  // Personal lecture-mode notes + Ask Doug chat for the active document, keyed
  // by slide index. Empty for prep-only uploads (no matching lecture record).
  const [notes, setNotes] = useState<Map<number, string>>(new Map())
  const [chats, setChats] = useState<Map<number, ChatTurnRecord[]>>(new Map())
  const [notesReady, setNotesReady] = useState(false)
  const [peekIndex, setPeekIndex] = useState<number | null>(null)
  // Editing the peeked note writes straight back to the lecture note store.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const saveTimer = useRef<number | null>(null)
  // Desired auto-peek from a surface request; opened only once notes for the
  // matching file have loaded AND that slide actually has content.
  const autoPeek = useRef<{ index: number; file: string } | null>(null)
  const [autoPeekNonce, setAutoPeekNonce] = useState(0)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const tileEls = useRef<Map<number, HTMLDivElement>>(new Map())
  const canvasCache = useRef<Map<string, HTMLCanvasElement>>(new Map())
  const visible = useRef<Set<number>>(new Set())
  const activeRef = useRef(activeFilename)
  activeRef.current = activeFilename
  const hasShownRef = useRef(false)
  const lastNonceRef = useRef(0)
  const pendingScroll = useRef<number | null>(null)
  const highlightTimer = useRef<number | null>(null)

  // Load doc metadata (page count + aspect) when the file changes.
  useEffect(() => {
    let cancelled = false
    if (!activeFilename) return
    setNumPages(0)
    setAspect(null)
    visible.current.clear()
    ;(async () => {
      const doc = await prepDocs.ensureDoc(activeFilename)
      if (cancelled || !doc) return
      const page = await doc.getPage(1)
      const vp = page.getViewport({ scale: 1 })
      if (cancelled) return
      setAspect(vp.width / vp.height)
      setNumPages(doc.numPages)
    })().catch((e) => console.error('reference meta load failed', e))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilename])

  // Load this document's personal notes + chat history. Resets the open peek so
  // it never carries a stale slide across a file switch.
  useEffect(() => {
    let cancelled = false
    setPeekIndex(null)
    setNotes(new Map())
    setChats(new Map())
    setNotesReady(false)
    if (!activeFilename) return
    Promise.all([
      getAllNotesForFile(activeFilename),
      getAllChatsForFile(activeFilename),
    ])
      .then(([n, c]) => {
        if (cancelled) return
        setNotes(n)
        setChats(c)
        setNotesReady(true)
      })
      .catch((e) => console.error('reference notes load failed', e))
    return () => {
      cancelled = true
    }
  }, [activeFilename])

  // Track the stage width (debounced) so tiles re-rasterise crisply on resize —
  // consistent with SlideViewer's resize handling.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    let t: number | null = null
    const ro = new ResizeObserver(() => {
      if (t != null) window.clearTimeout(t)
      t = window.setTimeout(() => setStageWidth(el.clientWidth), RESIZE_DEBOUNCE_MS)
    })
    ro.observe(el)
    setStageWidth(el.clientWidth)
    return () => {
      if (t != null) window.clearTimeout(t)
      ro.disconnect()
    }
  }, [])

  const renderTile = useCallback(async (index: number) => {
    const host = tileEls.current.get(index)
    const width = stageRef.current?.clientWidth ?? 0
    if (!host || width <= 0) return
    const filename = activeRef.current
    const key = `${filename}::${index}`
    const cached = canvasCache.current.get(key)
    if (cached) {
      if (host.firstChild !== cached) {
        host.innerHTML = ''
        host.appendChild(cached)
      }
      return
    }
    const doc = prepDocs.getDoc(filename) ?? (await prepDocs.ensureDoc(filename))
    if (!doc || activeRef.current !== filename) return
    const page = await doc.getPage(index + 1)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.max(0.2, (width - 24) / base.width)
    const { canvas } = await renderPageToCanvas(page, scale)
    if (activeRef.current !== filename) return
    canvas.style.width = '100%'
    canvas.style.height = 'auto'
    canvas.style.display = 'block'
    canvasCache.current.set(key, canvas)
    host.innerHTML = ''
    host.appendChild(canvas)
  }, [prepDocs])

  // (Re)build the IntersectionObserver whenever the file, page count, or width
  // changes. A width change invalidates the cache so tiles redraw at the new
  // resolution.
  useEffect(() => {
    if (!activeFilename || numPages === 0 || stageWidth <= 0) return
    // Invalidate rasterised canvases for the new width/file.
    canvasCache.current.clear()
    for (const host of tileEls.current.values()) host.innerHTML = ''

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.index)
          if (e.isIntersecting) {
            visible.current.add(idx)
            void renderTile(idx)
          } else {
            visible.current.delete(idx)
          }
        }
        if (visible.current.size > 0) {
          setCurrentIndex(Math.min(...visible.current))
        }
      },
      { root: stageRef.current, rootMargin: PRELOAD_MARGIN, threshold: 0.01 },
    )
    for (const host of tileEls.current.values()) obs.observe(host)

    // If a surface jump arrived while switching files, honour it now.
    if (pendingScroll.current != null) {
      const idx = pendingScroll.current
      pendingScroll.current = null
      requestAnimationFrame(() => scrollToIndex(idx))
    }
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilename, numPages, stageWidth, renderTile])

  const scrollToIndex = useCallback((index: number) => {
    const host = tileEls.current.get(index)
    if (!host) return
    host.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setHighlightIndex(index)
    if (highlightTimer.current != null) window.clearTimeout(highlightTimer.current)
    highlightTimer.current = window.setTimeout(
      () => setHighlightIndex(null),
      HIGHLIGHT_MS,
    )
  }, [])

  const applySurface = useCallback(
    (req: SurfaceRequest) => {
      hasShownRef.current = true
      setNudge(null)
      // Register an auto-peek; the effect below opens it once that file's notes
      // are loaded and only if the slide actually has notes/chat.
      autoPeek.current = { index: req.slide.slideIndex, file: req.slide.filename }
      setAutoPeekNonce((n) => n + 1)
      if (req.slide.filename !== activeRef.current) {
        // Switch files first; the observer effect scrolls once it remounts.
        pendingScroll.current = req.slide.slideIndex
        setActiveFilename(req.slide.filename)
      } else {
        scrollToIndex(req.slide.slideIndex)
      }
    },
    [scrollToIndex],
  )

  // Open an auto-peek (from a surface request) once the target file's notes have
  // loaded — but only if that slide has notes or chat, so empty suggestions
  // don't pop the editor. Manual badge clicks bypass this entirely.
  useEffect(() => {
    if (!notesReady) return
    const t = autoPeek.current
    if (!t || t.file !== activeFilename) return
    autoPeek.current = null
    if (notes.get(t.index)?.trim() || chats.get(t.index)?.length) {
      setPeekIndex(t.index)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesReady, autoPeekNonce, notes, chats, activeFilename])

  // Persist a note edit back to the lecture store and reflect it locally so the
  // badge appears/disappears immediately. setNote deletes empties on its own.
  const commitNote = useCallback((index: number, value: string) => {
    const file = activeRef.current
    if (!file) return
    void setNote(file, index, value).catch((e) =>
      console.error('note save failed', e),
    )
    setNotes((prev) => {
      const next = new Map(prev)
      if (value.trim()) next.set(index, value)
      else next.delete(index)
      return next
    })
  }, [])

  // Initialise the draft when a different slide is peeked. Empty slides open
  // straight into edit mode (so you can start typing); annotated ones open as a
  // rendered read view. Not keyed on `notes` so saves don't reset the editor.
  useEffect(() => {
    if (peekIndex == null) {
      setEditing(false)
      return
    }
    const existing = notes.get(peekIndex) ?? ''
    setDraft(existing)
    setEditing(!existing.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peekIndex])

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value)
      const idx = peekIndex
      if (idx == null) return
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current)
      // Debounced autosave; the captured idx keeps a late save bound to the
      // right slide even if the user switches in the meantime.
      saveTimer.current = window.setTimeout(() => commitNote(idx, value), 600)
    },
    [peekIndex, commitNote],
  )

  const flushAndClose = useCallback(() => {
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    if (peekIndex != null && editing) commitNote(peekIndex, draft)
    setPeekIndex(null)
  }, [peekIndex, editing, draft, commitNote])

  // Open a slide's note sheet, flushing any pending edit on the previously-open one.
  const openPeek = useCallback(
    (index: number) => {
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      if (peekIndex != null && peekIndex !== index && editing) {
        commitNote(peekIndex, draft)
      }
      setPeekIndex(index)
    },
    [peekIndex, editing, draft, commitNote],
  )

  // React to a surface request. User-initiated clicks (force=true) always
  // navigate directly. AI-suggested slides use a nudge banner if the target
  // is far from the current viewport so we don't yank the user away.
  useEffect(() => {
    if (!surface || surface.nonce === lastNonceRef.current) return
    lastNonceRef.current = surface.nonce
    if (surface.force) {
      applySurface(surface)
      return
    }
    const near =
      surface.slide.filename === activeRef.current &&
      Math.abs(surface.slide.slideIndex - currentIndex) <= 1
    if (!hasShownRef.current || near) applySurface(surface)
    else setNudge(surface)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface])

  // Mirror live edit state so the unmount cleanup can flush without stale closure.
  const liveRef = useRef({ peekIndex, editing, draft })
  liveRef.current = { peekIndex, editing, draft }

  useEffect(
    () => () => {
      if (highlightTimer.current != null) window.clearTimeout(highlightTimer.current)
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current)
      // Best-effort flush of an open edit (e.g. pane collapsed mid-typing).
      const { peekIndex: pi, editing: ed, draft: d } = liveRef.current
      if (pi != null && ed && activeRef.current) {
        void setNote(activeRef.current, pi, d).catch(() => {})
      }
    },
    [],
  )

  const setTileRef = (index: number) => (el: HTMLDivElement | null) => {
    if (el) tileEls.current.set(index, el)
    else tileEls.current.delete(index)
  }

  const hasDocs = documents.length > 0
  const tileStyle = { aspectRatio: aspect ? `${aspect}` : '4 / 3' }

  return (
    <aside className="prep-ref">
      <div className="prep-ref-head">
        <div className="prep-eyebrow">Reference</div>
        <select
          className="prep-ref-select"
          value={activeFilename}
          onChange={(e) => setActiveFilename(e.target.value)}
          disabled={!hasDocs}
        >
          {documents.map((d) => (
            <option key={d.filename} value={d.filename}>
              {d.displayName} ({d.role})
            </option>
          ))}
        </select>
        {numPages > 0 ? (
          <span className="prep-ref-counter">
            {currentIndex + 1} / {numPages}
          </span>
        ) : null}
        <button
          type="button"
          className="prep-ref-collapse"
          onClick={onCollapse}
          title="Hide reference"
        >
          « Hide
        </button>
      </div>

      {nudge ? (
        <div className="prep-ref-nudge">
          <span>
            Relevant to <strong>{nudge.topicTitle}</strong> — slide{' '}
            {nudge.slide.slideIndex + 1} of{' '}
            {documents.find((d) => d.filename === nudge.slide.filename)
              ?.displayName ?? 'a source'}
          </span>
          <div className="prep-ref-nudge-actions">
            <button
              type="button"
              className="ate-btn ate-btn-primary"
              onClick={() => applySurface(nudge)}
            >
              Jump there
            </button>
            <button
              type="button"
              className="prep-ref-nudge-dismiss"
              onClick={() => setNudge(null)}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      <div className="prep-ref-stage" ref={stageRef}>
        {!hasDocs ? (
          <div className="prep-ref-empty">No source documents.</div>
        ) : numPages === 0 ? (
          <div className="prep-ref-empty">
            <span className="prep-spinner small" aria-hidden="true" />
            Loading slides…
          </div>
        ) : (
          <div className="prep-ref-list">
            {Array.from({ length: numPages }, (_, i) => {
              const note = notes.get(i)
              const chat = chats.get(i)
              const hasNote = Boolean(note && note.trim())
              const hasChat = Boolean(chat && chat.length)
              const hasContent = hasNote || hasChat
              return (
                <div
                  key={i}
                  className={`prep-ref-slide ${highlightIndex === i ? 'highlight' : ''}`}
                  style={tileStyle}
                >
                  <div
                    ref={setTileRef(i)}
                    data-index={i}
                    className="prep-ref-canvas"
                  />
                  <button
                    type="button"
                    className={`prep-ref-note-badge ${hasContent ? '' : 'add'} ${peekIndex === i ? 'active' : ''}`}
                    title={hasContent ? 'Your notes for this slide' : 'Add a note'}
                    onClick={() => (peekIndex === i ? flushAndClose() : openPeek(i))}
                  >
                    <span aria-hidden="true">{hasContent ? '✎' : '+'}</span>
                    {hasChat ? <span className="prep-ref-note-dot" /> : null}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {peekIndex != null ? (
        <div className="prep-ref-note">
          <div className="prep-ref-note-head">
            <span>Your notes · slide {peekIndex + 1}</span>
            <div className="prep-ref-note-actions">
              <button
                type="button"
                className={`prep-ref-note-edit-toggle ${editing ? 'active' : ''}`}
                onClick={() => {
                  if (editing) {
                    if (saveTimer.current != null) {
                      window.clearTimeout(saveTimer.current)
                      saveTimer.current = null
                    }
                    commitNote(peekIndex, draft)
                    setEditing(false)
                  } else {
                    setEditing(true)
                  }
                }}
                title={editing ? 'Done editing' : 'Edit note'}
              >
                {editing ? 'Done' : 'Edit'}
              </button>
              <button
                type="button"
                className="prep-ref-note-close"
                onClick={flushAndClose}
                title="Close"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="prep-ref-note-body">
            {editing ? (
              <textarea
                key={peekIndex}
                className="prep-ref-note-edit"
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                placeholder="Write a note for this slide… (saved to your lecture notes)"
                autoFocus
              />
            ) : notes.get(peekIndex)?.trim() ? (
              <div
                className="prep-ref-note-md"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(notes.get(peekIndex) as string),
                }}
              />
            ) : (
              <div className="prep-ref-note-placeholder">
                No notes yet — hit <strong>Edit</strong> to add one.
              </div>
            )}
            {chats.get(peekIndex)?.length ? (
              <div className="prep-ref-chat">
                <div className="prep-ref-chat-label">Ask Doug history</div>
                {(chats.get(peekIndex) as ChatTurnRecord[]).map((t, j) => (
                  <div key={j} className={`prep-ref-chat-turn ${t.role}`}>
                    <div
                      className="prep-ref-chat-md"
                      dangerouslySetInnerHTML={{
                        __html: renderMarkdown(t.content),
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </aside>
  )
}
