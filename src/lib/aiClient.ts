// Provider-agnostic AI client abstraction.
//
// All AI calls in the app go through this interface. The concrete provider
// (Anthropic or Gemini) is chosen once at startup via the VITE_AI_PROVIDER
// env variable and cached as a lazy singleton.

import { createAnthropicClient } from './aiProviderAnthropic'
import { createGeminiClient } from './aiProviderGemini'

export interface TextPart {
  type: 'text'
  text: string
}

export interface DocumentPart {
  type: 'document'
  mimeType: string
  data: string // base64
}

export type ContentPart = TextPart | DocumentPart

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

/** Abstraction over concrete model names. */
export type ModelTier = 'fast-lite' | 'fast' | 'smart'

export interface CompleteOptions {
  system: string
  messages: AIMessage[]
  maxTokens: number
  model?: ModelTier
  /** Enable extended thinking. */
  think?: boolean
  /** Hint that the response is expected to be JSON. Enables provider-specific optimisations. */
  json?: boolean
  /** Called with each streamed text delta. */
  onText?: (delta: string) => void
  signal?: AbortSignal
  /** Per-request timeout in ms (default: provider decides). */
  timeout?: number
  /** Server-side document cache ID (from cacheDocuments). */
  cachedContent?: string
}

export interface CacheableDocument {
  bytes: Uint8Array
  mimeType: string
  displayName: string
}

export interface AIClient {
  providerName: string
  complete(opts: CompleteOptions): Promise<string>
  hasApiKey(): boolean
  /**
   * Upload documents and create a reusable server-side cache.
   * Returns a cache name/ID to pass as `cachedContent` in subsequent calls.
   * Returns null if the provider doesn't support caching.
   */
  cacheDocuments?(model: ModelTier, docs: CacheableDocument[], ttlSeconds?: number): Promise<string | null>
}

/** Encode bytes to base64 in chunks (avoids call-stack limits on big files). */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

let cached: AIClient | null = null

export function getAIClient(): AIClient {
  if (cached) return cached

  const provider = (import.meta.env.VITE_AI_PROVIDER ?? 'anthropic')
    .trim()
    .toLowerCase()

  if (provider === 'gemini') {
    cached = createGeminiClient()
  } else {
    cached = createAnthropicClient()
  }

  return cached
}

/** Whether ANY configured provider has a usable API key. */
export function hasAnyApiKey(): boolean {
  return getAIClient().hasApiKey()
}
