// Firebase singletons — app, auth (Google), Firestore (offline persistence), and
// Cloud Storage. Config comes from VITE_FIREBASE_* env vars (web config keys are
// not secret; access is gated by Auth + per-user security rules).

import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore'
import { getStorage, type FirebaseStorage } from 'firebase/storage'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

let app: FirebaseApp | null = null
let authInstance: Auth | null = null
let dbInstance: Firestore | null = null
let storageInstance: FirebaseStorage | null = null

function getApp(): FirebaseApp {
  if (!app) app = initializeApp(firebaseConfig)
  return app
}

export function getFirebaseAuth(): Auth {
  if (!authInstance) authInstance = getAuth(getApp())
  return authInstance
}

export function getDb(): Firestore {
  if (!dbInstance) {
    // Offline-first: persistent IndexedDB-backed cache with multi-tab support.
    // `ignoreUndefinedProperties` lets us write records with optional fields
    // (e.g. PrepTurn.suggestedSlide) without stripping undefined by hand.
    dbInstance = initializeFirestore(getApp(), {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
      ignoreUndefinedProperties: true,
    })
  }
  return dbInstance
}

export function getFirebaseStorage(): FirebaseStorage {
  if (!storageInstance) storageInstance = getStorage(getApp())
  return storageInstance
}

/** Whether Firebase config is present (drives a setup hint if missing). */
export function hasFirebaseConfig(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId)
}

/** The signed-in user's uid, or null. */
export function currentUid(): string | null {
  return getFirebaseAuth().currentUser?.uid ?? null
}

/** The signed-in user's uid; throws if not signed in (AuthGate prevents this). */
export function requireUid(): string {
  const uid = currentUid()
  if (!uid) throw new Error('Not signed in — Firebase user is required.')
  return uid
}
