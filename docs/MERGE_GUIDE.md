# Arduboy Web Tools — Merge Guide

> **Purpose:** Practical guide for an AI coding agent (or developer) merging
> this project with another codebase. Covers integration points, shared state,
> naming conventions, potential conflicts, and step-by-step strategies.

---

## 1. Quick Facts

| Aspect | Detail |
|--------|--------|
| **Package name** | `arduboy-webtools` |
| **Module system** | ES Modules (`"type": "module"` in package.json) |
| **Framework** | None — vanilla JavaScript + CSS |
| **DOM coupling** | `src/core/` has ZERO DOM deps; `src/ui/` is DOM-dependent |
| **Build tool** | Vite 6 (can coexist with other Vite/Webpack projects) |
| **CSS strategy** | Plain CSS with custom properties (no CSS-in-JS, no preprocessor) |
| **State management** | Module-scoped variables in `main.js`, localStorage for persistence |
| **Runtime deps** | Only 2: `jszip`, `@tonejs/midi` |

---

## 2. What Can Be Reused As-Is

### 2.1 Core Library (`src/core/`)

The entire `src/core/` directory is a **standalone, framework-agnostic library**.
It can be imported into any JavaScript project that supports ES Modules.

```js
// Import everything
import * as ArduboyCore from './src/core/index.js';

// Or cherry-pick
import { parseIntelHex, generateIntelHex } from './src/core/formats/intelhex.js';
import { SerialTransport, ArduboyProtocol } from './src/core/serial/transport.js';
import { uploadSketch } from './src/core/operations/sketch.js';
```

**No DOM, no globals, no side effects** — just pure functions and classes.

### 2.2 Sub-modules That Work in Node.js / Web Workers

Everything in `src/core/` except the serial layer works without browser APIs:

| Module | Browser-only? | Notes |
|--------|:---:|-------|
| `constants.js` | No | Pure data |
| `utils/binary.js` | No* | `sha256()` uses `crypto.subtle` (available in Node 18+) |
| `formats/intelhex.js` | No | Pure computation |
| `formats/fxcart.js` | No | Pure computation |
| `formats/arduboy.js` | No | Uses `jszip` (works in Node) |
| `formats/image.js` | **Yes** | Uses Canvas API, `createImageBitmap` |
| `serial/*` | **Yes** | Uses Web Serial API |
| `operations/*` | **Yes** | Depends on serial layer |
| `music/*` | No* | `midiImport.js` uses `@tonejs/midi` (works in Node) |
| `fxdata/*` | Mostly No | `fxdataImageEncoder.js` uses `OffscreenCanvas` |

### 2.3 CSS Design Tokens

`src/ui/styles/variables.css` defines all design tokens as CSS custom properties.
If the target project uses CSS custom properties, these can be adopted or remapped:

```css
/* Key tokens */
--color-primary: #8B2DB4;
--color-surface: hsla(260, 30%, 15%, 0.6);
--radius-md: 12px;
--spacing-md: 16px;
/* ... see variables.css for the full set */
```

---

## 3. Integration Strategies

### Strategy A: Use Core as a Library (Recommended)

Best for: merging into a larger app that has its own UI framework.

1. Copy `src/core/` into the target project
2. Install the 2 runtime deps: `npm install jszip @tonejs/midi`
3. Import functions from `src/core/index.js`
4. Build your own UI around the core API
5. Discard `src/ui/`, `index.html`, and CSS

**Advantages:** Clean boundary, no DOM conflicts, no CSS conflicts.

### Strategy B: Embed as a Route/Tab

Best for: adding Arduboy tools as a section within an existing SPA.

1. Copy `src/core/` and `src/ui/` into the target project
2. Extract the relevant panel HTML from `index.html` (each `<div class="panel">`)
3. Wire up the editor classes (`CartEditor`, `MusicEditor`, etc.) to your panel lifecycle
4. Import the CSS files (may need scoping — see section 5)
5. Adapt `main.js` connection management to your app's state

### Strategy C: iframe / Micro-frontend

Best for: minimal integration effort, maximum isolation.

1. Deploy this project separately (GitHub Pages or any static host)
2. Embed via `<iframe>` in the target app
3. Communicate via `postMessage` if needed

---

## 4. Shared State & Global Assumptions

### 4.1 Module-Scoped State in `main.js`

The following state lives in `main.js` module scope (NOT in any class):

```js
let transport = null;      // SerialTransport instance
let protocol = null;       // ArduboyProtocol instance
const selectedFiles = {};  // { sketch: File, fx: File, eeprom: File }
```

If merging, you'll need to decide where device connection state lives.
Options:
- Singleton service class
- Framework store (Redux, Zustand, etc.)
- Keep as module-scoped (simplest)

### 4.2 localStorage Keys

| Key | Used by | Value |
|-----|---------|-------|
| `activeMainTab` | `TabController` | Tab ID string (e.g. "sketch") |
| `musicEditorSong` | `MusicEditor` | JSON-serialized song state |
| `musicEditorTracks` | `MusicEditor` | Track selection state |

If the target app uses localStorage, check for key collisions.
Consider namespacing: `arduboy.activeMainTab`, etc.

### 4.3 DOM ID Assumptions

All UI code uses `querySelector` with specific IDs/classes defined in `index.html`:
- `#progress-overlay`, `#progress-bar`, `#progress-status`, `#progress-percent`
- `#connection-status`, `#btn-reset`
- `#sketch-file`, `#fx-file`, `#eeprom-file`
- `#btn-sketch-upload`, `#btn-fx-write`, `#btn-eeprom-backup`, etc.
- `.tab-btn[data-panel]`, `.panel`, `.status-dot`, `.status-text`

These will conflict if the target app has elements with the same IDs.
Fix: prefix IDs (`arduboy-progress-overlay`) or use a container scope.

### 4.4 CSS Global Effects

The CSS applies some global styles that may conflict:

```css
/* Global resets in main.css */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; ... }
body::before { /* Full-page ambient gradient background */ }
```

For safe integration, either:
- Scope all CSS under a container class (`.arduboy-tools *`)
- Use Shadow DOM
- Selectively import only `variables.css` + `components.css`

---

## 5. Potential Conflicts & Mitigations

### 5.1 Dependency Conflicts

| Dep | This project | Risk | Mitigation |
|-----|-------------|------|------------|
| `jszip` | ^3.10.1 | Low — stable API, widely used | Version range is flexible |
| `@tonejs/midi` | ^2.0.28 | Low — niche but stable | Only needed if music features are included |
| `vite` | ^6.1.0 | Medium — if target uses different bundler | Core library is plain ESM, works with any bundler |

### 5.2 Web Serial Conflicts

Web Serial API allows only **one reader** and **one writer** per port.
If the target project also uses Web Serial, the two must share the same
`SerialTransport` instance — do NOT open the same port twice.

### 5.3 Build Configuration

The `vite.config.js` sets `base: '/Arduboy-Webtools/'`. This affects:
- Asset URL paths in production
- CSS `url()` references
- Import paths in the built output

When merging, update `base` to match the target deployment path or remove it
for root-relative paths.

### 5.4 File Naming

This project uses camelCase for ALL file names (`cartEditor.js`, `fxdataBuild.js`).
If the target project uses different conventions (kebab-case, PascalCase),
rename files or set up path aliases.

---

## 6. Step-by-Step Merge Checklist

### Phase 1: Preparation

- [ ] Read `docs/ARCHITECTURE.md` for full project structure
- [ ] Read `docs/API_REFERENCE.md` for all public APIs
- [ ] Identify which features are needed in the target project
- [ ] Choose integration strategy (A, B, or C from section 3)

### Phase 2: Core Library Integration

- [ ] Copy `src/core/` to target project
- [ ] Install `jszip` (required) and `@tonejs/midi` (if music features needed)
- [ ] Verify imports resolve (may need path adjustments)
- [ ] Run `npm run test:run` to verify core library tests pass

### Phase 3: UI Integration (if needed)

- [ ] Extract needed panel HTML from `index.html`
- [ ] Namespace all DOM IDs to avoid conflicts
- [ ] Import CSS files — scope under a container class if needed
- [ ] Adapt `main.js` wiring to target app's lifecycle
- [ ] Replace `showToast`/`showConfirm` with target app's notification system
- [ ] Adapt progress overlay to target app's loading UI

### Phase 4: Device Connection

- [ ] Decide where connection state lives (singleton, store, module)
- [ ] Map `ensureDevice()` pattern to target app's connection flow
- [ ] Handle Web Serial browser support detection
- [ ] Test device connection/disconnection lifecycle

### Phase 5: Testing & Cleanup

- [ ] Run all tests (`npm run test:run`)
- [ ] Run linter (`npm run lint`)
- [ ] Remove unused modules (e.g. music system if not needed)
- [ ] Remove `ref/` directory (reference code, not needed at runtime)
- [ ] Update deployment configuration

---

## 7. Key Patterns to Preserve

When integrating, these patterns should be maintained for consistency:

### 7.1 Progress Reporting Convention

All long-running operations accept `onProgress(fraction)` where `fraction` is
0.0 to 1.0. The UI maps this to percentage. If your target app has a different
progress system, create a thin adapter:

```js
// Adapter example
const onProgress = (fraction) => targetApp.setProgress(fraction * 100);
await uploadSketch(protocol, hexData, { onProgress });
```

### 7.2 Error Result Pattern

Operations return `{ success: boolean, message: string }` instead of throwing.
Serial-level errors still throw. UI code should handle both:

```js
try {
  const result = await uploadSketch(proto, data);
  if (!result.success) showError(result.message);
} catch (err) {
  showError(`Serial error: ${err.message}`);
}
```

### 7.3 Binary Data Convention

All binary data is `Uint8Array`. Never use `Array`, `Buffer`, or `ArrayBuffer`
directly. Use the utility functions in `utils/binary.js`:

```js
import { concat, padData, readUint16BE, writeUint16BE } from './core/utils/binary.js';
```

---

## 8. What to Exclude

When merging, these can be safely excluded:

| Path | Reason |
|------|--------|
| `ref/` | Reference codebases used during initial development |
| `dist/` | Build output — regenerated by `npm run build` |
| `docs/PROJECT_KNOWLEDGE.md` | Original planning document, superseded by other docs |
| `.github/workflows/deploy.yml` | GitHub Pages deployment (replace with target's CI/CD) |
| `tmpclaude-*` | Temporary files from AI coding sessions |

---

## 9. Feature-Level Import Map

If you only need specific features, here's what to bring:

| Feature | Core modules needed | UI modules needed | Deps |
|---------|-------------------|-------------------|------|
| **Flash .hex** | `serial/*`, `formats/intelhex`, `operations/sketch`, `utils/binary`, `constants` | — | None |
| **Flash .arduboy** | Above + `formats/arduboy` | — | `jszip` |
| **FX Flash R/W** | `serial/*`, `operations/fx`, `formats/fxcart`, `utils/binary`, `constants` | — | None |
| **Cart Editor** | `formats/fxcart`, `formats/arduboy`, `formats/image`, `operations/patch`, `utils/binary`, `constants` | `cartEditor`, `files`, `toast`, `modal`, `progress` | `jszip` |
| **Image Converter** | `formats/image`, `constants` | `imageConverter` | None |
| **Music Editor** | `music/*` | `musicEditor` | `@tonejs/midi` |
| **FX Data Build** | `fxdata/*`, `formats/image` | `fxdataEditor` | None |
| **EEPROM** | `serial/*`, `operations/eeprom`, `constants` | — | None |
| **Patching** | `operations/patch`, `constants`, `utils/binary` | — | None |
| **Package Editor** | `formats/arduboy`, `formats/image`, `constants` | `packageEditor` | `jszip` |
