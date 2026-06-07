# LectureNote

Offline-first React app for per-slide markdown notes on lecture PDFs, plus an AI-powered test prep mode. Backed by **Firebase** (Auth + Firestore + Cloud Storage) with a local IndexedDB cache for instant/offline access. The in-app AI assistant is branded **"Doug."**

> ## ⚠️ Keep this spec current
> **This file is the source of truth for the app's architecture.** Update `CLAUDE.md` in the *same change* whenever you:
> - add or remove a feature, screen, or major component;
> - change the data model, persistence layer, or a key type;
> - change a documented behavior, flow, or constraint.
>
> A change that alters how the app works but leaves this file stale is incomplete. When in doubt, update it.

## Stack

- React 18 + TypeScript + Vite 5
- **PDF viewing:** `pdfjs-dist` 4.7.76 (worker at `pdfjs-dist/build/pdf.worker.min.mjs?url`)
- **PDF export:** `pdf-lib` ^1.17.1 — copies slide pages verbatim (preserves text layer), adds real-text notes pages
- **Rich text editor:** TipTap (StarterKit + Placeholder + `tiptap-markdown`)
- **AI:** provider abstraction in `lib/aiClient.ts` — Anthropic (`@anthropic-ai/sdk`, browser-safe `/client` import) or Gemini, selected by `VITE_AI_PROVIDER` (`anthropic` | `gemini`, default `gemini`). Keys via `VITE_ANTHROPIC_API_KEY` / `VITE_GEMINI_API_KEY` in `.env.local`. The assistant is surfaced to users as **"Doug"** (internal symbols still say `askClaude`/`AskClaude`).
- **Auth:** Firebase Authentication — Google + Email/Password. `AuthGate` wraps the app so every data call runs under a known `uid`.
- **Persistence:** Firebase. **Firestore** for records (notes, chats, sessions, prep) under `users/{uid}/…` with `persistentLocalCache` (offline + sync); **Cloud Storage** for PDF bytes (`users/{uid}/pdfs/{filename}`); a local **IndexedDB cache** (`lib/pdfCache.ts`, db `lecturenote-cache`) holds PDF bytes + thumbnails for instant/offline access. `lib/db.ts` exposes the same public API as the old IndexedDB layer — call sites are unchanged.
- **Styling:** Single CSS file (`src/styles/globals.css`) + design tokens in `src/styles/theme.css`
- **Config (gitignored / infra):** `.env.local` (`VITE_FIREBASE_*` web config), `firestore.rules` + `storage.rules` (per-user `request.auth.uid == userId`), `firebase.json`, `.firebaserc`, `cors.json` (Storage CORS for cross-device PDF downloads, applied via `gsutil cors set`).

## Key files

```
src/
  main.tsx                        # Mounts <AuthGate><App/></AuthGate>
  App.tsx                         # Root — view state (lecture | library | focus | prep); hides Header in prep; remembers prepReturnView
  components/
    AuthGate.tsx                  # Firebase sign-in gate (Google + email/password); exports signOutUser
    SlideViewer.tsx               # PDF stage + SlideThumbStrip; JS-computed frame sizing via ResizeObserver
    SlideThumbStrip.tsx           # Lazy thumbnail carousel (IntersectionObserver, in-memory cache)
    FocusView.tsx                 # Full-screen focus mode — TipTap editor + slide thumbnail rail
    NotesPanel.tsx                # Right-panel markdown editor (TipTap)
    AskClaude.tsx                 # Lecture-mode "Ask Doug" Q&A panel (inline/floating)
    Header.tsx                    # 3-col grid; session name, nav controls, export + test-prep + sign-out (hidden in prep)
    LibraryView.tsx               # Card grid with real page-1 thumbnails
    prep/
      TestPrepMode.tsx            # Phase orchestrator: home | setup | processing | study; home is the prep hub
      PrepSetup.tsx               # Material picker + roles + difficulty selector
      PrepProcessing.tsx          # PDF ingestion + Tier 1 curriculum init, progress UI
      PrepStudy.tsx               # Split-pane study view; session-level interleaving + retry queue; back → "← All preps"
      CurriculumMap.tsx           # Topic list w/ progress bars + KC chips
      TopicSession.tsx            # Learn/practice tabs; open-ended + MC question UI
      PrepChatPopup.tsx           # Floating "Ask Doug" chat — viewport-sized, draggable header, edge/corner resize
      ReferencePane.tsx           # Multi-doc slide viewer + auto-surface + bidirectional per-slide notes/chat peek
  hooks/
    usePDF.ts                     # Loads PDF, retains bytes (pdf-lib needs them); LoadedPDF = { doc, bytes, ... }
    useNotes.ts                   # Per-slide notes CRUD (via db.ts → Firestore)
    useChats.ts                   # Per-slide Ask-Doug chat persistence (via db.ts → Firestore)
    useExport.ts                  # Wraps exportInterleavedPDF; exporting progress state
    usePrepDocs.ts                # Lazy multi-PDF loader for the reference pane (caches PDFDocumentProxy instances)
  lib/
    firebase.ts                   # Firebase app/auth/Firestore(persistentLocalCache, ignoreUndefinedProperties)/Storage singletons; requireUid()
    db.ts                         # Firestore + Storage CRUD + all types/mastery configs (stable public API)
    pdfCache.ts                   # Local IndexedDB cache for PDF bytes + thumbnails (offline/instant)
    pdf.ts                        # pdf.js helpers: loadPDFFromBytes, renderPageToCanvas
    aiClient.ts                   # AI provider abstraction (getAIClient → complete()); picks provider by VITE_AI_PROVIDER
    aiProviderAnthropic.ts        # Anthropic provider (claude-* models)
    aiProviderGemini.ts           # Gemini provider
    askClaude.ts                  # Lecture-mode Q&A call ("Ask Doug")
    testPrep.ts                   # Tier 1/2/3 AI orchestration: curriculum init, overview, questions, grading
    questionSelector.ts           # Adaptive question selection: interleaving, retry, review, KC targeting
    exportPDFv2.ts                # Main export pipeline (sourceBytes → interleaved PDF)
    exportMarkdownLayout.ts       # Mini markdown block walker for pdf-lib text layout
    exportOutline.ts              # PDF bookmarks (pdf-lib low-level dict API)
    exportPDF.ts                  # Thin re-export from exportPDFv2 (stable import path)
    library.ts                    # exportLectureByFilename, ensureThumbnail
    filenameUtils.ts              # prettifyFilename helper
  styles/
    theme.css                     # Atelier design tokens (--ate-bg, --ate-ink, --ate-accent, etc.)
    globals.css                   # All component CSS
firestore.rules, storage.rules, firebase.json, .firebaserc, cors.json   # Firebase infra config
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

- **Firebase, offline-first.** Vercel serves static files; user data lives in Firebase, namespaced per user. Firestore's `persistentLocalCache` serves reads/writes offline and syncs; PDFs sync via Cloud Storage with a local IndexedDB byte cache so an already-opened deck renders instantly and works offline.
- **Auth gates everything.** `AuthGate` (in `main.tsx`) renders the app only once a user is signed in, so every `db.ts` call has a `uid` (`requireUid()` throws otherwise). Google + email/password are separate Firebase users with separate data.
- **`db.ts` keeps a stable API.** All persistence funnels through its exported functions; internals are Firestore + Storage + `pdfCache`. Doc IDs are `encodeURIComponent`-sanitized (`::` keys → safe ids). `setNote` deletes empty notes (so `countNotesForFile` can use a server-side `getCountFromServer`, with a cached `getDocs` fallback offline). Bulk deletes are chunked under Firestore's 500-op batch limit. Firestore is configured with `ignoreUndefinedProperties` so optional record fields serialize cleanly.
- **PDF hybrid:** `savePDF` writes the local cache + uploads to Storage + writes a `pdfMeta` doc; `getPDF` returns the cached blob or downloads from Storage (then caches). Cross-device download needs the bucket CORS from `cors.json`.
- **pdf.js detaches its input buffer** on transfer to worker — always pass a defensive copy: `loadPDFFromBytes(new Uint8Array(bytes))`.
- **Frame sizing** is computed in JS (not CSS) to maintain slide aspect ratio within the available stage area. `STAGE_PADDING = 28px`.
- **Export bytes** — `LoadedPDF.bytes` retains the original Uint8Array so pdf-lib can copy pages verbatim without re-fetching.
- **SlideThumbStrip** uses `IntersectionObserver` with `rootMargin: '0px 240px 0px 240px'` for pre-loading tiles just off-screen. Thumbnails are kept in component state — cheap to regenerate.
- **FocusView** hides the thumb strip; slide navigation is via arrow keys only when focus is outside the TipTap editor.
- **Prep navigation.** Prep is a self-contained area: the lecture Header is hidden while `view === 'prep'`, so there's no second "Exit prep" that bypasses the hierarchy. Entry records `prepReturnView` (library vs lecture) so "Back to notes" returns to the origin. Inside study, back goes topic → "← Curriculum" → "← All preps" (the prep home), never out to a slide.

## Firestore + Storage data model (per user, `users/{uid}/…`)

`db.ts` returns `::`-joined keys (e.g. `noteKey = filename::slideIndex`); doc IDs sanitize them via `encodeURIComponent`. Queries use single-field `where` filters (no composite indexes needed).

| Collection / path | Doc id | Value |
|---|---|---|
| `notes` | `filename::slideIndex` | `{ key, filename, slideIndex, markdown, updatedAt }` (empties deleted) |
| `chats` | `filename::slideIndex` | `{ key, filename, slideIndex, turns[], updatedAt }` |
| `sessions` | `filename` | `{ filename, sessionName, lastOpenedAt, activeSlideIndex?, numPages? }` |
| `pdfMeta` | `filename` | `{ filename, byteSize, addedAt, storagePath }` (bytes live in Storage) |
| `meta` | `lastFilename` | `{ key, value }` |
| `prepSessions` | `sessionId` | `PrepSessionRecord` (difficulty, status, blueprint, documents) |
| `prepProgress` | `sessionId::topicId` | `PrepTopicProgressRecord` (status, turns, kcMastery, overview) |
| **Cloud Storage** | `users/{uid}/pdfs/{filename}` | raw PDF blob |
| **Local cache only** (`pdfCache`, not synced) | `filename` | PDF blob + thumbnail dataURL |

---

## Test Prep Mode

An isolated, AI-driven study mode. Students gather lecture PDFs → a curriculum is generated → they drill graded questions per topic until mastery.

### Workflow

1. **Gather materials** — lectures, homework, practice exams, topic sheets (max 15 files).
2. **Map the scope** — AI generates a `CurriculumBlueprint` (5–20 topics, target ~10) with knowledge components per topic.
3. **Suggested progression** — topics ordered foundations-first; student picks freely (no hard locks).
4. **Format matching** — questions mimic the practice exam's format (structure only — never its actual questions).
5. **Adaptive drilling** — difficulty, interleaving, retry queues, and KC coverage all adapt per difficulty mode.
6. **Real-time correction** — graded feedback explains *why*, surfaces relevant source slides.

### Three-tier context strategy

- **Tier 1 — Initialization** (`initializeCurriculum` in `testPrep.ts`): each PDF sent as a native document block (base64) to the AI provider (via `aiClient`) — no client-side text extraction.
  - **1 file** → single direct curriculum call.
  - **N files** → per-file concept summaries in parallel (map) then one text-only synthesis (reduce). Wall-clock ≈ slowest single file.
  - **Slide-index fidelity**: per-file calls attribute concepts to real 0-based slide indices; validated against actual page counts, hallucinated refs dropped.
  - **Practice exam** analysed in isolated call → `ExamBlueprint` (metadata only — raw content never enters question context).
  - **KC generation**: each topic gets 3–6 knowledge components (specific testable sub-concepts). Fallback: single KC with the topic title if the LLM omits them.
- **Tier 2 — Interactive loop** (`generateQuestion`, `gradeAnswer`): runs off stored blueprint + short history. No raw files in context.
- **Tier 3 — Auto-sourcing**: `gradeAnswer` returns a `suggestedSlide` from the topic's `keySlides`. The reference pane surfaces that page (O(1) lookup from the slide map baked at Tier 1).

### Models

Calls go through `aiClient` with a model **tier** (`'fast'` | `'smart'`); each provider maps the tier to a concrete model (Anthropic mapping shown):

- **Tier 1 map** (per-file summaries / exam analysis): `'fast'` → `claude-haiku-4-5`, thinking off — fast, parallel extraction.
- **Tier 1 topic picker** (single-file / synthesis): `'smart'` → `claude-sonnet-4-6` with adaptive thinking — reasoning quality matters for topic selection/sequencing.
- **Tier 2** (overview / question generation / grading): `'smart'` with adaptive thinking.

All calls stream via the provider's streaming API (`aiClient.complete({ onText })`). Responses are strict JSON, parsed tolerantly (fence/brace stripping). Scores snap to nearest legal quarter. Hallucinated slide references dropped.

### Difficulty modes

| | **Foundational** | **Thorough** | **Exam-ready** |
|---|---|---|---|
| Point threshold / topic | 3 | 5 | 7 |
| KC coverage | each KC tested 1× | each KC tested 2× | each KC tested 2×, avg score ≥ 0.75 |
| Min question depth | none | 1 question at difficulty ≥ 3 | 1 question at difficulty ≥ 4 |
| Interleaving | off (single-topic focus) | after wrong answers only | full automatic rotation |
| Retry queue | off | on (3-question delay) | on (3-question delay) |
| Review injection | off | off | every 5 questions from mastered topics |

Legacy sessions stored as `light|medium|hard` are mapped on read: `light→foundational`, `medium→thorough`, `hard→exam-ready`.

### Knowledge components (KCs)

Each `CurriculumTopic` has a `knowledgeComponents: KnowledgeComponent[]` array (3–6 items). Each KC is a specific testable sub-concept (e.g. "Ohm's Law", "Series vs Parallel Circuits").

KC mastery is tracked per-topic in `PrepTopicProgressRecord.kcMastery`: `Record<string, { attempts, totalScore }>`.

Legacy topics without KCs get a single fallback: `[{ id: 'kc0', label: topic.title }]` via `ensureKCs()`.

### Adaptive question selection (`questionSelector.ts`)

`selectNextQuestion(state: StudyState) → NextQuestion` drives interleaving, retry, and review per the difficulty mode's config:

1. **Retry queue** — if any item has `questionsUntilRetry ≤ 0`, pop it and re-test that topic/KC.
2. **Review injection** — every N turns (exam-ready: 5), pick a mastered topic weighted by least-recently-tested.
3. **Normal selection** — weighted-random from unmastered topics, excluding last 2 asked. Weight = `1 - (accumulated / threshold)`.
4. **KC targeting** — within chosen topic, pick KC with fewest attempts (ties: lowest score).
5. **Adaptive difficulty** — from last 3 scores: avg > 0.85 → +1, avg < 0.5 → −1, clamped 1–5.

**Difficulty scale** (passed to LLM): 1 = Recall/definition, 2 = Simple application, 3 = Conceptual reasoning, 4 = Multi-step problem, 5 = Transfer/synthesis.

**Post-answer hook** (`onAnswerGraded`): updates retry queue, KC mastery, and decrements all retry counters.

**Mastery check** (`canMarkMastered`): compound — point threshold AND KC coverage AND depth requirement must all pass.

### Question formats

Questions are either **open-ended** or **multiple-choice (MC)**, chosen by the LLM based on what's natural for the concept (biased toward MC at lower difficulty levels).

**Open-ended**: student types free-form answer → graded via API (`gradeAnswer`) → quarter-point credit (0/0.25/0.5/0.75/1.0) with `correctComponents`/`missingComponents`/`correction` breakdown.

**Multiple-choice**: 4 choices (A/B/C/D), 1 correct. Graded client-side (no API call) — correct → 1.0, wrong → 0.0. `generateQuestion` validates/clamps `correctIndex` to a real choice (falls back to open-ended if the choice set is malformed), so the highlighted correct answer and the client-side grade can never disagree. LLM provides an `explanation` shown after submission. The `MultipleChoice` component renders radio-style answer cards with correct/wrong highlighting on submit.

Both formats carry `kcId`, `difficultyLevel`, and `format` on the `PrepTurn` record.

### UX components

- **TestPrepMode** — phase orchestrator: `home | setup | processing | study`.
- **PrepSetup** — material picker (from library or upload), role assignment (lecture/homework/exam/topic-sheet), difficulty selector (Foundational/Thorough/Exam-ready), optional user context textarea.
- **PrepProcessing** — ingests PDFs, runs Tier 1 init, shows progress.
- **PrepStudy** — split-pane: left = curriculum map or topic session, right = resizable/collapsible reference pane. Manages session-level state: retry queue, recent topic IDs, turn count (in-memory refs, not persisted). Calls `selectNextQuestion()` and `onAnswerGraded()` to drive adaptive behavior. Shows topic-switch banner when interleaving causes a topic change. **Owns overview generation**: a background prefetch (`ensureOverview`) generates+persists each topic's cited overview once progress loads — sequentially, with the just-opened topic jumped to the front — so overviews are ready before entry and saved immediately (survives navigating away mid-generation). `TopicSession` consumes them via `overview`/`overviewLoading`/`overviewError`/`onRetryOverview` props.
- **CurriculumMap** — topic cards with progress bars, KC chips (filled/unfilled with labels), status line showing `pts/threshold` and `KCs covered/total`.
- **TopicSession** — two tabs: **Overview** (teaching primer with cited sections + citation chips that surface slides in the reference pane; generated/cached by PrepStudy and received via props — pure consumer) and **Practice** (one question at a time). Accepts `targetDifficulty`, `targetKcId`, `targetKcLabel` from the session-level selector. Renders either a textarea (open-ended) or `MultipleChoice` component based on question format. **Question prefetch**: the next question is generated in the background while the student works the current one, so "Next" promotes it instantly; each fetch excludes prior + current question text so every Next is a distinct question (never the same one). Provides chat trigger buttons: "Ask about this topic" on the overview tab (when overview is loaded), "Ask about this" on the practice tab (after answer submission only).
- **PrepChatPopup ("Ask Doug")** — floating chat window. **Default size scales to the viewport** (~30% w / ~72% h, clamped), **draggable by its header**, and **resizable** from the right edge (width), bottom edge (height), or corner (both); geometry persists across close/reopen (in-component state, re-clamped on viewport resize). Session-scoped history persists across all topics/questions. Streams from the configured AI provider (`model: 'smart'`). Context includes current topic, overview, and (after submission) the question, answer, score, and feedback. Opened via TopicSession trigger buttons.
- **ReferencePane** — vertical scroll carousel of source slides (lazily rasterised via IntersectionObserver with 600px preload margin). `<select>` switches sources. Resizable (drag divider), collapsible. Nudge banner on AI-suggested slides; smooth-scroll + brief highlight. **Bidirectional notes peek:** every slide shows a ✎ badge (solid when it has lecture-mode notes/chat, faded "+" to add); a bottom-sheet renders the slide's note markdown + Ask-Doug chat history and lets you **edit/add notes that autosave back to the lecture note store** (`setNote`, same `filename::slideIndex` key). Surfacing a slide (Tier-3 / citation) auto-opens the sheet only if that slide has content. Notes loaded per active document via `getAllNotesForFile`/`getAllChatsForFile`; empty for prep-only uploads.

### Constraints / guardrails

- Max **15 files** per session.
- Curriculum targets ~10 topics (hard bounds 5–20).
- Practice exam: format/weighting only — **never** reuse or leak its questions.
- Visual/technical subjects → abstract **text-only** questions (no diagrams).
- No image submissions.

### Key types (db.ts)

```
PrepDifficulty        = 'foundational' | 'thorough' | 'exam-ready'
KnowledgeComponent    = { id, label }
CurriculumTopic       = { id, title, summary, keySlides, masteryThreshold, order, knowledgeComponents }
PrepTurn              = { questionText, userAnswer, score, correctComponents, missingComponents,
                          correction, suggestedSlide?, timestamp, kcId?, difficultyLevel?,
                          format?, mcChoices?, mcCorrectIndex?, mcSelectedIndex? }
KCMasteryRecord       = { attempts, totalScore }
PrepTopicProgressRecord = { key, sessionId, topicId, status, masteryAccumulated, turns,
                            overview?, kcMastery? }
RetryItem             = { topicId, kcId?, questionsUntilRetry }
MasteryConfig         = { pointThreshold, minKCAttempts, minKCAvgScore, minDifficultyReached,
                          interleaving, retryEnabled, retryDelay, reviewInterval }
```

### Backward compatibility

- Difficulty values `light|medium|hard` mapped on read via `normalizeDifficulty()`.
- Topics without `knowledgeComponents` get fallback KC via `ensureKCs()`.
- Turns without `kcId`/`difficultyLevel`/`format` treated as `kcId: 'kc0'`, `difficultyLevel: 2`, `format: 'open'`.
