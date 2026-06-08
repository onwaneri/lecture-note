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
import { PrepHeader } from './PrepHeader'

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

  const buildBtn = (
    <button
      type="button"
      className="ate-btn ate-btn-primary"
      onClick={start}
      disabled={picks.length === 0}
    >
      Build curriculum →
    </button>
  )

  return (
    <div className="prep-screen">
      <PrepHeader
        center={<div className="prep-eyebrow acc">New prep session</div>}
        right={
          <>
            <button type="button" className="ate-btn" onClick={onCancel}>
              Cancel
            </button>
            {buildBtn}
          </>
        }
      />

      <div className="prep-setup-namebar">
        <input
          className="prep-name-input"
          placeholder="Session title — leave blank to auto-name after build"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="prep-setup-cols">
        {/* 01 · Gather materials */}
        <div className="prep-setup-col">
          <div className="prep-col-head">
            <span className="prep-col-num">01</span>
            <span className="prep-col-title">Gather materials</span>
            <span className="prep-chip">
              {picks.length} / {MAX_PREP_FILES}
            </span>
          </div>
          <div className="prep-col-body">
            <p className="prep-setup-hint">
              Pick from your library or upload new files. Mark practice exams (we
              never reuse their questions) and topic sheets so Doug can align the
              curriculum to what's actually on the exam. Up to {MAX_PREP_FILES}{' '}
              files.
            </p>

            <div className="prep-source-label">From library</div>
            {library.length === 0 ? (
              <div className="prep-setup-empty">No saved lectures yet.</div>
            ) : (
              library.map((e) => (
                <button
                  key={e.filename}
                  type="button"
                  className={`prep-lib-row ${isPicked(e.filename) ? 'sel' : ''}`}
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
              ))
            )}

            <div className="prep-source-label" style={{ marginTop: 16 }}>
              Upload
            </div>
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
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => fileInputRef.current?.click()}
              disabled={atLimit}
            >
              Upload PDFs from disk
            </button>
          </div>
        </div>

        {/* 02 · Selected + context */}
        <div className="prep-setup-col">
          <div className="prep-col-head">
            <span className="prep-col-num">02</span>
            <span className="prep-col-title">Selected</span>
            <span className="prep-chip">
              {picks.length} / {MAX_PREP_FILES}
            </span>
          </div>
          <div className="prep-col-body">
            {picks.length === 0 ? (
              <div className="prep-setup-empty">Nothing selected yet.</div>
            ) : (
              picks.map((p) => (
                <div key={p.id} className="prep-pick-row">
                  <span className="prep-pick-name" title={p.displayName}>
                    {p.displayName}
                  </span>
                  <select
                    className="prep-pick-role"
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
              ))
            )}

            <label className="prep-ctx-label" htmlFor="prep-user-context">
              Anything Doug should know?
            </label>
            <textarea
              id="prep-user-context"
              className="prep-ctx-ta"
              placeholder="e.g. I'm shaky on recursion · focus on application · my exam is Thursday"
              rows={4}
              value={userContext}
              onChange={(e) => setUserContext(e.target.value)}
            />
          </div>
        </div>

        {/* 03 · Intensity */}
        <div className="prep-setup-col">
          <div className="prep-col-head">
            <span className="prep-col-num">03</span>
            <span className="prep-col-title">Intensity</span>
          </div>
          <div className="prep-col-body">
            <div className="prep-intensity-list">
              {DIFFICULTIES.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  className={`prep-intensity-opt ${difficulty === d.value ? 'active' : ''}`}
                  onClick={() => setDifficulty(d.value)}
                >
                  <span className="prep-radio" aria-hidden="true" />
                  <span>
                    <span className="prep-intensity-label">{d.label}</span>
                    <span className="prep-intensity-desc">{d.blurb}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="prep-setup-foot">
        <button type="button" className="ate-btn" onClick={onCancel}>
          Cancel
        </button>
        {buildBtn}
      </div>
    </div>
  )
}
