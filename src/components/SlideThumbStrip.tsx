import { useEffect, useRef, useState } from 'react'
import { renderPageToCanvas, type PDFDocumentProxy } from '../lib/pdf'

interface SlideThumbStripProps {
  doc: PDFDocumentProxy
  numPages: number
  activeIndex: number
  onSelect: (index: number) => void
}

const THUMB_WIDTH_CSS = 86 // matches CSS .slide-thumb width

/**
 * Horizontal strip of all-slide thumbnails under the slide viewer.
 * Lazy: only renders thumbs as they scroll into view. Auto-scrolls to keep
 * the active thumb centered when the active slide changes (click on a
 * thumb, keyboard nav, etc.). Thumbs live in component memory only — no
 * IDB persistence — so reopening a deck regenerates them on demand.
 */
export function SlideThumbStrip({
  doc,
  numPages,
  activeIndex,
  onSelect,
}: SlideThumbStripProps) {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const thumbsRef = useRef(thumbs)
  const pendingRef = useRef<Set<number>>(new Set())
  const firstScrollRef = useRef(true)

  // Keep ref in sync so the IntersectionObserver callback can read the
  // latest `thumbs` map without needing to be re-created on each update.
  useEffect(() => {
    thumbsRef.current = thumbs
  }, [thumbs])

  // Reset cached thumbs when the document itself changes.
  useEffect(() => {
    setThumbs({})
    pendingRef.current = new Set()
    firstScrollRef.current = true
  }, [doc])

  // IntersectionObserver — render any thumb that enters the strip viewport
  // (plus a small lookahead margin) and isn't already cached or in flight.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const indexAttr = (entry.target as HTMLElement).dataset.slideIndex
          if (!indexAttr) continue
          const index = Number(indexAttr)
          if (Number.isNaN(index)) continue
          if (thumbsRef.current[index]) continue
          if (pendingRef.current.has(index)) continue
          pendingRef.current.add(index)
          renderThumb(doc, index)
            .then((url) => {
              if (url) {
                setThumbs((prev) =>
                  prev[index] ? prev : { ...prev, [index]: url },
                )
              }
            })
            .catch((e) => console.warn('thumb render failed', index, e))
            .finally(() => {
              pendingRef.current.delete(index)
            })
        }
      },
      { root: strip, rootMargin: '0px 240px 0px 240px' },
    )

    for (const el of tileRefs.current) {
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [doc, numPages])

  // Auto-scroll to keep the active thumb centered in the strip.
  useEffect(() => {
    const strip = stripRef.current
    const tile = tileRefs.current[activeIndex]
    if (!strip || !tile) return
    const desiredLeft =
      tile.offsetLeft - strip.clientWidth / 2 + tile.clientWidth / 2
    const clamped = Math.max(
      0,
      Math.min(desiredLeft, strip.scrollWidth - strip.clientWidth),
    )
    strip.scrollTo({
      left: clamped,
      behavior: firstScrollRef.current ? 'auto' : 'smooth',
    })
    firstScrollRef.current = false
  }, [activeIndex, numPages])

  return (
    <div
      className="slide-thumbstrip"
      ref={stripRef}
      role="tablist"
      aria-label="Slides"
    >
      {Array.from({ length: numPages }, (_, i) => (
        <button
          key={i}
          ref={(el) => {
            tileRefs.current[i] = el
          }}
          data-slide-index={i}
          type="button"
          role="tab"
          aria-selected={i === activeIndex}
          aria-label={`Slide ${i + 1}`}
          className={`slide-thumb ${i === activeIndex ? 'active' : ''}`}
          onClick={() => onSelect(i)}
        >
          {thumbs[i] ? <img src={thumbs[i]} alt="" /> : null}
        </button>
      ))}
    </div>
  )
}

async function renderThumb(
  doc: PDFDocumentProxy,
  index: number,
): Promise<string | null> {
  try {
    const page = await doc.getPage(index + 1)
    const baseViewport = page.getViewport({ scale: 1 })
    // Render at ~2x CSS width for crispness on retina; PNG dataURL stays small.
    const scale = (THUMB_WIDTH_CSS * 2) / baseViewport.width
    const { canvas } = await renderPageToCanvas(page, scale)
    return canvas.toDataURL('image/png')
  } catch (e) {
    console.warn('renderThumb failed', index, e)
    return null
  }
}
