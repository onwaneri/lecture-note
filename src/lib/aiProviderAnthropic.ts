import { Anthropic } from '@anthropic-ai/sdk/client'
import type { AIClient, CompleteOptions, ContentPart, ModelTier } from './aiClient'

const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY?.trim()

function tierToModel(tier: ModelTier): string {
  return tier === 'fast' || tier === 'fast-lite'
    ? 'claude-haiku-4-5'
    : 'claude-sonnet-4-6'
}

function toAnthropicContent(parts: ContentPart[]): Anthropic.ContentBlockParam[] {
  return parts.map((p) => {
    if (p.type === 'text') {
      return { type: 'text' as const, text: p.text }
    }
    return {
      type: 'document' as const,
      source: {
        type: 'base64' as const,
        media_type: p.mimeType as 'application/pdf',
        data: p.data,
      },
    }
  })
}

export function createAnthropicClient(): AIClient {
  let client: Anthropic | null = null

  function getClient(): Anthropic {
    if (!apiKey) {
      throw new Error(
        'No API key. Add VITE_ANTHROPIC_API_KEY to .env.local and restart the dev server.',
      )
    }
    if (!client) {
      client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
    }
    return client
  }

  return {
    providerName: 'anthropic',

    hasApiKey() {
      return Boolean(apiKey)
    },

    async complete({
      system,
      messages,
      maxTokens,
      model = 'fast',
      think = false,
      json: _json,
      onText,
      signal,
      timeout = 120_000,
      cachedContent: _cachedContent,
    }: CompleteOptions): Promise<string> {
      const anthropic = getClient()
      const modelId = tierToModel(model)

      const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : toAnthropicContent(m.content),
      }))

      const stream = anthropic.messages.stream(
        {
          model: modelId,
          max_tokens: maxTokens,
          ...(think ? { thinking: { type: 'adaptive' as const } } : {}),
          system,
          messages: anthropicMessages,
        },
        { signal, timeout },
      )

      stream.on('text', (delta) => onText?.(delta))

      const final = await stream.finalMessage()
      return final.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('')
    },
  }
}
