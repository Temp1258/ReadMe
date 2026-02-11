# ReadMe

ReadMe is a lightweight Chrome/Edge extension for chat. This repository currently includes the Manifest V3 extension scaffold for Issue #1.

## Extension scaffold (`/extension`)

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
6. Open the extension popup and confirm the title displays **ReadMe**.

## Available scripts

From the `extension` directory:

- `npm run dev` - starts the Vite development server
- `npm run build` - type-checks and creates the production build
- `npm run preview` - previews the built app locally
