import { useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import { getAIClient, type AIMessage } from '../../lib/aiClient'

marked.setOptions({ breaks: true, gfm: true })
function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

interface Box {
  top: number
  left: number
  width: number
  height: number
}

/** Default geometry scaled to the viewport, anchored bottom-right. */
function defaultBox(): Box {
  const width = Math.round(clamp(window.innerWidth * 0.3, 400, 640))
  const height = Math.round(clamp(window.innerHeight * 0.72, 460, 920))
  return {
    width,
    height,
    left: Math.round(Math.max(16, window.innerWidth - width - 24)),
    top: Math.round(Math.max(16, window.innerHeight - height - 24)),
  }
}

const MIN_W = 340
const MIN_H = 320

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Contextual info injected into the system prompt — updated as the student navigates. */
export interface PrepChatContext {
  sessionTitle: string
  difficulty: string
  topicTitle: string
  topicSummary: string
  /** Overview markdown (when on the overview tab). */
  overviewMarkdown?: string
  /** Set after the student submits an answer. */
  lastQuestion?: string
  lastAnswer?: string
  lastScore?: number
  lastFeedback?: string
}

interface PrepChatPopupProps {
  open: boolean
  onClose: () => void
  context: PrepChatContext
  history: ChatMessage[]
  onHistory: (h: ChatMessage[]) => void
}

const SYSTEM_PROMPT =
  'You are a focused study assistant embedded in a test prep session. ' +
  'The student is studying a specific topic and may ask you to explain concepts, ' +
  'clarify the overview material, dig deeper into a question they just answered, ' +
  'or help them understand why their answer was wrong. Ground your answers in the ' +
  'provided topic context. Be concise and direct — prefer short paragraphs and ' +
  'bullet points. Use markdown.'

function buildContextBlock(ctx: PrepChatContext): string {
  const lines: string[] = []
  lines.push(`Session: "${ctx.sessionTitle}" (${ctx.difficulty} mode)`)
  lines.push(`Current topic: ${ctx.topicTitle}`)
  lines.push(`Topic summary: ${ctx.topicSummary}`)

  if (ctx.overviewMarkdown) {
    lines.push('')
    lines.push('--- TOPIC OVERVIEW ---')
    lines.push(ctx.overviewMarkdown)
  }

  if (ctx.lastQuestion) {
    lines.push('')
    lines.push('--- LAST QUESTION & ANSWER ---')
    lines.push(`Question: ${ctx.lastQuestion}`)
    lines.push(`Student's answer: ${ctx.lastAnswer ?? '(no answer)'}`)
    if (ctx.lastScore != null) {
      lines.push(`Score: ${ctx.lastScore}/1`)
    }
    if (ctx.lastFeedback) {
      lines.push(`Feedback: ${ctx.lastFeedback}`)
    }
  }

  return lines.join('\n')
}

export function PrepChatPopup({
  open,
  onClose,
  context,
  history,
  onHistory,
}: PrepChatPopupProps) {
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Floating-window geometry: default-sized to the viewport (so it's not tiny on
  // big screens), then freely draggable (header) and resizable (corner handle).
  const [box, setBox] = useState<Box>(() => defaultBox())
  const boxRef = useRef(box)
  boxRef.current = box

  // Keep the window on-screen if the viewport shrinks.
  useEffect(() => {
    function onResize() {
      setBox((b) => ({
        ...b,
        left: clamp(b.left, 0, Math.max(0, window.innerWidth - b.width)),
        top: clamp(b.top, 0, Math.max(0, window.innerHeight - 48)),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Drag to move — started from the header (ignores clicks on its buttons).
  const startDrag = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const orig = boxRef.current
    const sx = e.clientX
    const sy = e.clientY
    function onMove(ev: PointerEvent) {
      const left = clamp(orig.left + (ev.clientX - sx), 0, window.innerWidth - orig.width)
      const top = clamp(orig.top + (ev.clientY - sy), 0, window.innerHeight - 48)
      setBox({ ...orig, left, top })
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  // Resize from an edge ('x' = width, 'y' = height) or the corner ('both').
  const startResize = useCallback(
    (e: React.PointerEvent, axis: 'x' | 'y' | 'both') => {
      e.preventDefault()
      e.stopPropagation()
      const orig = boxRef.current
      const sx = e.clientX
      const sy = e.clientY
      function onMove(ev: PointerEvent) {
        const width =
          axis === 'y'
            ? orig.width
            : clamp(
                orig.width + (ev.clientX - sx),
                MIN_W,
                window.innerWidth - orig.left - 8,
              )
        const height =
          axis === 'x'
            ? orig.height
            : clamp(
                orig.height + (ev.clientY - sy),
                MIN_H,
                window.innerHeight - orig.top - 8,
              )
        setBox({ ...orig, width, height })
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [],
  )

  // Auto-scroll to bottom when messages change or while streaming.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [history, streamText, open])

  // Focus input when popup opens.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Abort in-flight request on unmount.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return

    setInput('')
    setError(null)

    const userMsg: ChatMessage = { role: 'user', content: text }
    const updatedHistory = [...history, userMsg]
    onHistory(updatedHistory)

    setStreaming(true)
    setStreamText('')

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const client = getAIClient()
      const contextBlock = buildContextBlock(context)

      // Build messages: first user message gets context prepended,
      // subsequent messages are plain.
      const messages: AIMessage[] = updatedHistory.map(
        (msg, i) => {
          if (i === 0 && msg.role === 'user') {
            return {
              role: 'user' as const,
              content: `${contextBlock}\n\n---\n\nStudent question: ${msg.content}`,
            }
          }
          return { role: msg.role, content: msg.content }
        },
      )

      let full = ''
      await client.complete({
        system: SYSTEM_PROMPT,
        messages,
        maxTokens: 2048,
        model: 'smart',
        onText: (delta) => {
          full += delta
          setStreamText(full)
        },
        signal: controller.signal,
      })

      const assistantMsg: ChatMessage = { role: 'assistant', content: full }
      onHistory([...updatedHistory, assistantMsg])
      setStreamText('')
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(e instanceof Error ? e.message : 'Chat request failed.')
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [input, streaming, history, onHistory, context])

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  if (!open) return null

  return (
    <div
      className="prep-chat-popup"
      style={{
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        right: 'auto',
        bottom: 'auto',
        maxHeight: 'none',
      }}
    >
      <div className="prep-chat-header" onPointerDown={startDrag}>
        <span className="prep-chat-header-title">Ask Doug</span>
        <span className="prep-chat-header-topic">{context.topicTitle}</span>
        <button
          type="button"
          className="prep-chat-close"
          onClick={onClose}
          title="Close chat"
        >
          ✕
        </button>
      </div>

      <div className="prep-chat-messages" ref={scrollRef}>
        {history.length === 0 && !streaming ? (
          <div className="prep-chat-empty">
            Ask anything about{' '}
            <strong>{context.topicTitle}</strong>.
            {context.lastQuestion
              ? ' I have context on the question you just answered.'
              : ''}
          </div>
        ) : null}

        {history.map((msg, i) => (
          <div
            key={i}
            className={`prep-chat-msg prep-chat-msg-${msg.role}`}
          >
            <div className="prep-chat-msg-label">
              {msg.role === 'user' ? 'You' : 'Doug'}
            </div>
            {msg.role === 'assistant' ? (
              <div
                className="prep-chat-msg-body ask-md"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(msg.content),
                }}
              />
            ) : (
              <div className="prep-chat-msg-body">{msg.content}</div>
            )}
          </div>
        ))}

        {streaming && streamText ? (
          <div className="prep-chat-msg prep-chat-msg-assistant">
            <div className="prep-chat-msg-label">Doug</div>
            <div
              className="prep-chat-msg-body ask-md"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(streamText),
              }}
            />
          </div>
        ) : streaming ? (
          <div className="prep-chat-msg prep-chat-msg-assistant">
            <div className="prep-chat-msg-label">Doug</div>
            <div className="prep-chat-msg-body prep-chat-thinking">
              <span className="prep-spinner small" aria-hidden="true" />
              Thinking…
            </div>
          </div>
        ) : null}

        {error ? <div className="prep-chat-error">{error}</div> : null}
      </div>

      <div className="prep-chat-input-area">
        <textarea
          ref={inputRef}
          className="prep-chat-input"
          placeholder="Ask a question…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={streaming}
          rows={1}
        />
        <button
          type="button"
          className="prep-chat-send"
          onClick={() => void send()}
          disabled={streaming || !input.trim()}
          title="Send"
        >
          ↑
        </button>
      </div>

      <div
        className="prep-chat-resize-e"
        onPointerDown={(e) => startResize(e, 'x')}
        title="Drag to resize width"
      />
      <div
        className="prep-chat-resize-s"
        onPointerDown={(e) => startResize(e, 'y')}
        title="Drag to resize height"
      />
      <div
        className="prep-chat-resize-se"
        onPointerDown={(e) => startResize(e, 'both')}
        title="Drag to resize"
      />
    </div>
  )
}
