import { GoogleGenAI, type Content, type Part } from '@google/genai'
import {
  toBase64,
  type AIClient,
  type CacheableDocument,
  type CompleteOptions,
  type ContentPart,
  type ModelTier,
} from './aiClient'

const apiKey = import.meta.env.VITE_GEMINI_API_KEY?.trim()

function tierToModel(tier: ModelTier): string {
  switch (tier) {
    case 'fast-lite':
      return 'gemini-2.5-flash-lite'
    case 'fast':
      return 'gemini-2.5-flash'
    case 'smart':
      return 'gemini-2.5-pro'
  }
}

/**
 * Compute the thinking budget for a given model + think flag.
 * - Flash-Lite and Flash support thinkingBudget: 0 to disable thinking.
 * - Pro requires a minimum of 128.
 * - When think=true, give a generous budget for reasoning quality.
 */
function getThinkingBudget(modelId: string, think: boolean): number {
  if (think) return 8192
  if (modelId === 'gemini-2.5-pro') return 128
  return 0
}

function toGeminiParts(parts: ContentPart[]): Part[] {
  return parts.map((p) => {
    if (p.type === 'text') {
      return { text: p.text }
    }
    return {
      inlineData: {
        mimeType: p.mimeType,
        data: p.data,
      },
    }
  })
}

export function createGeminiClient(): AIClient {
  let client: GoogleGenAI | null = null

  function getClient(): GoogleGenAI {
    if (!apiKey) {
      throw new Error(
        'No API key. Add VITE_GEMINI_API_KEY to .env.local and restart the dev server.',
      )
    }
    if (!client) {
      client = new GoogleGenAI({ apiKey })
    }
    return client
  }

  return {
    providerName: 'gemini',

    hasApiKey() {
      return Boolean(apiKey)
    },

    async cacheDocuments(
      model: ModelTier,
      docs: CacheableDocument[],
      ttlSeconds = 3600,
    ): Promise<string | null> {
      if (docs.length === 0) return null
      const ai = getClient()
      const modelId = tierToModel(model)

      const parts: Part[] = docs.map((d) => ({
        inlineData: {
          mimeType: d.mimeType,
          data: toBase64(d.bytes),
        },
      }))

      try {
        const cached = await ai.caches.create({
          model: modelId,
          config: {
            contents: [{ role: 'user', parts }],
            displayName: `prep-session-${Date.now()}`,
            ttl: `${ttlSeconds}s`,
          },
        })
        console.info(
          `[gemini] cached ${docs.length} doc(s) → ${cached.name}`,
        )
        return cached.name ?? null
      } catch (e) {
        console.warn('[gemini] cache creation failed, falling back to inline', e)
        return null
      }
    },

    async complete({
      system,
      messages,
      maxTokens,
      model = 'fast',
      think = false,
      json = false,
      onText,
      signal,
      timeout = 120_000,
      cachedContent,
    }: CompleteOptions): Promise<string> {
      const ai = getClient()
      const modelId = tierToModel(model)

      // Build Gemini contents array from AIMessage[].
      // When using cachedContent, Gemini forbids systemInstruction in the
      // generation config, so we fold it into the first user message instead.
      const contents: Content[] = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts:
          typeof m.content === 'string'
            ? [{ text: m.content }]
            : toGeminiParts(m.content),
      }))
      if (cachedContent && system) {
        const preamble: Part = { text: `[System instructions]\n${system}\n[End system instructions]\n\n` }
        if (contents.length > 0 && contents[0].role === 'user') {
          contents[0] = { ...contents[0], parts: [preamble, ...contents[0].parts!] }
        } else {
          contents.unshift({ role: 'user', parts: [preamble] })
        }
      }

      // Manual timeout via AbortController (Gemini SDK has no built-in timeout).
      const timeoutController = new AbortController()
      const timer = setTimeout(() => timeoutController.abort(), timeout)

      // Combine caller signal with timeout signal.
      const combinedController = new AbortController()
      const onAbort = () => combinedController.abort()
      signal?.addEventListener('abort', onAbort)
      timeoutController.signal.addEventListener('abort', onAbort)

      // Gemini 2.5 counts thinking tokens WITHIN maxOutputTokens (unlike
      // Anthropic where max_tokens only covers visible output). We must add
      // headroom so the model's internal reasoning doesn't eat the output
      // budget. Use a controlled thinking budget and add it on top.
      const thinkingBudget = getThinkingBudget(modelId, think)
      const totalMaxTokens = maxTokens + thinkingBudget

      try {
        const response = await ai.models.generateContentStream({
          model: modelId,
          contents,
          config: {
            maxOutputTokens: totalMaxTokens,
            // systemInstruction is forbidden when cachedContent is set.
            ...(cachedContent ? { cachedContent } : { systemInstruction: system }),
            thinkingConfig: { thinkingBudget },
            abortSignal: combinedController.signal,
            ...(json ? { responseMimeType: 'application/json' } : {}),
          },
        })

        let full = ''
        for await (const chunk of response) {
          const parts = chunk.candidates?.[0]?.content?.parts
          if (!parts) continue
          for (const part of parts) {
            if ((part as Record<string, unknown>).thought || !part.text) continue
            full += part.text
            onText?.(part.text)
          }
        }
        return full
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        timeoutController.signal.removeEventListener('abort', onAbort)
      }
    },
  }
}
