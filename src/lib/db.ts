import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

const DB_NAME = 'lecturenote-db'
const DB_VERSION = 3

export interface NoteRecord {
  key: string
  filename: string
  slideIndex: number
  markdown: string
  updatedAt: number
}

export interface SessionRecord {
  filename: string
  sessionName: string
  lastOpenedAt: number
  activeSlideIndex?: number
  numPages?: number
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
    ['pdfs', 'sessions', 'notes', 'thumbnails'],
    'readwrite',
  )
  await Promise.all([
    tx.objectStore('pdfs').delete(filename),
    tx.objectStore('sessions').delete(filename),
    tx.objectStore('thumbnails').delete(filename),
    (async () => {
      const notesStore = tx.objectStore('notes')
      const idx = notesStore.index('by-filename')
      let cursor = await idx.openCursor(IDBKeyRange.only(filename))
      while (cursor) {
        await cursor.delete()
        cursor = await cursor.continue()
      }
    })(),
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
