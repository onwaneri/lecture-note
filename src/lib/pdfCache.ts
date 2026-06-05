// Local IndexedDB cache for PDF bytes + thumbnails. This is the "fast + offline"
// half of the hybrid storage strategy: Cloud Storage is the durable synced copy,
// but a deck you've already opened is served instantly from here and keeps
// working offline. Thumbnails live here too (regenerable, not worth syncing).

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

interface CacheDB extends DBSchema {
  /** filename -> PDF blob */
  pdfBytes: { key: string; value: Blob }
  /** filename -> thumbnail dataURL */
  thumbnails: { key: string; value: string }
}

const DB_NAME = 'lecturenote-cache'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<CacheDB>> | null = null

function cacheDB(): Promise<IDBPDatabase<CacheDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CacheDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('pdfBytes')) {
          db.createObjectStore('pdfBytes')
        }
        if (!db.objectStoreNames.contains('thumbnails')) {
          db.createObjectStore('thumbnails')
        }
      },
    })
  }
  return dbPromise
}

export async function cacheGetPDF(filename: string): Promise<Blob | undefined> {
  try {
    return await (await cacheDB()).get('pdfBytes', filename)
  } catch (e) {
    console.warn('pdf cache read failed', e)
    return undefined
  }
}

export async function cachePutPDF(filename: string, blob: Blob): Promise<void> {
  try {
    await (await cacheDB()).put('pdfBytes', blob, filename)
  } catch (e) {
    // Local cache is best-effort (e.g. quota); the Storage copy is durable.
    console.warn('pdf cache write failed', e)
  }
}

export async function cacheDeletePDF(filename: string): Promise<void> {
  try {
    await (await cacheDB()).delete('pdfBytes', filename)
  } catch (e) {
    console.warn('pdf cache delete failed', e)
  }
}

export async function cacheGetThumb(filename: string): Promise<string | undefined> {
  try {
    return await (await cacheDB()).get('thumbnails', filename)
  } catch {
    return undefined
  }
}

export async function cachePutThumb(filename: string, dataURL: string): Promise<void> {
  try {
    await (await cacheDB()).put('thumbnails', dataURL, filename)
  } catch (e) {
    console.warn('thumb cache write failed', e)
  }
}

export async function cacheDeleteThumb(filename: string): Promise<void> {
  try {
    await (await cacheDB()).delete('thumbnails', filename)
  } catch {
    /* ignore */
  }
}
