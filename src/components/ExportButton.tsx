interface ExportButtonProps {
  disabled: boolean
  exporting: boolean
  hasAnyNotes: boolean
  onClick: () => void
}

export function ExportButton({
  disabled,
  exporting,
  hasAnyNotes,
  onClick,
}: ExportButtonProps) {
  return (
    <button
      type="button"
      className="export-btn"
      disabled={disabled}
      onClick={onClick}
      title={hasAnyNotes ? 'Export PDF' : 'Export PDF (no notes yet)'}
    >
      {exporting ? 'Exporting…' : 'Export'}
      {!exporting ? <span className="kbd">⌘E</span> : null}
    </button>
  )
}
