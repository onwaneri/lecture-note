# LectureNote

Local-first React app for per-slide markdown notes on lecture PDFs. No backend — all data lives in IndexedDB.

## Stack

- React 18 + TypeScript + Vite 5
- **PDF viewing:** `pdfjs-dist` 4.7.76 (worker at `pdfjs-dist/build/pdf.worker.min.mjs?url`)
- **PDF export:** `pdf-lib` ^1.17.1 — copies slide pages verbatim (preserves text layer), adds real-text notes pages
- **Rich text editor:** TipTap (StarterKit + Placeholder + `tiptap-markdown`)
- **Persistence:** IndexedDB via `idb`; DB version 3, stores: `notes`, `sessions`, `pdfs`, `thumbnails`, `meta`
- **Styling:** Single CSS file (`src/styles/globals.css`) + design tokens in `src/styles/theme.css`

## Key files

```
src/
  App.tsx                     # Root — view state (lecture | library | focus), PDF open/close
  components/
    SlideViewer.tsx           # PDF stage + SlideThumbStrip; JS-computed frame sizing via ResizeObserver
    SlideThumbStrip.tsx       # Lazy thumbnail carousel (IntersectionObserver, in-memory cache)
    FocusView.tsx             # Full-screen focus mode — TipTap editor + slide thumbnail rail
    NotesPanel.tsx            # Right-panel markdown editor (TipTap)
    Header.tsx                # 3-col grid; session name, nav controls, export button
    LibraryView.tsx           # Card grid with real page-1 thumbnails from IDB
  hooks/
    usePDF.ts                 # Loads PDF, retains bytes (pdf-lib needs them); LoadedPDF = { doc, bytes, ... }
    useNotes.ts               # Per-slide notes CRUD backed by IDB
    useExport.ts              # Wraps exportInterleavedPDF; exporting progress state
  lib/
    db.ts                     # IDB schema (v3), CRUD helpers
    pdf.ts                    # pdf.js helpers: loadPDFFromBytes, renderPageToCanvas
    exportPDFv2.ts            # Main export pipeline (sourceBytes → interleaved PDF)
    exportMarkdownLayout.ts   # Mini markdown block walker for pdf-lib text layout
    exportOutline.ts          # PDF bookmarks (pdf-lib low-level dict API)
    exportPDF.ts              # Thin re-export from exportPDFv2 (stable import path)
    library.ts                # exportLectureByFilename, ensureThumbnail
    filenameUtils.ts          # prettifyFilename helper
  styles/
    theme.css                 # Atelier design tokens (--ate-bg, --ate-ink, --ate-accent, etc.)
    globals.css               # All component CSS
```

## Design system (Atelier)

Warm white editorial palette:
- `--ate-bg: #f6f4ee` (warm white)
- `--ate-surface: #fff`
- `--ate-ink: #14130f` (near-black)
- `--ate-accent: #2747b3` (indigo)
- `--ate-mark: #f7e58a` (highlight yellow)
- Fonts: Newsreader (serif display), Instrument Sans (UI), JetBrains Mono (code)

## Dev commands

```bash
npm run dev        # Vite dev server (runs on 5174 if 5173 is taken)
npm run build      # tsc + vite build
npx tsc -b         # type-check only
```

## Architecture notes

- **No server.** Vercel just serves static files; all user data (PDFs, notes) lives in the visitor's own browser IDB.
- **pdf.js detaches its input buffer** on transfer to worker — always pass a defensive copy: `loadPDFFromBytes(new Uint8Array(bytes))`.
- **Frame sizing** is computed in JS (not CSS) to maintain slide aspect ratio within the available stage area. `STAGE_PADDING = 28px`.
- **Export bytes** — `LoadedPDF.bytes` retains the original Uint8Array so pdf-lib can copy pages verbatim without re-fetching from IDB.
- **SlideThumbStrip** uses `IntersectionObserver` with `rootMargin: '0px 240px 0px 240px'` for pre-loading tiles just off-screen. Thumbnails are kept in component state (not IDB) — they're cheap to regenerate.
- **FocusView** hides the thumb strip; slide navigation is via arrow keys only when focus is outside the TipTap editor.

## IDB schema (db.ts, DB_VERSION = 3)

| Store | Key | Value |
|---|---|---|
| `notes` | `filename_slideIndex` | `{ filename, slideIndex, markdown, updatedAt }` |
| `sessions` | `filename` | `{ filename, sessionName, activeSlideIndex, updatedAt }` |
| `pdfs` | `filename` | `{ filename, blob, size, storedAt }` |
| `thumbnails` | `filename` | `{ filename, dataURL, generatedAt }` |
| `meta` | `'lastFilename'` | string |
