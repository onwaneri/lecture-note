import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import { renderPageToCanvas, type PDFDocumentProxy } from '../lib/pdf'
import { AskClaude } from './AskClaude'
import type { ChatTurn } from '../lib/askClaude'

interface FocusViewProps {
  doc: PDFDocumentProxy
  numPages: number
  activeIndex: number
  sessionName: string
  markdown: string
  onActiveChange: (index: number) => void
  onChange: (markdown: string) => void
  onExit: () => void
  conversation?: ChatTurn[]
  onConversationChange?: (turns: ChatTurn[]) => void
}

const NO_CONVERSATION: ChatTurn[] = []

export function FocusView({
  doc,
  numPages,
  activeIndex,
  sessionName,
  markdown,
  onActiveChange,
  onChange,
  onExit,
  conversation = NO_CONVERSATION,
  onConversationChange = () => {},
}: FocusViewProps) {
  const railCanvasRef = useRef<HTMLDivElement | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)

  // Editor — mirrors NotesPanel so markdown round-trips cleanly between views.
  const onChangeRef = useRef(onChange)
  const lastEmittedRef = useRef<string>(markdown)
  const loadedSlideRef = useRef<number>(activeIndex)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: 'Type notes for this slide…',
      }),
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: true,
        transformPastedText: true,
      }),
    ],
    content: markdown,
    autofocus: 'end',
    editorProps: {
      attributes: {
        class: 'focus-prose',
        spellcheck: 'true',
      },
    },
    onUpdate({ editor }) {
      const md: string = editor.storage.markdown.getMarkdown()
      lastEmittedRef.current = md
      onChangeRef.current(md)
    },
  })

  useEffect(() => {
    if (!editor) return
    if (loadedSlideRef.current !== activeIndex) {
      loadedSlideRef.current = activeIndex
      lastEmittedRef.current = markdown
      editor.commands.setContent(markdown || '', false)
      editor.commands.focus('end')
      return
    }
    if (markdown !== lastEmittedRef.current) {
      lastEmittedRef.current = markdown
      editor.commands.setContent(markdown || '', false)
    }
  }, [activeIndex, markdown, editor])

  // Render a small thumbnail of the current slide into the floating rail.
  useEffect(() => {
    let cancelled = false
    const host = railCanvasRef.current
    if (!host) return
    ;(async () => {
      try {
        const page = await doc.getPage(activeIndex + 1)
        if (cancelled) return
        const baseViewport = page.getViewport({ scale: 1 })
        const targetWidth = 180
        const scale = Math.max(0.2, targetWidth / baseViewport.width)
        const { canvas } = await renderPageToCanvas(page, scale)
        if (cancelled) return
        canvas.style.width = '100%'
        canvas.style.height = '100%'
        canvas.style.display = 'block'
        host.innerHTML = ''
        host.appendChild(canvas)
      } catch (e) {
        console.error('focus thumb render failed', e)
        if (!cancelled) setRenderError('Could not render slide')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc, activeIndex])

  // Keyboard: Esc exits. Arrow keys navigate slides only when NOT inside the
  // editor — otherwise the user can't move the caret with the arrow keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement | null
        // Let TipTap handle Esc if it has its own bindings (it doesn't by
        // default), but always allow exiting focus.
        if (target?.tagName === 'INPUT' || target?.tagName === 'SELECT') return
        e.preventDefault()
        onExit()
        return
      }
      const target = e.target as HTMLElement | null
      const inEditableField =
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT'
      if (inEditableField) return // arrow keys move caret, not slides

      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'j') {
        if (activeIndex < numPages - 1) {
          e.preventDefault()
          onActiveChange(activeIndex + 1)
        }
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'k') {
        if (activeIndex > 0) {
          e.preventDefault()
          onActiveChange(activeIndex - 1)
        }
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeIndex, numPages, onActiveChange, onExit])

  function focusEditor() {
    editor?.commands.focus()
  }

  const slideLabel = `${String(activeIndex + 1).padStart(2, '0')} / ${String(numPages).padStart(2, '0')}`
  const eyebrow = sessionName
    ? `${sessionName.toUpperCase()} · SLIDE ${slideLabel}`
    : `SLIDE ${slideLabel}`

  return (
    <div className="focus-view">
      <div className="focus-rail" role="complementary" aria-label="Slide rail">
        <div className="focus-rail-thumb">
          <div ref={railCanvasRef} className="focus-rail-canvas-host" />
          {renderError ? (
            <div className="focus-rail-error">{renderError}</div>
          ) : null}
        </div>
        <div className="focus-rail-meta">
          <span>{slideLabel}</span>
          <button type="button" onClick={onExit} title="Exit focus (Esc)">
            Exit <span className="kbd">⎋</span>
          </button>
        </div>
        <div className="focus-rail-nav">
          <button
            type="button"
            onClick={() => onActiveChange(Math.max(0, activeIndex - 1))}
            disabled={activeIndex === 0}
            aria-label="Previous slide"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() =>
              onActiveChange(Math.min(numPages - 1, activeIndex + 1))
            }
            disabled={activeIndex >= numPages - 1}
            aria-label="Next slide"
          >
            →
          </button>
        </div>
      </div>

      <article className="focus-page" onClick={focusEditor}>
        <div className="focus-eyebrow">{eyebrow}</div>
        <h1 className="focus-title">
          {sessionName ? sessionName : 'Untitled lecture'}
        </h1>
        <div className="focus-body">
          <EditorContent editor={editor} />
        </div>
      </article>

      <AskClaude
        variant="floating"
        doc={doc}
        slideIndex={activeIndex}
        totalSlides={numPages}
        sessionName={sessionName}
        notes={markdown}
        conversation={conversation}
        onConversationChange={onConversationChange}
      />
    </div>
  )
}
