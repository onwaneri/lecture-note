import type { ReactNode } from 'react'

interface PrepHeaderProps {
  center?: ReactNode
  right?: ReactNode
}

/**
 * 56px brand header for the non-study prep phases (Home / Setup / Processing).
 * The lecture Header is hidden while in prep, so prep owns its own top chrome.
 */
export function PrepHeader({ center, right }: PrepHeaderProps) {
  return (
    <header className="prep-header">
      <div className="prep-brand">
        <span className="prep-brand-mark" aria-hidden="true" />
        <span className="prep-brand-name">
          Lecture<em>note</em>
        </span>
      </div>
      <div className="prep-header-center">{center}</div>
      <div className="prep-header-right">{right}</div>
    </header>
  )
}
