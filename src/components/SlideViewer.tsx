import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from '../lib/pdf'
import { renderPageToCanvas } from '../lib/pdf'
import { SlideThumbStrip } from './SlideThumbStrip'

interface SlideViewerProps {
  doc: PDFDocumentProxy
  numPages: number
  activeIndex: number
  onActiveChange: (index: number) => void
}

const WHEEL_COOLDOWN_MS = 360
const WHEEL_THRESHOLD = 24
const RESIZE_DEBOUNCE_MS = 140
const STAGE_PADDING = 28 // matches .slide-viewer-stage CSS padding
const FRAME_BORDER_PADDING = 5 // 1px border + 4px padding per side

export function SlideViewer({
  doc,
  numPages,
  activeIndex,
  onActiveChange,
}: SlideViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const canvasHostRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef(activeIndex)
  const numPagesRef = useRef(numPages)
  const lastNavAtRef = useRef(0)
  const wheelAccumRef = useRef(0)
  const onActiveChangeRef = useRef(onActiveChange)

  const pageRef = useRef<PDFPageProxy | null>(null)
  const aspectRef = useRef<number | null>(null)
  const renderTokenRef = useRef(0)
  const lastRenderedWidthRef = useRef(0)
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(
    null,
  )
  // User-resizable thumbnail height (px). Drag the divider above the strip.
  const [thumbHeight, setThumbHeight] = useState(56)

  function startThumbResize(e: ReactPointerEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startH = thumbHeight
    function onMove(ev: PointerEvent) {
      // Dragging up makes the thumbnails taller.
      const next = Math.max(40, Math.min(startH + (startY - ev.clientY), 220))
      setThumbHeight(next)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  useEffect(() => {
    activeRef.current = activeIndex
  }, [activeIndex])

  useEffect(() => {
    numPagesRef.current = numPages
  }, [numPages])

  useEffect(() => {
    onActiveChangeRef.current = onActiveChange
  }, [onActiveChange])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return

    function tryNavigate(direction: 1 | -1): boolean {
      const now = Date.now()
      if (now - lastNavAtRef.current < WHEEL_COOLDOWN_MS) return false
      const current = activeRef.current
      const total = numPagesRef.current
      const next = current + direction
      if (next < 0 || next >= total) return false
      lastNavAtRef.current = now
      wheelAccumRef.current = 0
      onActiveChangeRef.current(next)
      return true
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const now = Date.now()
      if (now - lastNavAtRef.current < WHEEL_COOLDOWN_MS) return
      wheelAccumRef.current += e.deltaY
      if (Math.abs(wheelAccumRef.current) < WHEEL_THRESHOLD) return
      tryNavigate(wheelAccumRef.current > 0 ? 1 : -1)
    }

    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target) {
        if (
          target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT'
        ) {
          return
        }
      }
      switch (e.key) {
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'j':
          if (tryNavigate(1)) e.preventDefault()
          break
        case 'ArrowUp':
        case 'PageUp':
        case 'k':
          if (tryNavigate(-1)) e.preventDefault()
          break
        case 'Home':
          lastNavAtRef.current = Date.now()
          onActiveChangeRef.current(0)
          e.preventDefault()
          break
        case 'End':
          lastNavAtRef.current = Date.now()
          onActiveChangeRef.current(numPagesRef.current - 1)
          e.preventDefault()
          break
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  function computeFrameSize(): { w: number; h: number } | null {
    const aspect = aspectRef.current
    const stage = stageRef.current
    if (!aspect || !stage) return null
    const availW = stage.clientWidth - STAGE_PADDING * 2
    const availH = stage.clientHeight - STAGE_PADDING * 2
    if (availW <= 0 || availH <= 0) return null
    let w = availW
    let h = w / aspect
    if (h > availH) {
      h = availH
      w = h * aspect
    }
    return { w: Math.floor(w), h: Math.floor(h) }
  }

  async function renderAtCurrentSize() {
    const page = pageRef.current
    const host = canvasHostRef.current
    const frame = frameRef.current
    if (!page || !host || !frame) return

    const innerWidth = frame.clientWidth - FRAME_BORDER_PADDING * 2
    if (innerWidth <= 0) return
    if (Math.abs(innerWidth - lastRenderedWidthRef.current) < 1) return

    const baseViewport = page.getViewport({ scale: 1 })
    const scale = Math.max(0.2, innerWidth / baseViewport.width)
    const token = ++renderTokenRef.current

    const { canvas } = await renderPageToCanvas(page, scale)
    if (token !== renderTokenRef.current) return

    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    host.innerHTML = ''
    host.appendChild(canvas)
    lastRenderedWidthRef.current = innerWidth
  }

  // Load page on slide change, set aspect, fit frame, render.
  useEffect(() => {
    let cancelled = false
    pageRef.current = null
    lastRenderedWidthRef.current = 0
    ;(async () => {
      const page = await doc.getPage(activeIndex + 1)
      if (cancelled) return
      pageRef.current = page
      const baseViewport = page.getViewport({ scale: 1 })
      aspectRef.current = baseViewport.width / baseViewport.height
      setFrameSize(computeFrameSize())
      // Defer render to next frame so frameSize layout takes effect.
      requestAnimationFrame(() => {
        if (!cancelled) {
          renderAtCurrentSize().catch((e) =>
            console.error('slide render failed', e),
          )
        }
      })
    })().catch((e) => console.error('slide load failed', e))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, activeIndex])

  // Recompute frame size + re-rasterize on stage resize.
  // Watching the stage (not the outer viewer) means the strip's height
  // is already excluded from the available area — adding/removing it
  // triggers a stage resize that this observer picks up.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let timer: number | null = null
    const ro = new ResizeObserver(() => {
      setFrameSize(computeFrameSize())
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        renderAtCurrentSize().catch((e) =>
          console.error('slide resize render failed', e),
        )
      }, RESIZE_DEBOUNCE_MS)
    })
    ro.observe(stage)
    return () => {
      if (timer != null) window.clearTimeout(timer)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const frameStyle = frameSize
    ? { width: `${frameSize.w}px`, height: `${frameSize.h}px` }
    : { visibility: 'hidden' as const }

  return (
    <div
      className="slide-viewer"
      ref={containerRef}
      style={{ '--thumb-h': `${thumbHeight}px` } as CSSProperties}
    >
      <div className="slide-viewer-stage" ref={stageRef}>
        <div className="slide-frame" ref={frameRef} style={frameStyle}>
          <div className="slide-canvas-host" ref={canvasHostRef} />
        </div>
      </div>
      {numPages > 1 ? (
        <>
          <div
            className="thumb-divider"
            onPointerDown={startThumbResize}
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize thumbnails"
          />
          <SlideThumbStrip
            doc={doc}
            numPages={numPages}
            activeIndex={activeIndex}
            onSelect={onActiveChange}
          />
        </>
      ) : null}
    </div>
  )
}
