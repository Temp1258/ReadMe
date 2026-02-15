# Project Structure

This repository contains the ReadMe Chrome/Edge extension MVP.

## Top-level folders

- `extension/` — MV3 extension source code, static assets, and build config.
- `docs/` — project documentation, implementation notes, and checklists.

## `extension/` layout

- `src/` — React UI and extension runtime modules.
  - `main.tsx` — popup entry point.
  - `options.tsx` — options/settings page entry point.
  - `service_worker.ts` — MV3 background service worker.
  - `offscreen.ts` + `offscreen.html` — offscreen runtime for audio/STT-related tasks.
  - `stt/` — speech-to-text integration code.
  - `db/` — IndexedDB helpers.
- `public/` — static files copied to build output as-is.
  - `manifest.json` — extension manifest template.
  - `icons/` — extension icons used by manifest and UI metadata.
- `index.html` — popup HTML shell.
- `options.html` — options page HTML shell.
- `vite.config.ts` — Vite build setup for multi-entry extension pages.
- `manifest.json` — checked-in manifest aligned with build output paths.

## Build output (generated)

Running `npm run build` in `extension/` produces a `dist/` folder with compiled assets and copied static files. The manifest references files under `dist/`.
