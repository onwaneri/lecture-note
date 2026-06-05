import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth'
import { getFirebaseAuth, hasFirebaseConfig } from '../lib/firebase'

/** Sign the current user out (exported for a future header affordance). */
export function signOutUser(): Promise<void> {
  return signOut(getFirebaseAuth())
}

interface AuthGateProps {
  children: ReactNode
}

/**
 * Gates the whole app behind Google sign-in. Renders children only once a user
 * is authenticated, so every downstream `db.ts` call has a known uid to scope to.
 */
export function AuthGate({ children }: AuthGateProps) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!hasFirebaseConfig()) {
      setLoading(false)
      return
    }
    return onAuthStateChanged(getFirebaseAuth(), (u) => {
      setUser(u)
      setLoading(false)
    })
  }, [])

  if (!hasFirebaseConfig()) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-title">Firebase not configured</div>
          <p className="auth-sub">
            Add your <code>VITE_FIREBASE_*</code> values to <code>.env.local</code>{' '}
            and restart the dev server.
          </p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-spinner" aria-hidden="true" />
          <div className="auth-sub">Loading…</div>
        </div>
      </div>
    )
  }

  if (!user) return <SignIn />

  return <>{children}</>
}

/** Map Firebase auth error codes to friendly messages. */
function authErrorMessage(e: unknown): string | null {
  const code = (e as { code?: string })?.code
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null // user dismissed — stay quiet
    case 'auth/invalid-email':
      return 'That email address looks invalid.'
    case 'auth/missing-password':
      return 'Enter a password.'
    case 'auth/weak-password':
      return 'Password should be at least 6 characters.'
    case 'auth/email-already-in-use':
      return 'An account already exists for that email — try signing in.'
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password.'
    default:
      return e instanceof Error ? e.message : 'Authentication failed.'
  }
}

type Mode = 'signin' | 'signup'

function SignIn() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGoogle() {
    setBusy(true)
    setError(null)
    try {
      await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider())
    } catch (e) {
      setError(authErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleEmail(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const auth = getFirebaseAuth()
      if (mode === 'signup') {
        await createUserWithEmailAndPassword(auth, email.trim(), password)
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand auth-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">
            Lecture<em>note</em>
          </span>
        </div>
        <h1 className="auth-title">
          {mode === 'signup' ? 'Create your account' : 'Sign in to study'}
        </h1>
        <p className="auth-sub">
          Your notes, library, and test-prep progress sync to your account across
          devices.
        </p>

        <button
          type="button"
          className="ate-btn auth-google"
          onClick={handleGoogle}
          disabled={busy}
        >
          Continue with Google
        </button>

        <div className="auth-divider">
          <span>or</span>
        </div>

        <form className="auth-form" onSubmit={handleEmail}>
          <input
            className="auth-input"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            disabled={busy}
            required
          />
          <input
            className="auth-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            disabled={busy}
            required
          />
          <button
            type="submit"
            className="ate-btn ate-btn-primary auth-google"
            disabled={busy || !email.trim() || !password}
          >
            {busy
              ? 'Working…'
              : mode === 'signup'
                ? 'Create account'
                : 'Sign in'}
          </button>
        </form>

        <button
          type="button"
          className="auth-toggle"
          onClick={() => {
            setMode((m) => (m === 'signin' ? 'signup' : 'signin'))
            setError(null)
          }}
          disabled={busy}
        >
          {mode === 'signin'
            ? "Don't have an account? Create one"
            : 'Already have an account? Sign in'}
        </button>

        {error ? <div className="auth-error">{error}</div> : null}
      </div>
    </div>
  )
}
