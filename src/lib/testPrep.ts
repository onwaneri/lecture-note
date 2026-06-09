// Test Prep Mode — AI orchestration.
//
// Three tiers (see the feature spec):
//   Tier 1  initializeCurriculum() — sends each PDF to the AI as a native
//           document block (server-side parse — text + vision — no client-side
//           per-page extraction). One file per call so the model can attribute
//           every concept to a real 0-based slide index within that file:
//             • 1 file  → a single direct curriculum call.
//             • N files → per-file concept summaries IN PARALLEL (map) +
//               one small text-only synthesis call (reduce).
//           The practice exam is analysed in an ISOLATED call so its actual
//           questions never reach the curriculum/question context (no spoiling).
//   Tier 2  generateQuestion() / gradeAnswer() — interactive loop with
//           adaptive thinking (grading nuance), off the stored blueprint.
//   Tier 3  gradeAnswer() returns a `suggestedSlide` from the topic's key
//           slides so the reference pane can auto-surface the right page.

import { getAIClient, toBase64, type CacheableDocument, type ContentPart } from './aiClient'
import {
  getPDF,
  MASTERY_THRESHOLDS,
  type CurriculumBlueprint,
  type CurriculumTopic,
  type ExamBlueprint,
  type KnowledgeComponent,
  type KeySlide,
  type PrepDifficulty,
  type PrepDocRef,
  type PrepDocRole,
  type PrepScore,
  type PrepTurn,
} from './db'
import { loadPDFFromBytes } from './pdf'

/** A document ready for the curriculum pass — raw bytes + page count. */
export interface PrepDocInput {
  filename: string
  displayName: string
  role: PrepDocRole
  /** 0-based slide indices run 0..numPages-1. */
  numPages: number
  /** Raw PDF bytes (sent to the AI as a document block). */
  bytes: Uint8Array
}

export type InitStage =
  | { phase: 'summarizing'; current: number; total: number }
  | { phase: 'analyzing-exam' }
  | { phase: 'reading-topic-sheet' }
  | { phase: 'building-curriculum'; topicsFound: number }

type UserContent = string | ContentPart[]

function docBlock(doc: PrepDocInput): ContentPart {
  return {
    type: 'document',
    mimeType: 'application/pdf',
    data: toBase64(doc.bytes),
  }
}

/** Strip markdown fences / prose and parse the first JSON object or array. */
function parseJSON<T>(raw: string): T {
  if (!raw || !raw.trim()) {
    throw new Error(
      'AI returned an empty response — the model may have hit its token ' +
      'limit before producing output. Try again or use fewer/smaller files.',
    )
  }
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  if (!fence) {
    const firstObj = s.indexOf('{')
    const firstArr = s.indexOf('[')
    const start =
      firstArr === -1
        ? firstObj
        : firstObj === -1
          ? firstArr
          : Math.min(firstObj, firstArr)
    if (start > 0) s = s.slice(start)
    const lastBrace = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'))
    if (lastBrace !== -1) s = s.slice(0, lastBrace + 1)
  }
  try {
    return JSON.parse(s) as T
  } catch {
    throw new Error(
      'AI returned malformed JSON — the response may have been truncated. ' +
      'Try again. (Raw start: ' + JSON.stringify(s.slice(0, 120)) + '…)',
    )
  }
}

/** Per-request hard cap so a stalled call fails loudly instead of hanging. */
const REQUEST_TIMEOUT_MS = 120_000

interface CompleteOptions {
  system: string
  user: UserContent
  maxTokens: number
  model?: 'fast-lite' | 'fast' | 'smart'
  /** Enable adaptive extended thinking. Off by default for Tier 1 speed. */
  think?: boolean
  /** Hint that the response is JSON — enables provider-specific optimisations. */
  json?: boolean
  /** Called with each streamed text delta (for live progress UI). */
  onText?: (delta: string) => void
  /** Human label for console diagnostics. */
  label?: string
  signal?: AbortSignal
  /** Server-side document cache ID (from cacheDocuments). */
  cachedContent?: string
}

async function complete({
  system,
  user,
  maxTokens,
  model = 'fast',
  think = false,
  json = false,
  onText,
  label = 'request',
  signal,
  cachedContent,
}: CompleteOptions): Promise<string> {
  const client = getAIClient()
  const started = performance.now()
  console.info(`[prep] → ${client.providerName}:${model} ${label}`)
  try {
    let firstAt = 0
    const wrappedOnText = (delta: string) => {
      if (!firstAt) {
        firstAt = performance.now()
        console.info(
          `[prep] · ${label} first token at ${Math.round(firstAt - started)}ms`,
        )
      }
      onText?.(delta)
    }

    const text = await client.complete({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens,
      model,
      think,
      json,
      onText: wrappedOnText,
      signal,
      timeout: REQUEST_TIMEOUT_MS,
      cachedContent,
    })

    const elapsed = Math.round(performance.now() - started)
    console.info(`[prep] ✓ ${label} in ${elapsed}ms`)

    if (!text.trim()) {
      console.warn(`[prep] ⚠ ${label} returned no text content.`)
    }
    return text
  } catch (e) {
    console.error(
      `[prep] ✗ ${label} after ${Math.round(performance.now() - started)}ms`,
      e,
    )
    throw e
  }
}

// --- Tier 1: exam analysis (isolated, metadata only) ------------------------

const EXAM_SYSTEM =
  'You analyse a practice exam to extract STRUCTURAL METADATA ONLY. ' +
  'You must never include, quote, summarise, or paraphrase any specific ' +
  'question, prompt, answer choice, or solution from the exam. Output only ' +
  'the shape of the exam so a tutor can mimic its format without reusing its ' +
  'content. Respond with a single JSON object and nothing else.'

const EXAM_INSTRUCTIONS = [
  'Analyse the attached practice exam PDF(s). Return a JSON object with:',
  '- "questionTypes": string[] (e.g. "multiple choice", "short calculation", "conceptual explanation", "proof")',
  '- "topicWeights": object mapping a short topic label to an estimated 0–100 percentage of the exam',
  '- "answerFormatNotes": string (how students are expected to respond — show work, one sentence, derive, etc.)',
  '- "difficultyDistribution": { "conceptual": number, "application": number, "synthesis": number } (percentages summing to ~100)',
  '',
  'CRITICAL: include ZERO exam content — only structural metadata. Do not echo any question.',
].join('\n')

async function analyzeExam(
  examDocs: PrepDocInput[],
  signal?: AbortSignal,
): Promise<ExamBlueprint> {
  const content: ContentPart[] = [
    { type: 'text', text: 'Practice exam material:' },
    ...examDocs.flatMap((d): ContentPart[] => [
      { type: 'text', text: `=== ${d.displayName} ===` },
      docBlock(d),
    ]),
    { type: 'text', text: EXAM_INSTRUCTIONS },
  ]
  const out = await complete({
    system: EXAM_SYSTEM,
    user: content,
    maxTokens: 1536,
    model: 'fast-lite',
    json: true,
    label: 'exam analysis',
    signal,
  })
  return parseJSON<ExamBlueprint>(out)
}

// --- Tier 1: topic sheet analysis (guides curriculum alignment) -------------

const TOPIC_SHEET_SYSTEM =
  "You extract a structured topic list from a professor's topic sheet or study guide. " +
  'Identify the course or exam name if present, and list every topic in the order given, ' +
  'noting subtopics and any weights or emphasis indicated. Respond with a single JSON object and nothing else.'

interface TopicSheetEntry {
  title: string
  weight?: number
  subtopics?: string[]
}

export interface TopicSheetData {
  /** Course or exam name found on the sheet, if any. */
  courseName?: string
  topics: TopicSheetEntry[]
  /** Explicit professor notes or emphasis ("focus on Ch 3–5", etc.) */
  notes?: string
}

async function analyzeTopicSheet(
  docs: PrepDocInput[],
  signal?: AbortSignal,
): Promise<TopicSheetData> {
  const content: ContentPart[] = [
    { type: 'text', text: "Topic sheet(s) from the professor:" },
    ...docs.flatMap((d): ContentPart[] => [
      { type: 'text', text: `=== ${d.displayName} ===` },
      docBlock(d),
    ]),
    {
      type: 'text',
      text: [
        'Extract the topic structure. Return JSON:',
        '{',
        '  "courseName": "course or exam name if identifiable, else null",',
        '  "topics": [',
        '    {',
        '      "title": "topic name",',
        '      "weight": <percentage 0–100 or null>,',
        '      "subtopics": ["subtopic1"] or []',
        '    }',
        '  ],',
        '  "notes": "any explicit professor emphasis or scope restrictions, else null"',
        '}',
      ].join('\n'),
    },
  ]
  try {
    const out = await complete({
      system: TOPIC_SHEET_SYSTEM,
      user: content,
      maxTokens: 2048,
      model: 'fast-lite',
      json: true,
      label: 'topic sheet analysis',
      signal,
    })
    return parseJSON<TopicSheetData>(out)
  } catch (e) {
    console.warn('topic sheet analysis failed — ignoring', e)
    return { topics: [] }
  }
}

// --- Shared topic shape -----------------------------------------------------

interface RawTopic {
  title: string
  summary: string
  keySlides: KeySlide[]
  knowledgeComponents?: { id: string; label: string }[]
}

function pageNote(doc: PrepDocInput): string {
  return (
    `Document: "${doc.displayName}" (file id: "${doc.filename}", role: ${doc.role}). ` +
    `It has ${doc.numPages} pages, numbered 1..${doc.numPages} in the PDF. ` +
    `Report every slide as a 0-based slideIndex = (PDF page number − 1), so valid values are 0..${doc.numPages - 1}.`
  )
}

// --- Tier 1 (single file): direct curriculum --------------------------------

const CURRICULUM_SYSTEM =
  'You are a study architect. You build a focused, sequential curriculum a ' +
  'student can master before an exam, grounded in the attached material. Order ' +
  'topics so foundational concepts come before topics that build on them ' +
  '(concept → application). Respond with a single JSON object and nothing else.'

function curriculumSchemaText(
  exam: ExamBlueprint | undefined,
  topicSheet: TopicSheetData | undefined,
  userContext?: string,
): string {
  const weightHint = exam
    ? [
        '',
        'The practice exam emphasises these areas (use to weight coverage, NOT to copy content):',
        JSON.stringify(exam.topicWeights),
        `Exam answer format: ${exam.answerFormatNotes}`,
      ].join('\n')
    : ''

  const topicSheetHint =
    topicSheet && topicSheet.topics.length > 0
      ? [
          '',
          'The professor provided a topic sheet. ALIGN your curriculum to cover these topics in the order listed:',
          topicSheet.topics
            .map((t, i) => {
              const sub = t.subtopics?.length ? ` (${t.subtopics.join(', ')})` : ''
              const w = t.weight != null ? ` [${t.weight}%]` : ''
              return `${i + 1}. ${t.title}${sub}${w}`
            })
            .join('\n'),
          topicSheet.notes ? `Professor note: ${topicSheet.notes}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : ''

  const userContextHint = userContext
    ? [
        '',
        "Student's personal notes (factor into topic ordering, emphasis, and depth):",
        userContext,
      ].join('\n')
    : ''

  return [
    'Return JSON:',
    '{',
    '  "topics": [',
    '    {',
    '      "title": "short topic name",',
    '      "summary": "1–2 sentence description",',
    '      "keySlides": [ { "filename": "<exact file id>", "slideIndex": <0-based int> } ],',
    '      "knowledgeComponents": [ { "id": "kc1", "label": "specific testable concept" } ]',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Produce between 5 and 20 topics. Target around 10. Merge overlapping concepts.',
    '- List topics in the order a student should learn them (foundations first).',
    '- Each topic needs 1–3 keySlides citing the EXACT file id(s) and valid 0-based slideIndex values where that topic is actually taught.',
    '- Each topic needs 3–6 knowledgeComponents: specific, testable sub-concepts (e.g. "Ohm\'s Law", "Series vs Parallel"). IDs must be unique within the topic (kc1, kc2, …).',
    '- Topics must reflect the actual material — do not invent content.',
    weightHint,
    topicSheetHint,
    userContextHint,
  ].join('\n')
}

async function curriculumDirect(
  doc: PrepDocInput,
  exam: ExamBlueprint | undefined,
  topicSheet: TopicSheetData | undefined,
  userContext: string | undefined,
  onText: ((d: string) => void) | undefined,
  signal?: AbortSignal,
): Promise<RawTopic[]> {
  const content: ContentPart[] = [
    { type: 'text', text: pageNote(doc) },
    docBlock(doc),
    {
      type: 'text',
      text:
        'Build a curriculum from the attached document.\n' +
        curriculumSchemaText(exam, topicSheet, userContext),
    },
  ]
  const out = await complete({
    system: CURRICULUM_SYSTEM,
    user: content,
    maxTokens: 16384,
    model: 'smart',
    json: true,
    onText,
    label: `curriculum direct (${doc.displayName}, ${doc.numPages}p)`,
    signal,
  })
  return parseJSON<{ topics: RawTopic[] }>(out).topics ?? []
}

// --- Tier 1 (map): per-file concept summary via document block --------------

const SUMMARY_SYSTEM =
  'You distil one document into the key concepts it teaches. For each concept ' +
  'cite the 0-based slide indices where it appears. Be compact. Respond with a ' +
  'single JSON object and nothing else.'

interface DocConcept {
  label: string
  slideIndices: number[]
  detail: string
}

interface DocSummary {
  filename: string
  displayName: string
  role: string
  concepts: DocConcept[]
}

async function summarizeDoc(
  doc: PrepDocInput,
  signal?: AbortSignal,
): Promise<DocSummary> {
  const content: ContentPart[] = [
    { type: 'text', text: pageNote(doc) },
    docBlock(doc),
    {
      type: 'text',
      text: [
        'Return JSON:',
        '{ "concepts": [ { "label": "concept name", "slideIndices": [0,1], "detail": "one sentence" } ] }',
        '',
        'Rules:',
        '- 3–12 concepts depending on density.',
        '- slideIndices must be valid 0-based indices that exist in this document.',
        '- Keep "detail" to one sentence.',
      ].join('\n'),
    },
  ]
  try {
    const out = await complete({
      system: SUMMARY_SYSTEM,
      user: content,
      maxTokens: 1536,
      model: 'fast-lite',
      json: true,
      label: `summary (${doc.displayName}, ${doc.numPages}p)`,
      signal,
    })
    const parsed = parseJSON<{ concepts: DocConcept[] }>(out)
    return {
      filename: doc.filename,
      displayName: doc.displayName,
      role: doc.role,
      concepts: parsed.concepts ?? [],
    }
  } catch (e) {
    console.warn('doc summary failed', doc.displayName, e)
    return {
      filename: doc.filename,
      displayName: doc.displayName,
      role: doc.role,
      concepts: [],
    }
  }
}

// --- Tier 1 (reduce): synthesise the curriculum from summaries --------------

function synthesisPrompt(
  summaries: DocSummary[],
  exam: ExamBlueprint | undefined,
  topicSheet: TopicSheetData | undefined,
  userContext?: string,
): string {
  const blocks = summaries
    .map((s) => {
      const head = `=== FILE: ${s.displayName} (file id: "${s.filename}", role: ${s.role}) ===`
      const lines = s.concepts
        .map(
          (c) =>
            `- ${c.label} [slides: ${c.slideIndices.join(', ')}] — ${c.detail}`,
        )
        .join('\n')
      return `${head}\n${lines || '(no concepts extracted)'}`
    })
    .join('\n\n')

  return [
    'Build a curriculum from the per-file concept summaries below.',
    curriculumSchemaText(exam, topicSheet, userContext),
    '',
    '--- CONCEPT SUMMARIES ---',
    blocks,
  ].join('\n')
}

function buildSlideMap(topics: CurriculumTopic[]): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const t of topics) {
    for (const ks of t.keySlides) {
      const key = `${ks.filename}::${ks.slideIndex}`
      ;(map[key] ??= []).push(t.id)
    }
  }
  return map
}

async function generateSessionTitle(
  topics: CurriculumTopic[],
  topicSheet: TopicSheetData | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (topicSheet?.courseName) return topicSheet.courseName
  const topicList = topics
    .slice(0, 12)
    .map((t) => t.title)
    .join(', ')
  try {
    const out = await complete({
      system: 'You name study sessions. Output only the session name — no quotes, no explanation.',
      user: `Give a concise 3–7 word study session name for a prep session covering: ${topicList}. Reflect the subject area and scope (e.g. "Thermodynamics & Heat Transfer" or "CS 214 — Memory & Pointers").`,
      maxTokens: 64,
      label: 'session title',
      signal,
    })
    return out.trim().replace(/^["']|["']$/g, '') || fallbackTitle(topics)
  } catch {
    return fallbackTitle(topics)
  }
}

function fallbackTitle(topics: CurriculumTopic[]): string {
  const first = topics.slice(0, 2).map((t) => t.title)
  return first.join(' · ') || 'Prep session'
}

export interface InitOptions {
  docs: PrepDocInput[]
  difficulty: PrepDifficulty
  /** Free-text personal context from the student — emphasis, weak areas, time constraints, etc. */
  userContext?: string
  onStage?: (stage: InitStage) => void
  signal?: AbortSignal
}

export interface InitResult {
  blueprint: CurriculumBlueprint
  /** Auto-generated session name derived from curriculum topics (and topic sheet if present). */
  suggestedTitle: string
}

/** Tier 1: produce the full curriculum blueprint from raw materials. */
export async function initializeCurriculum({
  docs,
  difficulty,
  userContext,
  onStage,
  signal,
}: InitOptions): Promise<InitResult> {
  const examDocs = docs.filter((d) => d.role === 'exam')
  const topicSheetDocs = docs.filter((d) => d.role === 'topic-sheet')
  const contentDocs = docs.filter((d) => d.role !== 'exam' && d.role !== 'topic-sheet')
  // Source = docs whose slides can be referenced in the curriculum (no exams, no topic sheets).
  const source = contentDocs.length > 0 ? contentDocs : docs.filter((d) => d.role !== 'topic-sheet')

  // Fire exam analysis and topic sheet extraction in parallel — both are background work.
  const examPromise: Promise<ExamBlueprint | undefined> =
    examDocs.length > 0
      ? analyzeExam(examDocs, signal).catch((e) => {
          console.warn('exam analysis failed — continuing without weighting', e)
          return undefined
        })
      : Promise.resolve(undefined)

  const topicSheetPromise: Promise<TopicSheetData | undefined> =
    topicSheetDocs.length > 0
      ? analyzeTopicSheet(topicSheetDocs, signal)
      : Promise.resolve(undefined)

  let rawTopics: RawTopic[]
  let examOut: ExamBlueprint | undefined
  let topicSheetData: TopicSheetData | undefined

  const trackTopics = () => {
    let acc = ''
    return (delta: string) => {
      acc += delta
      const n = (acc.match(/"title"\s*:/g) ?? []).length
      onStage?.({ phase: 'building-curriculum', topicsFound: n })
    }
  }

  if (source.length === 1) {
    // Fast path: one content file — await both background tasks, then one direct call.
    if (topicSheetDocs.length > 0) onStage?.({ phase: 'reading-topic-sheet' })
    ;[examOut, topicSheetData] = await Promise.all([examPromise, topicSheetPromise])
    onStage?.({ phase: 'building-curriculum', topicsFound: 0 })
    rawTopics = await curriculumDirect(source[0], examOut, topicSheetData, userContext, trackTopics(), signal)
  } else {
    // MAP: summarise every content file concurrently (each a native PDF call).
    let done = 0
    onStage?.({ phase: 'summarizing', current: 0, total: source.length })
    const summaries = await Promise.all(
      source.map(async (d) => {
        const s = await summarizeDoc(d, signal)
        done += 1
        onStage?.({ phase: 'summarizing', current: done, total: source.length })
        return s
      }),
    )

    // Await both background tasks before synthesis.
    if (topicSheetDocs.length > 0) onStage?.({ phase: 'reading-topic-sheet' })
    ;[examOut, topicSheetData] = await Promise.all([examPromise, topicSheetPromise])

    // REDUCE: synthesise from the (small) summaries; stream for live progress.
    onStage?.({ phase: 'building-curriculum', topicsFound: 0 })
    const out = await complete({
      system: CURRICULUM_SYSTEM,
      user: synthesisPrompt(summaries, examOut, topicSheetData, userContext),
      maxTokens: 16384,
      model: 'smart',
      json: true,
      signal,
      onText: trackTopics(),
      label: 'curriculum synthesis',
    })
    rawTopics = parseJSON<{ topics: RawTopic[] }>(out).topics ?? []
  }

  const threshold = MASTERY_THRESHOLDS[difficulty]
  // Valid (filename::slideIndex) coordinates so we can drop hallucinations.
  const validSlides = new Set<string>()
  for (const d of source) {
    for (let i = 0; i < d.numPages; i++) validSlides.add(`${d.filename}::${i}`)
  }
  const topics: CurriculumTopic[] = rawTopics.map((t, i) => {
    const topicId = `t${i + 1}`
    const topicTitle = t.title?.trim() || `Topic ${i + 1}`

    // Build KCs — fallback to a single KC with the topic title.
    let kcs: KnowledgeComponent[] = []
    if (Array.isArray(t.knowledgeComponents) && t.knowledgeComponents.length > 0) {
      kcs = t.knowledgeComponents.map((kc, ki) => ({
        id: kc.id?.trim() || `kc${ki + 1}`,
        label: kc.label?.trim() || `Concept ${ki + 1}`,
      }))
    }
    if (kcs.length === 0) {
      kcs = [{ id: 'kc0', label: topicTitle }]
    }

    return {
      id: topicId,
      title: topicTitle,
      summary: t.summary?.trim() || '',
      keySlides: (t.keySlides ?? []).filter((ks) =>
        validSlides.has(`${ks.filename}::${ks.slideIndex}`),
      ),
      masteryThreshold: threshold,
      order: i,
      knowledgeComponents: kcs,
    }
  })

  const blueprint: CurriculumBlueprint = {
    topics,
    slideMap: buildSlideMap(topics),
    examBlueprint: examOut,
  }

  const suggestedTitle = await generateSessionTitle(topics, topicSheetData, signal).catch(
    () => fallbackTitle(topics),
  )

  return { blueprint, suggestedTitle }
}

// --- Tier 2: topic overview (concept understanding before practice) ---------

const OVERVIEW_SYSTEM =
  'You are a sharp tutor giving a student the briefing they need on a topic ' +
  'BEFORE they practice it — concept understanding comes before application. ' +
  'Teach the actual content from the attached slides: core definitions, the key ' +
  'ideas and how they connect, the formulas/rules that matter and when to use ' +
  'them, and the common pitfalls. Be substantive but tight — a study primer, not ' +
  'a textbook chapter. For visual/technical subjects, explain in words; never ' +
  'ask for or describe images. Do not ask the student questions — this is the ' +
  'teaching step. Ground every section in the slides and cite the exact slide ' +
  'each section draws from. Respond with a single JSON object and nothing else.'

/** One cited chunk of a topic overview. */
export interface OverviewSection {
  heading: string
  /** Section body in markdown (no heading inside). */
  markdown: string
  /** The slide this section was drawn from. */
  citation?: KeySlide
}

export interface TopicOverview {
  sections: OverviewSection[]
}

export interface GenerateOverviewOptions {
  topic: CurriculumTopic
  difficulty: PrepDifficulty
  examBlueprint?: ExamBlueprint
  /** Session source files — resolved to bytes and sent as document blocks. */
  documents: PrepDocRef[]
  /** Server-side document cache ID — when set, skip loading/inlining PDFs. */
  cachedContent?: string
  /** Summaries of previously generated overviews — used to avoid content overlap. */
  priorOverviews?: { title: string; headings: string[] }[]
  signal?: AbortSignal
}

/** Load the topic's source file(s) — the ones its key slides reference. */
async function loadOverviewDocs(
  topic: CurriculumTopic,
  documents: PrepDocRef[],
): Promise<PrepDocInput[]> {
  const cited = new Set(topic.keySlides.map((k) => k.filename))
  const wanted =
    cited.size > 0
      ? documents.filter((d) => cited.has(d.filename))
      : documents.filter((d) => d.role !== 'exam')
  const inputs: PrepDocInput[] = []
  for (const d of wanted) {
    const blob = await getPDF(d.filename)
    if (!blob) continue
    const bytes = new Uint8Array(await blob.arrayBuffer())
    // Defensive copy for pdf.js (it detaches the buffer); keep bytes for the API.
    const doc = await loadPDFFromBytes(new Uint8Array(bytes))
    inputs.push({
      filename: d.filename,
      displayName: d.displayName,
      role: d.role,
      numPages: doc.numPages,
      bytes,
    })
    doc.destroy()
  }
  return inputs
}

export async function generateOverview({
  topic,
  difficulty,
  examBlueprint,
  documents,
  cachedContent,
  priorOverviews,
  signal,
}: GenerateOverviewOptions): Promise<TopicOverview> {
  // When a server-side cache is available, skip loading PDFs from IDB —
  // the model already has the documents in context.
  const docs = cachedContent ? [] : await loadOverviewDocs(topic, documents)

  const examHint = examBlueprint
    ? `The exam tests this with: ${examBlueprint.questionTypes.join(', ')} (${examBlueprint.answerFormatNotes}). Emphasise what that format demands.`
    : ''

  // When using cached docs, include file metadata so the model knows
  // which filenames/slide indices are valid.
  const docMetadata = cachedContent
    ? documents
        .filter((d) => d.role !== 'exam')
        .map((d) => `Document "${d.displayName}" (file id: "${d.filename}", role: ${d.role}).`)
        .join('\n')
    : ''

  const priorContext =
    priorOverviews && priorOverviews.length > 0
      ? [
          '',
          'The following topics have already been covered in separate overviews — do NOT repeat their content. Focus on what is unique to THIS topic.',
          'Prior topics:',
          ...priorOverviews.map(
            (p) => `- ${p.title}: ${p.headings.join(', ')}`,
          ),
        ].join('\n')
      : ''

  const instructions = [
    `Topic: ${topic.title}`,
    `Scope: ${topic.summary}`,
    `Student's target depth: ${difficulty} tier.`,
    examHint,
    docMetadata ? `\nSource documents (already provided via cache):\n${docMetadata}` : '',
    priorContext,
    '',
    'Write the pre-practice overview, grounded in the attached slides. Return JSON:',
    '{',
    '  "sections": [',
    '    {',
    '      "heading": "short section heading",',
    '      "markdown": "section body in markdown (bullets, bold, inline code/math ok; do NOT repeat the heading)",',
    '      "citation": { "filename": "<exact file id>", "slideIndex": <0-based int> }',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- 3–6 sections covering definitions, key ideas, formulas/rules, and pitfalls; end with a "Key takeaways" section.',
    '- EVERY section must include a citation: the exact file id and 0-based slideIndex of the slide that section is drawn from.',
    '- Teaching only — no questions.',
  ]
    .filter(Boolean)
    .join('\n')

  const content: ContentPart[] = cachedContent
    ? [{ type: 'text', text: instructions }]
    : [
        ...docs.flatMap((d): ContentPart[] => [
          { type: 'text', text: pageNote(d) },
          docBlock(d),
        ]),
        { type: 'text', text: instructions },
      ]

  const out = await complete({
    system: OVERVIEW_SYSTEM,
    user: content,
    maxTokens: 3072,
    model: 'smart',
    think: true,
    json: true,
    label: `overview (${topic.title})`,
    signal,
    cachedContent,
  })
  const parsed = parseJSON<TopicOverview>(out)

  // Drop any citation that doesn't point at a real slide.
  // When loaded docs are available, validate exact (filename, slideIndex) pairs.
  // When using cache (no loaded docs), at least verify the filename is known.
  const validSlides = new Set<string>()
  for (const d of docs) {
    for (let i = 0; i < d.numPages; i++) validSlides.add(`${d.filename}::${i}`)
  }
  const validFilenames = new Set(documents.map((d) => d.filename))
  const sections: OverviewSection[] = (parsed.sections ?? []).map((s) => {
    let citation: KeySlide | undefined
    if (s.citation) {
      const key = `${s.citation.filename}::${s.citation.slideIndex}`
      if (validSlides.size > 0) {
        // Full validation: exact slide coordinate must exist.
        citation = validSlides.has(key) ? s.citation : undefined
      } else {
        // Cache mode: no page counts, but at least verify the filename.
        citation = validFilenames.has(s.citation.filename) ? s.citation : undefined
      }
    }
    return {
      heading: s.heading?.trim() || '',
      markdown: s.markdown?.trim() || '',
      citation,
    }
  })
  return { sections }
}

// --- Tier 2: question generation --------------------------------------------

const QUESTION_SYSTEM =
  'You are a rigorous tutor running a mastery-based practice session. You ask ' +
  'ONE question at a time. You may produce open-ended OR multiple-choice (MC) ' +
  'questions — choose whichever format best tests the concept at the given ' +
  'difficulty. Match the testing format implied by the exam metadata. For ' +
  'technical, hardware, or inherently visual subjects (circuits, diagrams, ' +
  'anatomy) ask an ABSTRACT, text-only conceptual or calculation question — ' +
  'never ask the student to draw or describe an image, and never request an ' +
  'image. Never reuse a practice exam question. Respond with a single JSON ' +
  'object and nothing else.'

export interface GenerateQuestionOptions {
  topic: CurriculumTopic
  difficulty: PrepDifficulty
  examBlueprint?: ExamBlueprint
  askedQuestions: string[]
  masteryAccumulated: number
  /** 1–5 target difficulty level for adaptive difficulty. */
  targetDifficulty?: number
  /** KC to focus on. */
  targetKcId?: string
  targetKcLabel?: string
  /** Bias toward MC format (e.g. at lower difficulty or if exam uses MC). */
  preferMC?: boolean
  signal?: AbortSignal
}

export interface GeneratedQuestion {
  questionText: string
  format: 'open' | 'mc'
  kcId?: string
  difficultyLevel: number
  /** Directional hint text (always present on newly generated questions). */
  hint: string
  /** Slide reference for the hint. */
  hintSlide?: KeySlide
  /** Precomputed correct answer — fed to grading so the LLM only compares. */
  correctAnswer?: string
  /** MC-only fields */
  choices?: string[]
  correctIndex?: number
  explanation?: string
}

export interface QuestionBlock {
  questions: GeneratedQuestion[]
  blockDifficulty: number
  blockIndex: number
}

export async function generateQuestion({
  topic,
  difficulty,
  examBlueprint,
  askedQuestions,
  masteryAccumulated,
  targetDifficulty,
  targetKcId,
  targetKcLabel,
  preferMC,
  signal,
}: GenerateQuestionOptions): Promise<GeneratedQuestion> {
  const diffLevel = targetDifficulty ?? 2

  const difficultyScale = [
    'Difficulty scale:',
    '1 = Recall / definition',
    '2 = Simple application',
    '3 = Conceptual reasoning',
    '4 = Multi-step problem',
    '5 = Transfer / synthesis',
  ].join('\n')

  const format = examBlueprint
    ? `Mimic this exam format where natural — question types: ${examBlueprint.questionTypes.join(', ')}; answer expectations: ${examBlueprint.answerFormatNotes}.`
    : 'No practice exam was provided; use a mix of conceptual and applied questions.'

  const prior =
    askedQuestions.length > 0
      ? [
          'These previous questions are provided as context for the next prompt:',
          ...askedQuestions.map((q) => `- ${q}`),
          'Do NOT repeat any of these already-asked questions; instead ask a new, fresh question that builds on the topic.',
        ].join('\n')
      : 'This is the first question for the topic.'

  const kcHint = targetKcLabel
    ? `Focus this question on the sub-concept: "${targetKcLabel}" (kcId: "${targetKcId}").`
    : ''

  const mcHint = preferMC
    ? 'Prefer multiple-choice format for this question.'
    : 'Choose the most natural format (open-ended or multiple-choice) for this question.'

  const slideOptions = topic.keySlides
    .map((ks) => `{ "filename": "${ks.filename}", "slideIndex": ${ks.slideIndex} }`)
    .join(', ')

  const user = [
    `Topic: ${topic.title}`,
    `Summary: ${topic.summary}`,
    `Difficulty mode: ${difficulty}.`,
    `Target difficulty level: ${diffLevel}.`,
    difficultyScale,
    `Student has accumulated ${masteryAccumulated} of ${topic.masteryThreshold} mastery points so far.`,
    kcHint,
    mcHint,
    format,
    prior,
    '',
    'Return one of these JSON formats:',
    '',
    `For open-ended: { "questionText": "...", "format": "open", "correctAnswer": "the complete correct answer in 1-3 sentences", "kcId": "<kcId or null>", "difficultyLevel": <1-5>, "hint": "a short directional hint that points the student toward the answer without giving it away", "hintSlide": one of [${slideOptions || 'null'}] or null }`,
    '',
    `For multiple-choice: { "questionText": "...", "format": "mc", "correctAnswer": "brief correct answer text", "choices": ["A", "B", "C", "D"], "correctIndex": <0-3>, "explanation": "brief explanation of correct answer", "kcId": "<kcId or null>", "difficultyLevel": <1-5>, "hint": "a short directional hint", "hintSlide": one of [${slideOptions || 'null'}] or null }`,
    'MC questions must have exactly 4 choices with 1 correct answer.',
    'The "hint" field is REQUIRED — it should guide the student directionally without revealing the answer.',
    'The "correctAnswer" field is REQUIRED — provide the complete, correct answer so grading can be done efficiently.',
  ].join('\n')

  const out = await complete({
    system: QUESTION_SYSTEM,
    user,
    maxTokens: 1536,
    model: 'smart',
    think: true,
    json: true,
    signal,
  })
  const raw = parseJSON<{
    questionText: string
    format?: 'open' | 'mc'
    kcId?: string
    difficultyLevel?: number
    hint?: string
    hintSlide?: KeySlide | null
    correctAnswer?: string
    choices?: string[]
    correctIndex?: number
    explanation?: string
  }>(out)

  // Only treat as MC if it has a valid choice set; otherwise fall back to
  // open-ended. Clamp correctIndex to a real choice so client-side grading and
  // the highlighted "correct" choice can never disagree.
  const isMC =
    raw.format === 'mc' && Array.isArray(raw.choices) && raw.choices.length >= 2
  let correctIndex: number | undefined
  if (isMC) {
    const ci = Number(raw.correctIndex)
    correctIndex =
      Number.isInteger(ci) && ci >= 0 && ci < raw.choices!.length ? ci : 0
  }

  return {
    questionText: raw.questionText,
    format: isMC ? 'mc' : 'open',
    kcId: raw.kcId ?? targetKcId,
    difficultyLevel: raw.difficultyLevel ?? diffLevel,
    hint: raw.hint || 'Review the relevant lecture slides for this concept.',
    hintSlide: raw.hintSlide ?? undefined,
    correctAnswer: raw.correctAnswer || undefined,
    choices: isMC ? raw.choices : undefined,
    correctIndex,
    explanation: isMC ? raw.explanation : undefined,
  }
}

// --- Tier 2: block generation (3 questions per call) -------------------------

const BLOCK_SYSTEM =
  'You are a rigorous tutor running a mastery-based practice session. You generate ' +
  'exactly 3 distinct questions at the specified difficulty level. You may produce ' +
  'open-ended OR multiple-choice (MC) questions — choose whichever format best tests ' +
  'each concept. For MC, ensure all 4 choices are distinct and plausible — never ' +
  'repeat the same choice across questions. For technical, hardware, or inherently ' +
  'visual subjects ask ABSTRACT, text-only conceptual or calculation questions. ' +
  'Level 1 = Recall/definition — ask for specific terms/facts directly found in ' +
  'lecture notes. Never reuse a practice exam question. Each question MUST include ' +
  'a "hint" field (a short directional hint that points the student toward the ' +
  'answer without giving it away) and a "hintSlide" (the specific slide reference). ' +
  'Respond with a single JSON object and nothing else.'

export interface GenerateQuestionBlockOptions {
  topic: CurriculumTopic
  difficulty: PrepDifficulty
  examBlueprint?: ExamBlueprint
  askedQuestions: string[]
  masteryAccumulated: number
  targetDifficulty?: number
  targetKcId?: string
  targetKcLabel?: string
  blockIndex: number
  signal?: AbortSignal
}

export async function generateQuestionBlock({
  topic,
  difficulty,
  examBlueprint,
  askedQuestions,
  masteryAccumulated,
  targetDifficulty,
  targetKcId,
  targetKcLabel,
  blockIndex,
  signal,
}: GenerateQuestionBlockOptions): Promise<QuestionBlock> {
  const diffLevel = targetDifficulty ?? 1

  const difficultyScale = [
    'Difficulty scale:',
    '1 = Recall / definition — ask for specific terms/facts directly found in lecture notes',
    '2 = Simple application',
    '3 = Conceptual reasoning',
    '4 = Multi-step problem',
    '5 = Transfer / synthesis',
  ].join('\n')

  const format = examBlueprint
    ? `Mimic this exam format where natural — question types: ${examBlueprint.questionTypes.join(', ')}; answer expectations: ${examBlueprint.answerFormatNotes}.`
    : 'No practice exam was provided; use a mix of conceptual and applied questions.'

  const prior =
    askedQuestions.length > 0
      ? [
          'Previously asked questions (do NOT repeat any of these):',
          ...askedQuestions.slice(-10).map((q) => `- ${q}`),
        ].join('\n')
      : 'This is the first block for the topic.'

  const kcHint = targetKcLabel
    ? `Focus questions on the sub-concept: "${targetKcLabel}" (kcId: "${targetKcId}").`
    : ''

  const slideOptions = topic.keySlides
    .map((ks) => `{ "filename": "${ks.filename}", "slideIndex": ${ks.slideIndex} }`)
    .join(', ')

  const user = [
    `Topic: ${topic.title}`,
    `Summary: ${topic.summary}`,
    `Difficulty mode: ${difficulty}.`,
    `Target difficulty level for ALL 3 questions: ${diffLevel}.`,
    difficultyScale,
    `Student has accumulated ${masteryAccumulated} of ${topic.masteryThreshold} mastery points so far.`,
    kcHint,
    format,
    prior,
    '',
    'Generate exactly 3 distinct questions as a JSON object:',
    '{',
    '  "questions": [',
    '    {',
    '      "questionText": "...",',
    '      "format": "open" or "mc",',
    '      "correctAnswer": "the complete correct answer in 1-3 sentences",',
    '      "kcId": "<kcId or null>",',
    '      "difficultyLevel": <1-5>,',
    '      "hint": "a short directional hint",',
    `      "hintSlide": one of [${slideOptions || 'null'}] or null,`,
    '      "choices": ["A","B","C","D"] (MC only),',
    '      "correctIndex": <0-3> (MC only),',
    '      "explanation": "brief explanation" (MC only)',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Exactly 3 questions. Each must be distinct.',
    '- Every question MUST have a non-empty "hint" field.',
    '- Every question MUST have a non-empty "correctAnswer" field with the complete correct answer.',
    '- MC questions must have exactly 4 distinct, plausible choices.',
    `- Prefer MC at difficulty level 1-2; choose most natural format at higher levels.`,
  ].join('\n')

  const out = await complete({
    system: BLOCK_SYSTEM,
    user,
    maxTokens: 4096,
    model: 'smart',
    think: true,
    json: true,
    signal,
    label: `question block (${topic.title}, lv${diffLevel}, #${blockIndex})`,
  })

  const raw = parseJSON<{
    questions: Array<{
      questionText: string
      format?: 'open' | 'mc'
      kcId?: string
      difficultyLevel?: number
      hint?: string
      hintSlide?: KeySlide | null
      correctAnswer?: string
      choices?: string[]
      correctIndex?: number
      explanation?: string
    }>
  }>(out)

  const questions: GeneratedQuestion[] = (raw.questions ?? [])
    .slice(0, 3)
    .map((q) => {
      const isMC =
        q.format === 'mc' && Array.isArray(q.choices) && q.choices.length >= 2
      let correctIndex: number | undefined
      if (isMC) {
        const ci = Number(q.correctIndex)
        correctIndex =
          Number.isInteger(ci) && ci >= 0 && ci < q.choices!.length ? ci : 0
      }
      return {
        questionText: q.questionText,
        format: isMC ? ('mc' as const) : ('open' as const),
        kcId: q.kcId ?? targetKcId,
        difficultyLevel: q.difficultyLevel ?? diffLevel,
        hint: q.hint || 'Review the relevant lecture slides for this concept.',
        hintSlide: q.hintSlide ?? undefined,
        correctAnswer: q.correctAnswer || undefined,
        choices: isMC ? q.choices : undefined,
        correctIndex,
        explanation: isMC ? q.explanation : undefined,
      }
    })

  // Pad to 3 if the model returned fewer — fall back to generating singles.
  while (questions.length < 3) {
    try {
      const single = await generateQuestion({
        topic,
        difficulty,
        examBlueprint,
        askedQuestions: [
          ...askedQuestions,
          ...questions.map((q) => q.questionText),
        ],
        masteryAccumulated,
        targetDifficulty,
        targetKcId,
        targetKcLabel,
        preferMC: diffLevel <= 2,
        signal,
      })
      questions.push(single)
    } catch (e) {
      console.warn('[prep] block padding failed', e)
      break
    }
  }

  return {
    questions,
    blockDifficulty: diffLevel,
    blockIndex,
  }
}

// --- Tier 2/3: grading + slide sourcing -------------------------------------

const GRADE_SYSTEM = [
  'You grade a student answer STRICTLY using this rubric. Assign exactly one score:',
  '1.00 — Complete, correct, with sound underlying reasoning. No significant gaps.',
  '0.75 — Correct conclusion but a minor gap, imprecision, or missing edge case.',
  '0.50 — Partially correct: relevant knowledge but misses a key mechanism or has a factual error.',
  '0.25 — Minimal: shows topic awareness but a fundamental misunderstanding is present.',
  '0.00 — Incorrect, off-topic, or a critical misconception.',
  'Do NOT output a score between these values. Do NOT round up for effort.',
  'Explain WHY, separating what was right from what was missing. Respond with a single JSON object and nothing else.',
].join('\n')

export interface GradeOptions {
  topic: CurriculumTopic
  question: string
  answer: string
  /** Precomputed correct answer — when provided the model just compares. */
  correctAnswer?: string
  history?: PrepTurn[]
  signal?: AbortSignal
}

export interface GradeResult {
  score: PrepScore
  correctComponents: string
  missingComponents: string
  correction: string
  suggestedSlide?: KeySlide
}

const ALLOWED_SCORES: PrepScore[] = [0, 0.25, 0.5, 0.75, 1]

function snapScore(n: number): PrepScore {
  let best: PrepScore = 0
  let bestDist = Infinity
  for (const s of ALLOWED_SCORES) {
    const d = Math.abs(s - n)
    if (d < bestDist) {
      bestDist = d
      best = s
    }
  }
  return best
}

export async function gradeAnswer({
  topic,
  question,
  answer,
  correctAnswer,
  signal,
}: GradeOptions): Promise<GradeResult> {
  const slideOptions = topic.keySlides
    .map((ks) => `{ "filename": "${ks.filename}", "slideIndex": ${ks.slideIndex} }`)
    .join(', ')

  const correctAnswerHint = correctAnswer
    ? `\nCorrect answer:\n${correctAnswer}\n\nCompare the student's answer against the correct answer above.`
    : ''

  const user = [
    `Topic: ${topic.title} — ${topic.summary}`,
    '',
    `Question asked:\n${question}`,
    correctAnswerHint,
    '',
    `Student answer:\n${answer || '(blank)'}`,
    '',
    'Return JSON:',
    '{',
    '  "score": 0 | 0.25 | 0.5 | 0.75 | 1,',
    '  "correctComponents": "what the student got right (empty string if nothing)",',
    '  "missingComponents": "what was missing or wrong",',
    '  "correction": "concise explanation of the correct reasoning and WHY the mistake happened",',
    `  "suggestedSlide": one of [${slideOptions || 'null'}] — the single most relevant slide to review, or null`,
    '}',
  ].join('\n')

  const out = await complete({
    system: GRADE_SYSTEM,
    user,
    maxTokens: 1536,
    model: 'fast',
    json: true,
    signal,
  })
  const raw = parseJSON<{
    score: number
    correctComponents?: string
    missingComponents?: string
    correction?: string
    suggestedSlide?: KeySlide | null
  }>(out)

  return {
    score: snapScore(Number(raw.score)),
    correctComponents: raw.correctComponents ?? '',
    missingComponents: raw.missingComponents ?? '',
    correction: raw.correction ?? '',
    suggestedSlide: raw.suggestedSlide ?? undefined,
  }
}

// --- Document caching --------------------------------------------------------

/**
 * Pre-cache session documents server-side (Gemini context caching).
 * Returns a cache name to pass as `cachedContent` in subsequent calls,
 * or null if the provider doesn't support caching.
 */
export async function createDocumentCache(
  documents: PrepDocRef[],
): Promise<string | null> {
  const client = getAIClient()
  if (!client.cacheDocuments) return null

  const contentDocs = documents.filter((d) => d.role !== 'exam')
  const cacheDocs: CacheableDocument[] = []
  for (const d of contentDocs) {
    const blob = await getPDF(d.filename)
    if (!blob) continue
    const bytes = new Uint8Array(await blob.arrayBuffer())
    cacheDocs.push({
      bytes,
      mimeType: 'application/pdf',
      displayName: d.displayName,
    })
  }
  if (cacheDocs.length === 0) return null

  try {
    return await client.cacheDocuments('smart', cacheDocs)
  } catch (e) {
    console.warn('[prep] document cache creation failed', e)
    return null
  }
}
