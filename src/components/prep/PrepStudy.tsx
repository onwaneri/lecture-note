import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  MASTERY_CONFIGS,
  getAllProgressForSession,
  progressKey,
  putTopicProgress,
  resetSessionProgress,
  updatePrepSession,
  type KeySlide,
  type PrepSessionRecord,
  type PrepTopicProgressRecord,
  type PrepTurn,
  type RetryItem,
} from '../../lib/db'
import {
  canMarkMastered,
  onAnswerGraded,
  selectNextQuestion,
  type NextQuestion,
} from '../../lib/questionSelector'
import { createDocumentCache, generateOverview, generateQuestion, type GeneratedQuestion, type TopicOverview } from '../../lib/testPrep'
import { usePrepDocs } from '../../hooks/usePrepDocs'
import { CurriculumMap } from './CurriculumMap'
import { TopicSession } from './TopicSession'
import { ReferencePane } from './ReferencePane'
import { PrepChatPopup, type ChatMessage, type PrepChatContext } from './PrepChatPopup'

interface PrepStudyProps {
  session: PrepSessionRecord
  onExit: () => void
}

export interface SurfaceRequest {
  slide: KeySlide
  topicTitle: string
  nonce: number
  /** When true, navigate directly — skip the nudge banner. */
  force?: boolean
}

/** Parse a cached overview JSON string; null if absent/unparseable. */
function parseOverview(raw: string | undefined): TopicOverview | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as TopicOverview
    return parsed?.sections?.length ? parsed : null
  } catch {
    return null
  }
}

export function PrepStudy({ session, onExit }: PrepStudyProps) {
  const [progress, setProgress] = useState<
    Map<string, PrepTopicProgressRecord>
  >(new Map())
  const [ready, setReady] = useState(false)
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null)
  const [surface, setSurface] = useState<SurfaceRequest | null>(null)
  const [refCollapsed, setRefCollapsed] = useState(false)
  const [refWidth, setRefWidth] = useState<number | null>(null)
  const studyRef = useRef<HTMLDivElement | null>(null)
  const prepDocs = usePrepDocs()

  // Background overview generation state (per topic).
  const [overviewLoadingIds, setOverviewLoadingIds] = useState<Set<string>>(
    new Set(),
  )
  const [overviewErrors, setOverviewErrors] = useState<Map<string, string>>(
    new Map(),
  )
  const overviewInFlight = useRef<Set<string>>(new Set())
  // Latest progress, readable inside async generation without stale closures.
  const progressRef = useRef(progress)
  progressRef.current = progress

  // Session-scoped adaptive state (in-memory, not persisted).
  const retryQueueRef = useRef<RetryItem[]>([])
  const sessionTurnCountRef = useRef(0)
  const [targetQuestion, setTargetQuestion] = useState<NextQuestion | null>(null)

  // Per-topic question buffer — owned here (not in TopicSession) so generation
  // is pre-warmed concurrently and survives leaving the topic / switching tabs.
  // `current` = the displayed unanswered question (restored on remount);
  // `buffer` = a few questions queued ahead so "Next" is instant.
  const QUESTION_BUFFER = 3
  const qStoreRef = useRef<
    Map<string, { current: GeneratedQuestion | null; buffer: GeneratedQuestion[] }>
  >(new Map())
  const qFillingRef = useRef<Set<string>>(new Set())

  function qSlot(topicId: string) {
    let s = qStoreRef.current.get(topicId)
    if (!s) {
      s = { current: null, buffer: [] }
      qStoreRef.current.set(topicId, s)
    }
    return s
  }
  /** The topic's persisted pending list: [current?, ...buffer]. */
  const pendingOf = useCallback(
    (topicId: string): GeneratedQuestion[] | undefined => {
      const s = qStoreRef.current.get(topicId)
      if (!s) return undefined
      const arr = [...(s.current ? [s.current] : []), ...s.buffer]
      return arr.length ? arr : undefined
    },
    [],
  )
  // Persist the buffer into the topic's progress record (preserving the rest)
  // and re-render so `cachedQuestion` re-reads. Mirrors saveOverview's merge so
  // unanswered questions survive a full prep exit / reload.
  const syncPending = useCallback(
    (topicId: string) => {
      setProgress((prev) => {
        const existing = prev.get(topicId)
        const record: PrepTopicProgressRecord = {
          key: progressKey(session.sessionId, topicId),
          sessionId: session.sessionId,
          topicId,
          status: existing?.status ?? 'unlocked',
          masteryAccumulated: existing?.masteryAccumulated ?? 0,
          turns: existing?.turns ?? [],
          overview: existing?.overview,
          kcMastery: existing?.kcMastery,
          pendingQuestions: pendingOf(topicId),
        }
        void putTopicProgress(record)
        const next = new Map(prev)
        next.set(topicId, record)
        return next
      })
    },
    [session.sessionId, pendingOf],
  )

  // Server-side document cache (Gemini context caching) — created once per
  // session, reused across all overview generation calls.
  const docCacheRef = useRef<string | null>(null)
  const docCacheInitiated = useRef(false)

  useEffect(() => {
    if (docCacheInitiated.current) return
    docCacheInitiated.current = true
    createDocumentCache(session.documents).then((name) => {
      if (name) {
        docCacheRef.current = name
        console.info('[prep] document cache ready:', name)
      }
    }).catch((e) => {
      console.warn('[prep] document cache creation failed (will use inline)', e)
    })
  }, [session.documents])

  // Session-scoped chat state — persists across topics/questions.
  const [chatOpen, setChatOpen] = useState(false)
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [chatContext, setChatContext] = useState<PrepChatContext>({
    sessionTitle: session.title,
    difficulty: session.difficulty,
    topicTitle: '',
    topicSummary: '',
  })

  const config = MASTERY_CONFIGS[session.difficulty]

  // Drag the divider between the study pane and the reference pane.
  function startRefResize(e: ReactPointerEvent) {
    e.preventDefault()
    const root = studyRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    function onMove(ev: PointerEvent) {
      const w = Math.max(320, Math.min(rect.right - ev.clientX, rect.width - 380))
      setRefWidth(w)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  useEffect(() => {
    let cancelled = false
    getAllProgressForSession(session.sessionId).then((m) => {
      if (cancelled) return
      // Restore any persisted unanswered questions into the in-memory buffer so
      // the student resumes on the same question after a full exit / reload.
      m.forEach((rec, topicId) => {
        const pending = rec.pendingQuestions
        if (pending && pending.length) {
          qStoreRef.current.set(topicId, {
            current: pending[0],
            buffer: pending.slice(1),
          })
        }
      })
      setProgress(m)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [session.sessionId])

  const topics = useMemo(
    () => [...session.blueprint.topics].sort((a, b) => a.order - b.order),
    [session.blueprint.topics],
  )

  /** Update KC + difficulty targeting for the current topic (no topic switching). */
  const handleNextQuestion = useCallback(() => {
    if (!selectedTopicId) return
    const next = selectNextQuestion({
      topics,
      progress,
      difficulty: session.difficulty,
      retryQueue: retryQueueRef.current,
      recentTopicIds: [],
      turnCount: sessionTurnCountRef.current,
      currentTopicId: selectedTopicId,
    })
    setTargetQuestion(next)
  }, [topics, progress, session.difficulty, selectedTopicId])

  // Fill a topic's question buffer concurrently up to QUESTION_BUFFER. Runs here
  // (not in TopicSession) so it keeps going after the student leaves the topic.
  const ensureBuffer = useCallback(
    async (topicId: string) => {
      if (qFillingRef.current.has(topicId)) return
      const topic = topics.find((t) => t.id === topicId)
      if (!topic) return
      const rec = progressRef.current.get(topicId)
      const accumulated = rec?.masteryAccumulated ?? 0
      if (accumulated >= topic.masteryThreshold) return // mastered — stop prefetching
      const slot = qSlot(topicId)
      const need = QUESTION_BUFFER - slot.buffer.length
      if (need <= 0) return
      qFillingRef.current.add(topicId)
      try {
        const target = selectNextQuestion({
          topics,
          progress: progressRef.current,
          difficulty: session.difficulty,
          retryQueue: retryQueueRef.current,
          recentTopicIds: [],
          turnCount: sessionTurnCountRef.current,
          currentTopicId: topicId,
        })
        // The selector may interleave to another topic; only apply its KC/
        // difficulty target when it's actually for this topic.
        const useTarget = target.topicId === topicId
        const asked = [
          ...(rec?.turns ?? []).map((t) => t.questionText),
          ...(slot.current ? [slot.current.questionText] : []),
          ...slot.buffer.map((q) => q.questionText),
        ]
        const generated = await Promise.all(
          Array.from({ length: need }, () =>
            generateQuestion({
              topic,
              difficulty: session.difficulty,
              examBlueprint: session.blueprint.examBlueprint,
              askedQuestions: asked,
              masteryAccumulated: accumulated,
              targetDifficulty: useTarget ? target.targetDifficulty : undefined,
              targetKcId: useTarget ? target.targetKcId : undefined,
              targetKcLabel: useTarget ? target.targetKcLabel : undefined,
              preferMC: useTarget && (target.targetDifficulty ?? 2) <= 1,
            }).catch((e) => {
              console.warn('[prep] question prefetch failed', e)
              return null
            }),
          ),
        )
        // Concurrent gens can collide — dedupe against history + each other.
        const seen = new Set(asked)
        for (const q of generated) {
          if (q && !seen.has(q.questionText)) {
            seen.add(q.questionText)
            slot.buffer.push(q)
          }
        }
        syncPending(topicId)
      } finally {
        qFillingRef.current.delete(topicId)
      }
    },
    [topics, session, syncPending],
  )
  const ensureBufferRef = useRef(ensureBuffer)
  ensureBufferRef.current = ensureBuffer

  /** Current question for a topic, promoting the next buffered one if needed. */
  const takeQuestion = useCallback(
    (topicId: string): GeneratedQuestion | null => {
      const slot = qSlot(topicId)
      if (!slot.current) slot.current = slot.buffer.shift() ?? null
      syncPending(topicId)
      void ensureBufferRef.current(topicId)
      return slot.current
    },
    [syncPending],
  )
  /** Discard the current (answered) question and promote the next buffered one. */
  const advanceQuestion = useCallback(
    (topicId: string): GeneratedQuestion | null => {
      const slot = qSlot(topicId)
      slot.current = slot.buffer.shift() ?? null
      syncPending(topicId)
      void ensureBufferRef.current(topicId)
      return slot.current
    },
    [syncPending],
  )
  /** Store an on-demand-generated question as the current (buffer-empty fallback). */
  const setCurrentQuestion = useCallback(
    (topicId: string, q: GeneratedQuestion | null) => {
      qSlot(topicId).current = q
      syncPending(topicId)
    },
    [syncPending],
  )

  const recordTurn = useCallback(
    async (topicId: string, turn: PrepTurn) => {
      // Question was answered — drop the current so a remount shows a fresh one;
      // the buffer already holds the next (refilled here for the latest target).
      qSlot(topicId).current = null
      void ensureBufferRef.current(topicId)

      const topic = topics.find((t) => t.id === topicId)
      if (!topic) return

      // Read from ref (not closure) so we always see the latest state,
      // even if two turns are submitted before React re-renders.
      const existing = progressRef.current.get(topicId)

      // Post-answer hook: update retry queue + KC mastery.
      const postResult = onAnswerGraded(
        turn.score,
        topicId,
        turn.kcId,
        retryQueueRef.current,
        existing?.kcMastery ?? {},
        config,
      )
      retryQueueRef.current = postResult.retryQueue
      sessionTurnCountRef.current++

      // Build the record inside setProgress so we merge with the true
      // latest state — prevents saveOverview or a concurrent recordTurn
      // from clobbering our update.
      setProgress((prev) => {
        const latest = prev.get(topicId)
        const accumulated = Math.min(
          topic.masteryThreshold,
          (latest?.masteryAccumulated ?? 0) + turn.score,
        )
        const updatedRecord: PrepTopicProgressRecord = {
          key: progressKey(session.sessionId, topicId),
          sessionId: session.sessionId,
          topicId,
          status: 'unlocked',
          masteryAccumulated: accumulated,
          turns: [...(latest?.turns ?? []), turn],
          overview: latest?.overview,
          kcMastery: postResult.kcMastery,
          pendingQuestions: pendingOf(topicId),
        }
        updatedRecord.status = canMarkMastered(topic, updatedRecord, config)
          ? 'mastered'
          : 'unlocked'

        void putTopicProgress(updatedRecord)

        const next = new Map(prev)
        next.set(topicId, updatedRecord)
        const allMastered = topics.every(
          (t) => next.get(t.id)?.status === 'mastered',
        )
        void updatePrepSession({
          ...session,
          status: allMastered ? 'completed' : 'active',
        })
        return next
      })
    },
    [session, topics, config],
  )

  // Persist a topic's teaching overview, preserving any other progress fields.
  // Reads the latest progress via ref so background generation never clobbers a
  // concurrently-recorded turn.
  const saveOverview = useCallback(
    async (topicId: string, overview: string) => {
      // Build the record inside setProgress so we merge with the true
      // latest state — a concurrent recordTurn may have updated points
      // between when the overview started generating and when it finished.
      setProgress((prev) => {
        const existing = prev.get(topicId)
        const record: PrepTopicProgressRecord = {
          key: progressKey(session.sessionId, topicId),
          sessionId: session.sessionId,
          topicId,
          status: existing?.status ?? 'unlocked',
          masteryAccumulated: existing?.masteryAccumulated ?? 0,
          turns: existing?.turns ?? [],
          overview,
          kcMastery: existing?.kcMastery,
          pendingQuestions: pendingOf(topicId),
        }
        void putTopicProgress(record)
        const next = new Map(prev)
        next.set(topicId, record)
        return next
      })
    },
    [session.sessionId],
  )

  // Generate + persist a topic's overview if it doesn't already have one.
  // Guards against duplicate concurrent runs for the same topic.
  const ensureOverview = useCallback(
    async (topicId: string) => {
      if (overviewInFlight.current.has(topicId)) return
      if (progressRef.current.get(topicId)?.overview) return
      const topic = topics.find((t) => t.id === topicId)
      if (!topic) return
      overviewInFlight.current.add(topicId)
      setOverviewLoadingIds((prev) => new Set(prev).add(topicId))
      setOverviewErrors((prev) => {
        if (!prev.has(topicId)) return prev
        const next = new Map(prev)
        next.delete(topicId)
        return next
      })
      try {
        const ov = await generateOverview({
          topic,
          difficulty: session.difficulty,
          examBlueprint: session.blueprint.examBlueprint,
          documents: session.documents,
          cachedContent: docCacheRef.current ?? undefined,
        })
        await saveOverview(topicId, JSON.stringify(ov))
      } catch (e) {
        console.error('overview generation failed', topic.title, e)
        setOverviewErrors((prev) =>
          new Map(prev).set(
            topicId,
            e instanceof Error ? e.message : 'Failed to load overview.',
          ),
        )
      } finally {
        overviewInFlight.current.delete(topicId)
        setOverviewLoadingIds((prev) => {
          const next = new Set(prev)
          next.delete(topicId)
          return next
        })
      }
    },
    [topics, session, saveOverview],
  )

  // Background prefetch: once progress is loaded, generate overviews for every
  // topic that lacks one — sequentially, so they're ready before the student
  // opens each topic instead of waiting on entry.
  const ensureOverviewRef = useRef(ensureOverview)
  ensureOverviewRef.current = ensureOverview
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    ;(async () => {
      for (const t of topics) {
        if (cancelled) return
        if (progressRef.current.get(t.id)?.overview) continue
        await ensureOverviewRef.current(t.id)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ready, topics])

  // Prioritise the topic the student just opened — jump it ahead of the queue.
  useEffect(() => {
    if (!ready || !selectedTopicId) return
    if (progressRef.current.get(selectedTopicId)?.overview) return
    void ensureOverviewRef.current(selectedTopicId)
  }, [ready, selectedTopicId])

  // Pre-warm the opened topic's question buffer (concurrent) so a few questions
  // are ready before the student reaches the Practice tab.
  useEffect(() => {
    if (!ready || !selectedTopicId) return
    void ensureBufferRef.current(selectedTopicId)
  }, [ready, selectedTopicId])

  const requestSurface = useCallback((slide: KeySlide, topicTitle: string, force?: boolean) => {
    // Auto-expand the reference pane so the surfaced slide is visible.
    setRefCollapsed(false)
    setSurface({ slide, topicTitle, nonce: Date.now(), force })
  }, [])

  /** Open the chat popup with updated context. */
  const openChat = useCallback((ctx: PrepChatContext) => {
    setChatContext(ctx)
    setChatOpen(true)
  }, [])

  const resetProgress = useCallback(async () => {
    await resetSessionProgress(session.sessionId)
    await updatePrepSession({ ...session, status: 'active' })
    setProgress(new Map())
    retryQueueRef.current = []
    sessionTurnCountRef.current = 0
    qStoreRef.current.clear()
    setTargetQuestion(null)
  }, [session])

  const selectedTopic = topics.find((t) => t.id === selectedTopicId) ?? null
  const masteredCount = topics.filter(
    (t) => progress.get(t.id)?.status === 'mastered',
  ).length
  const selectedOverview = useMemo(
    () => parseOverview(selectedTopic ? progress.get(selectedTopic.id)?.overview : undefined),
    [selectedTopic, progress],
  )

  return (
    <div
      className={`prep-study ${refCollapsed ? 'ref-collapsed' : ''}`}
      ref={studyRef}
      style={
        refWidth != null
          ? ({ '--prep-ref-w': `${refWidth}px` } as CSSProperties)
          : undefined
      }
    >
      <div className="prep-study-left">
        <div className="prep-study-bar">
          <button
            type="button"
            className="ate-btn prep-back-btn"
            onClick={() =>
              selectedTopic ? setSelectedTopicId(null) : onExit()
            }
          >
            {selectedTopic ? '← Curriculum' : '← All preps'}
          </button>
          <span className="prep-study-title">{session.title}</span>
          <span className="prep-chip acc">
            {selectedTopic
              ? `${progress.get(selectedTopic.id)?.masteryAccumulated ?? 0} / ${selectedTopic.masteryThreshold} pts`
              : `${masteredCount} / ${topics.length} mastered`}
          </span>
          {refCollapsed ? (
            <button
              type="button"
              className="ate-btn prep-ref-toggle"
              onClick={() => setRefCollapsed(false)}
              title="Show reference"
            >
              Reference »
            </button>
          ) : null}
        </div>

        {!ready ? (
          <div className="prep-loading">Loading progress…</div>
        ) : selectedTopic ? (
          <TopicSession
            session={session}
            topic={selectedTopic}
            progress={progress.get(selectedTopic.id) ?? null}
            onRecordTurn={(turn) => recordTurn(selectedTopic.id, turn)}
            overview={selectedOverview}
            overviewLoading={overviewLoadingIds.has(selectedTopic.id)}
            overviewError={overviewErrors.get(selectedTopic.id) ?? null}
            onRetryOverview={() => void ensureOverview(selectedTopic.id)}
            onSurfaceSlide={(slide, force) =>
              requestSurface(slide, selectedTopic.title, force)
            }
            targetDifficulty={targetQuestion?.topicId === selectedTopic.id ? targetQuestion.targetDifficulty : undefined}
            targetKcId={targetQuestion?.topicId === selectedTopic.id ? targetQuestion.targetKcId : undefined}
            targetKcLabel={targetQuestion?.topicId === selectedTopic.id ? targetQuestion.targetKcLabel : undefined}
            onRequestNext={handleNextQuestion}
            onOpenChat={openChat}
            cachedQuestion={qStoreRef.current.get(selectedTopic.id)?.current ?? null}
            onTakeQuestion={takeQuestion}
            onAdvanceQuestion={advanceQuestion}
            onSetCurrentQuestion={setCurrentQuestion}
            onPrimeQuestions={(id) => void ensureBufferRef.current(id)}
          />
        ) : (
          <CurriculumMap
            topics={topics}
            progress={progress}
            difficulty={session.difficulty}
            title={session.title}
            onSelect={(id) => {
              setSelectedTopicId(id)
              setTargetQuestion(null)
            }}
            onResetProgress={resetProgress}
          />
        )}
      </div>

      {!refCollapsed ? (
        <>
          <div
            className="pane-divider"
            onPointerDown={startRefResize}
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
          />
          <ReferencePane
            documents={session.documents}
            prepDocs={prepDocs}
            surface={surface}
            onCollapse={() => setRefCollapsed(true)}
          />
        </>
      ) : null}

      <PrepChatPopup
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        context={chatContext}
        history={chatHistory}
        onHistory={setChatHistory}
      />
    </div>
  )
}
