import { useCallback, useEffect, useState } from 'react'
import {
  deletePrepSession,
  listPrepSessions,
  MASTERY_THRESHOLDS,
  type PrepSessionRecord,
} from '../../lib/db'
import { PrepSetup, type PrepSetupResult } from './PrepSetup'
import { PrepProcessing } from './PrepProcessing'
import { PrepStudy } from './PrepStudy'

type Phase = 'home' | 'setup' | 'processing' | 'study'

interface TestPrepModeProps {
  /** Library files available to pull into a session. */
  onExit: () => void
}

export function TestPrepMode({ onExit }: TestPrepModeProps) {
  const [phase, setPhase] = useState<Phase>('home')
  const [sessions, setSessions] = useState<PrepSessionRecord[]>([])
  const [setupResult, setSetupResult] = useState<PrepSetupResult | null>(null)
  const [activeSession, setActiveSession] = useState<PrepSessionRecord | null>(
    null,
  )

  const refresh = useCallback(async () => {
    setSessions(await listPrepSessions())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openSession = useCallback((s: PrepSessionRecord) => {
    setActiveSession(s)
    setPhase('study')
  }, [])

  async function handleDelete(sessionId: string) {
    if (!confirm('Delete this prep session and all its progress?')) return
    await deletePrepSession(sessionId)
    await refresh()
  }

  if (phase === 'setup') {
    return (
      <PrepSetup
        onCancel={() => setPhase('home')}
        onStart={(result) => {
          setSetupResult(result)
          setPhase('processing')
        }}
      />
    )
  }

  if (phase === 'processing' && setupResult) {
    return (
      <PrepProcessing
        setup={setupResult}
        onCancel={() => setPhase('setup')}
        onDone={async (session) => {
          await refresh()
          openSession(session)
        }}
      />
    )
  }

  if (phase === 'study' && activeSession) {
    return (
      <PrepStudy
        session={activeSession}
        onExit={() => {
          setActiveSession(null)
          void refresh()
          setPhase('home')
        }}
      />
    )
  }

  // Home
  return (
    <div className="prep-home">
      <div className="prep-home-head">
        <div>
          <div className="prep-eyebrow">Test Prep Mode</div>
          <h1 className="prep-home-title">Master the material, one topic at a time.</h1>
          <p className="prep-home-sub">
            Pull in your slides, homework, and a practice exam. We map the
            scope, then drill you with graded questions until each topic is
            mastered.
          </p>
        </div>
        <div className="prep-home-actions">
          <button
            type="button"
            className="ate-btn ate-btn-primary"
            onClick={() => setPhase('setup')}
          >
            New prep session
          </button>
          <button type="button" className="ate-btn" onClick={onExit}>
            Back to notes
          </button>
        </div>
      </div>

      {sessions.length > 0 ? (
        <div className="prep-session-grid">
          {sessions.map((s) => {
            const total = s.blueprint.topics.length
            const perTopic = MASTERY_THRESHOLDS[s.difficulty]
            return (
              <div key={s.sessionId} className="prep-session-card">
                <button
                  type="button"
                  className="prep-session-open"
                  onClick={() => openSession(s)}
                >
                  <div className="prep-session-title">{s.title}</div>
                  <div className="prep-session-meta">
                    <span className={`prep-diff prep-diff-${s.difficulty}`}>
                      {s.difficulty}
                    </span>
                    <span>{total} topics</span>
                    <span>{perTopic} pts/topic</span>
                  </div>
                  <div className="prep-session-docs">
                    {s.documents.length} source
                    {s.documents.length === 1 ? '' : 's'} ·{' '}
                    {s.status === 'completed' ? 'Completed' : 'In progress'}
                  </div>
                </button>
                <button
                  type="button"
                  className="prep-session-del"
                  title="Delete"
                  onClick={() => handleDelete(s.sessionId)}
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="prep-empty">
          No prep sessions yet. Start one to map your study scope.
        </div>
      )}
    </div>
  )
}
