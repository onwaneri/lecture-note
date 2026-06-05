import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

const DB_NAME = 'lecturenote-db'
const DB_VERSION = 5

export interface NoteRecord {
  key: string
  filename: string
  slideIndex: number
  markdown: string
  updatedAt: number
}

export interface ChatTurnRecord {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRecord {
  key: string
  filename: string
  slideIndex: number
  turns: ChatTurnRecord[]
  updatedAt: number
}

export interface SessionRecord {
  filename: string
  sessionName: string
  lastOpenedAt: number
  activeSlideIndex?: number
  numPages?: number
}

// --- Test Prep Mode ---------------------------------------------------------

export type PrepDifficulty = 'foundational' | 'thorough' | 'exam-ready'

/** Legacy difficulty values from pre-migration sessions. */
type LegacyDifficulty = 'light' | 'medium' | 'hard'

const LEGACY_DIFFICULTY_MAP: Record<LegacyDifficulty, PrepDifficulty> = {
  light: 'foundational',
  medium: 'thorough',
  hard: 'exam-ready',
}

/** Normalise a difficulty value, mapping legacy names if needed. */
export function normalizeDifficulty(d: string): PrepDifficulty {
  if (d in LEGACY_DIFFICULTY_MAP) return LEGACY_DIFFICULTY_MAP[d as LegacyDifficulty]
  return d as PrepDifficulty
}
export type PrepDocRole = 'lecture' | 'homework' | 'exam' | 'topic-sheet'
/** Awarded credit per answer — quarter-point increments out of 1. */
export type PrepScore = 0 | 0.25 | 0.5 | 0.75 | 1

/** Points required to master one topic, by difficulty tier. */
export const MASTERY_THRESHOLDS: Record<PrepDifficulty, number> = {
  foundational: 3,
  thorough: 5,
  'exam-ready': 7,
}

/** Configuration for mastery checking per difficulty mode. */
export interface MasteryConfig {
  pointThreshold: number
  /** Minimum times each KC must be tested. */
  minKCAttempts: number
  /** Minimum average score across KC attempts (null = no constraint). */
  minKCAvgScore: number | null
  /** At least one question must reach this difficulty level (null = no constraint). */
  minDifficultyReached: number | null
  /** Whether interleaving is active (and when). */
  interleaving: 'off' | 'after-wrong' | 'full'
  /** Retry queue enabled? */
  retryEnabled: boolean
  /** Number of questions before a failed item is retried. */
  retryDelay: number
  /** Inject review questions every N turns from mastered topics (0 = off). */
  reviewInterval: number
}

export const MASTERY_CONFIGS: Record<PrepDifficulty, MasteryConfig> = {
  foundational: {
    pointThreshold: 3,
    minKCAttempts: 1,
    minKCAvgScore: null,
    minDifficultyReached: null,
    interleaving: 'off',
    retryEnabled: false,
    retryDelay: 3,
    reviewInterval: 0,
  },
  thorough: {
    pointThreshold: 5,
    minKCAttempts: 2,
    minKCAvgScore: null,
    minDifficultyReached: 3,
    interleaving: 'after-wrong',
    retryEnabled: true,
    retryDelay: 3,
    reviewInterval: 0,
  },
  'exam-ready': {
    pointThreshold: 7,
    minKCAttempts: 2,
    minKCAvgScore: 0.75,
    minDifficultyReached: 4,
    interleaving: 'full',
    retryEnabled: true,
    retryDelay: 3,
    reviewInterval: 5,
  },
}

/** Max files a single prep session may ingest. */
export const MAX_PREP_FILES = 15

export interface PrepDocRef {
  /** Key into the `pdfs` store. */
  filename: string
  role: PrepDocRole
  displayName: string
}

export interface KeySlide {
  filename: string
  /** 0-based page index. */
  slideIndex: number
}

export interface KnowledgeComponent {
  id: string
  label: string
}

export interface CurriculumTopic {
  id: string
  title: string
  /** 1–2 sentence blurb shown on the map. */
  summary: string
  keySlides: KeySlide[]
  masteryThreshold: number
  /** Sequential position; lower unlocks first. */
  order: number
  /** Knowledge components for fine-grained mastery tracking. */
  knowledgeComponents: KnowledgeComponent[]
}

/** Structural metadata about a practice exam — never its actual questions. */
export interface ExamBlueprint {
  questionTypes: string[]
  topicWeights: Record<string, number>
  answerFormatNotes: string
  difficultyDistribution: {
    conceptual: number
    application: number
    synthesis: number
  }
}

export interface CurriculumBlueprint {
  topics: CurriculumTopic[]
  /** 'filename::slideIndex' → topicId[] for fast slide→topic lookup. */
  slideMap: Record<string, string[]>
  examBlueprint?: ExamBlueprint
}

export interface PrepSessionRecord {
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
  difficulty: PrepDifficulty
  status: 'initializing' | 'active' | 'completed'
  blueprint: CurriculumBlueprint
  documents: PrepDocRef[]
}

export interface PrepTurn {
  questionText: string
  userAnswer: string
  score: PrepScore
  correctComponents: string
  missingComponents: string
  correction: string
  suggestedSlide?: KeySlide
  timestamp: number
  /** Which KC this question tested. */
  kcId?: string
  /** 1–5 actual difficulty. */
  difficultyLevel?: number
  /** Question format. */
  format?: 'open' | 'mc'
  /** The 4 MC choices (if mc). */
  mcChoices?: string[]
  /** 0-based index of correct answer (if mc). */
  mcCorrectIndex?: number
  /** What the student picked (if mc). */
  mcSelectedIndex?: number
}

export interface KCMasteryRecord {
  attempts: number
  totalScore: number
}

export interface PrepTopicProgressRecord {
  /** `${sessionId}::${topicId}` */
  key: string
  sessionId: string
  topicId: string
  status: 'locked' | 'unlocked' | 'mastered'
  masteryAccumulated: number
  turns: PrepTurn[]
  /** Cached teaching overview (markdown) shown before practice. */
  overview?: string
  /** Per-KC mastery tracking. */
  kcMastery?: Record<string, KCMasteryRecord>
}

/** Item in the retry queue — a failed concept to re-test after a delay. */
export interface RetryItem {
  topicId: string
  kcId?: string
  questionsUntilRetry: number
}

/**
 * Ensure a CurriculumTopic has KCs — legacy topics without them get a single
 * fallback KC with the topic title.
 */
export function ensureKCs(topic: CurriculumTopic): KnowledgeComponent[] {
  if (topic.knowledgeComponents?.length) return topic.knowledgeComponents
  return [{ id: 'kc0', label: topic.title }]
}

export interface PDFRecord {
  filename: string
  blob: Blob
  byteSize: number
  addedAt: number
}

export interface ThumbnailRecord {
  filename: string
  dataURL: string
  generatedAt: number
}

export interface LibraryEntry {
  filename: string
  sessionName: string
  lastOpenedAt: number
  activeSlideIndex: number
  numPages: number
  notesCount: number
  byteSize: number
}

interface LectureNoteDB extends DBSchema {
  notes: {
    key: string
    value: NoteRecord
    indexes: { 'by-filename': string }
  }
  chats: {
    key: string
    value: ChatRecord
    indexes: { 'by-filename': string }
  }
  prepSessions: {
    key: string
    value: PrepSessionRecord
  }
  prepTopicProgress: {
    key: string
    value: PrepTopicProgressRecord
    indexes: { 'by-session': string }
  }
  sessions: {
    key: string
    value: SessionRecord
  }
  pdfs: {
    key: string
    value: PDFRecord
  }
  thumbnails: {
    key: string
    value: ThumbnailRecord
  }
  meta: {
    key: string
    value: { key: string; value: string }
  }
}

let dbPromise: Promise<IDBPDatabase<LectureNoteDB>> | null = null

export function getDB(): Promise<IDBPDatabase<LectureNoteDB>> {
  if (!dbPromise) {
    dbPromise = openDB<LectureNoteDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const notes = db.createObjectStore('notes', { keyPath: 'key' })
          notes.createIndex('by-filename', 'filename')
          db.createObjectStore('sessions', { keyPath: 'filename' })
          db.createObjectStore('meta', { keyPath: 'key' })
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains('pdfs')) {
            db.createObjectStore('pdfs', { keyPath: 'filename' })
          }
        }
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains('thumbnails')) {
            db.createObjectStore('thumbnails', { keyPath: 'filename' })
          }
        }
        if (oldVersion < 4) {
          if (!db.objectStoreNames.contains('chats')) {
            const chats = db.createObjectStore('chats', { keyPath: 'key' })
            chats.createIndex('by-filename', 'filename')
          }
        }
        if (oldVersion < 5) {
          if (!db.objectStoreNames.contains('prepSessions')) {
            db.createObjectStore('prepSessions', { keyPath: 'sessionId' })
          }
          if (!db.objectStoreNames.contains('prepTopicProgress')) {
            const prog = db.createObjectStore('prepTopicProgress', {
              keyPath: 'key',
            })
            prog.createIndex('by-session', 'sessionId')
          }
        }
      },
    })
  }
  return dbPromise
}

export function noteKey(filename: string, slideIndex: number): string {
  return `${filename}::${slideIndex}`
}

export async function getNote(filename: string, slideIndex: number): Promise<string> {
  const db = await getDB()
  const rec = await db.get('notes', noteKey(filename, slideIndex))
  return rec?.markdown ?? ''
}

export async function setNote(
  filename: string,
  slideIndex: number,
  markdown: string,
): Promise<void> {
  const db = await getDB()
  await db.put('notes', {
    key: noteKey(filename, slideIndex),
    filename,
    slideIndex,
    markdown,
    updatedAt: Date.now(),
  })
}

export async function getAllNotesForFile(
  filename: string,
): Promise<Map<number, string>> {
  const db = await getDB()
  const all = await db.getAllFromIndex('notes', 'by-filename', filename)
  const map = new Map<number, string>()
  for (const r of all) map.set(r.slideIndex, r.markdown)
  return map
}

export async function countNotesForFile(filename: string): Promise<number> {
  const db = await getDB()
  const all = await db.getAllFromIndex('notes', 'by-filename', filename)
  return all.reduce((acc, r) => (r.markdown.trim() ? acc + 1 : acc), 0)
}

export function chatKey(filename: string, slideIndex: number): string {
  return `${filename}::${slideIndex}`
}

export async function getAllChatsForFile(
  filename: string,
): Promise<Map<number, ChatTurnRecord[]>> {
  const db = await getDB()
  const all = await db.getAllFromIndex('chats', 'by-filename', filename)
  const map = new Map<number, ChatTurnRecord[]>()
  for (const r of all) map.set(r.slideIndex, r.turns)
  return map
}

export async function setChat(
  filename: string,
  slideIndex: number,
  turns: ChatTurnRecord[],
): Promise<void> {
  const db = await getDB()
  const key = chatKey(filename, slideIndex)
  if (turns.length === 0) {
    await db.delete('chats', key)
    return
  }
  await db.put('chats', {
    key,
    filename,
    slideIndex,
    turns,
    updatedAt: Date.now(),
  })
}

// --- Test Prep CRUD ---------------------------------------------------------

export function progressKey(sessionId: string, topicId: string): string {
  return `${sessionId}::${topicId}`
}

export async function createPrepSession(
  record: PrepSessionRecord,
): Promise<void> {
  const db = await getDB()
  await db.put('prepSessions', record)
}

export async function getPrepSession(
  sessionId: string,
): Promise<PrepSessionRecord | undefined> {
  const db = await getDB()
  const rec = await db.get('prepSessions', sessionId)
  if (rec) rec.difficulty = normalizeDifficulty(rec.difficulty)
  return rec
}

export async function listPrepSessions(): Promise<PrepSessionRecord[]> {
  const db = await getDB()
  const all = await db.getAll('prepSessions')
  for (const rec of all) rec.difficulty = normalizeDifficulty(rec.difficulty)
  all.sort((a, b) => b.updatedAt - a.updatedAt)
  return all
}

export async function updatePrepSession(
  record: PrepSessionRecord,
): Promise<void> {
  const db = await getDB()
  await db.put('prepSessions', { ...record, updatedAt: Date.now() })
}

export async function deletePrepSession(sessionId: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['prepSessions', 'prepTopicProgress'], 'readwrite')
  const idx = tx.objectStore('prepTopicProgress').index('by-session')
  let cursor = await idx.openCursor(IDBKeyRange.only(sessionId))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.objectStore('prepSessions').delete(sessionId)
  await tx.done
}

export async function resetSessionProgress(
  sessionId: string,
): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('prepTopicProgress', 'readwrite')
  const idx = tx.store.index('by-session')
  let cursor = await idx.openCursor(IDBKeyRange.only(sessionId))
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}

export async function getAllProgressForSession(
  sessionId: string,
): Promise<Map<string, PrepTopicProgressRecord>> {
  const db = await getDB()
  const all = await db.getAllFromIndex(
    'prepTopicProgress',
    'by-session',
    sessionId,
  )
  const map = new Map<string, PrepTopicProgressRecord>()
  for (const r of all) map.set(r.topicId, r)
  return map
}

export async function putTopicProgress(
  record: PrepTopicProgressRecord,
): Promise<void> {
  const db = await getDB()
  await db.put('prepTopicProgress', record)
}

export async function getSession(filename: string): Promise<SessionRecord | undefined> {
  const db = await getDB()
  return db.get('sessions', filename)
}

export async function ensureSession(
  filename: string,
  defaultName: string,
): Promise<void> {
  const db = await getDB()
  const existing = await db.get('sessions', filename)
  if (existing) {
    await db.put('sessions', { ...existing, lastOpenedAt: Date.now() })
  } else {
    await db.put('sessions', {
      filename,
      sessionName: defaultName,
      lastOpenedAt: Date.now(),
    })
  }
}

export async function renameSession(
  filename: string,
  sessionName: string,
): Promise<void> {
  const db = await getDB()
  const existing = await db.get('sessions', filename)
  if (!existing) return
  await db.put('sessions', { ...existing, sessionName })
}

export async function setActiveSlide(
  filename: string,
  activeSlideIndex: number,
): Promise<void> {
  const db = await getDB()
  const existing = await db.get('sessions', filename)
  if (!existing) return
  await db.put('sessions', {
    ...existing,
    activeSlideIndex,
    lastOpenedAt: Date.now(),
  })
}

export async function setNumPages(
  filename: string,
  numPages: number,
): Promise<void> {
  const db = await getDB()
  const existing = await db.get('sessions', filename)
  if (!existing) return
  if (existing.numPages === numPages) return
  await db.put('sessions', { ...existing, numPages })
}

export async function getLastFilename(): Promise<string | null> {
  const db = await getDB()
  const rec = await db.get('meta', 'lastFilename')
  return rec?.value ?? null
}

export async function setLastFilename(filename: string): Promise<void> {
  const db = await getDB()
  await db.put('meta', { key: 'lastFilename', value: filename })
}

export async function clearLastFilename(): Promise<void> {
  const db = await getDB()
  await db.delete('meta', 'lastFilename')
}

export class QuotaExceededWhileSavingPDF extends Error {
  constructor() {
    super('Browser storage is full — PDF not saved to library.')
    this.name = 'QuotaExceededWhileSavingPDF'
  }
}

export async function savePDF(filename: string, blob: Blob): Promise<void> {
  const db = await getDB()
  const record: PDFRecord = {
    filename,
    blob,
    byteSize: blob.size,
    addedAt: Date.now(),
  }
  try {
    await db.put('pdfs', record)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      throw new QuotaExceededWhileSavingPDF()
    }
    throw e
  }
}

export async function getPDF(filename: string): Promise<Blob | undefined> {
  const db = await getDB()
  const rec = await db.get('pdfs', filename)
  return rec?.blob
}

export async function hasPDF(filename: string): Promise<boolean> {
  const db = await getDB()
  const keys = await db.getAllKeys('pdfs', IDBKeyRange.only(filename))
  return keys.length > 0
}

export async function getThumbnail(filename: string): Promise<string | undefined> {
  const db = await getDB()
  const rec = await db.get('thumbnails', filename)
  return rec?.dataURL
}

export async function setThumbnail(
  filename: string,
  dataURL: string,
): Promise<void> {
  const db = await getDB()
  await db.put('thumbnails', { filename, dataURL, generatedAt: Date.now() })
}

export async function deleteLectureEntry(filename: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(
    ['pdfs', 'sessions', 'notes', 'thumbnails', 'chats'],
    'readwrite',
  )
  const deleteByFilenameIndex = async (
    store: 'notes' | 'chats',
  ): Promise<void> => {
    const idx = tx.objectStore(store).index('by-filename')
    let cursor = await idx.openCursor(IDBKeyRange.only(filename))
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }
  }
  await Promise.all([
    tx.objectStore('pdfs').delete(filename),
    tx.objectStore('sessions').delete(filename),
    tx.objectStore('thumbnails').delete(filename),
    deleteByFilenameIndex('notes'),
    deleteByFilenameIndex('chats'),
  ])
  await tx.done
  const last = await getLastFilename()
  if (last === filename) await clearLastFilename()
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  const db = await getDB()
  const sessions = await db.getAll('sessions')
  const entries: LibraryEntry[] = []
  for (const s of sessions) {
    const pdfRec = await db.get('pdfs', s.filename)
    if (!pdfRec) continue
    const notesCount = await countNotesForFile(s.filename)
    entries.push({
      filename: s.filename,
      sessionName: s.sessionName,
      lastOpenedAt: s.lastOpenedAt,
      activeSlideIndex: s.activeSlideIndex ?? 0,
      numPages: s.numPages ?? 0,
      notesCount,
      byteSize: pdfRec.byteSize,
    })
  }
  entries.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  return entries
}
