<p align="center">
  <img src="extension/public/branding/logo.png" alt="ReadMe Logo" width="120" />
</p>

<h1 align="center">ReadMe</h1>

<p align="center">
  A lightweight Chrome/Edge extension that records audio and transcribes it in real time.
</p>

<p align="center">
  <a href="#installation">Installation</a> •
  <a href="#features">Features</a> •
  <a href="#supported-providers">Providers</a> •
  <a href="#development">Development</a> •
  <a href="#license">License</a>
</p>

---

## Installation

### For Users

1. Download the latest `readme-extension.zip` from the [Releases](../../releases) page
2. Unzip the file
3. Open `chrome://extensions` (or `edge://extensions`)
4. Enable **Developer mode** (toggle in the top-right corner)
5. Click **Load unpacked** and select the unzipped folder
6. Click the ReadMe icon in your toolbar to get started

### Initial Setup

1. Open the extension popup → **Settings** → **Manage API key**
2. Choose an STT provider and enter your API key
3. Save — you're ready to record

> **No API key?** Select the **Mock** provider to test the full pipeline with placeholder transcriptions.

---

## Features

| Feature | Description |
|---------|-------------|
| **Multi-source recording** | Capture from microphone, browser tab audio, or both simultaneously |
| **Real-time transcription** | Audio is chunked and transcribed on the fly as you record |
| **Batch fallback** | If live transcription misses anything, a batch pass with overlap deduplication fills the gaps |
| **AI summary** | One-click summary powered by GPT-4o-mini — key points and action items extracted automatically |
| **Session management** | Full recording history stored locally with search and playback |
| **Export** | Download transcripts as `.txt`, `.md`, or `.srt` (subtitles with timestamps) |
| **Audio playback** | Replay any recording directly in the popup with seek controls |
| **i18n** | English and Chinese (中文) UI |
| **Themes** | Light and dark mode |
| **Privacy-first** | All data stays in your browser; only audio is sent to your configured STT provider |

---

## Supported Providers

| Provider | Model | Notes |
|----------|-------|-------|
| [OpenAI Whisper](https://platform.openai.com/) | `whisper-1` | Multilingual, widely supported |
| [Deepgram](https://deepgram.com/) | `nova-2` | Fast, smart formatting |
| [SiliconFlow](https://siliconflow.cn/) | SenseVoice | Good for Chinese audio |
| Mock | — | Offline testing, no API key needed |

AI summaries require an OpenAI API key (uses `gpt-4o-mini`).

---

## How It Works

```
Microphone / Tab Audio / Mix
        │
        ▼
  MediaRecorder (30-second chunks)
        │
        ├──▶ IndexedDB (persistent storage)
        │
        ▼
  Live Transcription Queue
  (every ~60 seconds → STT API)
        │
        ▼
  Overlap Deduplication
        │
        ▼
  Transcript + AI Summary
```

- Audio is recorded in 30-second WebM chunks and persisted to IndexedDB immediately
- Every 2 chunks (~60s), a batch is sent to your STT provider for transcription
- Adjacent batches overlap slightly; a deduplication algorithm removes repeated text
- If any batch fails during recording, it is retried automatically when you stop
- Recordings up to **4 hours** / **500 MB** are supported

---

## Development

### Prerequisites

- Node.js (v18+)
- npm

### Setup

```bash
cd extension
npm install
npm run build
```

### Load in Browser

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension` folder
4. After each rebuild, click **Reload** on the extension card

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Type-check (`tsc`) + production build |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |

### Tech Stack

- **UI:** React 18 + TypeScript
- **Build:** Vite 5
- **Extension:** Chrome Manifest V3
- **Storage:** IndexedDB (sessions & audio) + `chrome.storage.local` (settings)
- **Audio:** Offscreen document with MediaRecorder API
- **Testing:** Vitest + Testing Library

### Project Structure

```
extension/
├── src/
│   ├── App.tsx                    # Popup UI (3-tab layout)
│   ├── options.tsx                # Options page (API key management)
│   ├── service_worker.ts          # MV3 background service worker
│   ├── offscreen/
│   │   ├── recording.ts           # Audio capture pipeline
│   │   ├── live-transcribe.ts     # Real-time transcription queue
│   │   ├── segmentation.ts        # WebM segmentation for batch mode
│   │   ├── transcription.ts       # Batch transcription processor
│   │   └── state.ts               # Offscreen state management
│   ├── stt/
│   │   ├── whisper.ts             # OpenAI Whisper client
│   │   ├── deepgram.ts            # Deepgram client
│   │   └── llm.ts                 # GPT-4o-mini summary generation
│   ├── components/
│   │   ├── TranscriptionView.tsx  # Recording controls & live transcript
│   │   ├── NotesView.tsx          # Session list, export, AI summary
│   │   ├── SettingsView.tsx       # Theme, language, provider settings
│   │   └── AudioPlayer.tsx        # Playback with seek controls
│   ├── db/
│   │   └── indexeddb.ts           # IndexedDB schema & CRUD
│   ├── utils/
│   │   ├── dedup.ts               # Overlap deduplication (CJK-aware)
│   │   ├── export.ts              # TXT / Markdown / SRT formatters
│   │   └── webm.ts                # WebM binary parsing
│   └── i18n.ts                    # Translations (en / zh)
├── public/
│   ├── manifest.json              # Extension manifest
│   └── icons/                     # Extension icons
└── dist/                          # Build output
```

---

## License

[MIT](LICENSE) © 2026 Temp1258
