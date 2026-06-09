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
  calculateTotalMasteryPoints,
  type NextQuestion,
} from '../../lib/questionSelector'
import {
  generateOverview,
  generateQuestionBlock,
  type GeneratedQuestion,
  type QuestionBlock,
  type TopicOverview,
} from '../../lib/testPrep'
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

/** Per-topic block buffer state. */
interface BlockSlot {
  currentBlock: QuestionBlock | null
  currentIndex: number // 0, 1, or 2 within block
  nextBlock: QuestionBlock | null
  nextBlockGenerating: boolean
  /** Sequential counter for block indices. */
  blockCounter: number
}

function emptyBlockSlot(): BlockSlot {
  return {
    currentBlock: null,
    currentIndex: 0,
    nextBlock: null,
    nextBlockGenerating: false,
    blockCounter: 0,
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

  // Overview error recovery — overviews are now generated during init
  // (PrepProcessing), but we keep a simple retry mechanism for error cases.
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

  // ── Block buffer system ────────────────────────────────
  // Per-topic block buffer — owned here so generation persists across topic/tab
  // navigation. Each topic has a current block (3 questions) and a next block
  // (pre-generated for instant transitions).
  const blockStoreRef = useRef<Map<string, BlockSlot>>(new Map())
  const blockGenRef = useRef<Set<string>>(new Set())

  function blockSlot(topicId: string): BlockSlot {
    let s = blockStoreRef.current.get(topicId)
    if (!s) {
      s = emptyBlockSlot()
      blockStoreRef.current.set(topicId, s)
    }
    return s
  }

  /** Build the persisted pendingQuestionBlock shape from a slot. */
  const pendingBlockOf = useCallback(
    (topicId: string): PrepTopicProgressRecord['pendingQuestionBlock'] => {
      const s = blockStoreRef.current.get(topicId)
      if (!s || (!s.currentBlock && !s.nextBlock)) return undefined
      return {
        currentBlock: s.currentBlock,
        currentIndex: s.currentIndex,
        nextBlock: s.nextBlock,
      }
    },
    [],
  )

  /** Persist the block buffer into the topic's progress record. */
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
          pendingQuestionBlock: pendingBlockOf(topicId),
        }
        void putTopicProgress(record)
        const next = new Map(prev)
        next.set(topicId, record)
        return next
      })
    },
    [session.sessionId, pendingBlockOf],
  )

  // Per-topic difficulty nudge state (+1 or -1 from user arrows).
  const [topicDifficultyNudge, setTopicDifficultyNudge] = useState<
    Record<string, number | null>
  >({})

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

  // Load persisted progress + restore block buffers on mount.
  useEffect(() => {
    let cancelled = false
    getAllProgressForSession(session.sessionId).then((m) => {
      if (cancelled) return
      // Restore persisted block buffers.
      m.forEach((rec, topicId) => {
        if (rec.pendingQuestionBlock) {
          const pb = rec.pendingQuestionBlock
          blockStoreRef.current.set(topicId, {
            currentBlock: pb.currentBlock,
            currentIndex: pb.currentIndex,
            nextBlock: pb.nextBlock,
            nextBlockGenerating: false,
            blockCounter:
              (pb.currentBlock?.blockIndex ?? 0) +
              (pb.nextBlock ? 2 : 1),
          })
        }
        // Backward compat: discard old pendingQuestions (don't try to convert).
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

  /** Update KC + difficulty targeting for the current topic. */
  const handleNextQuestion = useCallback(() => {
    if (!selectedTopicId) return
    const nudge = topicDifficultyNudge[selectedTopicId] ?? undefined
    const next = selectNextQuestion({
      topics,
      progress,
      difficulty: session.difficulty,
      retryQueue: retryQueueRef.current,
      recentTopicIds: [],
      turnCount: sessionTurnCountRef.current,
      currentTopicId: selectedTopicId,
      difficultyNudge: nudge ?? undefined,
    })
    setTargetQuestion(next)
  }, [topics, progress, session.difficulty, selectedTopicId, topicDifficultyNudge])

  /** Generate a question block for a topic. */
  const generateBlock = useCallback(
    async (topicId: string, blockIndex: number): Promise<QuestionBlock | null> => {
      const topic = topics.find((t) => t.id === topicId)
      if (!topic) return null
      const rec = progressRef.current.get(topicId)
      const accumulated = rec?.masteryAccumulated ?? 0
      const slot = blockSlot(topicId)

      // Collect asked questions for dedup.
      const asked = [
        ...(rec?.turns ?? []).map((t) => t.questionText),
        ...(slot.currentBlock?.questions ?? []).map((q) => q.questionText),
        ...(slot.nextBlock?.questions ?? []).map((q) => q.questionText),
      ]

      const nudge = topicDifficultyNudge[topicId] ?? undefined
      const target = selectNextQuestion({
        topics,
        progress: progressRef.current,
        difficulty: session.difficulty,
        retryQueue: retryQueueRef.current,
        recentTopicIds: [],
        turnCount: sessionTurnCountRef.current,
        currentTopicId: topicId,
        difficultyNudge: nudge ?? undefined,
      })
      const useTarget = target.topicId === topicId

      try {
        const block = await generateQuestionBlock({
          topic,
          difficulty: session.difficulty,
          examBlueprint: session.blueprint.examBlueprint,
          askedQuestions: asked,
          masteryAccumulated: accumulated,
          targetDifficulty: useTarget ? target.targetDifficulty : undefined,
          targetKcId: useTarget ? target.targetKcId : undefined,
          targetKcLabel: useTarget ? target.targetKcLabel : undefined,
          blockIndex,
        })
        return block
      } catch (e) {
        console.warn('[prep] block generation failed', e)
        return null
      }
    },
    [topics, session, topicDifficultyNudge],
  )

  /** Ensure a next block is queued for a topic (called after Q2 answered). */
  const ensureNextBlock = useCallback(
    async (topicId: string) => {
      const key = `${topicId}:next`
      if (blockGenRef.current.has(key)) return
      const slot = blockSlot(topicId)
      if (slot.nextBlock) return
      if (slot.nextBlockGenerating) return
      slot.nextBlockGenerating = true
      blockGenRef.current.add(key)
      try {
        const block = await generateBlock(topicId, slot.blockCounter)
        slot.nextBlock = block
        if (block) slot.blockCounter++
        syncPending(topicId)
      } finally {
        slot.nextBlockGenerating = false
        blockGenRef.current.delete(key)
      }
    },
    [generateBlock, syncPending],
  )
  const ensureNextBlockRef = useRef(ensureNextBlock)
  ensureNextBlockRef.current = ensureNextBlock

  /** Generate the first block for a topic (when no current block exists). */
  const ensureCurrentBlock = useCallback(
    async (topicId: string) => {
      const key = `${topicId}:current`
      if (blockGenRef.current.has(key)) return
      const slot = blockSlot(topicId)
      if (slot.currentBlock) return
      blockGenRef.current.add(key)
      try {
        const block = await generateBlock(topicId, slot.blockCounter)
        slot.currentBlock = block
        slot.currentIndex = 0
        if (block) slot.blockCounter++
        syncPending(topicId)
        // Start prefetching next block.
        void ensureNextBlockRef.current(topicId)
      } finally {
        blockGenRef.current.delete(key)
      }
    },
    [generateBlock, syncPending],
  )
  const ensureCurrentBlockRef = useRef(ensureCurrentBlock)
  ensureCurrentBlockRef.current = ensureCurrentBlock

  /** Get the current question from the block buffer. */
  const takeQuestion = useCallback(
    (topicId: string): GeneratedQuestion | null => {
      const slot = blockSlot(topicId)
      if (!slot.currentBlock) {
        // No block yet — trigger generation.
        void ensureCurrentBlockRef.current(topicId)
        return null
      }
      return slot.currentBlock.questions[slot.currentIndex] ?? null
    },
    [],
  )

  /** Advance to the next question (within block or promote next block). */
  const advanceQuestion = useCallback(
    (topicId: string): GeneratedQuestion | null => {
      const slot = blockSlot(topicId)
      if (!slot.currentBlock) return null

      const nextIdx = slot.currentIndex + 1
      if (nextIdx < slot.currentBlock.questions.length) {
        // Next question within the same block.
        slot.currentIndex = nextIdx
        // After Q2 (index 2), pre-generate next block.
        if (nextIdx >= 2) void ensureNextBlockRef.current(topicId)
        syncPending(topicId)
        return slot.currentBlock.questions[nextIdx] ?? null
      }

      // Block exhausted — promote next block.
      if (slot.nextBlock) {
        slot.currentBlock = slot.nextBlock
        slot.currentIndex = 0
        slot.nextBlock = null
        slot.nextBlockGenerating = false
        syncPending(topicId)
        // Start generating the next next block.
        void ensureNextBlockRef.current(topicId)
        return slot.currentBlock.questions[0] ?? null
      }

      // No next block ready — trigger generation.
      slot.currentBlock = null
      slot.currentIndex = 0
      syncPending(topicId)
      void ensureCurrentBlockRef.current(topicId)
      return null
    },
    [syncPending],
  )

  /** Store an on-demand-generated question as a single-question block. */
  const setCurrentQuestion = useCallback(
    (topicId: string, q: GeneratedQuestion | null) => {
      if (!q) return
      const slot = blockSlot(topicId)
      slot.currentBlock = {
        questions: [q],
        blockDifficulty: q.difficultyLevel,
        blockIndex: slot.blockCounter++,
      }
      slot.currentIndex = 0
      syncPending(topicId)
    },
    [syncPending],
  )

  /** Nudge the difficulty for the next block and regenerate. */
  const nudgeDifficulty = useCallback(
    (topicId: string, delta: 1 | -1) => {
      setTopicDifficultyNudge((prev) => ({
        ...prev,
        [topicId]: delta,
      }))
      // Discard current + next block, regenerate at nudged level.
      const slot = blockSlot(topicId)
      slot.currentBlock = null
      slot.currentIndex = 0
      slot.nextBlock = null
      slot.nextBlockGenerating = false
      syncPending(topicId)
      // Generation will pick up the nudge from topicDifficultyNudge state.
      // Use a microtask so the nudge state is set before generation reads it.
      queueMicrotask(() => void ensureCurrentBlockRef.current(topicId))
    },
    [syncPending],
  )

  /** Get the current block's difficulty level (for display). */
  const currentBlockDifficulty = useCallback(
    (topicId: string): number | null => {
      const slot = blockStoreRef.current.get(topicId)
      return slot?.currentBlock?.blockDifficulty ?? null
    },
    [],
  )

  /** Clear the difficulty nudge for a topic (deselect arrow). */
  const clearNudge = useCallback(
    (topicId: string) => {
      setTopicDifficultyNudge((prev) => {
        if (prev[topicId] == null) return prev
        const next = { ...prev }
        delete next[topicId]
        return next
      })
    },
    [],
  )

  /** Post-mastery: set an exact difficulty and generate a single question. */
  const setMasteryDifficulty = useCallback(
    (topicId: string, level: number) => {
      const topic = topics.find((t) => t.id === topicId)
      if (!topic) return
      // Discard any existing block buffer.
      const slot = blockSlot(topicId)
      slot.currentBlock = null
      slot.currentIndex = 0
      slot.nextBlock = null
      slot.nextBlockGenerating = false
      syncPending(topicId)

      // Generate a single question at the exact level (not a block).
      const rec = progressRef.current.get(topicId)
      const asked = (rec?.turns ?? []).map((t) => t.questionText)
      const target = selectNextQuestion({
        topics,
        progress: progressRef.current,
        difficulty: session.difficulty,
        retryQueue: retryQueueRef.current,
        recentTopicIds: [],
        turnCount: sessionTurnCountRef.current,
        currentTopicId: topicId,
      })
      const useTarget = target.topicId === topicId

      void (async () => {
        try {
          const { generateQuestion } = await import('../../lib/testPrep')
          const q = await generateQuestion({
            topic,
            difficulty: session.difficulty,
            examBlueprint: session.blueprint.examBlueprint,
            askedQuestions: asked,
            masteryAccumulated: rec?.masteryAccumulated ?? 0,
            targetDifficulty: level,
            targetKcId: useTarget ? target.targetKcId : undefined,
            targetKcLabel: useTarget ? target.targetKcLabel : undefined,
            preferMC: level <= 2,
          })
          // Store as a single-question block.
          slot.currentBlock = {
            questions: [q],
            blockDifficulty: level,
            blockIndex: slot.blockCounter++,
          }
          slot.currentIndex = 0
          syncPending(topicId)
        } catch (e) {
          console.warn('[prep] mastery single-question gen failed', e)
        }
      })()
    },
    [topics, session, syncPending],
  )

  const recordTurn = useCallback(
    async (topicId: string, turn: PrepTurn) => {
      // Question was answered — clear the current question index
      // so a remount sees a fresh one from advanceQuestion.
      const topic = topics.find((t) => t.id === topicId)
      if (!topic) return

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

      // Clear nudge after the block containing this question finishes.
      const slot = blockSlot(topicId)
      if (slot.currentIndex >= (slot.currentBlock?.questions.length ?? 3) - 1) {
        setTopicDifficultyNudge((prev) => {
          if (prev[topicId] == null) return prev
          const next = { ...prev }
          delete next[topicId]
          return next
        })
      }

      setProgress((prev) => {
        const latest = prev.get(topicId)
        const alreadyMastered = latest?.status === 'mastered'
        const turns = [...(latest?.turns ?? []), turn]
        // Once mastered, freeze points — post-mastery practice is for learning,
        // not for changing the score.
        const accumulated = alreadyMastered
          ? (latest?.masteryAccumulated ?? 0)
          : Math.min(topic.masteryThreshold, calculateTotalMasteryPoints(turns))
        const updatedRecord: PrepTopicProgressRecord = {
          key: progressKey(session.sessionId, topicId),
          sessionId: session.sessionId,
          topicId,
          status: alreadyMastered ? 'mastered' : 'unlocked',
          masteryAccumulated: accumulated,
          turns,
          overview: latest?.overview,
          kcMastery: postResult.kcMastery,
          pendingQuestionBlock: pendingBlockOf(topicId),
        }
        if (!alreadyMastered) {
          updatedRecord.status = canMarkMastered(topic, updatedRecord, config)
            ? 'mastered'
            : 'unlocked'
        }

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
    [session, topics, config, pendingBlockOf],
  )

  // Overview error recovery — re-generate a single overview on demand.
  const retryOverview = useCallback(
    async (topicId: string) => {
      if (overviewInFlight.current.has(topicId)) return
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
        })
        // Persist overview into progress.
        setProgress((prev) => {
          const existing = prev.get(topicId)
          const record: PrepTopicProgressRecord = {
            key: progressKey(session.sessionId, topicId),
            sessionId: session.sessionId,
            topicId,
            status: existing?.status ?? 'unlocked',
            masteryAccumulated: existing?.masteryAccumulated ?? 0,
            turns: existing?.turns ?? [],
            overview: JSON.stringify(ov),
            kcMastery: existing?.kcMastery,
            pendingQuestionBlock: pendingBlockOf(topicId),
          }
          void putTopicProgress(record)
          const next = new Map(prev)
          next.set(topicId, record)
          return next
        })
      } catch (e) {
        console.error('overview retry failed', topic.title, e)
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
    [topics, session, pendingBlockOf],
  )

  // Pre-warm the opened topic's block buffer so questions are ready by Practice.
  useEffect(() => {
    if (!ready || !selectedTopicId) return
    void ensureCurrentBlockRef.current(selectedTopicId)
  }, [ready, selectedTopicId])

  const requestSurface = useCallback((slide: KeySlide, topicTitle: string, force?: boolean) => {
    setRefCollapsed(false)
    setSurface({ slide, topicTitle, nonce: Date.now(), force })
  }, [])

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
    blockStoreRef.current.clear()
    setTargetQuestion(null)
    setTopicDifficultyNudge({})
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
            onRetryOverview={() => void retryOverview(selectedTopic.id)}
            onSurfaceSlide={(slide, force) =>
              requestSurface(slide, selectedTopic.title, force)
            }
            targetDifficulty={targetQuestion?.topicId === selectedTopic.id ? targetQuestion.targetDifficulty : undefined}
            targetKcId={targetQuestion?.topicId === selectedTopic.id ? targetQuestion.targetKcId : undefined}
            targetKcLabel={targetQuestion?.topicId === selectedTopic.id ? targetQuestion.targetKcLabel : undefined}
            onRequestNext={handleNextQuestion}
            onOpenChat={openChat}
            cachedQuestion={
              (() => {
                const slot = blockStoreRef.current.get(selectedTopic.id)
                return slot?.currentBlock?.questions[slot.currentIndex] ?? null
              })()
            }
            onTakeQuestion={takeQuestion}
            onAdvanceQuestion={advanceQuestion}
            onSetCurrentQuestion={setCurrentQuestion}
            onPrimeQuestions={(id) => void ensureCurrentBlockRef.current(id)}
            currentBlockDifficulty={currentBlockDifficulty(selectedTopic.id)}
            onNudgeDifficulty={(delta) => nudgeDifficulty(selectedTopic.id, delta)}
            onClearNudge={() => clearNudge(selectedTopic.id)}
            difficultyNudge={topicDifficultyNudge[selectedTopic.id] ?? null}
            onSetDifficulty={(level) => setMasteryDifficulty(selectedTopic.id, level)}
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
