import { useEffect, useRef, useState } from 'react'
import {
  listLibrary,
  MASTERY_THRESHOLDS,
  MAX_PREP_FILES,
  type LibraryEntry,
  type PrepDifficulty,
  type PrepDocRole,
} from '../../lib/db'
import { prettifyFilename } from '../../lib/filenameUtils'

export interface PrepPick {
  id: string
  source: 'library' | 'upload'
  /** Key in the `pdfs` store. */
  storageFilename: string
  displayName: string
  role: PrepDocRole
  /** Present for fresh uploads — must be persisted before processing. */
  file?: File
}

export interface PrepSetupResult {
  title: string
  difficulty: PrepDifficulty
  picks: PrepPick[]
  userContext: string
}

interface PrepSetupProps {
  onCancel: () => void
  onStart: (result: PrepSetupResult) => void
}

const DIFFICULTIES: { value: PrepDifficulty; label: string; blurb: string }[] = [
  {
    value: 'foundational',
    label: 'Foundational',
    blurb: `${MASTERY_THRESHOLDS.foundational} pts · single-topic focus`,
  },
  {
    value: 'thorough',
    label: 'Thorough',
    blurb: `${MASTERY_THRESHOLDS.thorough} pts · KC coverage · retry queue`,
  },
  {
    value: 'exam-ready',
    label: 'Exam-ready',
    blurb: `${MASTERY_THRESHOLDS['exam-ready']} pts · full rotation · review`,
  },
]

const ROLES: PrepDocRole[] = ['lecture', 'homework', 'exam', 'topic-sheet']

const ROLE_LABELS: Record<PrepDocRole, string> = {
  lecture: 'Lecture',
  homework: 'Homework',
  exam: 'Practice exam',
  'topic-sheet': 'Topic sheet',
}

export function PrepSetup({ onCancel, onStart }: PrepSetupProps) {
  const [library, setLibrary] = useState<LibraryEntry[]>([])
  const [picks, setPicks] = useState<PrepPick[]>([])
  const [title, setTitle] = useState('')
  const [difficulty, setDifficulty] = useState<PrepDifficulty>('thorough')
  const [userContext, setUserContext] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    listLibrary().then(setLibrary)
  }, [])

  const atLimit = picks.length >= MAX_PREP_FILES

  function isPicked(storageFilename: string): boolean {
    return picks.some((p) => p.storageFilename === storageFilename)
  }

  function toggleLibrary(entry: LibraryEntry) {
    setPicks((prev) => {
      const existing = prev.find((p) => p.storageFilename === entry.filename)
      if (existing) return prev.filter((p) => p !== existing)
      if (prev.length >= MAX_PREP_FILES) return prev
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          source: 'library',
          storageFilename: entry.filename,
          displayName: entry.sessionName || prettifyFilename(entry.filename),
          role: 'lecture',
        },
      ]
    })
  }

  function addUploads(files: FileList | null) {
    if (!files) return
    // Snapshot the FileList NOW — the caller resets the input value right after,
    // which empties this FileList before the (deferred) state updater runs.
    const incoming = Array.from(files).filter((f) => /\.pdf$/i.test(f.name))
    if (incoming.length === 0) return
    setPicks((prev) => {
      const next = [...prev]
      for (const file of incoming) {
        if (next.length >= MAX_PREP_FILES) break
        next.push({
          id: crypto.randomUUID(),
          source: 'upload',
          storageFilename: `prep-${crypto.randomUUID()}-${file.name}`,
          displayName: prettifyFilename(file.name),
          role: 'lecture',
          file,
        })
      }
      return next
    })
  }

  function setRole(id: string, role: PrepDocRole) {
    setPicks((prev) => prev.map((p) => (p.id === id ? { ...p, role } : p)))
  }

  function removePick(id: string) {
    setPicks((prev) => prev.filter((p) => p.id !== id))
  }

  function start() {
    if (picks.length === 0) return
    onStart({
      title: title.trim(),
      difficulty,
      picks,
      userContext: userContext.trim(),
    })
  }

  return (
    <div className="prep-setup">
      <div className="prep-setup-head">
        <div className="prep-eyebrow">New prep session</div>
        <input
          className="session-input prep-title-input"
          placeholder="Auto-named from content · or enter a title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="prep-title-hint">Leave blank to auto-name after build.</div>
      </div>

      <div className="prep-setup-body">
        <section className="prep-setup-col">
          <h3 className="prep-setup-h">1 · Gather materials</h3>
          <p className="prep-setup-hint">
            Pick from your library or upload new files. Mark practice exams (we
            never reuse their questions) and topic sheets if your professor gave
            one out — we use those to align the curriculum to what's actually
            on the exam. Up to {MAX_PREP_FILES} files.
          </p>

          <div className="prep-source-group">
            <div className="prep-source-label">From library</div>
            {library.length === 0 ? (
              <div className="prep-setup-empty">No saved lectures yet.</div>
            ) : (
              <div className="prep-lib-list">
                {library.map((e) => (
                  <button
                    key={e.filename}
                    type="button"
                    className={`prep-lib-item ${isPicked(e.filename) ? 'selected' : ''}`}
                    onClick={() => toggleLibrary(e)}
                    disabled={!isPicked(e.filename) && atLimit}
                  >
                    <span className="prep-lib-check" aria-hidden="true">
                      {isPicked(e.filename) ? '✓' : ''}
                    </span>
                    <span className="prep-lib-name">
                      {e.sessionName || prettifyFilename(e.filename)}
                    </span>
                    <span className="prep-lib-pages">{e.numPages}p</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="prep-source-group">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              multiple
              className="file-hidden"
              onChange={(e) => {
                addUploads(e.target.files)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              className="ate-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={atLimit}
            >
              Upload PDFs from computer
            </button>
          </div>
        </section>

        <section className="prep-setup-col">
          <h3 className="prep-setup-h">
            2 · Selected ({picks.length}/{MAX_PREP_FILES})
          </h3>
          {picks.length === 0 ? (
            <div className="prep-setup-empty">Nothing selected yet.</div>
          ) : (
            <div className="prep-pick-list">
              {picks.map((p) => (
                <div key={p.id} className="prep-pick-item">
                  <div className="prep-pick-name" title={p.displayName}>
                    {p.displayName}
                    <span className="prep-pick-src">
                      {p.source === 'upload' ? 'new' : 'library'}
                    </span>
                  </div>
                  <select
                    className="prep-role-select"
                    value={p.role}
                    onChange={(e) => setRole(p.id, e.target.value as PrepDocRole)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="prep-pick-del"
                    onClick={() => removePick(p.id)}
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <h3 className="prep-setup-h" style={{ marginTop: 20 }}>
            3 · Intensity
          </h3>
          <div className="prep-diff-row">
            {DIFFICULTIES.map((d) => (
              <button
                key={d.value}
                type="button"
                className={`prep-diff-btn ${difficulty === d.value ? 'active' : ''}`}
                onClick={() => setDifficulty(d.value)}
              >
                <span className="prep-diff-name">{d.label}</span>
                <span className="prep-diff-blurb">{d.blurb}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="prep-context-wrap">
        <label className="prep-setup-h prep-context-label" htmlFor="prep-user-context">
          4 · Anything Claude should know?
        </label>
        <textarea
          id="prep-user-context"
          className="prep-context-area"
          placeholder="e.g. I always mix up memoization vs tabulation · focus on application questions · my exam is in 2 days and I'm shaky on sorting · skip things I'm confident in"
          rows={3}
          value={userContext}
          onChange={(e) => setUserContext(e.target.value)}
        />
      </div>

      <div className="prep-setup-foot">
        <button type="button" className="ate-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ate-btn ate-btn-primary"
          onClick={start}
          disabled={picks.length === 0}
        >
          Build curriculum →
        </button>
      </div>
    </div>
  )
}
