# Development Guide

This document covers the architecture, patterns, and conventions used in the Object Builder codebase. Read this before making changes.

## Architecture Overview

Object Builder follows Electron's multi-process architecture with three distinct layers:

```
┌─────────────────────────────────────────────────────────┐
│                    Main Process                          │
│  (Node.js - full OS access)                             │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ │
│  │ File I/O │ │ Project  │ │ Settings │ │  Menu     │ │
│  │ Service  │ │ Service  │ │ Service  │ │  Service  │ │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘ │
│  ┌──────────┐ ┌──────────┐                              │
│  │ Logger   │ │ Recovery │                              │
│  │ Service  │ │ Service  │                              │
│  └──────────┘ └──────────┘                              │
├─────────────────── IPC ─────────────────────────────────┤
│                   Preload Script                        │
│  (contextBridge - secure API surface)                   │
│  window.api.{file,recent,project,settings,menu,log,...} │
├─────────────────────────────────────────────────────────┤
│                  Renderer Process                        │
│  (Chromium - sandboxed browser context)                 │
│                                                         │
│  ┌───────────────────┐  ┌────────────────────────────┐ │
│  │   React UI        │  │    Zustand Stores          │ │
│  │   (Components)    │  │    (app, editor, sprite,   │ │
│  │                   │  │     animation)             │ │
│  └───────────────────┘  └────────────────────────────┘ │
│  ┌───────────────────┐  ┌────────────────────────────┐ │
│  │   Binary Services │  │    Web Workers             │ │
│  │   (DAT, SPR, OBD, │  │    (DAT, SPR, OBD)        │ │
│  │    OTB, XML, OTFI)│  │                            │ │
│  └───────────────────┘  └────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Main Process (`src/main/`)

Handles OS-level operations: file system access, native dialogs, window management, application menu, logging, and crash recovery. Services are pure functions with module-level state (no classes or singletons).

### Preload Script (`src/preload/`)

Bridges main and renderer via `contextBridge.exposeInMainWorld()`. Exposes a typed `window.api` object grouped by domain (file, recent, project, settings, menu, log, app, recovery). Only whitelisted IPC channels are exposed.

### Renderer Process (`src/renderer/`)

React application that handles all UI, binary format parsing/serialization, and state management. Binary services (DAT, SPR, OBD, OTB, XML) run in the renderer for direct access to parsed data. Heavy operations are offloaded to Web Workers.

## IPC Communication

Communication between main and renderer uses typed IPC channels defined in `src/shared/ipc-channels.ts`.

### Patterns

**Invoke (request/response):** Renderer calls main and awaits a result.
```typescript
// Renderer (via preload)
const result = await window.api.file.readBinary('/path/to/file.dat')

// Main (handler)
ipcMain.handle('file:readBinary', async (_event, filePath) => {
  return readBinaryFile(filePath)
})
```

**Event (push):** Main sends data to renderer without a request.
```typescript
// Main (send)
mainWindow.webContents.send('menu:action', 'fileNew')

// Renderer (via preload)
window.api.menu.onAction((action) => { /* handle */ })
```

### Channel Naming

Channels follow the pattern `domain:action`:
- `file:readBinary`, `file:showOpenDialog`
- `project:load`, `project:compile`
- `settings:get`, `settings:set`
- `menu:action` (event), `menu:updateState` (invoke)

Currently there are **48 invoke channels** and **4 event channels**.

### Adding New IPC Channels

1. Add the channel constant to `src/shared/ipc-channels.ts`
2. Add the handler in `src/main/ipc-handlers.ts`
3. Add the preload method in `src/preload/index.ts`
4. Add the type declaration in `src/preload/index.d.ts`
5. Update `CLAUDE.md` documentation

## State Management

State is managed with [Zustand](https://github.com/pmndrs/zustand) stores in the renderer process.

### Stores

| Store | File | Purpose |
|---|---|---|
| App Store | `use-app-store.ts` | Project state, things by category, selection, sprites count, UI, logs |
| Editor Store | `use-editor-store.ts` | Editing thing, undo/redo, clipboard, edit mode (single/bulk) |
| Sprite Store | `use-sprite-store.ts` | Loaded sprites, render cache (LRU), selection, change tracking |
| Animation Store | `use-animation-store.ts` | Frame group editing, playback state, frame management |

### Conventions

- Each store exports **selectors** for efficient React subscriptions:
  ```typescript
  const isLoaded = useAppStore(selectIsProjectLoaded)
  ```
- Actions are accessed via `getState()` outside React:
  ```typescript
  useAppStore.getState().addLog('info', 'Done')
  ```
- Stores don't call IPC directly &mdash; React components handle the IPC-to-store bridge.

### Thing Lookup

Things are stored in arrays per category. Lookup by ID uses the `clientInfo.minId` offset for O(1) access:
```typescript
const thing = thingsArray[id - clientInfo.minItemId]
```

## Binary Format Services

Located in `src/renderer/src/services/`. Each service is a pure functional module (no classes).

| Service | Directory | Formats |
|---|---|---|
| DAT | `services/dat/` | `.dat` metadata (ThingType properties, sprite references) |
| SPR | `services/spr/` | `.spr` sprites (RLE compression, ARGB pixels) |
| OBD | `services/obd/` | `.obd` single objects (LZMA, 3 versions) |
| OTB | `services/otb/` | `.otb` server items (binary tree, escape chars) |
| Items XML | `services/items-xml/` | `items.xml` server item attributes |
| OTFI | `services/otfi/` | `.otfi` file interface (OTML format) |
| Sprite Render | `services/sprite-render/` | Sprite composition, outfit colorization |
| Item Attributes | `services/item-attributes/` | TFS attribute definitions (8 versions) |
| Server Items | `services/server-items/` | OTB sync, sprite hash (MD5), high-level service |

### Binary I/O Pattern

All binary readers accept `ArrayBuffer` and return typed results. Writers accept typed data and return `ArrayBuffer`. This keeps the I/O boundary clean.

```typescript
// Reading
const result = readDat(buffer, version, features)
// result.items: ThingType[], result.outfits: ThingType[], ...

// Writing
const buffer = writeDat(data, version, features)
// buffer: ArrayBuffer ready to write to disk
```

### BinaryReader / BinaryWriter

Located in `services/dat/binary-stream.ts`. Little-endian utilities over `DataView`:
- Types: uint8, int8, uint16, int16, uint32, int32
- Strings: `readMultiByte(length, charset)` / `writeMultiByte(str, charset)` (latin1 support)
- BinaryWriter auto-expands its buffer when needed

## Web Workers

Three specialized workers offload heavy operations from the main thread:

| Worker | File | Operations |
|---|---|---|
| DAT Worker | `workers/dat-worker.ts` | Parse/serialize 50k+ thing types |
| SPR Worker | `workers/spr-worker.ts` | Parse/serialize sprite files, batch decompress |
| OBD Worker | `workers/obd-worker.ts` | LZMA compress/decompress |

### Usage

```typescript
import { workerService } from '@renderer/workers/worker-service'

const result = await workerService.readDat(buffer, version, features, durations)
```

Workers are lazy singletons created on first use. The `WorkerManager` wrapper provides a Promise-based API with request ID correlation and transferable object support (zero-copy `ArrayBuffer`).

### When to Use Workers

- **Use workers** for parsing entire files (50k+ things, large sprite files, LZMA compression)
- **Don't use workers** for individual sprite decompression (~0.01ms) &mdash; the postMessage overhead exceeds the computation

## Theme System

Light/Dark mode is implemented via CSS custom properties and a React context provider.

### How It Works

1. `ThemeProvider` in `providers/ThemeProvider.tsx` manages the theme state
2. The `useTheme()` hook provides `{ theme, resolvedTheme, setTheme }`
3. CSS custom properties are defined in `styles/global.css` using Tailwind's `@theme` directive
4. Dark is the default; `html.light` overrides with light values
5. An inline script in `index.html` applies the theme class before first paint (prevents flash)

### Color Tokens

Use semantic tokens, **never** hardcoded hex values in component styles:

```tsx
// Correct
<div className="bg-bg-primary text-text-secondary border-border">

// Wrong
<div className="bg-[#1e1e1e] text-[#858585] border-[#3c3c3c]">
```

Hardcoded hex colors are only acceptable in canvas rendering code (`ctx.fillStyle`, checkerboard patterns).

### Key Tokens

| Token | Purpose |
|---|---|
| `bg-primary/secondary/tertiary` | Background layers |
| `text-primary/secondary/muted` | Text hierarchy |
| `border/border-subtle` | Borders |
| `accent/accent-hover/accent-active` | Interactive accent |
| `success/warning/error/info` | Semantic colors |

## Internationalization (i18n)

Configured with `i18next` + `react-i18next`. Three languages: `en_US` (default), `es_ES`, `pt_BR`.

### Adding Translations

Translation files are in `src/renderer/src/i18n/locales/*.json`. Structure is nested JSON with 14 semantic sections.

```typescript
import { useTranslation } from 'react-i18next'

function MyComponent() {
  const { t } = useTranslation()
  return <span>{t('labels.items')}</span>
}
```

For interpolation: `t('alert.objectsAdded', { 0: count })`.

### Dynamic Labels

When constants arrays need translated labels, use `labelKey` instead of `label` and call `t()` at render time:

```typescript
const CATEGORIES = [
  { value: 'item', labelKey: 'labels.items' },
  // ...
]

// In render:
{CATEGORIES.map(c => <Tab key={c.value}>{t(c.labelKey)}</Tab>)}
```

## Web Build (browser, view-only)

The renderer can also run in a regular browser, without Electron:

```bash
npm run dev:web      # http://localhost:5174 (Vite dev server)
npm run build:web    # static files in out/web
npm run preview:web  # serves out/web on http://localhost:4174
```

- `vite.web.config.ts` builds `src/renderer` standalone and defines `import.meta.env.VITE_PLATFORM = web`.
- In that mode `main.tsx` installs `src/renderer/src/platform/web-api.ts` as `window.api`. It mirrors the preload API but is backed by an in-memory virtual file system: files picked with **Open** (choose `Tibia.dat` + `Tibia.spr`, optionally `.otfi`) or dragged onto the window are read with the File API. Nothing is uploaded.
- DAT/SPR parsing already lives in the renderer (services + Web Workers), so both builds share the same code. Electron builds are unaffected (`window.api` comes from the preload).
- Writes (compile/export) fall back to browser downloads; file watching, updater, recovery and the log file are no-ops. Focus for now is viewing.
- Real client check (read-only): `OB_CLIENT_DIR=/path/to/things/860 npx vitest run real-client` validates object/sprite counts and a DAT/SPR read-write-read round-trip.

## Testing Strategy

### Unit & Component Tests (Vitest)

- **Location:** `__tests__/` directories colocated with source files
- **Environment:** jsdom for renderer tests, node for main process tests
- **Libraries:** React Testing Library for components, jest-dom matchers
- **Pattern:** Test behavior, not implementation. Use `getByRole`, `getByText`, `getByTestId`.

```bash
npm run test          # Single run
npm run test:watch    # Watch mode
```

### E2E Tests (Playwright)

- **Location:** `e2e/` directory
- **Setup:** Custom fixture in `e2e/fixtures/electron-test.ts` launches the real Electron app
- **Requirement:** Build the app first (`npm run build`)
- **Dialog mocking:** Helper functions mock native file dialogs via `electronApp.evaluate()`

```bash
npm run test:e2e:build   # Build + run E2E
```

### Test Coverage by Layer

| Layer | Coverage |
|---|---|
| Core types | animation, things, geometry, version, sprites, metadata-flags |
| Binary services | DAT, SPR, OBD, OTB, items-xml, OTFI, item-attributes, server-items, sprite-render |
| Zustand stores | app, editor, sprite, animation |
| Main services | IPC handlers, file, project, settings, menu |
| UI components | Layout, Modal, ThingTypeEditor, AttributesEditor, SpritePanel, SpriteRenderer, ThingListPanel, all dialogs |
| E2E flows | App launch, create project, dialogs, edit objects, compile, file dialog mocking |

## Known Workarounds

### electron-vite v5.0.0 Ignores Renderer Config

electron-vite silently ignores `esbuild` config and Vite `plugins` for the renderer in dev mode. This causes two issues:

#### JSX: `React is not defined`

The bundler always uses classic `React.createElement()` regardless of config. **Every `.tsx` file must have `import React from 'react'`** at the top. The `tsconfig.web.json` uses `"jsx": "react"` to match.

#### CSS: Tailwind Plugin Ignored

`@tailwindcss/vite` is silently ignored. **Use `@tailwindcss/postcss`** via `postcss.config.mjs` instead. PostCSS is handled natively by Vite without going through the plugin system.

## Adding New Features

### New Component

1. Create the component in the appropriate `features/` subdirectory
2. Add `import React from 'react'` at the top of every `.tsx` file
3. Use `useTranslation()` for all user-visible strings
4. Use semantic color tokens (never hardcoded hex in styles)
5. Add tests in a colocated `__tests__/` directory

### New Dialog

1. Create the dialog component in `features/dialogs/` (or the relevant feature directory)
2. Add it to the `activeDialog` union type in `App.tsx`
3. Add the menu action constant in `shared/menu-actions.ts` if triggered from the menu
4. Wire the action in `App.tsx`'s `handleMenuAction` function
5. Add translations for all 3 languages

### New IPC Channel

1. Add channel constant to `shared/ipc-channels.ts`
2. Implement the handler in `main/ipc-handlers.ts`
3. Add preload method in `preload/index.ts`
4. Add type declaration in `preload/index.d.ts`
5. Update the IPC channel count in `CLAUDE.md`

### New Binary Service

1. Create a directory under `renderer/src/services/`
2. Follow the reader/writer pattern: accept `ArrayBuffer`, return typed result or `ArrayBuffer`
3. Use `BinaryReader`/`BinaryWriter` from `services/dat/binary-stream.ts`
4. Add tests covering round-trip encode/decode
5. If the operation is heavy, consider adding a Web Worker

## Debugging

### Main Process

```bash
# Launch with Chrome DevTools for main process
ELECTRON_ENABLE_LOGGING=1 npm run dev
```

In development mode, the main process console output appears in the terminal.

### Renderer Process

The renderer DevTools open automatically in development. Use the Console and Network tabs as with any web application.

### Logs

Application logs are written to `{userData}/objectbuilder.log` with session markers and timestamps. Open via Help or the Log panel's "Open Log File" button.

## Performance Considerations

- **Virtual scrolling:** ThingListPanel renders only visible items + overscan
- **LRU caches:** Sprite render cache (2000 entries) and thumbnail cache (5000 entries) with automatic eviction
- **Lazy sprite loading:** `SpriteAccessor` extracts sprites from the raw SPR buffer on demand instead of all at once (50% memory savings for large files)
- **Web Workers:** Heavy parsing (DAT/SPR/OBD) runs off the main thread
- **Debounced search:** ThingListPanel filter has 150ms debounce
- **Memoization:** SpriteRenderer memoizes sprite sheets, frames, and display calculations
