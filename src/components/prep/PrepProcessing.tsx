import { useEffect, useRef, useState } from 'react'
import {
  createPrepSession,
  getPDF,
  savePDF,
  type PrepSessionRecord,
} from '../../lib/db'
import { loadPDFFromBytes } from '../../lib/pdf'
import { initializeCurriculum, type PrepDocInput, type InitResult } from '../../lib/testPrep'
import type { PrepSetupResult } from './PrepSetup'
import { PrepHeader } from './PrepHeader'

interface PrepProcessingProps {
  setup: PrepSetupResult
  onCancel: () => void
  onDone: (session: PrepSessionRecord) => void
}

type Status =
  | { kind: 'running'; label: string; detail: string }
  | { kind: 'error'; message: string }

export function PrepProcessing({ setup, onCancel, onDone }: PrepProcessingProps) {
  const [status, setStatus] = useState<Status>({
    kind: 'running',
    label: 'Starting…',
    detail: '',
  })
  const [elapsed, setElapsed] = useState(0)
  // How many source files have finished their pass — drives the file-status list.
  const [done, setDone] = useState(0)
  const startedRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const teardownRef = useRef<number | null>(null)

  // Defer aborting the in-flight run. StrictMode unmounts then immediately
  // remounts in dev; the remount clears this timer so the run survives. A real
  // unmount lets the timer fire and aborts the API calls.
  function scheduleTeardown() {
    teardownRef.current = window.setTimeout(() => {
      abortRef.current?.abort()
    }, 0)
  }

  // A 1s ticker so the screen always shows time advancing — proof the run is
  // alive even when a single request is mid-flight with nothing to stream yet.
  useEffect(() => {
    if (status.kind !== 'running') return
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [status.kind])

  useEffect(() => {
    // Cancel a pending teardown from a StrictMode unmount — if we're remounting
    // immediately, the previous run is still good and must not be aborted.
    if (teardownRef.current !== null) {
      window.clearTimeout(teardownRef.current)
      teardownRef.current = null
    }

    if (startedRef.current) {
      // Second StrictMode pass (or a re-render): the run is already going.
      return () => scheduleTeardown()
    }
    startedRef.current = true
    const abort = new AbortController()
    abortRef.current = abort

    ;(async () => {
      try {
        // 1. Persist any freshly uploaded files so they're retrievable later
        //    (no library session entry — they stay out of the library grid).
        for (const p of setup.picks) {
          if (p.source === 'upload' && p.file) {
            await savePDF(p.storageFilename, p.file)
          }
        }

        // 2. Read raw bytes + page count for every document. The PDFs are sent
        //    to Doug as native document blocks (server-side parse) — no slow
        //    client-side per-page text extraction.
        const docs: PrepDocInput[] = []
        for (let i = 0; i < setup.picks.length; i++) {
          const p = setup.picks[i]
          setStatus({
            kind: 'running',
            label: 'Preparing files',
            detail: `Loading ${i + 1}/${setup.picks.length}: ${p.displayName}`,
          })
          setDone(i)
          let bytes: Uint8Array
          if (p.file) {
            bytes = new Uint8Array(await p.file.arrayBuffer())
          } else {
            const blob = await getPDF(p.storageFilename)
            if (!blob) throw new Error(`Missing PDF for ${p.displayName}`)
            bytes = new Uint8Array(await blob.arrayBuffer())
          }
          // Load a defensive copy just to read the page count — pdf.js detaches
          // the buffer it's handed, so keep `bytes` intact for the API call.
          const doc = await loadPDFFromBytes(new Uint8Array(bytes))
          const numPages = doc.numPages
          doc.destroy()
          docs.push({
            filename: p.storageFilename,
            displayName: p.displayName,
            role: p.role,
            numPages,
            bytes,
          })
        }

        // 3. Tier 1 — build the curriculum blueprint.
        let initResult: InitResult
        initResult = await initializeCurriculum({
          docs,
          difficulty: setup.difficulty,
          userContext: setup.userContext || undefined,
          signal: abort.signal,
          onStage: (stage) => {
            if (stage.phase === 'analyzing-exam') {
              setStatus({
                kind: 'running',
                label: 'Analysing practice exam',
                detail: 'Learning the format — not the answers.',
              })
            } else if (stage.phase === 'reading-topic-sheet') {
              setStatus({
                kind: 'running',
                label: 'Reading topic sheet',
                detail: "Aligning curriculum to the professor's outline…",
              })
            } else if (stage.phase === 'summarizing') {
              setDone(stage.current)
              setStatus({
                kind: 'running',
                label: 'Summarising materials',
                detail: `Reading files in parallel — ${stage.current}/${stage.total} done`,
              })
            } else if (stage.phase === 'building-curriculum') {
              setDone(setup.picks.length)
              setStatus({
                kind: 'running',
                label: 'Mapping the curriculum',
                detail:
                  stage.topicsFound > 0
                    ? `Found ${stage.topicsFound} topic${stage.topicsFound === 1 ? '' : 's'} so far…`
                    : 'Distilling summaries into masterable topics…',
              })
            }
          },
        })

        const { blueprint, suggestedTitle } = initResult

        if (abort.signal.aborted) return
        if (blueprint.topics.length === 0) {
          throw new Error(
            'Could not derive any topics from these materials. Try different files.',
          )
        }

        // 4. Persist the session.
        const now = Date.now()
        const session: PrepSessionRecord = {
          sessionId: crypto.randomUUID(),
          title: setup.title || suggestedTitle,
          createdAt: now,
          updatedAt: now,
          difficulty: setup.difficulty,
          status: 'active',
          blueprint,
          documents: setup.picks.map((p) => ({
            filename: p.storageFilename,
            role: p.role,
            displayName: p.displayName,
          })),
        }
        await createPrepSession(session)
        onDone(session)
      } catch (e) {
        if (abort.signal.aborted) return
        console.error('prep init failed', e)
        setStatus({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
      }
    })()

    return () => scheduleTeardown()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="prep-screen">
      <PrepHeader
        center={<div className="prep-eyebrow">Building curriculum</div>}
        right={
          status.kind === 'running' ? (
            <button type="button" className="ate-btn" onClick={onCancel}>
              Cancel
            </button>
          ) : null
        }
      />
      <div className="prep-proc-stage">
        {status.kind === 'running' ? (
          <div className="prep-proc-card">
            <div className="prep-proc-mark" aria-hidden="true" />
            <h2 className="prep-proc-heading">{status.label}</h2>
            {status.detail ? (
              <p className="prep-proc-detail">{status.detail}</p>
            ) : null}
            <span className="prep-chip acc">{elapsed}s · Working</span>
            <div className="prep-proc-files">
              {setup.picks.map((p, i) => {
                const state =
                  i < done ? 'done' : i === done ? 'active' : 'queued'
                const icon = state === 'done' ? '✓' : state === 'active' ? '…' : '·'
                const label =
                  state === 'done'
                    ? 'Done'
                    : state === 'active'
                      ? 'Reading…'
                      : 'Queued'
                return (
                  <div key={p.id} className={`prep-proc-file ${state}`}>
                    <span className="prep-proc-icon">{icon}</span>
                    <span className="prep-proc-fname">{p.displayName}</span>
                    <span className="prep-proc-status">{label}</span>
                  </div>
                )
              })}
            </div>
            <p className="prep-proc-note">
              This one-time pass sends each file to Doug as a native document
              block. Open the browser console to follow the [prep] logs. Each
              call times out after 120s.
            </p>
          </div>
        ) : (
          <div className="prep-proc-card">
            <div className="prep-proc-mark" aria-hidden="true" />
            <h2 className="prep-proc-heading">Couldn’t build curriculum</h2>
            <p className="prep-proc-detail" style={{ color: 'var(--ate-red)' }}>
              {status.message}
            </p>
            <button type="button" className="ate-btn" onClick={onCancel}>
              ← Back to setup
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
