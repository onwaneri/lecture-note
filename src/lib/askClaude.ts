import { getAIClient, hasAnyApiKey, type AIMessage } from './aiClient'

/** Whether a usable key is configured. Drives the "set your key" empty state. */
export function hasApiKey(): boolean {
  return hasAnyApiKey()
}

export interface AskContext {
  sessionName: string
  slideNumber: number
  totalSlides: number
  /** Text layer of the current slide ('' if scanned / image-only). */
  slideText: string
  /** The user's markdown notes for the current slide. */
  notes: string
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface AskOptions {
  question: string
  context: AskContext
  history?: ChatTurn[]
  onText: (delta: string) => void
  signal?: AbortSignal
}

function buildContextBlock(ctx: AskContext): string {
  const lines: string[] = []
  lines.push(
    `The student is on slide ${ctx.slideNumber} of ${ctx.totalSlides}` +
      (ctx.sessionName ? ` of the lecture "${ctx.sessionName}".` : '.'),
  )
  lines.push('')
  lines.push('--- CURRENT SLIDE TEXT ---')
  lines.push(ctx.slideText ? ctx.slideText : '(no extractable text — likely an image-only slide)')
  lines.push('')
  lines.push('--- STUDENT NOTES FOR THIS SLIDE ---')
  lines.push(ctx.notes.trim() ? ctx.notes.trim() : '(no notes yet)')
  return lines.join('\n')
}

const SYSTEM_PROMPT =
  'You are a focused study assistant embedded in a lecture-notes app. ' +
  'The student is reviewing one slide at a time and may ask you to explain ' +
  'concepts, clarify their notes, quiz them, or expand on the slide. ' +
  'Ground your answers in the provided slide text and notes when relevant, ' +
  'but use your broader knowledge to fill gaps. Be concise and direct — ' +
  'prefer short paragraphs and bullet points. Use markdown. If the slide has ' +
  'no extractable text, rely on the notes and the question.'

/**
 * Streams an answer from the AI provider. Calls `onText` with each text delta
 * and resolves with the full answer string. Throws if the key is missing or the
 * request fails.
 */
export async function askClaude({
  question,
  context,
  history = [],
  onText,
  signal,
}: AskOptions): Promise<string> {
  const client = getAIClient()

  const messages: AIMessage[] = [
    ...history.map((t) => ({ role: t.role, content: t.content }) as AIMessage),
    {
      role: 'user',
      content: `${buildContextBlock(context)}\n\nQuestion: ${question}`,
    },
  ]

  return client.complete({
    system: SYSTEM_PROMPT,
    messages,
    maxTokens: 2048,
    model: 'smart',
    think: true,
    onText,
    signal,
  })
}
