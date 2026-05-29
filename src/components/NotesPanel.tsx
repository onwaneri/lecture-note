import { useEffect, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'

interface NotesPanelProps {
  slideIndex: number
  totalSlides: number
  value: string
  onChange: (markdown: string) => void
  disabled?: boolean
}

export function NotesPanel({
  slideIndex,
  totalSlides,
  value,
  onChange,
  disabled,
}: NotesPanelProps) {
  const onChangeRef = useRef(onChange)
  const lastEmittedRef = useRef<string>(value)
  const loadedSlideRef = useRef<number>(slideIndex)

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
    content: value,
    editable: !disabled,
    autofocus: !disabled ? 'end' : false,
    editorProps: {
      attributes: {
        class: 'notes-prose',
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
    if (loadedSlideRef.current !== slideIndex) {
      loadedSlideRef.current = slideIndex
      lastEmittedRef.current = value
      editor.commands.setContent(value || '', false)
      return
    }
    if (value !== lastEmittedRef.current) {
      lastEmittedRef.current = value
      editor.commands.setContent(value || '', false)
    }
  }, [slideIndex, value, editor])

  useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled)
  }, [editor, disabled])

  function focusEditor() {
    editor?.commands.focus()
  }

  return (
    <section className="notes-panel">
      <div className="notes-header">
        {editor && !disabled ? (
          <div className="notes-toolbar">
            <ToolbarButton
              label="B"
              title="Bold (⌘B)"
              active={editor.isActive('bold')}
              bold
              onClick={() => editor.chain().focus().toggleBold().run()}
            />
            <ToolbarButton
              label="I"
              title="Italic (⌘I)"
              active={editor.isActive('italic')}
              italic
              onClick={() => editor.chain().focus().toggleItalic().run()}
            />
            <ToolbarButton
              label="H1"
              title="Heading 1"
              active={editor.isActive('heading', { level: 1 })}
              onClick={() =>
                editor.chain().focus().toggleHeading({ level: 1 }).run()
              }
            />
            <ToolbarButton
              label="H2"
              title="Heading 2"
              active={editor.isActive('heading', { level: 2 })}
              onClick={() =>
                editor.chain().focus().toggleHeading({ level: 2 }).run()
              }
            />
            <ToolbarButton
              label="•"
              title="Bullet list"
              active={editor.isActive('bulletList')}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            />
            <ToolbarButton
              label="1."
              title="Numbered list"
              active={editor.isActive('orderedList')}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            />
            <ToolbarButton
              label="</>"
              title="Inline code"
              active={editor.isActive('code')}
              onClick={() => editor.chain().focus().toggleCode().run()}
            />
            <ToolbarButton
              label="❝"
              title="Quote"
              active={editor.isActive('blockquote')}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
            />
          </div>
        ) : null}
        <span className="meta">
          Slide {String(slideIndex + 1).padStart(2, '0')} /{' '}
          {String(totalSlides).padStart(2, '0')}
        </span>
      </div>
      <div className="editor-area" onClick={focusEditor}>
        <EditorContent editor={editor} />
      </div>
    </section>
  )
}

interface ToolbarButtonProps {
  label: string
  title: string
  active: boolean
  bold?: boolean
  italic?: boolean
  onClick: () => void
}

function ToolbarButton({
  label,
  title,
  active,
  bold,
  italic,
  onClick,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      className={`tb-btn ${active ? 'active' : ''}`}
      style={{
        fontWeight: bold ? 700 : undefined,
        fontStyle: italic ? 'italic' : undefined,
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
