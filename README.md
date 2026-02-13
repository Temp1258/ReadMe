# ReadMe

ReadMe is a lightweight Chrome/Edge extension for chat. This repository now includes Issue #1 scaffold work and Issue #2 login/token storage in the popup UI.

## Extension (`/extension`)

The extension is built with:

- Vite
- React
- TypeScript
- Manifest V3

### 1) Install dependencies

```bash
cd extension
npm install
```

### 2) Run development server

```bash
npm run dev
```

### 3) Build extension assets

```bash
npm run build
```

The production build output is generated in `extension/dist`.

### 4) Load the unpacked extension in Chrome

1. Build the extension with `npm run build`.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extension/dist` folder.
6. Open the extension popup.

## Login flow (Issue #2)

The popup now supports:

- Email + password login via `POST http://localhost:8080/auth/login`
- Mock login fallback for local UI testing when backend is unavailable
- Auth persistence in `chrome.storage.local` (`token` + `email`)
- Logout that clears `chrome.storage.local`

### Test login with backend

1. Start a backend locally at `http://localhost:8080` that accepts `POST /auth/login` and returns JSON with an `accessToken` field.
2. Open the extension popup.
3. Enter email/password and click **Login**.
4. Verify the popup shows the **Chats** placeholder screen.
5. Close/reopen the popup and verify auth is still persisted.

### Test login in mock mode (no backend required)

1. Open the extension popup.
2. Enter an email address (password optional for mock mode).
3. Click **Mock Login**.
4. Verify the popup shows the **Chats** placeholder screen.
5. Click **Logout** and verify the login form is shown again.

## Available scripts

From the `extension` directory:

- `npm run dev` - starts the Vite development server
- `npm run build` - type-checks and creates the production build
- `npm run preview` - previews the built app locally

## STT pipeline (Issue #13)

The offscreen recorder now chunks audio every ~12 seconds and transcribes chunks in FIFO order via Whisper.

### Set API key (MVP)

1. Open the extension popup and sign in.
2. In **Transcription**, paste your Whisper/OpenAI API key into **Whisper API Key**.
3. Click **Save API Key** (stored in `chrome.storage.local`).
4. Click **Start** to begin listening/transcribing.

### Test without a real API key

If no API key is saved, the extension skips network requests and appends mock lines such as `[mock] chunk 1 text`.
This allows validating chunk ordering and live transcript UI without external dependencies.
