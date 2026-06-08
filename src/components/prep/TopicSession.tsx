import { useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import type {
  CurriculumTopic,
  KeySlide,
  PrepSessionRecord,
  PrepTopicProgressRecord,
  PrepTurn,
  PrepScore,
} from '../../lib/db'
import {
  generateQuestion,
  gradeAnswer,
  type GeneratedQuestion,
  type GradeResult,
  type TopicOverview,
} from '../../lib/testPrep'
import type { PrepChatContext } from './PrepChatPopup'

marked.setOptions({ breaks: true, gfm: true })
function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string
}

/** Resolve a file id to its display name for a citation chip. */
function docName(documents: PrepSessionRecord['documents'], filename: string): string {
  return documents.find((d) => d.filename === filename)?.displayName ?? 'source'
}

const CHOICE_LABELS = ['A', 'B', 'C', 'D']

/** Reusable citation chip that surfaces a slide in the reference pane. */
function CitationChip({
  slide,
  documents,
  onSurfaceSlide,
}: {
  slide: KeySlide
  documents: PrepSessionRecord['documents']
  onSurfaceSlide: (slide: KeySlide, force?: boolean) => void
}) {
  return (
    <button
      type="button"
      className="prep-cite"
      onClick={() => onSurfaceSlide(slide, true)}
      title="Jump to this slide in the reference pane"
    >
      <span className="prep-cite-icon" aria-hidden="true">▦</span>
      {docName(documents, slide.filename)} · slide {slide.slideIndex + 1}
    </button>
  )
}

interface TopicSessionProps {
  session: PrepSessionRecord
  topic: CurriculumTopic
  progress: PrepTopicProgressRecord | null
  onRecordTurn: (turn: PrepTurn) => void
  /** Cited teaching overview (generated + cached by PrepStudy). */
  overview: TopicOverview | null
  overviewLoading: boolean
  overviewError: string | null
  onRetryOverview: () => void
  onSurfaceSlide: (slide: KeySlide, force?: boolean) => void
  /** Adaptive difficulty target from the question selector. */
  targetDifficulty?: number
  /** KC to focus on from the question selector. */
  targetKcId?: string
  targetKcLabel?: string
  /** Callback to request the next question via the session-level algorithm. */
  onRequestNext?: () => void
  /** Open the session-level chat popup with context. */
  onOpenChat?: (ctx: PrepChatContext) => void
  /** The topic's current unanswered question, persisted in the parent buffer. */
  cachedQuestion?: GeneratedQuestion | null
  /** Pull the current (or next buffered) question from the parent buffer. */
  onTakeQuestion?: (topicId: string) => GeneratedQuestion | null
  /** Advance to the next buffered question (after answering). */
  onAdvanceQuestion?: (topicId: string) => GeneratedQuestion | null
  /** Store an on-demand-generated question as the current (buffer-empty path). */
  onSetCurrentQuestion?: (topicId: string, q: GeneratedQuestion | null) => void
  /** Ask the parent to keep this topic's question buffer filled. */
  onPrimeQuestions?: (topicId: string) => void
}

type Mode = 'learn' | 'practice'

export function TopicSession({
  session,
  topic,
  progress,
  onRecordTurn,
  overview,
  overviewLoading,
  overviewError,
  onRetryOverview,
  onSurfaceSlide,
  targetDifficulty,
  targetKcId,
  targetKcLabel,
  onRequestNext,
  onOpenChat,
  cachedQuestion,
  onTakeQuestion,
  onAdvanceQuestion,
  onSetCurrentQuestion,
  onPrimeQuestions,
}: TopicSessionProps) {
  const [mode, setMode] = useState<Mode>('learn')

  // Learn phase — the overview is generated + cached by PrepStudy and arrives
  // via props. A local ticker just gives feedback while it's still loading.
  const [overviewElapsed, setOverviewElapsed] = useState(0)

  // Practice phase — the question buffer (current + upcoming) is owned by
  // PrepStudy; this is just the displayed question.
  const [generatedQ, setGeneratedQ] = useState<GeneratedQuestion | null>(null)
  const [loadingQuestion, setLoadingQuestion] = useState(false)
  const [answer, setAnswer] = useState('')
  const [grading, setGrading] = useState(false)
  const [result, setResult] = useState<GradeResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // MC state
  const [mcSelected, setMcSelected] = useState<number | null>(null)
  const [mcSubmitted, setMcSubmitted] = useState(false)

  // Review state — index into the persisted `progress.turns` history. `null`
  // means the live (current) question; a number shows that past answered
  // question read-only. History survives exit/re-entry (it's in Firestore).
  const [reviewIndex, setReviewIndex] = useState<number | null>(null)

  const questionReqRef = useRef(0)

  const accumulated = progress?.masteryAccumulated ?? 0
  const mastered = accumulated >= topic.masteryThreshold
  const pct = Math.min(100, Math.round((accumulated / topic.masteryThreshold) * 100))
  const turns = progress?.turns ?? []
  const hasPracticed = turns.length > 0

  // Tick while the overview is generating (it reads the slides + thinks) so the
  // wait never looks frozen.
  useEffect(() => {
    if (!overviewLoading) return
    setOverviewElapsed(0)
    const id = window.setInterval(() => setOverviewElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [overviewLoading])

  // On opening a topic: always land on the overview (concept before practice)
  // and reset answer state. Restore a cached question if one exists so
  // navigating away and back doesn't regenerate.
  useEffect(() => {
    questionReqRef.current++
    setMode('learn')
    setGeneratedQ(cachedQuestion ?? null)
    setResult(null)
    setAnswer('')
    setError(null)
    setMcSelected(null)
    setMcSubmitted(false)
    setReviewIndex(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.id])

  // Generate a question, excluding prior turns + any extra texts so each one is
  // distinct (fixes "same question again").
  const requestQuestion = useCallback(
    (exclude: string[]) => {
      const asked = [
        ...(progress?.turns ?? []).map((t) => t.questionText),
        ...exclude,
      ]
      return generateQuestion({
        topic,
        difficulty: session.difficulty,
        examBlueprint: session.blueprint.examBlueprint,
        askedQuestions: asked,
        masteryAccumulated: accumulated,
        targetDifficulty,
        targetKcId,
        targetKcLabel,
        preferMC: (targetDifficulty ?? 2) <= 1,
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topic, session, accumulated, targetDifficulty, targetKcId, targetKcLabel, progress],
  )

  // Promote a question into the displayed slot, resetting answer state.
  const promote = useCallback((q: GeneratedQuestion) => {
    questionReqRef.current++ // supersede any in-flight on-demand fetch
    setGeneratedQ(q)
    setResult(null)
    setAnswer('')
    setError(null)
    setMcSelected(null)
    setMcSubmitted(false)
    setLoadingQuestion(false)
  }, [])

  // Fallback when the parent buffer is empty — generate one on demand and store
  // it as the topic's current so it survives navigation.
  const fetchOnDemand = useCallback(async () => {
    const token = ++questionReqRef.current
    setLoadingQuestion(true)
    setError(null)
    setResult(null)
    setAnswer('')
    setGeneratedQ(null)
    setMcSelected(null)
    setMcSubmitted(false)
    try {
      const q = await requestQuestion([])
      if (token !== questionReqRef.current) return
      setGeneratedQ(q)
      onSetCurrentQuestion?.(topic.id, q)
    } catch (e) {
      if (token !== questionReqRef.current) return
      setError(e instanceof Error ? e.message : 'Failed to load a question.')
    } finally {
      if (token === questionReqRef.current) setLoadingQuestion(false)
    }
  }, [requestQuestion, onSetCurrentQuestion, topic.id])

  // Show the topic's current question — instant from the parent buffer, else
  // an on-demand fetch.
  const loadCurrent = useCallback(() => {
    const q = onTakeQuestion?.(topic.id) ?? null
    if (q) promote(q)
    else void fetchOnDemand()
  }, [onTakeQuestion, topic.id, promote, fetchOnDemand])

  function startPractice() {
    setMode('practice')
    onPrimeQuestions?.(topic.id) // keep the buffer topped up
    if (!generatedQ && !mastered) loadCurrent()
  }

  /** Submit an MC answer — graded client-side. */
  function submitMC() {
    if (!generatedQ || mcSelected == null || mcSubmitted) return
    setMcSubmitted(true)

    // Use a single clamped index for both grading and the feedback message so
    // they can never disagree (the UI highlights this same index as correct).
    const correctIndex = generatedQ.correctIndex ?? 0
    const correct = mcSelected === correctIndex
    const score: PrepScore = correct ? 1 : 0
    const turn: PrepTurn = {
      questionText: generatedQ.questionText,
      userAnswer: generatedQ.choices?.[mcSelected] ?? '',
      score,
      correctComponents: correct ? 'Correct!' : '',
      missingComponents: correct
        ? ''
        : `The correct answer was ${CHOICE_LABELS[correctIndex]}: ${generatedQ.choices?.[correctIndex] ?? ''}`,
      correction: generatedQ.explanation ?? '',
      timestamp: Date.now(),
      kcId: generatedQ.kcId,
      difficultyLevel: generatedQ.difficultyLevel,
      format: 'mc',
      mcChoices: generatedQ.choices,
      mcCorrectIndex: correctIndex,
      mcSelectedIndex: mcSelected,
    }
    onRecordTurn(turn)
    setResult({
      score,
      correctComponents: turn.correctComponents,
      missingComponents: turn.missingComponents,
      correction: turn.correction,
    })
    // Surface the topic's most relevant slide for review (especially on wrong).
    if (!correct && topic.keySlides.length > 0) {
      onSurfaceSlide(topic.keySlides[0])
    }
  }

  /** Submit an open-ended answer — graded via API. */
  async function submitOpen() {
    if (!generatedQ || grading || !answer.trim()) return
    setGrading(true)
    setError(null)
    try {
      const r = await gradeAnswer({
        topic,
        question: generatedQ.questionText,
        answer,
        history: progress?.turns,
      })
      const turn: PrepTurn = {
        questionText: generatedQ.questionText,
        userAnswer: answer,
        score: r.score,
        correctComponents: r.correctComponents,
        missingComponents: r.missingComponents,
        correction: r.correction,
        suggestedSlide: r.suggestedSlide,
        timestamp: Date.now(),
        kcId: generatedQ.kcId,
        difficultyLevel: generatedQ.difficultyLevel,
        format: 'open',
      }
      onRecordTurn(turn)
      setResult(r)
      if (r.suggestedSlide && r.score < 1) onSurfaceSlide(r.suggestedSlide)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Grading failed.')
    } finally {
      setGrading(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submitOpen()
    }
  }

  function handleNext() {
    onRequestNext?.()
    // Promote the next buffered question instantly; fall back to on-demand.
    const q = onAdvanceQuestion?.(topic.id) ?? null
    if (q) promote(q)
    else void fetchOnDemand()
  }

  /** Step back into answered-question history (or enter it from the live view). */
  function reviewPrev() {
    setReviewIndex((idx) => (idx === null ? turns.length - 1 : Math.max(0, idx - 1)))
  }
  /** Step forward; past the most recent answered question returns to the live one. */
  function reviewNext() {
    setReviewIndex((idx) => {
      if (idx === null) return null
      if (idx >= turns.length - 1) return null
      return idx + 1
    })
  }

  /** Build chat context for the current state. */
  function buildChatContext(opts?: {
    question?: string
    answer?: string
    score?: number
    feedback?: string
  }): PrepChatContext {
    const overviewMd = overview
      ? overview.sections.map((s) => `### ${s.heading ?? ''}\n${s.markdown}`).join('\n\n')
      : undefined
    return {
      sessionTitle: session.title,
      difficulty: session.difficulty,
      topicTitle: topic.title,
      topicSummary: topic.summary,
      overviewMarkdown: overviewMd,
      lastQuestion: opts?.question,
      lastAnswer: opts?.answer,
      lastScore: opts?.score,
      lastFeedback: opts?.feedback,
    }
  }

  function handleOpenChatOverview() {
    onOpenChat?.(buildChatContext())
  }

  function handleOpenChatAfterAnswer() {
    if (!generatedQ || !result) return
    const feedbackParts = [
      result.correctComponents ? `Correct: ${result.correctComponents}` : '',
      result.missingComponents ? `Missing: ${result.missingComponents}` : '',
      result.correction ? `Correction: ${result.correction}` : '',
    ]
      .filter(Boolean)
      .join(' | ')
    onOpenChat?.(
      buildChatContext({
        question: generatedQ.questionText,
        answer: answer || (generatedQ.choices?.[mcSelected ?? 0] ?? ''),
        score: result.score,
        feedback: feedbackParts,
      }),
    )
  }

  return (
    <div className="prep-topic-session">
      <div className="prep-ts-head">
        <div className="prep-eyebrow acc">
          Topic {String(topic.order + 1).padStart(2, '0')}
        </div>
        <h2 className="prep-display prep-ts-title">{topic.title}</h2>
        <div className="prep-ts-prog">
          <div className="prep-ts-bar">
            <div className="prep-ts-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="prep-chip">
            {accumulated} / {topic.masteryThreshold} pts
          </span>
        </div>
        <div className="prep-tabs">
          <button
            type="button"
            className={`prep-tab ${mode === 'learn' ? 'active' : ''}`}
            onClick={() => setMode('learn')}
          >
            Overview
          </button>
          <button
            type="button"
            className={`prep-tab ${mode === 'practice' ? 'active' : ''}`}
            onClick={startPractice}
          >
            Practice
          </button>
        </div>
      </div>

      {mode === 'learn' ? (
        <div className="prep-learn">
          {overviewError ? (
            <div className="prep-error">{overviewError}</div>
          ) : null}
          {overview ? (
            <div className="prep-overview-sections">
              {overview.sections.map((s, i) => (
                <section key={i} className="prep-overview-section">
                  {s.heading ? (
                    <h3 className="prep-overview-heading">{s.heading}</h3>
                  ) : null}
                  <div
                    className="prep-overview ask-md"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(s.markdown),
                    }}
                  />
                  {s.citation ? (
                    <CitationChip
                      slide={s.citation}
                      documents={session.documents}
                      onSurfaceSlide={onSurfaceSlide}
                    />
                  ) : null}
                </section>
              ))}
            </div>
          ) : overviewLoading ? (
            <div className="prep-q-loading">
              <span className="prep-spinner small" aria-hidden="true" />
              Reading the slides &amp; preparing your overview… {overviewElapsed}s
            </div>
          ) : (
            <div className="prep-q-loading">No overview yet.</div>
          )}

          <div className="prep-learn-foot">
            {overviewError && !overviewLoading ? (
              <button
                type="button"
                className="ate-btn"
                onClick={onRetryOverview}
              >
                Retry overview
              </button>
            ) : null}
            {overview && onOpenChat ? (
              <button
                type="button"
                className="ate-btn prep-chat-trigger"
                onClick={handleOpenChatOverview}
              >
                Ask about this topic
              </button>
            ) : null}
            <button
              type="button"
              className="ate-btn ate-btn-primary"
              onClick={startPractice}
              disabled={overviewLoading && !overview}
            >
              {hasPracticed ? 'Continue practice →' : 'Start practice →'}
            </button>
          </div>
        </div>
      ) : (
        <PracticeView
          mastered={mastered}
          generatedQ={generatedQ}
          loadingQuestion={loadingQuestion}
          answer={answer}
          grading={grading}
          result={result}
          error={error}
          mcSelected={mcSelected}
          mcSubmitted={mcSubmitted}
          onMcSelect={setMcSelected}
          onMcSubmit={submitMC}
          onAnswerChange={setAnswer}
          onKeyDown={onKeyDown}
          onSubmit={() => void submitOpen()}
          onNext={handleNext}
          onReviewOverview={() => setMode('learn')}
          onOpenChat={onOpenChat ? handleOpenChatAfterAnswer : undefined}
          keySlides={topic.keySlides}
          documents={session.documents}
          onSurfaceSlide={onSurfaceSlide}
          turns={turns}
          reviewIndex={reviewIndex}
          onReviewPrev={reviewPrev}
          onReviewNext={reviewNext}
        />
      )}
    </div>
  )
}

interface PracticeViewProps {
  mastered: boolean
  generatedQ: GeneratedQuestion | null
  loadingQuestion: boolean
  answer: string
  grading: boolean
  result: GradeResult | null
  error: string | null
  mcSelected: number | null
  mcSubmitted: boolean
  onMcSelect: (idx: number) => void
  onMcSubmit: () => void
  onAnswerChange: (v: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onSubmit: () => void
  onNext: () => void
  onReviewOverview: () => void
  /** Opens the chat popup with Q&A context. Only present after submit. */
  onOpenChat?: () => void
  /** Topic key slides for citation chips. */
  keySlides: KeySlide[]
  /** Session documents for resolving display names. */
  documents: PrepSessionRecord['documents']
  onSurfaceSlide: (slide: KeySlide, force?: boolean) => void
  /** Persisted answered-question history. */
  turns: PrepTurn[]
  /** Index into `turns` being reviewed, or null for the live question. */
  reviewIndex: number | null
  onReviewPrev: () => void
  onReviewNext: () => void
}

function PracticeView({
  mastered,
  generatedQ,
  loadingQuestion,
  answer,
  grading,
  result,
  error,
  mcSelected,
  mcSubmitted,
  onMcSelect,
  onMcSubmit,
  onAnswerChange,
  onKeyDown,
  onSubmit,
  onNext,
  onReviewOverview,
  onOpenChat,
  keySlides,
  documents,
  onSurfaceSlide,
  turns,
  reviewIndex,
  onReviewPrev,
  onReviewNext,
}: PracticeViewProps) {
  const question = generatedQ?.questionText ?? null
  const isMC = generatedQ?.format === 'mc'
  const reviewing = reviewIndex !== null
  const showLive = !reviewing && (!mastered || question || loadingQuestion)

  return (
    <>
      {mastered && !reviewing ? (
        <div className="prep-mastered-banner">
          <div className="prep-mastered-emoji" aria-hidden="true">
            ✓
          </div>
          <div className="prep-mastered-title">Topic mastered</div>
          <p className="prep-mastered-sub">
            You hit the mastery bar for this topic. Keep going on the next one,
            or drill a few more questions to stay sharp.
          </p>
          <button
            type="button"
            className="ate-btn"
            onClick={onNext}
            disabled={loadingQuestion}
          >
            {loadingQuestion ? 'Loading…' : 'Practice more'}
          </button>
        </div>
      ) : null}

      {reviewing || showLive || turns.length > 0 ? (
        <div className="prep-qa">
          {turns.length > 0 ? (
            <div className="prep-q-nav">
              <button
                type="button"
                className="prep-q-nav-btn"
                onClick={onReviewPrev}
                disabled={reviewIndex === 0}
                title="Previous question"
              >
                ← Prev
              </button>
              <span className="prep-q-nav-pos">
                {reviewIndex === null
                  ? 'Current question'
                  : `Reviewing ${reviewIndex + 1} / ${turns.length}`}
              </span>
              <button
                type="button"
                className="prep-q-nav-btn"
                onClick={onReviewNext}
                disabled={reviewIndex === null}
                title="Next question"
              >
                {reviewIndex !== null && reviewIndex === turns.length - 1
                  ? 'Back to current →'
                  : 'Next →'}
              </button>
            </div>
          ) : null}

          {reviewing ? (
            <ReviewTurn
              turn={turns[reviewIndex]}
              documents={documents}
              onSurfaceSlide={onSurfaceSlide}
            />
          ) : showLive ? (
            <>
          <div className="prep-q-meta">
            <span className="prep-eyebrow">Question</span>
            {generatedQ?.difficultyLevel ? (
              <span className="prep-chip" title="Difficulty level">
                Lv {generatedQ.difficultyLevel}
              </span>
            ) : null}
            <button
              type="button"
              className="prep-q-review"
              onClick={onReviewOverview}
            >
              ↩ Review overview
            </button>
          </div>
          {loadingQuestion ? (
            <div className="prep-q-loading">
              <span className="prep-spinner small" aria-hidden="true" />
              Writing a question…
            </div>
          ) : question ? (
            <div className="prep-q-text">{question}</div>
          ) : (
            <div className="prep-q-loading">No question yet.</div>
          )}

          {isMC && generatedQ?.choices ? (
            <MultipleChoice
              choices={generatedQ.choices}
              correctIndex={generatedQ.correctIndex ?? 0}
              explanation={generatedQ.explanation}
              selected={mcSelected}
              submitted={mcSubmitted}
              loading={loadingQuestion}
              onSelect={onMcSelect}
              onSubmit={onMcSubmit}
              onNext={onNext}
              nextDisabled={loadingQuestion}
              mastered={mastered}
              onOpenChat={onOpenChat}
              keySlides={keySlides}
              documents={documents}
              onSurfaceSlide={onSurfaceSlide}
            />
          ) : !result ? (
            <div className="prep-answer-block">
              <textarea
                className="prep-answer-input"
                placeholder="Type your answer… (⌘/Ctrl + Enter to submit)"
                value={answer}
                onChange={(e) => onAnswerChange(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={grading || loadingQuestion || !question}
                rows={6}
              />
              <button
                type="button"
                className="ate-btn ate-btn-primary prep-submit"
                onClick={onSubmit}
                disabled={grading || loadingQuestion || !answer.trim()}
              >
                {grading ? 'Grading…' : 'Submit answer'}
              </button>
            </div>
          ) : (
            <Feedback
              result={result}
              onNext={onNext}
              nextDisabled={loadingQuestion}
              mastered={mastered}
              onOpenChat={onOpenChat}
              keySlides={keySlides}
              documents={documents}
              onSurfaceSlide={onSurfaceSlide}
            />
          )}
            </>
          ) : (
            <div className="prep-q-loading">
              Use “← Prev” to review your answered questions.
            </div>
          )}
        </div>
      ) : null}

      {error && !reviewing ? <div className="prep-error">{error}</div> : null}
    </>
  )
}

/** Read-only render of a previously answered question from history. */
function ReviewTurn({
  turn,
  documents,
  onSurfaceSlide,
}: {
  turn: PrepTurn
  documents: PrepSessionRecord['documents']
  onSurfaceSlide: (slide: KeySlide, force?: boolean) => void
}) {
  const isMC = turn.format === 'mc' && (turn.mcChoices?.length ?? 0) > 0
  const scorePct = Math.round(turn.score * 100)
  return (
    <>
      <div className="prep-q-meta">
        <span className="prep-eyebrow">Question</span>
        {turn.difficultyLevel ? (
          <span className="prep-chip" title="Difficulty level">
            Lv {turn.difficultyLevel}
          </span>
        ) : null}
        <span className="prep-q-reviewing">Answered</span>
      </div>
      <div className="prep-q-text">{turn.questionText}</div>

      {isMC ? (
        <div className="prep-mc-choices">
          {turn.mcChoices!.map((choice, i) => {
            let cls = 'prep-mc-card'
            if (i === turn.mcCorrectIndex) cls += ' correct'
            else if (i === turn.mcSelectedIndex) cls += ' wrong'
            else cls += ' other'
            return (
              <div key={i} className={cls}>
                <span className="prep-mc-letter">{CHOICE_LABELS[i]}</span>
                <span className="prep-mc-text">{choice}</span>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="prep-review-answer">
          <div className="prep-review-answer-label">Your answer</div>
          <div className="prep-review-answer-text">
            {turn.userAnswer || '(no answer)'}
          </div>
        </div>
      )}

      <div className="prep-feedback">
        <div className="prep-score-row">
          <ScoreDots score={turn.score} />
          <span className="prep-score-num">+{turn.score} pt</span>
          <span className="prep-score-pct">{scorePct}%</span>
        </div>
        {turn.correctComponents ? (
          <div className="prep-fb-item">
            <div className="prep-fb-h prep-fb-good">What you got right</div>
            <div className="prep-fb-body">{turn.correctComponents}</div>
          </div>
        ) : null}
        {turn.missingComponents ? (
          <div className="prep-fb-item">
            <div className="prep-fb-h prep-fb-miss">What was missing</div>
            <div className="prep-fb-body">{turn.missingComponents}</div>
          </div>
        ) : null}
        {turn.correction ? (
          <div className="prep-fb-item">
            <div className="prep-fb-h">Why</div>
            <div className="prep-fb-body">{turn.correction}</div>
          </div>
        ) : null}
        {turn.suggestedSlide ? (
          <CitationChip
            slide={turn.suggestedSlide}
            documents={documents}
            onSurfaceSlide={onSurfaceSlide}
          />
        ) : null}
      </div>
    </>
  )
}

/** Multiple-choice answer cards with instant client-side grading. */
function MultipleChoice({
  choices,
  correctIndex,
  explanation,
  selected,
  submitted,
  loading,
  onSelect,
  onSubmit,
  onNext,
  nextDisabled,
  mastered,
  onOpenChat,
  keySlides,
  documents,
  onSurfaceSlide,
}: {
  choices: string[]
  correctIndex: number
  explanation?: string
  selected: number | null
  submitted: boolean
  /** A new question is being fetched — block all interaction. */
  loading: boolean
  onSelect: (idx: number) => void
  onSubmit: () => void
  onNext: () => void
  nextDisabled: boolean
  mastered: boolean
  onOpenChat?: () => void
  keySlides: KeySlide[]
  documents: PrepSessionRecord['documents']
  onSurfaceSlide: (slide: KeySlide, force?: boolean) => void
}) {
  const cite = keySlides[0] ?? null
  const locked = submitted || loading
  return (
    <div className="prep-mc-block">
      <div className="prep-mc-choices">
        {choices.map((choice, i) => {
          let cls = 'prep-mc-card'
          if (selected === i && !submitted) cls += ' selected'
          if (submitted) {
            if (i === correctIndex) cls += ' correct'
            else if (i === selected && i !== correctIndex) cls += ' wrong'
            else if (i !== correctIndex) cls += ' other'
          }
          return (
            <button
              key={i}
              type="button"
              className={cls}
              onClick={() => !locked && onSelect(i)}
              disabled={locked}
            >
              <span className="prep-mc-letter">{CHOICE_LABELS[i]}</span>
              <span className="prep-mc-text">{choice}</span>
            </button>
          )
        })}
      </div>

      {!submitted ? (
        <button
          type="button"
          className="ate-btn ate-btn-primary prep-submit"
          onClick={onSubmit}
          disabled={selected == null || loading}
        >
          Submit answer
        </button>
      ) : (
        <>
          <div className="prep-mc-explanation">
            <div className="prep-mc-verdict">
              {selected === correctIndex ? (
                <span className="prep-mc-correct-label">Correct!</span>
              ) : (
                <span className="prep-mc-wrong-label">
                  Incorrect — the answer is {CHOICE_LABELS[correctIndex]}
                </span>
              )}
            </div>
            {explanation ? (
              <div className="prep-mc-explain-text">{explanation}</div>
            ) : null}
            {cite ? (
              <CitationChip slide={cite} documents={documents} onSurfaceSlide={onSurfaceSlide} />
            ) : null}
          </div>
          <div className="prep-mc-after">
            {onOpenChat ? (
              <button
                type="button"
                className="ate-btn prep-chat-trigger"
                onClick={onOpenChat}
              >
                Ask about this
              </button>
            ) : null}
            {!mastered ? (
              <button
                type="button"
                className="ate-btn ate-btn-primary prep-next"
                onClick={onNext}
                disabled={nextDisabled}
              >
                {nextDisabled ? 'Loading…' : 'Next question →'}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}

function Feedback({
  result,
  onNext,
  nextDisabled,
  mastered,
  onOpenChat,
  keySlides,
  documents,
  onSurfaceSlide,
}: {
  result: GradeResult
  onNext: () => void
  nextDisabled: boolean
  mastered: boolean
  onOpenChat?: () => void
  keySlides: KeySlide[]
  documents: PrepSessionRecord['documents']
  onSurfaceSlide: (slide: KeySlide, force?: boolean) => void
}) {
  const scorePct = result.score * 100
  const tone =
    result.score >= 1 ? 'great' : result.score >= 0.5 ? 'ok' : 'low'
  // Prefer the AI-suggested slide; fall back to the topic's first key slide.
  const cite = result.suggestedSlide ?? keySlides[0] ?? null
  return (
    <div className={`prep-feedback prep-feedback-${tone}`}>
      <div className="prep-score-row">
        <ScoreDots score={result.score} />
        <span className="prep-score-num">+{result.score} pt</span>
        <span className="prep-score-pct">{scorePct}%</span>
      </div>

      {result.correctComponents ? (
        <div className="prep-fb-item">
          <div className="prep-fb-h prep-fb-good">What you got right</div>
          <div className="prep-fb-body">{result.correctComponents}</div>
        </div>
      ) : null}
      {result.missingComponents ? (
        <div className="prep-fb-item">
          <div className="prep-fb-h prep-fb-miss">What was missing</div>
          <div className="prep-fb-body">{result.missingComponents}</div>
        </div>
      ) : null}
      {result.correction ? (
        <div className="prep-fb-item">
          <div className="prep-fb-h">Why</div>
          <div className="prep-fb-body">{result.correction}</div>
        </div>
      ) : null}

      {cite ? (
        <CitationChip slide={cite} documents={documents} onSurfaceSlide={onSurfaceSlide} />
      ) : null}

      <div className="prep-fb-actions">
        {onOpenChat ? (
          <button
            type="button"
            className="ate-btn prep-chat-trigger"
            onClick={onOpenChat}
          >
            Ask about this
          </button>
        ) : null}
        {!mastered ? (
          <button
            type="button"
            className="ate-btn ate-btn-primary prep-next"
            onClick={onNext}
            disabled={nextDisabled}
          >
            {nextDisabled ? 'Loading…' : 'Next question →'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ScoreDots({ score }: { score: number }) {
  const quarters = Math.round(score * 4)
  return (
    <span className="prep-dots" aria-label={`${score} of 1 point`}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={`prep-dot ${i < quarters ? 'filled' : ''}`} />
      ))}
    </span>
  )
}
