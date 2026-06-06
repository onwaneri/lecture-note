// Persistence layer — Firebase backed.
//
// Data records live in Firestore under `users/{uid}/...` (synced + offline via
// persistentLocalCache). PDF bytes live in Cloud Storage (`users/{uid}/pdfs/...`)
// with a local IndexedDB byte cache (pdfCache.ts) for instant/offline access.
// Thumbnails are local-only (regenerable). The exported API is unchanged from the
// old IndexedDB implementation so no call site needed to change.

import {
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  writeBatch,
  type DocumentReference,
} from 'firebase/firestore'
import {
  deleteObject,
  getBytes,
  ref as storageRef,
  uploadBytes,
} from 'firebase/storage'
import { getDb, getFirebaseStorage, requireUid } from './firebase'
import {
  cacheDeletePDF,
  cacheDeleteThumb,
  cacheGetPDF,
  cacheGetThumb,
  cachePutPDF,
  cachePutThumb,
} from './pdfCache'

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
  /** Key into the PDF store / Storage. */
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
  byteSize: number
  addedAt: number
  storagePath: string
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

// --- Firestore plumbing -----------------------------------------------------

/** Firestore doc IDs can't contain '/'. Encode keys to a safe id. */
function did(key: string): string {
  return encodeURIComponent(key)
}

/** A per-user collection reference. */
function col(name: string) {
  return collection(getDb(), 'users', requireUid(), name)
}

/** A per-user document reference (id sanitized). */
function dref(name: string, id: string) {
  return doc(getDb(), 'users', requireUid(), name, did(id))
}

/**
 * Delete an arbitrary number of docs, chunked under Firestore's 500-op-per-batch
 * limit (kept at 450 for headroom). A heavily-annotated deck can have hundreds of
 * note + chat docs, which would overflow a single writeBatch.
 */
const BATCH_LIMIT = 450
async function deleteRefsInChunks(refs: DocumentReference[]): Promise<void> {
  for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
    const batch = writeBatch(getDb())
    for (const ref of refs.slice(i, i + BATCH_LIMIT)) batch.delete(ref)
    await batch.commit()
  }
}

// --- Notes ------------------------------------------------------------------

export function noteKey(filename: string, slideIndex: number): string {
  return `${filename}::${slideIndex}`
}

export async function getNote(filename: string, slideIndex: number): Promise<string> {
  const snap = await getDoc(dref('notes', noteKey(filename, slideIndex)))
  return (snap.data() as NoteRecord | undefined)?.markdown ?? ''
}

export async function setNote(
  filename: string,
  slideIndex: number,
  markdown: string,
): Promise<void> {
  const key = noteKey(filename, slideIndex)
  // Don't persist empty notes — delete instead, mirroring setChat. This keeps
  // every stored note doc non-empty, so countNotesForFile can use a cheap
  // server-side count without an index or downloading bodies.
  if (!markdown.trim()) {
    await deleteDoc(dref('notes', key))
    return
  }
  await setDoc(dref('notes', key), {
    key,
    filename,
    slideIndex,
    markdown,
    updatedAt: Date.now(),
  } satisfies NoteRecord)
}

export async function getAllNotesForFile(
  filename: string,
): Promise<Map<number, string>> {
  const snaps = await getDocs(query(col('notes'), where('filename', '==', filename)))
  const map = new Map<number, string>()
  snaps.forEach((s) => {
    const r = s.data() as NoteRecord
    map.set(r.slideIndex, r.markdown)
  })
  return map
}

export async function countNotesForFile(filename: string): Promise<number> {
  // Server-side aggregation — counts matching docs without downloading them.
  // All stored notes are non-empty (see setNote), so a plain count is accurate.
  const q = query(col('notes'), where('filename', '==', filename))
  try {
    const snap = await getCountFromServer(q)
    return snap.data().count
  } catch {
    // Aggregation requires the server; offline, count from the local cache.
    const snaps = await getDocs(q)
    return snaps.size
  }
}

// --- Chats ------------------------------------------------------------------

export function chatKey(filename: string, slideIndex: number): string {
  return `${filename}::${slideIndex}`
}

export async function getAllChatsForFile(
  filename: string,
): Promise<Map<number, ChatTurnRecord[]>> {
  const snaps = await getDocs(query(col('chats'), where('filename', '==', filename)))
  const map = new Map<number, ChatTurnRecord[]>()
  snaps.forEach((s) => {
    const r = s.data() as ChatRecord
    map.set(r.slideIndex, r.turns)
  })
  return map
}

export async function setChat(
  filename: string,
  slideIndex: number,
  turns: ChatTurnRecord[],
): Promise<void> {
  const key = chatKey(filename, slideIndex)
  if (turns.length === 0) {
    await deleteDoc(dref('chats', key))
    return
  }
  await setDoc(dref('chats', key), {
    key,
    filename,
    slideIndex,
    turns,
    updatedAt: Date.now(),
  } satisfies ChatRecord)
}

// --- Test Prep CRUD ---------------------------------------------------------

export function progressKey(sessionId: string, topicId: string): string {
  return `${sessionId}::${topicId}`
}

export async function createPrepSession(record: PrepSessionRecord): Promise<void> {
  await setDoc(dref('prepSessions', record.sessionId), record)
}

export async function getPrepSession(
  sessionId: string,
): Promise<PrepSessionRecord | undefined> {
  const snap = await getDoc(dref('prepSessions', sessionId))
  const rec = snap.data() as PrepSessionRecord | undefined
  if (rec) rec.difficulty = normalizeDifficulty(rec.difficulty)
  return rec
}

export async function listPrepSessions(): Promise<PrepSessionRecord[]> {
  const snaps = await getDocs(col('prepSessions'))
  const all: PrepSessionRecord[] = []
  snaps.forEach((s) => {
    const rec = s.data() as PrepSessionRecord
    rec.difficulty = normalizeDifficulty(rec.difficulty)
    all.push(rec)
  })
  all.sort((a, b) => b.updatedAt - a.updatedAt)
  return all
}

export async function updatePrepSession(record: PrepSessionRecord): Promise<void> {
  await setDoc(dref('prepSessions', record.sessionId), {
    ...record,
    updatedAt: Date.now(),
  })
}

export async function deletePrepSession(sessionId: string): Promise<void> {
  const progressSnaps = await getDocs(
    query(col('prepProgress'), where('sessionId', '==', sessionId)),
  )
  const refs: DocumentReference[] = []
  progressSnaps.forEach((s) => refs.push(s.ref))
  refs.push(dref('prepSessions', sessionId))
  await deleteRefsInChunks(refs)
}

export async function resetSessionProgress(sessionId: string): Promise<void> {
  const snaps = await getDocs(
    query(col('prepProgress'), where('sessionId', '==', sessionId)),
  )
  const refs: DocumentReference[] = []
  snaps.forEach((s) => refs.push(s.ref))
  await deleteRefsInChunks(refs)
}

export async function getAllProgressForSession(
  sessionId: string,
): Promise<Map<string, PrepTopicProgressRecord>> {
  const snaps = await getDocs(
    query(col('prepProgress'), where('sessionId', '==', sessionId)),
  )
  const map = new Map<string, PrepTopicProgressRecord>()
  snaps.forEach((s) => {
    const r = s.data() as PrepTopicProgressRecord
    map.set(r.topicId, r)
  })
  return map
}

export async function putTopicProgress(
  record: PrepTopicProgressRecord,
): Promise<void> {
  await setDoc(dref('prepProgress', record.key), record)
}

// --- Sessions ---------------------------------------------------------------

export async function getSession(filename: string): Promise<SessionRecord | undefined> {
  const snap = await getDoc(dref('sessions', filename))
  return snap.data() as SessionRecord | undefined
}

export async function ensureSession(
  filename: string,
  defaultName: string,
): Promise<void> {
  const existing = await getSession(filename)
  if (existing) {
    await setDoc(dref('sessions', filename), { lastOpenedAt: Date.now() }, { merge: true })
  } else {
    await setDoc(dref('sessions', filename), {
      filename,
      sessionName: defaultName,
      lastOpenedAt: Date.now(),
    } satisfies SessionRecord)
  }
}

export async function renameSession(
  filename: string,
  sessionName: string,
): Promise<void> {
  const existing = await getSession(filename)
  if (!existing) return
  await setDoc(dref('sessions', filename), { sessionName }, { merge: true })
}

export async function setActiveSlide(
  filename: string,
  activeSlideIndex: number,
): Promise<void> {
  const existing = await getSession(filename)
  if (!existing) return
  await setDoc(
    dref('sessions', filename),
    { activeSlideIndex, lastOpenedAt: Date.now() },
    { merge: true },
  )
}

export async function setNumPages(filename: string, numPages: number): Promise<void> {
  const existing = await getSession(filename)
  if (!existing) return
  if (existing.numPages === numPages) return
  await setDoc(dref('sessions', filename), { numPages }, { merge: true })
}

// --- Meta -------------------------------------------------------------------

export async function getLastFilename(): Promise<string | null> {
  const snap = await getDoc(dref('meta', 'lastFilename'))
  return (snap.data() as { value: string } | undefined)?.value ?? null
}

export async function setLastFilename(filename: string): Promise<void> {
  await setDoc(dref('meta', 'lastFilename'), { key: 'lastFilename', value: filename })
}

export async function clearLastFilename(): Promise<void> {
  await deleteDoc(dref('meta', 'lastFilename'))
}

// --- PDFs (Cloud Storage + local cache) -------------------------------------

function pdfStoragePath(filename: string): string {
  return `users/${requireUid()}/pdfs/${encodeURIComponent(filename)}`
}

function pdfRef(filename: string) {
  return storageRef(getFirebaseStorage(), pdfStoragePath(filename))
}

export async function savePDF(filename: string, blob: Blob): Promise<void> {
  // Cache locally first (instant + offline); Storage is the durable synced copy.
  await cachePutPDF(filename, blob)
  await uploadBytes(pdfRef(filename), blob, { contentType: 'application/pdf' })
  await setDoc(dref('pdfMeta', filename), {
    filename,
    byteSize: blob.size,
    addedAt: Date.now(),
    storagePath: pdfStoragePath(filename),
  } satisfies PDFRecord)
}

export async function getPDF(filename: string): Promise<Blob | undefined> {
  const cached = await cacheGetPDF(filename)
  if (cached) return cached
  try {
    const bytes = await getBytes(pdfRef(filename))
    const blob = new Blob([bytes], { type: 'application/pdf' })
    await cachePutPDF(filename, blob)
    return blob
  } catch (e) {
    // Not found, offline + uncached, or permission — caller handles undefined.
    console.warn('getPDF download failed', filename, e)
    return undefined
  }
}

export async function hasPDF(filename: string): Promise<boolean> {
  if (await cacheGetPDF(filename)) return true
  const snap = await getDoc(dref('pdfMeta', filename))
  return snap.exists()
}

export async function getThumbnail(filename: string): Promise<string | undefined> {
  return cacheGetThumb(filename)
}

export async function setThumbnail(filename: string, dataURL: string): Promise<void> {
  await cachePutThumb(filename, dataURL)
}

export async function deleteLectureEntry(filename: string): Promise<void> {
  // Firestore: session + pdfMeta + all notes/chats for this file.
  const [noteSnaps, chatSnaps] = await Promise.all([
    getDocs(query(col('notes'), where('filename', '==', filename))),
    getDocs(query(col('chats'), where('filename', '==', filename))),
  ])
  const refs: DocumentReference[] = []
  noteSnaps.forEach((s) => refs.push(s.ref))
  chatSnaps.forEach((s) => refs.push(s.ref))
  refs.push(dref('sessions', filename), dref('pdfMeta', filename))
  await deleteRefsInChunks(refs)

  // Storage object + local caches.
  await deleteObject(pdfRef(filename)).catch(() => {
    /* already gone / offline */
  })
  await Promise.all([cacheDeletePDF(filename), cacheDeleteThumb(filename)])

  const last = await getLastFilename()
  if (last === filename) await clearLastFilename()
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  const sessionSnaps = await getDocs(col('sessions'))
  const sessions: SessionRecord[] = []
  sessionSnaps.forEach((s) => sessions.push(s.data() as SessionRecord))

  const entries: LibraryEntry[] = []
  await Promise.all(
    sessions.map(async (s) => {
      const metaSnap = await getDoc(dref('pdfMeta', s.filename))
      if (!metaSnap.exists()) return
      const meta = metaSnap.data() as PDFRecord
      const notesCount = await countNotesForFile(s.filename)
      entries.push({
        filename: s.filename,
        sessionName: s.sessionName,
        lastOpenedAt: s.lastOpenedAt,
        activeSlideIndex: s.activeSlideIndex ?? 0,
        numPages: s.numPages ?? 0,
        notesCount,
        byteSize: meta.byteSize,
      })
    }),
  )
  entries.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  return entries
}
