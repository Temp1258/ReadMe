# ReadMe

ReadMe is a lightweight Chrome/Edge extension that records audio and transcribes it in real time. It captures microphone input, browser tab audio, or both, then uses cloud STT APIs to produce a live transcript. After recording, an AI summary extracts key points and action items automatically.

## Features

- **Multi-source recording** — Microphone, tab audio, or mixed (tab + mic)
- **Real-time transcription** — Audio is chunked every ~12 seconds and transcribed on the fly
- **Batch transcription fallback** — If live transcription misses anything, a batch pass with overlap deduplication fills the gaps
- **Multiple STT providers** — OpenAI Whisper, Deepgram Nova-2, or Mock (no API key required)
- **AI summary** — One-click summary powered by GPT-4o-mini: concise summary, key points, and action items
- **Session management** — All recordings are stored locally in IndexedDB with full session history
- **Export** — Download transcripts as TXT, Markdown, or SRT (subtitles with timestamps)
- **Audio playback** — Replay recordings directly in the popup
- **Privacy-first** — All data stays in your browser; only audio chunks are sent to the STT API you configure
- **i18n** — English and Chinese UI
- **Themes** — Light and dark mode

## Tech stack

- Vite + React + TypeScript
- Chrome Manifest V3
- Offscreen document for audio recording and STT processing
- IndexedDB for local session and audio chunk storage
- `chrome.storage.local` for settings persistence

## Getting started

### 1) Install dependencies

```bash
cd extension
npm install
```

### 2) Build the extension

```bash
npm run build
```

### 3) Load in Chrome / Edge

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the **`extension` folder** (not `extension/dist`). The root `extension/manifest.json` references build output under `dist/`.
5. After every rebuild, click **Reload** on the extension card.

Notes:
- `extension/manifest.json` and `extension/public/manifest.json` are both MV3 manifests and should stay aligned.
- Runtime pages are served from `dist/*` (e.g. `chrome-extension://<id>/dist/src/offscreen.html`).

### 4) Configure an STT provider

1. Open the extension popup and go to **Settings**.
2. Click **Manage API key** to open the Options page.
3. Choose a provider (OpenAI Whisper or Deepgram Nova-2) and paste your API key.
4. Save. The key is stored in `chrome.storage.local`.

To test without an API key, select **Mock** — the extension will generate placeholder transcription text so you can validate the full pipeline.

### 5) Record and transcribe

1. Open the extension popup.
2. Select an audio source: **Microphone**, **Tab audio**, or **Mix (tab + mic)**.
3. Click **Start**. The transcript appears live as audio is processed.
4. Click **Stop** when finished.
5. Switch to the **Notes** tab to review sessions, generate an AI summary, or export.

## Available scripts

From the `extension` directory:

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the Vite development server |
| `npm run build` | Type-check and create a production build |
| `npm run preview` | Preview the built app locally |
| `npm test` | Run unit tests with Vitest |

## Project structure

```
extension/
  src/
    App.tsx                  # Main popup UI
    main.tsx                 # Popup entry point
    options.tsx              # Options page (API key management)
    service_worker.ts        # MV3 background service worker
    offscreen.ts             # Offscreen document entry
    offscreen/
      recording.ts           # Audio recording pipeline
      segmentation.ts        # WebM segmentation for batch transcription
      transcription.ts       # Batch transcription processor
      live-transcribe.ts     # Real-time transcription queue
      state.ts               # Centralized offscreen state
    stt/
      whisper.ts             # OpenAI Whisper API integration
      deepgram.ts            # Deepgram API integration
      llm.ts                 # LLM-based AI summary generation
    components/
      TranscriptionView.tsx  # Live transcription controls and display
      NotesView.tsx          # Session list, search, export, and AI summary
      SettingsView.tsx       # Theme, language, and provider settings
      AudioPlayer.tsx        # Audio playback with seek controls
    db/
      indexeddb.ts           # IndexedDB schema and CRUD operations
    utils/
      dedup.ts               # Overlap deduplication for transcript segments
      export.ts              # TXT / Markdown / SRT export formatters
      format.ts              # Timestamp and duration formatting
      webm.ts                # WebM binary utilities
      chrome-storage.ts      # Chrome storage API helpers
    state/
      reducer.ts             # Redux-style app state reducer
    i18n.ts                  # Internationalization (en / zh)
    errors.ts                # Unified error hierarchy
    settings.ts              # Extension settings management
    types.ts                 # Shared TypeScript types
  public/
    manifest.json            # Extension manifest template
    icons/                   # Extension icons
    branding/                # Logo assets
  manifest.json              # Root manifest aligned with build output
docs/
  API.md                     # REST API contract (for future backend)
  PROJECT_STRUCTURE.md       # Project structure overview
```

## License

See [LICENSE](LICENSE).
