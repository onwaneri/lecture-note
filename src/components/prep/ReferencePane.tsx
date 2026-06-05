import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrepDocRef } from '../../lib/db'
import { renderPageToCanvas } from '../../lib/pdf'
import type { UsePrepDocsResult } from '../../hooks/usePrepDocs'
import type { SurfaceRequest } from './PrepStudy'

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

  useEffect(
    () => () => {
      if (highlightTimer.current != null) window.clearTimeout(highlightTimer.current)
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
          »
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
            {Array.from({ length: numPages }, (_, i) => (
              <div
                key={i}
                ref={setTileRef(i)}
                data-index={i}
                className={`prep-ref-slide ${highlightIndex === i ? 'highlight' : ''}`}
                style={tileStyle}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
