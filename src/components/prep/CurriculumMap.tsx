import { useState } from 'react'
import { ensureKCs, MASTERY_CONFIGS, type PrepDifficulty } from '../../lib/db'
import type {
  CurriculumTopic,
  PrepTopicProgressRecord,
} from '../../lib/db'

interface CurriculumMapProps {
  topics: CurriculumTopic[]
  progress: Map<string, PrepTopicProgressRecord>
  difficulty: PrepDifficulty
  onSelect: (topicId: string) => void
  onResetProgress: () => Promise<void>
}

export function CurriculumMap({
  topics,
  progress,
  difficulty,
  onSelect,
  onResetProgress,
}: CurriculumMapProps) {
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const config = MASTERY_CONFIGS[difficulty]
  const masteredCount = topics.filter(
    (t) => progress.get(t.id)?.status === 'mastered',
  ).length

  return (
    <div className="prep-map">
      <div className="prep-map-head">
        <h2 className="prep-map-title">Curriculum</h2>
        <span className="prep-map-progress">
          {masteredCount} / {topics.length} mastered
        </span>
      </div>
      <p className="prep-map-hint">
        Jump into any topic, in whatever order you like — the suggested order
        builds foundations first, but it's up to you.
      </p>

      <ol className="prep-topic-list">
        {topics.map((t) => {
          const rec = progress.get(t.id)
          const accumulated = rec?.masteryAccumulated ?? 0
          const mastered = rec?.status === 'mastered'
          const pct = Math.min(
            100,
            Math.round((accumulated / t.masteryThreshold) * 100),
          )
          const kcs = ensureKCs(t)
          const kcMastery = rec?.kcMastery ?? {}
          const kcsMet = kcs.filter((kc) => {
            const m = kcMastery[kc.id]
            const attempts = m?.attempts ?? 0
            const avg = attempts > 0 ? m!.totalScore / attempts : 0
            return (
              attempts >= config.minKCAttempts &&
              (config.minKCAvgScore == null || avg >= config.minKCAvgScore)
            )
          }).length
          return (
            <li key={t.id}>
              <button
                type="button"
                className={`prep-topic-card ${mastered ? 'mastered' : ''}`}
                onClick={() => onSelect(t.id)}
              >
                <div className="prep-topic-top">
                  <span className="prep-topic-num">
                    {String(t.order + 1).padStart(2, '0')}
                  </span>
                  <span className="prep-topic-name">{t.title}</span>
                  <span className="prep-topic-badge">
                    {mastered ? '✓ Mastered' : `${accumulated}/${t.masteryThreshold}`}
                  </span>
                </div>
                {t.summary ? (
                  <div className="prep-topic-summary">{t.summary}</div>
                ) : null}
                {kcs.length > 1 ? (
                  <div className="prep-kc-dots">
                    {kcs.map((kc) => {
                      const m = kcMastery[kc.id]
                      const attempts = m?.attempts ?? 0
                      const avg = attempts > 0 ? m!.totalScore / attempts : 0
                      const met =
                        attempts >= config.minKCAttempts &&
                        (config.minKCAvgScore == null || avg >= config.minKCAvgScore)
                      return (
                        <span
                          key={kc.id}
                          className={`prep-kc-dot ${met ? 'met' : ''}`}
                          title={`${kc.label}${m ? ` · ${m.attempts} attempt${m.attempts !== 1 ? 's' : ''} · avg ${Math.round(avg * 100)}%` : ''}`}
                        />
                      )
                    })}
                  </div>
                ) : null}
                <div className="prep-topic-status-line">
                  <span>{accumulated}/{t.masteryThreshold} pts</span>
                  {kcs.length > 1 ? <span>{kcsMet}/{kcs.length} KCs</span> : null}
                </div>
                <div className="prep-topic-bar">
                  <div
                    className="prep-topic-bar-fill"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </button>
            </li>
          )
        })}
      </ol>

      <div className="prep-map-reset">
        {!confirmReset ? (
          <button
            type="button"
            className="prep-reset-btn"
            onClick={() => setConfirmReset(true)}
          >
            Reset progress
          </button>
        ) : (
          <div className="prep-reset-confirm">
            <span>Reset all progress for this session?</span>
            <button
              type="button"
              className="ate-btn prep-reset-yes"
              disabled={resetting}
              onClick={async () => {
                setResetting(true)
                await onResetProgress()
                setResetting(false)
                setConfirmReset(false)
              }}
            >
              {resetting ? 'Resetting…' : 'Yes, reset'}
            </button>
            <button
              type="button"
              className="ate-btn"
              disabled={resetting}
              onClick={() => setConfirmReset(false)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
