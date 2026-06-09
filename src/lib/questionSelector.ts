// Adaptive question selection algorithm.
//
// Drives interleaving, retry queues, review injection, KC targeting, and
// adaptive difficulty — all configured per difficulty mode.

import {
  ensureKCs,
  MASTERY_CONFIGS,
  type CurriculumTopic,
  type KnowledgeComponent,
  type MasteryConfig,
  type PrepDifficulty,
  type PrepTopicProgressRecord,
  type RetryItem,
  type PrepTurn,
} from './db'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StudyState {
  topics: CurriculumTopic[]
  progress: Map<string, PrepTopicProgressRecord>
  difficulty: PrepDifficulty
  retryQueue: RetryItem[]
  /** Last 2 topic IDs asked (most recent last). */
  recentTopicIds: string[]
  turnCount: number
  /** The topic the student is currently viewing (for foundational single-topic). */
  currentTopicId?: string
  /** User-requested difficulty nudge (+1 or -1) applied on top of adaptive. */
  difficultyNudge?: number
}

export interface NextQuestion {
  topicId: string
  targetDifficulty: number
  targetKcId?: string
  targetKcLabel?: string
  reason: 'retry' | 'review' | 'normal'
}

// ---------------------------------------------------------------------------
// Core selection
// ---------------------------------------------------------------------------

export function selectNextQuestion(state: StudyState): NextQuestion {
  const config = MASTERY_CONFIGS[state.difficulty]
  // Questions always stay within the current topic — topic navigation is
  // always explicit (via the curriculum map), never forced.
  const currentId = state.currentTopicId ?? state.topics[0]?.id ?? ''
  const topic = state.topics.find((t) => t.id === currentId)

  const topicProgress = state.progress.get(currentId)

  const nudge = state.difficultyNudge ?? 0
  const applyNudge = (d: number) => Math.max(1, Math.min(5, d + nudge))

  // Retry queue — only process items queued for the current topic.
  if (config.retryEnabled) {
    const retryIdx = state.retryQueue.findIndex(
      (r) => r.questionsUntilRetry <= 0 && r.topicId === currentId,
    )
    if (retryIdx !== -1) {
      const item = state.retryQueue[retryIdx]
      return {
        topicId: currentId,
        targetDifficulty: applyNudge(adaptiveDifficulty(topic ?? null, topicProgress)),
        targetKcId: item.kcId,
        targetKcLabel: item.kcId ? kcLabelById(topic, item.kcId) : undefined,
        reason: 'retry',
      }
    }
  }

  // Normal — KC targeting + adaptive difficulty within the current topic.
  const kc = topic ? pickTargetKC(topic, topicProgress) : undefined
  return {
    topicId: currentId,
    targetDifficulty: applyNudge(adaptiveDifficulty(topic ?? null, topicProgress)),
    targetKcId: kc?.id,
    targetKcLabel: kc?.label,
    reason: 'normal',
  }
}

// ---------------------------------------------------------------------------
// KC targeting — fewest attempts, lowest score
// ---------------------------------------------------------------------------

function pickTargetKC(
  topic: CurriculumTopic,
  progress: PrepTopicProgressRecord | undefined,
): KnowledgeComponent | undefined {
  const kcs = ensureKCs(topic)
  if (kcs.length <= 1) return kcs[0]

  const kcMastery = progress?.kcMastery ?? {}
  // Sort by fewest attempts, then lowest average score.
  const sorted = [...kcs].sort((a, b) => {
    const ma = kcMastery[a.id]
    const mb = kcMastery[b.id]
    const attA = ma?.attempts ?? 0
    const attB = mb?.attempts ?? 0
    if (attA !== attB) return attA - attB
    const avgA = attA > 0 ? (ma!.totalScore / attA) : 0
    const avgB = attB > 0 ? (mb!.totalScore / attB) : 0
    return avgA - avgB
  })
  return sorted[0]
}

// ---------------------------------------------------------------------------
// Adaptive difficulty — based on last 3 scores
// ---------------------------------------------------------------------------

function adaptiveDifficulty(
  _topic: CurriculumTopic | null,
  progress: PrepTopicProgressRecord | undefined,
): number {
  const turns = progress?.turns ?? []
  if (turns.length === 0) return 1 // start at recall/definition

  const recent = turns.slice(-3)
  const avg = recent.reduce((s, t) => s + t.score, 0) / recent.length

  // Base from last question's difficulty, or 2.
  const lastDiff =
    turns.length > 0 ? (turns[turns.length - 1].difficultyLevel ?? 2) : 2
  let next = lastDiff
  if (avg > 0.85) next = lastDiff + 1
  else if (avg < 0.5) next = lastDiff - 1

  return Math.max(1, Math.min(5, next))
}

// ---------------------------------------------------------------------------
// Mastery check — compound check replacing simple threshold
// ---------------------------------------------------------------------------

/** Penalty points applied when a student scores exactly 0, by difficulty level. */
export const WRONG_PENALTIES: Record<number, number> = {
  1: -0.5,
  2: -0.4,
  3: -0.3,
  4: -0.2,
  5: -0.1,
}

/**
 * Calculates the effective score contribution toward mastery based on difficulty.
 *
 * When `rawScore === 0` (completely wrong), a negative penalty is applied that
 * decreases with difficulty (harder questions penalize less).
 *
 * When `rawScore > 0`:
 *   - Level 1: 0 (doesn't count toward mastery)
 *   - Level 2: 0.5x
 *   - Level 3: 0.75x
 *   - Level 4+: 1x
 */
export function calculateMasteryScore(
  rawScore: number,
  difficultyLevel: number = 1,
  penaltiesEnabled: boolean = false,
): number {
  // Completely wrong → penalty only for turns created after the refactor
  // (indicated by penaltiesEnabled). Old turns stay at 0.
  if (rawScore === 0) {
    if (!penaltiesEnabled) return 0
    return WRONG_PENALTIES[Math.max(1, Math.min(5, difficultyLevel))] ?? -0.1
  }
  if (difficultyLevel < 2) {
    return 0 // Level 1 questions don't count toward mastery
  }
  if (difficultyLevel === 2) {
    return rawScore * 0.5
  }
  if (difficultyLevel === 3) {
    return rawScore * 0.75
  }
  return rawScore // Level 4+ worth full points
}

/**
 * Halves the raw score when the student used a hint. Apply this BEFORE
 * feeding the score into `calculateMasteryScore`.
 */
export function applyHintPenalty(score: number, hintUsed: boolean): number {
  return hintUsed ? score * 0.5 : score
}

/**
 * Filters turns to only include those that count toward mastery (level 2+).
 */
export function filterMasteryTurns(turns: PrepTurn[]): PrepTurn[] {
  return turns.filter((t) => (t.difficultyLevel ?? 1) >= 2)
}

/**
 * Calculates the total mastery points from a turn history,
 * applying difficulty-based scoring rules. Clamped to ≥ 0.
 *
 * Wrong-answer penalties only apply to turns created after the refactor
 * (identified by having `hintUsed` defined on the turn record).
 */
export function calculateTotalMasteryPoints(turns: PrepTurn[]): number {
  const raw = turns.reduce((sum, turn) => {
    const penaltiesEnabled = turn.hintUsed !== undefined
    return sum + calculateMasteryScore(turn.score, turn.difficultyLevel ?? 1, penaltiesEnabled)
  }, 0)
  return Math.max(0, raw)
}

export function canMarkMastered(
  topic: CurriculumTopic,
  progress: PrepTopicProgressRecord,
  config: MasteryConfig,
): boolean {
  // 1. Point threshold — only using level 2+ questions
  const masteryPoints = calculateTotalMasteryPoints(progress.turns)
  if (masteryPoints < config.pointThreshold) return false

  // 2. KC coverage — only count attempts/scores from level 2+ questions
  const kcs = ensureKCs(topic)
  for (const kc of kcs) {
    const m = progress.kcMastery?.[kc.id]
    if (!m || m.attempts < config.minKCAttempts) return false
    if (
      config.minKCAvgScore != null &&
      m.totalScore / m.attempts < config.minKCAvgScore
    ) {
      return false
    }
  }

  // 3. Depth — at least one question at the required difficulty (level 2+).
  if (config.minDifficultyReached != null) {
    const hasDepth = filterMasteryTurns(progress.turns).some(
      (t) => (t.difficultyLevel ?? 1) >= config.minDifficultyReached!,
    )
    if (!hasDepth) return false
  }

  return true
}

// ---------------------------------------------------------------------------
// Post-answer hook — update retry queue & KC mastery
// ---------------------------------------------------------------------------

export interface PostAnswerResult {
  retryQueue: RetryItem[]
  kcMastery: Record<string, { attempts: number; totalScore: number }>
}

export function onAnswerGraded(
  score: number,
  topicId: string,
  kcId: string | undefined,
  retryQueue: RetryItem[],
  kcMastery: Record<string, { attempts: number; totalScore: number }>,
  config: MasteryConfig,
): PostAnswerResult {
  // Clone to avoid mutation.
  let queue = retryQueue.map((r) => ({ ...r }))
  const mastery = { ...kcMastery }

  // Update KC mastery.
  if (kcId) {
    const prev = mastery[kcId] ?? { attempts: 0, totalScore: 0 }
    mastery[kcId] = {
      attempts: prev.attempts + 1,
      totalScore: prev.totalScore + score,
    }
  }

  // If the retry popped this item, remove it.
  queue = queue.filter(
    (r) => !(r.topicId === topicId && r.kcId === kcId && r.questionsUntilRetry <= 0),
  )

  // If score < 0.75 and retry is enabled, push a new retry item
  // (unless this topic/kc is already in the queue).
  if (score < 0.75 && config.retryEnabled) {
    const alreadyQueued = queue.some(
      (r) => r.topicId === topicId && r.kcId === kcId,
    )
    if (!alreadyQueued) {
      queue.push({
        topicId,
        kcId,
        questionsUntilRetry: config.retryDelay,
      })
    }
  }

  // Decrement all retry queue items' questionsUntilRetry.
  queue = queue.map((r) => ({
    ...r,
    questionsUntilRetry: Math.max(0, r.questionsUntilRetry - 1),
  }))

  return { retryQueue: queue, kcMastery: mastery }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kcLabelById(
  topic: CurriculumTopic | undefined,
  kcId: string,
): string | undefined {
  if (!topic) return undefined
  const kcs = ensureKCs(topic)
  return kcs.find((k) => k.id === kcId)?.label
}
