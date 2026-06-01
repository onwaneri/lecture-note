import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import { askClaude, hasApiKey, type ChatTurn } from '../lib/askClaude'
import { getPageText, type PDFDocumentProxy } from '../lib/pdf'

marked.setOptions({ breaks: true, gfm: true })

function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string
}

interface AskClaudeProps {
  doc: PDFDocumentProxy | null
  slideIndex: number
  totalSlides: number
  sessionName: string
  notes: string
  /** Persisted conversation for the current slide (role + content only). */
  conversation: ChatTurn[]
  /** Persist the conversation for the current slide. */
  onConversationChange: (turns: ChatTurn[]) => void
  /** 'inline' docks at the bottom of the notes panel; 'floating' pops out. */
  variant: 'inline' | 'floating'
}

interface Turn extends ChatTurn {
  /** True while this assistant turn is still streaming. */
  pending?: boolean
}

interface Size {
  width?: number
  height?: number
}

export function AskClaude({
  doc,
  slideIndex,
  totalSlides,
  sessionName,
  notes,
  conversation,
  onConversationChange,
  variant,
}: AskClaudeProps) {
  const keyed = hasApiKey()
  const [open, setOpen] = useState(variant === 'inline')
  const [input, setInput] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState<Size>({})

  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)

  // Refs keep the latest persisted conversation + persist callback without
  // forcing the load/persist effects to re-run (which would loop or clobber).
  const conversationRef = useRef(conversation)
  conversationRef.current = conversation
  const onConversationChangeRef = useRef(onConversationChange)
  onConversationChangeRef.current = onConversationChange

  // Load the persisted conversation when the slide changes — context shifts
  // per slide, and returning to a slide should restore where we left off.
  useEffect(() => {
    abortRef.current?.abort()
    setTurns(conversationRef.current.map((t) => ({ ...t })))
    setError(null)
    setBusy(false)
  }, [slideIndex])

  // Persist completed conversations. Skip while a turn is still streaming so
  // we don't save half-written answers; the final state flushes once done.
  useEffect(() => {
    if (turns.some((t) => t.pending)) return
    onConversationChangeRef.current(
      turns.map(({ role, content }) => ({ role, content })),
    )
  }, [turns])

  // Stop any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Keep the transcript scrolled to the latest text.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  // Drag-to-resize. Both windows grow away from their anchor: the floating
  // window is pinned bottom-right so its top-left handle grows up/left; the
  // inline window sits at the bottom of the notes panel so its top edge grows
  // upward.
  function startResize(e: React.PointerEvent) {
    e.preventDefault()
    const el = panelRef.current
    if (!el) return
    const startX = e.clientX
    const startY = e.clientY
    const startW = el.offsetWidth
    const startH = el.offsetHeight

    function onMove(ev: PointerEvent) {
      if (variant === 'floating') {
        const nextW = clamp(startW + (startX - ev.clientX), 280, window.innerWidth - 44)
        const nextH = clamp(startH + (startY - ev.clientY), 220, window.innerHeight - 44)
        setSize({ width: nextW, height: nextH })
      } else {
        const nextH = clamp(startH + (startY - ev.clientY), 120, window.innerHeight * 0.8)
        setSize({ height: nextH })
      }
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  async function submit() {
    const question = input.trim()
    if (!question || busy) return
    setInput('')
    setError(null)

    const history: ChatTurn[] = turns.map(({ role, content }) => ({ role, content }))
    setTurns((prev) => [
      ...prev,
      { role: 'user', content: question },
      { role: 'assistant', content: '', pending: true },
    ])
    setBusy(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const slideText = doc ? await getPageText(doc, slideIndex) : ''
      await askClaude({
        question,
        history,
        context: {
          sessionName,
          slideNumber: slideIndex + 1,
          totalSlides,
          slideText,
          notes,
        },
        signal: controller.signal,
        onText: (delta) => {
          setTurns((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, content: last.content + delta }
            }
            return next
          })
        },
      })
      setTurns((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant') {
          next[next.length - 1] = { ...last, pending: false }
        }
        return next
      })
    } catch (e) {
      if (controller.signal.aborted) {
        // User changed slide or unmounted — drop the dangling turn quietly.
        return
      }
      const message = e instanceof Error ? e.message : 'Request failed.'
      setError(message)
      setTurns((prev) => prev.filter((t) => !(t.role === 'assistant' && t.pending)))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setBusy(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const showHeaderToggle = variant === 'floating'

  // Apply resized dimensions. The inline window only controls its height; the
  // floating window controls both (and only while open).
  const style: React.CSSProperties =
    variant === 'inline'
      ? { height: size.height }
      : { width: size.width, height: open ? size.height : undefined }

  return (
    <section
      ref={panelRef}
      className={`ask-claude ask-claude-${variant} ${open ? 'open' : 'closed'}`}
      style={style}
    >
      {open ? (
        <div
          className={`ask-resize ask-resize-${variant === 'floating' ? 'corner' : 'top'}`}
          onPointerDown={startResize}
          title="Drag to resize"
        />
      ) : null}

      <header
        className="ask-head"
        onClick={showHeaderToggle ? () => setOpen((o) => !o) : undefined}
        role={showHeaderToggle ? 'button' : undefined}
      >
        <span className="ask-title">
          <span className="ask-dot" aria-hidden="true" />
          Ask Claude
        </span>
        {showHeaderToggle ? (
          <span className="ask-chevron" aria-hidden="true">
            {open ? '▾' : '▴'}
          </span>
        ) : null}
      </header>

      {open ? (
        <div className="ask-body">
          {!keyed ? (
            <div className="ask-empty">
              Add <code>VITE_ANTHROPIC_API_KEY</code> to <code>.env.local</code> and
              restart the dev server to ask questions about this slide.
            </div>
          ) : (
            <>
              {turns.length > 0 ? (
                <div className="ask-log" ref={logRef}>
                  {turns.map((t, i) => (
                    <div key={i} className={`ask-turn ask-turn-${t.role}`}>
                      <div className="ask-turn-role">
                        {t.role === 'user' ? 'You' : 'Claude'}
                      </div>
                      <div className="ask-turn-content">
                        {t.role === 'assistant' ? (
                          t.content ? (
                            <div
                              className="ask-md"
                              dangerouslySetInnerHTML={{ __html: renderMarkdown(t.content) }}
                            />
                          ) : t.pending ? (
                            <span className="ask-cursor">▍</span>
                          ) : null
                        ) : (
                          t.content
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ask-hint">
                  Ask about this slide — explain a concept, quiz me, or expand my notes.
                </div>
              )}

              {error ? <div className="ask-error">{error}</div> : null}

              <div className="ask-input-row">
                <textarea
                  className="ask-input"
                  placeholder="Ask about this slide…"
                  value={input}
                  rows={1}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="ask-send ate-btn ate-btn-primary"
                  onClick={() => void submit()}
                  disabled={busy || !input.trim()}
                >
                  {busy ? '…' : 'Ask'}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
