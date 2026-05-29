import type { ChangeEvent } from 'react'
import { ExportButton } from './ExportButton'
import type { PDFDocumentProxy } from '../lib/pdf'

interface HeaderProps {
  sessionName: string
  filename: string | null
  activeIndex: number
  numPages: number
  onSessionNameChange: (name: string) => void
  onOpenFile: () => void
  doc: PDFDocumentProxy | null
  notes: Map<number, string>
  exporting: boolean
  onExport: () => void
  view: 'lecture' | 'library' | 'focus'
  libraryCount: number
  onToggleLibrary: () => void
  onToggleFocus: () => void
}

export function Header({
  sessionName,
  filename,
  activeIndex,
  numPages,
  onSessionNameChange,
  onOpenFile,
  doc,
  notes,
  exporting,
  onExport,
  view,
  libraryCount,
  onToggleLibrary,
  onToggleFocus,
}: HeaderProps) {
  function handleInput(e: ChangeEvent<HTMLInputElement>) {
    onSessionNameChange(e.target.value)
  }

  const showMiddle = view === 'lecture' || view === 'focus'
  const showExport = view === 'lecture'
  const showFocus = (view === 'lecture' || view === 'focus') && doc !== null
  const libraryLabel = view === 'library' ? 'Back' : 'Library'

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">
          Lecture<em>note</em>
        </span>
      </div>

      <div className="middle">
        {showMiddle && filename ? (
          <input
            className="session-input"
            type="text"
            placeholder="Untitled lecture"
            value={sessionName}
            onChange={handleInput}
          />
        ) : view === 'library' ? (
          <span className="brand-name" style={{ fontStyle: 'italic' }}>
            Library
          </span>
        ) : null}
        {showMiddle && numPages > 0 ? (
          <span className="counter-chip">
            {String(activeIndex + 1).padStart(2, '0')} /{' '}
            {String(numPages).padStart(2, '0')}
          </span>
        ) : null}
      </div>

      <div className="actions">
        {libraryCount > 0 || view === 'library' ? (
          <button
            type="button"
            onClick={onToggleLibrary}
            className={`ate-btn ${view === 'library' ? 'active' : ''}`}
            title="Library"
          >
            {libraryLabel}
            {view !== 'library' && libraryCount > 0 ? (
              <span className="kbd">{libraryCount}</span>
            ) : (
              <span className="kbd">⌘L</span>
            )}
          </button>
        ) : null}
        <button type="button" onClick={onOpenFile} className="ate-btn">
          {filename ? 'Open new' : 'Open PDF'}
        </button>
        {showFocus ? (
          <button
            type="button"
            onClick={onToggleFocus}
            className={`ate-btn ${view === 'focus' ? 'active' : ''}`}
            title="Focus mode (F)"
          >
            {view === 'focus' ? 'Exit focus' : 'Focus'}
            <span className="kbd">{view === 'focus' ? '⎋' : 'F'}</span>
          </button>
        ) : null}
        {showExport ? (
          <ExportButton
            disabled={!doc || exporting}
            exporting={exporting}
            onClick={onExport}
            hasAnyNotes={notes.size > 0}
          />
        ) : null}
      </div>
    </header>
  )
}
