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
      PrepHeader.tsx              # Shared 56px brand header for Home/Setup/Processing
      TestPrepMode.tsx            # Phase orchestrator: home | setup | processing | study; home = editorial two-column hub (hero + ruled session list w/ live mastered counts)
      PrepSetup.tsx               # 3-column setup: Gather materials | Selected + context | Intensity; name bar + footer
      PrepProcessing.tsx          # PDF ingestion + Tier 1 init + batched overview generation; brand-mark card + per-file status list (done/active/queued)
      PrepStudy.tsx               # Split-pane study view; block-based question buffer + difficulty nudge; study bar w/ progress chip; back → "← All preps"
      CurriculumMap.tsx           # Ruled topic rows w/ KC dots + mini progress bars
      TopicSession.tsx            # Learn/practice tabs; open-ended + MC question UI; hint system + difficulty nudge arrows
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
| `prepProgress` | `sessionId::topicId` | `PrepTopicProgressRecord` (status, turns, kcMastery, overview, pendingQuestions) |
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
- **Tier 2** (overview / question generation): `'smart'` with adaptive thinking. **Grading**: `'fast'` without thinking — correct answers are precomputed during generation so the model only compares.

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
5. **Adaptive difficulty** — from last 3 scores: avg > 0.85 → +1, avg < 0.5 → −1, clamped 1–5. **Default starting difficulty is 1** (recall/definition). User nudge (`difficultyNudge` on `StudyState`) is applied on top: `clamp(adaptive + nudge, 1, 5)`.

**Difficulty scale** (passed to LLM): 1 = Recall/definition, 2 = Simple application, 3 = Conceptual reasoning, 4 = Multi-step problem, 5 = Transfer/synthesis.

**Post-answer hook** (`onAnswerGraded`): updates retry queue, KC mastery, and decrements all retry counters.

**Mastery check** (`canMarkMastered`): compound — point threshold AND KC coverage AND depth requirement must all pass.

### Question formats

Questions are either **open-ended** or **multiple-choice (MC)**, chosen by the LLM based on what's natural for the concept (biased toward MC at lower difficulty levels).

**Open-ended**: student types free-form answer → graded via API (`gradeAnswer`) → quarter-point credit (0/0.25/0.5/0.75/1.0) with `correctComponents`/`missingComponents`/`correction` breakdown. The correct answer is **precomputed** during question generation (`correctAnswer` field on `GeneratedQuestion`) and passed to the grading call so the LLM only compares rather than reasoning from scratch — grading uses `model: 'fast'` (no thinking) for speed.

**Multiple-choice**: 4 choices (A/B/C/D), 1 correct. Graded client-side (no API call) — correct → 1.0, wrong → 0.0. `generateQuestion` validates/clamps `correctIndex` to a real choice (falls back to open-ended if the choice set is malformed), so the highlighted correct answer and the client-side grade can never disagree. LLM provides an `explanation` shown after submission. The `MultipleChoice` component renders radio-style answer cards with correct/wrong highlighting on submit.

Both formats carry `kcId`, `difficultyLevel`, `format`, `hintUsed`, `hint`, and `hintSlide` on the `PrepTurn` record. Every generated question includes a directional `hint` (always present) and optional `hintSlide` reference. Questions are generated in blocks of 3 (`generateQuestionBlock`) or individually (`generateQuestion` as fallback).

### UX components

> **Design vocabulary (Direction D · Atelier).** All prep screens use the app's
> editorial vocabulary: mono all-caps eyebrows, Newsreader serif headers with
> italic-indigo accents, ruled dividers, counter chips (`prep-chip`), the brand
> mark, KC dots, and ruled (not boxed) feedback. The lecture Header is hidden in
> prep; `PrepHeader` supplies the brand header for the non-study phases. Buttons
> reuse `ate-btn`/`ate-btn-primary`. Prep CSS lives in the "TEST PREP — Direction
> D" block appended at the end of `globals.css` (single-class rules that win over
> the older generic prep styles, which are now dead).

- **TestPrepMode** — phase orchestrator: `home | setup | processing | study`. Home is an editorial two-column layout: left = hero + CTAs, right = ruled `prep-session-row` list with diff pills and **live per-session mastered counts** (`getAllProgressForSession`).
- **PrepSetup** — three ruled columns under a brand header + name bar + footer: **01 Gather materials** (library list + upload), **02 Selected** (picks w/ role pill + "Anything Doug should know?" context), **03 Intensity** (Foundational/Thorough/Exam-ready radios).
- **PrepProcessing** — ingests PDFs, runs Tier 1 init, then **generates overviews in batches of 4** (parallel within batch, sequential across batches) with `priorOverviews` context dedup. Each batch's overviews are persisted as `PrepTopicProgressRecord` entries so they're ready before the student opens any topic. Centered brand-mark card with Newsreader heading, elapsed chip, and a per-file status list (done/active/queued).
- **PrepStudy** — split-pane: left = curriculum map or topic session, right = resizable/collapsible reference pane. Manages session-level state: retry queue, turn count (in-memory refs, not persisted). Calls `selectNextQuestion()` and `onAnswerGraded()` to drive adaptive behavior. **Overviews are pre-generated during init** (PrepProcessing); PrepStudy only provides error-recovery re-generation via `retryOverview`. `TopicSession` consumes them via `overview`/`overviewLoading`/`overviewError`/`onRetryOverview` props. **Owns the block buffer**: a per-topic `BlockSlot` holds `currentBlock` (3 questions at the same difficulty) + `nextBlock` (pre-generated after Q2). `takeQuestion` returns the current block's question at `currentIndex`; `advanceQuestion` increments the index or promotes the next block. The buffer is **persisted** via `pendingQuestionBlock` in the topic's `prepProgress` record and restored on load. Supports **difficulty nudge**: user-triggered ±1 discards the current block and regenerates at the nudged level (consumed after block finishes). Old `pendingQuestions` format is discarded on load (backward compat).
- **CurriculumMap** — ruled topic rows (number, name + summary, KC dots, mini progress bar + `✓ Mastered`/`Not started`/`pts/threshold`); head shows the session title (passed via `title` prop) + mastered chip. Mastered rows go green.
- **TopicSession** — two tabs: **Overview** (teaching primer with cited sections + citation chips that surface slides in the reference pane; pre-generated during init and received via props — pure consumer) and **Practice** (one question at a time). Accepts `targetDifficulty`, `targetKcId`, `targetKcLabel` from the session-level selector. Renders either a textarea (open-ended) or `MultipleChoice` component based on question format. **Question source**: the displayed question comes from PrepStudy's per-topic block buffer — "Next" promotes the next question in the block instantly; between blocks a brief loading state shows if the next block isn't ready. **Hint system**: every question has a "Show hint" button; revealing the hint surfaces the `hintSlide` in the reference pane and halves the score for that question. `hintUsed`, `hint`, and `hintSlide` are persisted on the `PrepTurn`. **Difficulty nudge**: `DifficultyNudge` component (up/down arrows + "LV N" chip) replaces the old `DifficultySelector`; nudging discards the current block and regenerates at the adjusted level. Clicking the same arrow deselects; active arrow shows blue accent outline. **Post-mastery picker**: `MasteryDifficultyPicker` (5 level buttons) replaces the nudge arrows once the topic is mastered; picking a level generates a single question at that exact difficulty (not a block). Block internals (1/3 position) are not surfaced in the UI. Provides chat trigger buttons: "Ask about this topic" on the overview tab, "Ask about this" on the practice tab (after submission only). **Question-history navigator**: a Prev/Next pager lets the student page back through previously answered questions (`ReviewTurn`); hint slide + grading slide both shown as clickable `CitationChip`s, with a "Hint used" badge when applicable.
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
                          format?, mcChoices?, mcCorrectIndex?, mcSelectedIndex?,
                          hintUsed?, hint?, hintSlide? }
KCMasteryRecord       = { attempts, totalScore }
QuestionBlock         = { questions: GeneratedQuestion[], blockDifficulty, blockIndex }
PrepTopicProgressRecord = { key, sessionId, topicId, status, masteryAccumulated, turns,
                            overview?, kcMastery?, pendingQuestionBlock? }
RetryItem             = { topicId, kcId?, questionsUntilRetry }
MasteryConfig         = { pointThreshold, minKCAttempts, minKCAvgScore, minDifficultyReached,
                          interleaving, retryEnabled, retryDelay, reviewInterval }
```

### Mastery scoring

Only questions at difficulty level 2 or higher count positively toward mastery. Score multipliers:
- **Level 1**: 0 (doesn't count toward mastery)
- **Level 2**: 0.5x points
- **Level 3**: 0.75x points
- **Level 4+**: 1x points (full credit)

**Wrong-answer penalties** (score = 0): L1=-0.5, L2=-0.4, L3=-0.3, L4=-0.2, L5=-0.1. Total mastery is clamped to ≥ 0.

**Hint penalty**: using a hint halves the raw score before mastery calculation (`applyHintPenalty` in `questionSelector.ts`).

### Block-based question generation

Questions are generated in blocks of 3 at the same difficulty level (`generateQuestionBlock` in `testPrep.ts`). Each question includes a `hint` (directional text) and optional `hintSlide` (slide reference). The block buffer in `PrepStudy` manages current + next blocks so "Next question" is instant within a block, with next-block prefetch starting after Q2.

**Difficulty nudge**: users can press up/down arrows to adjust the next block's difficulty by ±1 on top of the adaptive level. Clicking the same arrow again deselects the nudge; selected arrows show a blue accent outline. The nudge discards the current block and regenerates. Nudge is consumed (cleared) after the block finishes. **Post-mastery**: once a topic is mastered, the nudge arrows are replaced by a direct 5-level picker (buttons 1–5) and questions are generated individually (not in blocks) at the chosen level. Post-mastery answers are recorded in history but **do not change mastery points** — the accumulated score is frozen at the mastered threshold.

**Overview pre-generation**: overviews are generated during `PrepProcessing` (init screen) in batches of 4, with `priorOverviews` context dedup so later topics don't repeat earlier content. `PrepStudy` only does error-recovery re-generation.

### Backward compatibility

- Difficulty values `light|medium|hard` mapped on read via `normalizeDifficulty()`.
- Topics without `knowledgeComponents` get fallback KC via `ensureKCs()`.
- Turns without `kcId`/`difficultyLevel`/`format` treated as `kcId: 'kc0'`, `difficultyLevel: 2`, `format: 'open'`.
- Turns without `hintUsed` read as `hintUsed: false`.
- Old `pendingQuestions` (array format) on `PrepTopicProgressRecord` is discarded on load — fresh blocks are generated instead. The field is kept on the type for read compat but never written.
- Old `GeneratedQuestion` objects without `hint` get a default hint string.

