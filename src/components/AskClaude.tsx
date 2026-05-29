import { useEffect, useRef, useState } from 'react'
import { askClaude, hasApiKey, type ChatTurn } from '../lib/askClaude'
import { getPageText, type PDFDocumentProxy } from '../lib/pdf'

interface AskClaudeProps {
  doc: PDFDocumentProxy | null
  slideIndex: number
  totalSlides: number
  sessionName: string
  notes: string
  /** 'inline' docks at the bottom of the notes panel; 'floating' pops out. */
  variant: 'inline' | 'floating'
}

interface Turn extends ChatTurn {
  /** True while this assistant turn is still streaming. */
  pending?: boolean
}

export function AskClaude({
  doc,
  slideIndex,
  totalSlides,
  sessionName,
  notes,
  variant,
}: AskClaudeProps) {
  const keyed = hasApiKey()
  const [open, setOpen] = useState(variant === 'inline')
  const [input, setInput] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  // Fresh conversation when the slide changes — context shifts per slide.
  useEffect(() => {
    abortRef.current?.abort()
    setTurns([])
    setError(null)
    setBusy(false)
  }, [slideIndex])

  // Stop any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Keep the transcript scrolled to the latest text.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

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

  return (
    <section className={`ask-claude ask-claude-${variant} ${open ? 'open' : 'closed'}`}>
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
                        {t.content || (t.pending ? <span className="ask-cursor">▍</span> : '')}
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
