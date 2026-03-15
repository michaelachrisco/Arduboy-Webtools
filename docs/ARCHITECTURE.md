# Arduboy Web Tools — Architecture Reference

> **Purpose:** Provide another AI coding agent with a complete understanding of
> this project's architecture, module boundaries, data flow, and conventions
> so that merge/integration work requires minimal exploration.

---

## 1. Project Identity

| Field | Value |
|-------|-------|
| **Name** | `arduboy-webtools` |
| **Type** | Single-page web application (SPA) |
| **Language** | Vanilla JavaScript (ES Modules) + CSS3 — no TypeScript, no framework |
| **Build tool** | Vite 6 |
| **Test runner** | Vitest 3 |
| **Runtime deps** | `jszip` (ZIP I/O), `@tonejs/midi` (MIDI parsing) |
| **Browser APIs** | Web Serial, Canvas, File/Drag-Drop, Web Crypto (SHA-256), localStorage |
| **Deploy** | GitHub Pages via GitHub Actions (`dist/` directory, base path `/Arduboy-Webtools/`) |

---

## 2. Directory Layout

```
arduboy-webtools/
├── index.html                  # Single HTML app shell (919 lines, all panel markup inline)
├── package.json                # ESM ("type": "module"), 2 deps, 4 devDeps
├── vite.config.js              # base: /Arduboy-Webtools/, port 3000, sourcemaps on
│
├── src/
│   ├── main.js                 # App entry — wires UI to core, handles drag-drop routing
│   │
│   ├── core/                   # ★ PURE JS LIBRARY — zero DOM dependencies ★
│   │   ├── index.js            # Barrel re-export of everything below
│   │   ├── constants.js        # All hardware/protocol constants
│   │   ├── serial/
│   │   │   ├── transport.js    # SerialTransport — Web Serial wrapper with buffered reads
│   │   │   ├── protocol.js     # ArduboyProtocol — all AVR109 bootloader commands
│   │   │   └── device.js       # DeviceManager — USB discovery, bootloader entry
│   │   ├── formats/
│   │   │   ├── intelhex.js     # Intel HEX parse/generate
│   │   │   ├── fxcart.js       # FX flash cart binary format (parse/compile/trim/scan)
│   │   │   ├── arduboy.js      # .arduboy ZIP package read/write (JSZip)
│   │   │   └── image.js        # Image ↔ binary (screen, sprites, masks, code gen)
│   │   ├── operations/
│   │   │   ├── sketch.js       # Upload/backup/erase/analyze sketch
│   │   │   ├── fx.js           # Write/backup/scan FX flash
│   │   │   ├── eeprom.js       # Read/write/erase EEPROM
│   │   │   └── patch.js        # SSD1309/contrast/LED/FX/menu-button patches
│   │   ├── utils/
│   │   │   └── binary.js       # Pad, concat, sha256, endian helpers, sleep
│   │   ├── music/
│   │   │   ├── index.js        # Barrel re-export
│   │   │   ├── songModel.js    # Song/note data model
│   │   │   ├── noteConstants.js# MIDI note/frequency tables
│   │   │   ├── midiImport.js   # MIDI file parser (uses @tonejs/midi)
│   │   │   ├── exportTones.js  # → ArduboyTones C++ format
│   │   │   └── exportPlaytune.js # → ArduboyPlaytune C++ format
│   │   └── fxdata/
│   │       ├── index.js        # Barrel re-export
│   │       ├── fxdataParser.js # Custom DSL parser
│   │       ├── fxdataBuild.js  # DSL → binary + C++ header builder
│   │       ├── fxdataProject.js# Project model (file management)
│   │       ├── fxdataImageEncoder.js # Image encoding for FX data
│   │       └── fxdataSymbols.js# Symbol table + predefined constants
│   │
│   └── ui/                     # DOM-dependent UI layer
│       ├── tabs.js             # TabController — tab switching + localStorage persistence
│       ├── progress.js         # ProgressController — overlay with bar + status text
│       ├── toast.js            # showToast() — notification pop-ups
│       ├── modal.js            # showConfirm() — modal dialogs
│       ├── files.js            # readFileAsArrayBuffer, readFileAsText, downloadBlob, wireFileInput
│       ├── cartEditor.js       # CartEditor class — full FX cart editor (largest UI module)
│       ├── packageEditor.js    # PackageEditor class — .arduboy package editor
│       ├── imageConverter.js   # ImageConverter class — image conversion tool
│       ├── musicEditor.js      # MusicEditor class — piano roll MIDI editor
│       ├── fxdataEditor.js     # FxDataEditor class — FX data DSL editor
│       └── styles/
│           ├── variables.css   # Design tokens (CSS custom properties)
│           ├── main.css        # Global layout, ambient gradient background
│           ├── components.css  # Shared component styles (buttons, cards, panels)
│           └── fxdata.css      # FX data editor-specific styles
│
├── tests/
│   └── fxdata/                 # Vitest unit tests for the FX data subsystem
│       ├── fxdataBuild.test.js
│       ├── fxdataImageEncoder.test.js
│       ├── fxdataParser.test.js
│       ├── fxdataProject.test.js
│       └── fxdataSymbols.test.js
│
├── docs/
│   ├── PROJECT_KNOWLEDGE.md    # Original planning/reference document (1054 lines)
│   ├── ARCHITECTURE.md         # ← This file
│   ├── API_REFERENCE.md        # All public exports with signatures
│   └── MERGE_GUIDE.md          # Integration guide for merging with another project
│
├── ref/                        # Reference codebases (NOT part of build)
│   ├── Arduboy-Python-Utilities/
│   ├── arduboy_toolset/
│   ├── ArduboyWebFlasher/
│   ├── Arduboy-homemade-package/
│   ├── ArduboyPlaytune/
│   ├── ArduboyTones/
│   └── midi2tones/
│
└── .github/workflows/
    └── deploy.yml              # Build + deploy to GitHub Pages on push to main
```

---

## 3. Layered Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  index.html          Single HTML shell with all panel       │
│                      markup inline (no routing/SPA router)  │
├─────────────────────────────────────────────────────────────┤
│  src/main.js         App entry point — wires everything:    │
│                      tab switching, file inputs, device      │
│                      connection, drag-drop routing,          │
│                      action button handlers                  │
├─────────────────────────────────────────────────────────────┤
│  src/ui/*            UI layer — DOM-dependent classes        │
│                      Each feature tab = one class/file       │
│                      Shared: tabs, progress, toast, modal    │
├─────────────────────────────────────────────────────────────┤
│  src/core/*          Pure JS core library — ZERO DOM deps   │
│                      Importable by any JS environment        │
│                      (browser, Node, Web Worker)             │
│                      Organized: serial / formats /           │
│                      operations / utils / music / fxdata     │
└─────────────────────────────────────────────────────────────┘
```

**Critical rule:** `src/core/` has NO `document`, `window`, or DOM references.
The UI layer in `src/ui/` may import from `src/core/`, but never the reverse.

---

## 4. Module Dependency Graph

```
constants.js                   ← no imports (leaf node)
    ↑
utils/binary.js                ← no imports (leaf node)
    ↑
serial/transport.js            ← binary.js (sleep)
    ↑
serial/protocol.js             ← constants.js, binary.js, transport.js
    ↑
serial/device.js               ← constants.js, transport.js, protocol.js, binary.js
    ↑
formats/intelhex.js            ← binary.js
formats/fxcart.js              ← constants.js, binary.js
formats/arduboy.js             ← constants.js, binary.js, fxcart.js  (+ jszip)
formats/image.js               ← constants.js, binary.js
    ↑
operations/sketch.js           ← constants.js, binary.js, protocol.js, intelhex.js
operations/fx.js               ← constants.js, binary.js, protocol.js
operations/eeprom.js           ← constants.js, protocol.js
operations/patch.js            ← constants.js, binary.js
    ↑
music/*                        ← binary.js, noteConstants.js  (+ @tonejs/midi)
fxdata/*                       ← constants.js, binary.js, image.js
    ↑
core/index.js                  ← barrel re-export of ALL above
    ↑
ui/*.js                        ← core/index.js, ui helpers
    ↑
main.js                        ← core/index.js, all ui/*.js, CSS imports
```

---

## 5. UI Architecture

### 5.1 Tab System

The app has 9 tabs (panels) controlled by `TabController`:

| Tab ID | Panel | Controller | File |
|--------|-------|-----------|------|
| `code` | Code Upload | Inline in main.js | — |
| `sketch` | Sketch Manager | Inline in main.js | — |
| `fx` | FX Flash | Inline in main.js | — |
| `eeprom` | EEPROM | Inline in main.js | — |
| `cart` | Cart Editor | `CartEditor` class | `cartEditor.js` |
| `package` | Package Editor | `PackageEditor` class | `packageEditor.js` |
| `image` | Image Converter | `ImageConverter` class | `imageConverter.js` |
| `music` | Music Editor | `MusicEditor` class | `musicEditor.js` |
| `fxdata` | FX Data Editor | `FxDataEditor` class | `fxdataEditor.js` |

Tab state is persisted in `localStorage` under key `activeMainTab`.

### 5.2 Device Connection Flow

```
User clicks connection status area
  → navigator.serial.requestPort() with USB_FILTERS
  → new SerialTransport().setPort(port)
  → transport.open(115200)
  → new ArduboyProtocol(transport)
  → protocol.getIdentifier()  // verify bootloader
  → Connection ready
```

The `protocol` and `transport` variables are module-scoped in `main.js`.
UI editors receive them via `ensureDevice()` callback.

### 5.3 Drag-and-Drop Routing

Files dropped anywhere on the page are routed by extension:

| Extension | Default tab | Also accepted by |
|-----------|------------|------------------|
| `.hex` | sketch | cart |
| `.arduboy` | package | sketch, cart |
| `.bin` | fx | cart, eeprom |
| `.eep` | eeprom | — |
| `.png/.jpg/etc` | image | fxdata |
| `.mid/.midi` | music | — |
| `.txt` | fxdata | — |
| `.zip` | fxdata | — |

If current tab matches a valid destination, it stays; otherwise switches to default.

### 5.4 CSS Architecture

- **No preprocessor** — plain CSS3 with custom properties
- **`variables.css`** — design tokens: `--color-*`, `--spacing-*`, `--radius-*`, glow/glass effects
- **`main.css`** — body layout, ambient gradient `::before`, responsive breakpoints
- **`components.css`** — all shared component styles (buttons, inputs, cards, modals, file pickers, progress overlay)
- **`fxdata.css`** — FX data editor-specific styles (isolated due to size/complexity)
- **Glass/blur effects** throughout using `backdrop-filter` and `hsla()` colors

---

## 6. Data Flow Patterns

### 6.1 Device Operation Pattern

All device operations follow this pattern:

```js
async function handleSomeAction() {
  const proto = await ensureDevice();   // connect if needed
  if (!proto) return;                    // user cancelled

  try {
    progress.show('Title');
    // ... perform operation with proto ...
    progress.hide();
    showToast('Success', 'success');
  } catch (err) {
    progress.hide();
    showToast(`Failed: ${err.message}`, 'error');
  }
}
```

### 6.2 Progress Reporting

Operations accept an `onProgress(fraction)` callback where `fraction` is 0.0–1.0.
The progress controller maps this to a percentage bar and status text.

### 6.3 File I/O Pattern

```
Input:  <input type="file"> change → selectedFiles[key] = file
        OR drag-drop → resolveDropTarget → handleDroppedFile

Output: downloadBlob(blob, filename) — creates temporary <a> and clicks it
```

---

## 7. Conventions

### 7.1 Code Style

- **ES Modules** — `import`/`export` throughout (no CommonJS)
- **JSDoc annotations** — types documented in comments, no TypeScript
- **No framework** — vanilla DOM manipulation (`querySelector`, `addEventListener`, `classList`)
- **Private fields** — `#field` syntax for class encapsulation
- **Async/await** — all I/O operations are async
- **Const-first** — `const` by default, `let` only when mutation needed

### 7.2 Naming

- **Files:** camelCase (`cartEditor.js`, `fxdataBuild.js`)
- **Classes:** PascalCase (`CartEditor`, `SerialTransport`, `ArduboyProtocol`)
- **Functions:** camelCase (`parseIntelHex`, `uploadSketch`, `showToast`)
- **Constants:** UPPER_SNAKE (`FX_PAGESIZE`, `CMD`, `MEM_TYPE`, `USB_FILTERS`)
- **CSS variables:** kebab-case (`--color-primary`, `--spacing-md`)

### 7.3 Error Handling

- Core library functions throw `Error` with descriptive messages
- UI layer catches errors and shows them via `showToast(msg, 'error')`
- Serial timeout errors include byte counts: `"expected N bytes, got M"`

### 7.4 Binary Data

- All binary data uses `Uint8Array`
- Multi-byte values are **big-endian** (matching Arduboy hardware)
- Helper functions in `utils/binary.js`: `readUint16BE`, `writeUint16BE`, `concat`, `padData`
- SHA-256 via Web Crypto API (`crypto.subtle.digest`)

---

## 8. Build & Deploy

### Scripts

| Command | Action |
|---------|--------|
| `npm run dev` | Vite dev server (port 3000, auto-open) |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Preview production build |
| `npm run test` | Vitest in watch mode |
| `npm run test:run` | Vitest single run |
| `npm run lint` | ESLint on `src/` and `tests/` |
| `npm run format` | Prettier on `src/` and `tests/` |

### GitHub Actions

- On push to `main`: checkout → Node 20 → `npm ci` → `npm run build` → deploy `dist/` to GitHub Pages
- Base path: `/Arduboy-Webtools/`

---

## 9. Key Size Metrics

| Metric | Count |
|--------|-------|
| JS source lines (src/) | ~17,300 |
| CSS lines | ~5,700 |
| HTML (index.html) | ~920 lines |
| Test lines | ~914 |
| Source files (src/) | 37 |
| Runtime dependencies | 2 |
| Largest files | `fxdataEditor.js` (3,647), `musicEditor.js` (2,532), `cartEditor.js` (1,928) |
