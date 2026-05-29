import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteLectureEntry,
  listLibrary,
  renameSession,
  type LibraryEntry,
} from '../lib/db'
import { ensureThumbnail, exportLectureByFilename } from '../lib/library'

interface LibraryViewProps {
  onOpen: (filename: string) => void
  onDeleted: (filename: string) => void
  currentlyOpenFilename: string | null
}

export function LibraryView({
  onOpen,
  onDeleted,
  currentlyOpenFilename,
}: LibraryViewProps) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const [exportingFor, setExportingFor] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    const list = await listLibrary()
    setEntries(list)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Lazily generate / fetch a page-1 thumbnail for each library entry.
  // Sequential to avoid spinning up many pdf.js workers at once.
  useEffect(() => {
    if (!entries) return
    let cancelled = false
    ;(async () => {
      for (const e of entries) {
        if (cancelled) return
        if (thumbs[e.filename]) continue
        const url = await ensureThumbnail(e.filename)
        if (cancelled) return
        if (url) {
          setThumbs((prev) =>
            prev[e.filename] === url ? prev : { ...prev, [e.filename]: url },
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries])

  async function handleDelete(entry: LibraryEntry) {
    const label = entry.sessionName || entry.filename
    const ok = window.confirm(
      `Delete "${label}" from the library? This removes the PDF and all notes.`,
    )
    if (!ok) return
    await deleteLectureEntry(entry.filename)
    onDeleted(entry.filename)
    await refresh()
  }

  async function handleRename(entry: LibraryEntry, nextName: string) {
    const trimmed = nextName.trim()
    if (trimmed === entry.sessionName) return
    await renameSession(entry.filename, trimmed)
    await refresh()
  }

  async function handleExport(entry: LibraryEntry) {
    setExportingFor(entry.filename)
    try {
      await exportLectureByFilename(entry.filename)
    } catch (e) {
      console.error('library export failed', e)
      alert('Export failed — see console for details.')
    } finally {
      setExportingFor(null)
    }
  }

  if (entries === null) {
    return <div className="library empty">Loading library…</div>
  }
  if (entries.length === 0) {
    return (
      <div className="library empty">
        <h2>No lectures yet</h2>
        <p>Open a PDF and it will appear here automatically.</p>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? entries.filter(
        (e) =>
          e.sessionName.toLowerCase().includes(q) ||
          e.filename.toLowerCase().includes(q),
      )
    : entries

  return (
    <div className="library">
      <div className="library-heading">
        <h2>
          Your library<em>, {entries.length} lecture{entries.length === 1 ? '' : 's'}</em>
        </h2>
        <div className="library-controls">
          <label className="library-search">
            <SearchIcon />
            <input
              type="text"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="library empty" style={{ paddingTop: 48 }}>
          <p>No lectures match “{query}”.</p>
        </div>
      ) : (
        <div className="library-grid">
          {filtered.map((e) => (
            <LibraryCard
              key={e.filename}
              entry={e}
              thumb={thumbs[e.filename]}
              isOpen={e.filename === currentlyOpenFilename}
              exporting={exportingFor === e.filename}
              renaming={renameTarget === e.filename}
              onOpen={() => onOpen(e.filename)}
              onDelete={() => handleDelete(e)}
              onExport={() => handleExport(e)}
              onStartRename={() => setRenameTarget(e.filename)}
              onCancelRename={() => setRenameTarget(null)}
              onCommitRename={async (n) => {
                await handleRename(e, n)
                setRenameTarget(null)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface LibraryCardProps {
  entry: LibraryEntry
  thumb: string | undefined
  isOpen: boolean
  exporting: boolean
  renaming: boolean
  onOpen: () => void
  onDelete: () => void
  onExport: () => void
  onStartRename: () => void
  onCancelRename: () => void
  onCommitRename: (next: string) => void
}

function LibraryCard({
  entry,
  thumb,
  isOpen,
  exporting,
  renaming,
  onOpen,
  onDelete,
  onExport,
  onStartRename,
  onCancelRename,
  onCommitRename,
}: LibraryCardProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useState(entry.sessionName)

  useEffect(() => {
    if (renaming) {
      setDraft(entry.sessionName)
      queueMicrotask(() => inputRef.current?.select())
    }
  }, [renaming, entry.sessionName])

  const displayName = entry.sessionName || 'Untitled lecture'
  const eyebrowText = entry.filename.replace(/\.pdf$/i, '').slice(0, 40)
  const slideLabel = entry.numPages
    ? `${String(entry.activeSlideIndex + 1).padStart(2, '0')} / ${String(entry.numPages).padStart(2, '0')} slides`
    : '— slides'
  const notesLabel = entry.numPages
    ? `${entry.notesCount} notes`
    : `${entry.notesCount} notes`
  const opened = useMemo(
    () => formatRelative(entry.lastOpenedAt),
    [entry.lastOpenedAt],
  )

  function onBodyClick(e: React.MouseEvent) {
    if (renaming) return
    if ((e.target as HTMLElement).closest('.lib-actions')) return
    onOpen()
  }

  return (
    <article
      className={`lib-card ${isOpen ? 'current' : ''}`}
      onClick={onBodyClick}
    >
      <div className="lib-card-thumb" aria-hidden="true">
        {thumb ? (
          <img src={thumb} alt="" className="lib-card-thumb-img" />
        ) : (
          <>
            <div className="placeholder">{displayName}</div>
            <div className="accent-line" />
          </>
        )}
      </div>
      <div className="lib-card-body">
        <div className="lib-card-eyebrow">{eyebrowText}</div>
        {renaming ? (
          <input
            ref={inputRef}
            className="lib-rename"
            value={draft}
            placeholder="Session name"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onCommitRename(draft)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancelRename()
              }
            }}
            onBlur={() => onCommitRename(draft)}
          />
        ) : (
          <h3
            className="lib-card-title"
            onDoubleClick={(e) => {
              e.stopPropagation()
              onStartRename()
            }}
          >
            {displayName}
          </h3>
        )}
        <div className="lib-card-meta">
          <span>{slideLabel} · {notesLabel}</span>
          <span className="lib-card-pill">{opened}</span>
        </div>
      </div>
      <div className="lib-actions" onClick={(e) => e.stopPropagation()}>
        <button onClick={onOpen} title="Open">
          Open
        </button>
        <button onClick={onStartRename} title="Rename">
          Rename
        </button>
        <button onClick={onExport} disabled={exporting} title="Export PDF">
          {exporting ? 'Exporting…' : 'Export'}
        </button>
        <button onClick={onDelete} className="danger" title="Delete">
          Delete
        </button>
      </div>
    </article>
  )
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: 'var(--ate-muted)', flexShrink: 0 }}
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
