import { useCallback, useEffect, useState } from 'react'
import {
  deletePrepSession,
  getAllProgressForSession,
  listPrepSessions,
  type PrepDifficulty,
  type PrepSessionRecord,
} from '../../lib/db'
import { PrepSetup, type PrepSetupResult } from './PrepSetup'
import { PrepProcessing } from './PrepProcessing'
import { PrepStudy } from './PrepStudy'
import { PrepHeader } from './PrepHeader'

type Phase = 'home' | 'setup' | 'processing' | 'study'

const DIFF_LABEL: Record<PrepDifficulty, string> = {
  foundational: 'Foundational',
  thorough: 'Thorough',
  'exam-ready': 'Exam-ready',
}
/** Difficulty → diff-pill modifier class (design uses `exam`, not `exam-ready`). */
const DIFF_PILL: Record<PrepDifficulty, string> = {
  foundational: 'foundational',
  thorough: 'thorough',
  'exam-ready': 'exam',
}

interface TestPrepModeProps {
  /** Library files available to pull into a session. */
  onExit: () => void
}

export function TestPrepMode({ onExit }: TestPrepModeProps) {
  const [phase, setPhase] = useState<Phase>('home')
  const [sessions, setSessions] = useState<PrepSessionRecord[]>([])
  const [masteredCounts, setMasteredCounts] = useState<Record<string, number>>(
    {},
  )
  const [setupResult, setSetupResult] = useState<PrepSetupResult | null>(null)
  const [activeSession, setActiveSession] = useState<PrepSessionRecord | null>(
    null,
  )

  const refresh = useCallback(async () => {
    const list = await listPrepSessions()
    setSessions(list)
    // Live per-session mastered counts for the progress column.
    const entries = await Promise.all(
      list.map(async (s) => {
        const prog = await getAllProgressForSession(s.sessionId)
        let mastered = 0
        prog.forEach((r) => {
          if (r.status === 'mastered') mastered++
        })
        return [s.sessionId, mastered] as const
      }),
    )
    setMasteredCounts(Object.fromEntries(entries))
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
    <div className="prep-screen">
      <PrepHeader
        center={
          <>
            <div className="prep-eyebrow">Test Prep</div>
            <span className="prep-chip">
              {sessions.length} session{sessions.length === 1 ? '' : 's'}
            </span>
          </>
        }
        right={
          <>
            <button type="button" className="ate-btn" onClick={onExit}>
              Back to notes
            </button>
            <button
              type="button"
              className="ate-btn ate-btn-primary"
              onClick={() => setPhase('setup')}
            >
              New session →
            </button>
          </>
        }
      />
      <div className="prep-home-body">
        <div className="prep-home-left">
          <div className="prep-eyebrow">Test Prep</div>
          <h1 className="prep-display prep-home-heading">
            Master the material, <em>one topic at a time.</em>
          </h1>
          <p className="prep-home-sub">
            Pull in your slides, homework, and a practice exam. Doug maps the
            scope, then drills you with graded questions until each topic is
            mastered — foundations first, but the order is yours.
          </p>
          <div className="prep-home-ctas">
            <button
              type="button"
              className="ate-btn ate-btn-primary"
              onClick={() => setPhase('setup')}
            >
              New prep session →
            </button>
            <button type="button" className="ate-btn" onClick={onExit}>
              Back to notes
            </button>
          </div>
        </div>

        <div className="prep-home-right">
          <div className="prep-home-right-head">
            <div className="prep-home-right-title">Sessions</div>
            <span className="prep-chip">{sessions.length} total</span>
          </div>
          {sessions.length > 0 ? (
            <div className="prep-sessions-list">
              {sessions.map((s, i) => {
                const total = s.blueprint.topics.length
                const mastered = masteredCounts[s.sessionId] ?? 0
                const done =
                  s.status === 'completed' || (total > 0 && mastered >= total)
                const pct = total > 0 ? Math.round((mastered / total) * 100) : 0
                return (
                  <div
                    key={s.sessionId}
                    className="prep-session-row"
                    onClick={() => openSession(s)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="prep-session-n">
                      {String(i + 1).padStart(2, '0')}
                    </div>
                    <div className="prep-session-info">
                      <div className="prep-session-title">{s.title}</div>
                      <div className="prep-session-meta">
                        <span className={`prep-diff-pill ${DIFF_PILL[s.difficulty]}`}>
                          {DIFF_LABEL[s.difficulty]}
                        </span>
                        <span className="prep-session-docs">
                          {total} topics · {s.documents.length} source
                          {s.documents.length === 1 ? '' : 's'}
                        </span>
                      </div>
                    </div>
                    <div className="prep-session-prog">
                      <div className="prep-prog-bar">
                        <div
                          className={`prep-prog-fill${done ? ' done' : ''}`}
                          style={{ width: `${done ? 100 : pct}%` }}
                        />
                      </div>
                      <div className={`prep-session-status${done ? ' done' : ''}`}>
                        {done ? '✓ Complete' : `${mastered} / ${total} mastered`}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="prep-session-del"
                      title="Delete session"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDelete(s.sessionId)
                      }}
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
      </div>
    </div>
  )
}
