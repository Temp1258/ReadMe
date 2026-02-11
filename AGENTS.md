# ReadMe (Chrome/Edge Extension) - Agent Instructions

## Goal (MVP in 3 days)
Build a Chrome/Edge extension (Manifest V3) that supports:
1) Email+password login (JWT token)
2) 1:1 text chat
3) Load last 50 messages (history)
4) Polling for new messages (every 2s) instead of WebSocket
5) Clickable URLs in messages -> open in a new tab
6) Basic error handling and clear UI states

## Explicit Non-Goals (DO NOT implement in MVP)
- WebSocket / Socket.IO realtime
- Group chat, read receipts, message recall, search
- File upload and document preview (PDF/Office)
- End-to-end encryption
- Multi-device sync beyond simple polling

## Tech Stack
- Extension: Vite + React + TypeScript
- Manifest: MV3
- Storage: chrome.storage.local for auth token + settings
- API: simple REST endpoints (server can be replaced later)

## Repository Structure
- /extension: Chrome extension source (React/Vite)
- /docs: specs, API contract, checklists
- (Optional later) /server: backend service

## Coding Rules
- Keep code minimal, clean, and easy to run
- No secrets committed; use .env.example if needed
- Provide step-by-step run instructions in README
- Prefer small PRs: each PR should complete ONE issue with acceptance criteria

## Commands
- Extension dev: `cd extension && npm install && npm run dev`
- Build: `cd extension && npm run build`

## Acceptance Criteria (MVP)
- User can login and token is persisted in chrome.storage.local
- User can see conversation list (can start with a single default conversation)
- User can send a text message and see it appear immediately
- Polling fetches new messages and appends to the chat
- URLs are detected and clickable; clicking opens a new tab
