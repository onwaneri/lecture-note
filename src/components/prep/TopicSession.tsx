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
  /** Cached unanswered question for this topic (survives unmount/remount). */
  cachedQuestion?: GeneratedQuestion | null
  /** Cache a newly generated question in the parent so it survives navigation. */
  onCacheQuestion?: (q: GeneratedQuestion) => void
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
  onCacheQuestion,
}: TopicSessionProps) {
  const [mode, setMode] = useState<Mode>('learn')

  // Learn phase — the overview is generated + cached by PrepStudy and arrives
  // via props. A local ticker just gives feedback while it's still loading.
  const [overviewElapsed, setOverviewElapsed] = useState(0)

  // Practice phase
  const [generatedQ, setGeneratedQ] = useState<GeneratedQuestion | null>(null)
  // Prefetched next question — promoted instantly when the student clicks Next.
  const [nextQ, setNextQ] = useState<GeneratedQuestion | null>(null)
  const [loadingQuestion, setLoadingQuestion] = useState(false)
  const [answer, setAnswer] = useState('')
  const [grading, setGrading] = useState(false)
  const [result, setResult] = useState<GradeResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // MC state
  const [mcSelected, setMcSelected] = useState<number | null>(null)
  const [mcSubmitted, setMcSubmitted] = useState(false)

  const questionReqRef = useRef(0)
  const prefetchTokenRef = useRef(0)
  const prefetchInFlight = useRef(false)

  const accumulated = progress?.masteryAccumulated ?? 0
  const mastered = accumulated >= topic.masteryThreshold
  const pct = Math.min(100, Math.round((accumulated / topic.masteryThreshold) * 100))
  const hasPracticed = (progress?.turns?.length ?? 0) > 0

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
    prefetchTokenRef.current++
    setMode('learn')
    setGeneratedQ(cachedQuestion ?? null)
    setNextQ(null)
    setResult(null)
    setAnswer('')
    setError(null)
    setMcSelected(null)
    setMcSubmitted(false)
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

  // Prefetch the next question in the background so "Next" is instant.
  const prefetchNext = useCallback(
    async (excludeText?: string) => {
      if (prefetchInFlight.current) return
      prefetchInFlight.current = true
      const token = ++prefetchTokenRef.current
      try {
        const q = await requestQuestion(excludeText ? [excludeText] : [])
        if (token === prefetchTokenRef.current) setNextQ(q)
      } catch {
        // Best-effort — if it fails we just fetch on demand when Next is clicked.
      } finally {
        prefetchInFlight.current = false
      }
    },
    [requestQuestion],
  )

  // Fetch the current question on demand (no prefetch ready), then prefetch next.
  const fetchCurrent = useCallback(async () => {
    const token = ++questionReqRef.current
    prefetchTokenRef.current++ // cancel any stale prefetch result
    prefetchInFlight.current = false // allow a fresh prefetch to start after
    setLoadingQuestion(true)
    setError(null)
    setResult(null)
    setAnswer('')
    setGeneratedQ(null)
    setMcSelected(null)
    setMcSubmitted(false)
    setNextQ(null)
    try {
      const q = await requestQuestion([])
      if (token !== questionReqRef.current) return
      setGeneratedQ(q)
      onCacheQuestion?.(q)
      void prefetchNext(q.questionText)
    } catch (e) {
      if (token !== questionReqRef.current) return
      setError(e instanceof Error ? e.message : 'Failed to load a question.')
    } finally {
      if (token === questionReqRef.current) setLoadingQuestion(false)
    }
  }, [requestQuestion, prefetchNext, onCacheQuestion])

  function startPractice() {
    setMode('practice')
    if (!generatedQ && !mastered) {
      void fetchCurrent()
    } else if (generatedQ && !nextQ && !mastered) {
      // Restored/cached question with no prefetch yet — warm one up.
      void prefetchNext(generatedQ.questionText)
    }
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
    // Start prefetching the next question immediately so it's ready when the
    // student clicks "Next question".
    void prefetchNext(generatedQ.questionText)
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
      // Prefetch the next question while the student reviews feedback.
      void prefetchNext(generatedQ.questionText)
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
    if (nextQ) {
      // Instant: promote the prefetched question and warm up the one after it.
      const promoted = nextQ
      questionReqRef.current++ // supersede any in-flight on-demand fetch
      setGeneratedQ(promoted)
      onCacheQuestion?.(promoted)
      setNextQ(null)
      setResult(null)
      setAnswer('')
      setError(null)
      setMcSelected(null)
      setMcSubmitted(false)
      setLoadingQuestion(false)
      void prefetchNext(promoted.questionText)
    } else {
      void fetchCurrent()
    }
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
        <h2 className="prep-ts-title">{topic.title}</h2>
        <div className="prep-ts-mastery">
          <div className="prep-topic-bar">
            <div className="prep-topic-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="prep-ts-pts">
            {accumulated} / {topic.masteryThreshold} pts
          </span>
        </div>
        <div className="prep-ts-tabs">
          <button
            type="button"
            className={`prep-ts-tab ${mode === 'learn' ? 'active' : ''}`}
            onClick={() => setMode('learn')}
          >
            Overview
          </button>
          <button
            type="button"
            className={`prep-ts-tab ${mode === 'practice' ? 'active' : ''}`}
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
}: PracticeViewProps) {
  const question = generatedQ?.questionText ?? null
  const isMC = generatedQ?.format === 'mc'

  return (
    <>
      {mastered ? (
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

      {!mastered || question ? (
        <div className="prep-qa">
          <div className="prep-q-block">
            <div className="prep-q-label">
              Question
              {generatedQ?.difficultyLevel ? (
                <span className="prep-q-diff" title="Difficulty level">
                  Lv {generatedQ.difficultyLevel}
                </span>
              ) : null}
              <button
                type="button"
                className="prep-review-link"
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
          </div>

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
        </div>
      ) : null}

      {error ? <div className="prep-error">{error}</div> : null}
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
