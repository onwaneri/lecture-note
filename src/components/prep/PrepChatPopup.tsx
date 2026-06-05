import { useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import { getAIClient, type AIMessage } from '../../lib/aiClient'

marked.setOptions({ breaks: true, gfm: true })
function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string
}

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
    <div className="prep-chat-popup">
      <div className="prep-chat-header">
        <span className="prep-chat-header-title">Ask AI</span>
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
              {msg.role === 'user' ? 'You' : 'AI'}
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
            <div className="prep-chat-msg-label">AI</div>
            <div
              className="prep-chat-msg-body ask-md"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(streamText),
              }}
            />
          </div>
        ) : streaming ? (
          <div className="prep-chat-msg prep-chat-msg-assistant">
            <div className="prep-chat-msg-label">AI</div>
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
    </div>
  )
}
