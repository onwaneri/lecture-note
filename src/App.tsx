import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Header } from './components/Header'
import { SlideViewer } from './components/SlideViewer'
import { NotesPanel } from './components/NotesPanel'
import { LibraryView } from './components/LibraryView'
import { FocusView } from './components/FocusView'
import { usePDF } from './hooks/usePDF'
import { useNotes } from './hooks/useNotes'
import { useChats } from './hooks/useChats'
import { useExport } from './hooks/useExport'
import {
  getLastFilename,
  getSession,
  hasPDF,
  listLibrary,
  renameSession,
  setActiveSlide,
} from './lib/db'

type View = 'lecture' | 'library' | 'focus'

export function App() {
  const {
    pdf,
    loading,
    error,
    quotaWarning,
    openFile,
    openFromLibrary,
    close,
    dismissQuotaWarning,
  } = usePDF()
  const [activeIndex, setActiveIndex] = useState(0)
  const [sessionName, setSessionName] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [view, setView] = useState<View>('lecture')
  const [libraryCount, setLibraryCount] = useState(0)
  const [bootChecked, setBootChecked] = useState(false)
  const [notesWidth, setNotesWidth] = useState<number | null>(null)

  const mainRef = useRef<HTMLDivElement | null>(null)

  const filename = pdf?.filename ?? null
  const numPages = pdf?.numPages ?? 0

  const { notes, getNote, updateNote } = useNotes(filename)
  const { getChat, updateChat } = useChats(filename)
  const { run: runExport, exporting } = useExport({
    doc: pdf?.doc ?? null,
    numPages,
    filename,
    sessionName,
    notes,
    sourceBytes: pdf?.bytes ?? null,
  })

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const refreshLibraryCount = useCallback(async () => {
    const list = await listLibrary()
    setLibraryCount(list.length)
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const last = await getLastFilename()
        if (last && (await hasPDF(last))) {
          const ok = await openFromLibrary(last)
          if (ok) {
            const sess = await getSession(last)
            if (sess?.activeSlideIndex !== undefined) {
              setActiveIndex(sess.activeSlideIndex)
            }
          }
        }
      } catch (e) {
        console.warn('resume failed', e)
      } finally {
        setBootChecked(true)
        await refreshLibraryCount()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!filename) return
    getSession(filename).then((s) => {
      setSessionName(s?.sessionName ?? '')
    })
  }, [filename])

  useEffect(() => {
    if (!filename) return
    const t = window.setTimeout(() => {
      renameSession(filename, sessionName).catch((e) =>
        console.error('session persist failed', e),
      )
    }, 300)
    return () => window.clearTimeout(t)
  }, [filename, sessionName])

  useEffect(() => {
    if (!filename) return
    const t = window.setTimeout(() => {
      setActiveSlide(filename, activeIndex).catch((e) =>
        console.error('activeSlide persist failed', e),
      )
    }, 250)
    return () => window.clearTimeout(t)
  }, [filename, activeIndex])

  // Drag the divider between the slide viewer and the notes panel. Width is
  // measured from the right edge of the main area so the notes panel grows as
  // you drag left.
  function startNotesResize(e: ReactPointerEvent) {
    e.preventDefault()
    const main = mainRef.current
    if (!main) return
    const rect = main.getBoundingClientRect()
    function onMove(ev: PointerEvent) {
      const w = Math.max(300, Math.min(rect.right - ev.clientX, rect.width - 360))
      setNotesWidth(w)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handleOpenFile = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileSelected = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return
      if (!/\.pdf$/i.test(file.name)) {
        alert('Please select a PDF file.')
        return
      }
      const ok = await openFile(file)
      if (ok) {
        setActiveIndex(0)
        setView('lecture')
        await refreshLibraryCount()
      }
    },
    [openFile, refreshLibraryCount],
  )

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    void handleFileSelected(file)
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(true)
  }

  function onDragLeave() {
    setDragOver(false)
  }

  async function handleOpenFromLibrary(libFilename: string) {
    if (pdf?.filename === libFilename) {
      setView('lecture')
      return
    }
    const ok = await openFromLibrary(libFilename)
    if (ok) {
      const sess = await getSession(libFilename)
      setActiveIndex(sess?.activeSlideIndex ?? 0)
      setView('lecture')
      await refreshLibraryCount()
    }
  }

  async function handleLibraryDeleted(deletedFilename: string) {
    if (pdf?.filename === deletedFilename) {
      close()
      setActiveIndex(0)
      setSessionName('')
    }
    await refreshLibraryCount()
  }

  function toggleLibrary() {
    setView((v) => (v === 'library' ? 'lecture' : 'library'))
  }

  function toggleFocus() {
    setView((v) => (v === 'focus' ? 'lecture' : 'focus'))
  }

  // Global 'F' shortcut: enter focus from lecture view when a PDF is open.
  // Esc-to-exit lives inside FocusView itself.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'f' && e.key !== 'F') return
      // Don't grab F while typing.
      const target = e.target as HTMLElement | null
      if (target) {
        if (
          target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT'
        ) {
          return
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (view !== 'lecture') return
      if (!pdf) return
      e.preventDefault()
      setView('focus')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, pdf])

  return (
    <div className="app" onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}>
      <Header
        sessionName={sessionName}
        filename={filename}
        activeIndex={activeIndex}
        numPages={numPages}
        onSessionNameChange={setSessionName}
        onOpenFile={handleOpenFile}
        doc={pdf?.doc ?? null}
        notes={notes}
        exporting={exporting}
        onExport={runExport}
        view={view}
        libraryCount={libraryCount}
        onToggleLibrary={toggleLibrary}
        onToggleFocus={toggleFocus}
      />

      {quotaWarning ? (
        <div className="quota-banner">
          Browser storage is full — this PDF wasn't saved to the library. Notes still save per-slide.
          <button onClick={dismissQuotaWarning}>Dismiss</button>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="file-hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          void handleFileSelected(f)
          e.target.value = ''
        }}
      />

      <div
        className="main"
        ref={mainRef}
        style={
          notesWidth != null
            ? ({ '--notes-w': `${notesWidth}px` } as CSSProperties)
            : undefined
        }
      >
        {view === 'library' ? (
          <div className="library-host">
            <LibraryView
              onOpen={handleOpenFromLibrary}
              onDeleted={handleLibraryDeleted}
              currentlyOpenFilename={filename}
            />
          </div>
        ) : view === 'focus' && pdf ? (
          <FocusView
            doc={pdf.doc}
            numPages={numPages}
            activeIndex={activeIndex}
            sessionName={sessionName}
            markdown={getNote(activeIndex)}
            onActiveChange={setActiveIndex}
            onChange={(md) => updateNote(activeIndex, md)}
            onExit={() => setView('lecture')}
            conversation={getChat(activeIndex)}
            onConversationChange={(turns) => updateChat(activeIndex, turns)}
          />
        ) : !pdf ? (
          <div className={`dropzone ${dragOver ? 'drag-over' : ''}`}>
            <div className="dropzone-inner">
              <div>
                <div className="dropzone-eyebrow">Local · No account</div>
                <h1>
                  Notes that <em>live</em> next to your slides.
                </h1>
                <p>
                  Drop a lecture PDF and start typing. Every note saves to this
                  browser, per slide. Reopen any time from the library.
                </p>
                <div className="dropzone-ctas">
                  <button
                    type="button"
                    className="ate-btn ate-btn-primary"
                    onClick={handleOpenFile}
                    disabled={loading || !bootChecked}
                  >
                    {loading || !bootChecked ? 'Loading…' : 'Select PDF'}
                  </button>
                  {libraryCount > 0 ? (
                    <button
                      type="button"
                      className="ate-btn"
                      onClick={() => setView('library')}
                    >
                      Open from library
                      <span className="kbd">{libraryCount}</span>
                    </button>
                  ) : null}
                </div>
                {error ? (
                  <p className="dropzone-error">Failed to open: {error}</p>
                ) : null}
              </div>
              <div
                className="dropzone-pick"
                onClick={handleOpenFile}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleOpenFile()
                  }
                }}
              >
                <div className="dropzone-pick-inner">
                  <div className="dropzone-icon" aria-hidden="true">
                    <svg
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 4v12" />
                      <path d="m7 11 5 5 5-5" />
                      <path d="M5 20h14" />
                    </svg>
                  </div>
                  <div className="dropzone-pick-title">Drop a PDF</div>
                  <p className="dropzone-pick-body">
                    or click anywhere in this card to pick a file.
                  </p>
                </div>
              </div>
            </div>
            <div className="dropzone-footer">
              <span>Lecturenote · v2</span>
              <span>Local only · No account</span>
            </div>
          </div>
        ) : (
          <>
            <SlideViewer
              doc={pdf.doc}
              numPages={numPages}
              activeIndex={activeIndex}
              onActiveChange={setActiveIndex}
            />
            <div
              className="pane-divider"
              onPointerDown={startNotesResize}
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize"
            />
            <NotesPanel
              slideIndex={activeIndex}
              totalSlides={numPages}
              value={getNote(activeIndex)}
              onChange={(md) => updateNote(activeIndex, md)}
              doc={pdf.doc}
              sessionName={sessionName}
              conversation={getChat(activeIndex)}
              onConversationChange={(turns) => updateChat(activeIndex, turns)}
            />
          </>
        )}
      </div>
    </div>
  )
}
