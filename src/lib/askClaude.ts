// Import from the `/client` entry rather than the package root: the root
// barrel pulls in the Node-only agent-toolset (node:crypto/fs), which breaks
// the Vite browser build.
import { Anthropic } from '@anthropic-ai/sdk/client'

const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY?.trim()

let client: Anthropic | null = null

function getClient(): Anthropic {
  if (!apiKey) {
    throw new Error(
      'No API key. Add VITE_ANTHROPIC_API_KEY to .env.local and restart the dev server.',
    )
  }
  if (!client) {
    // The key lives in the browser bundle — acceptable for local/personal use
    // only. See .env.local for the security note.
    client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  }
  return client
}

/** Whether a usable key is configured. Drives the "set your key" empty state. */
export function hasApiKey(): boolean {
  return Boolean(apiKey)
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
 * Streams an answer from Claude. Calls `onText` with each text delta and
 * resolves with the full answer string. Throws if the key is missing or the
 * request fails.
 */
export async function askClaude({
  question,
  context,
  history = [],
  onText,
  signal,
}: AskOptions): Promise<string> {
  const anthropic = getClient()

  const messages: ChatTurn[] = [
    ...history,
    { role: 'user', content: `${buildContextBlock(context)}\n\nQuestion: ${question}` },
  ]

  const stream = anthropic.messages.stream(
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      messages,
    },
    { signal },
  )

  stream.on('text', (delta) => onText(delta))

  const final = await stream.finalMessage()
  return final.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
