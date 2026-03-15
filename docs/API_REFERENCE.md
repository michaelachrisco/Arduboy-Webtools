# Arduboy Web Tools — API Reference

> **Purpose:** Complete public API surface of `src/core/` for consumption by
> AI coding agents during project merge/integration. Every exported function,
> class, and constant is documented with its signature, parameters, and return type.

---

## Table of Contents

1. [Constants](#1-constants)
2. [Serial Layer](#2-serial-layer)
3. [Format Parsers](#3-format-parsers)
4. [Device Operations](#4-device-operations)
5. [Binary Utilities](#5-binary-utilities)
6. [Music System](#6-music-system)
7. [FX Data Build System](#7-fx-data-build-system)
8. [UI Helpers](#8-ui-helpers)

---

## 1. Constants

**File:** `src/core/constants.js`

All constants are individually exported. Import via `import { ... } from './core/index.js'`.

### Hardware Constants

| Name | Type | Value | Description |
|------|------|-------|-------------|
| `FLASH_PAGESIZE` | number | 128 | Internal flash SPM page size (bytes) |
| `FLASH_SIZE` | number | 32768 | Total internal flash (32KB) |
| `FLASH_PAGES` | number | 256 | Number of internal flash pages |
| `BOOTLOADER_CATERINA_SIZE` | number | 4096 | Caterina bootloader (4KB) |
| `BOOTLOADER_CATHY_SIZE` | number | 3072 | Cathy3K bootloader (3KB) |
| `APP_SIZE_CATERINA` | number | 28672 | App area w/ Caterina |
| `APP_SIZE_CATHY` | number | 29696 | App area w/ Cathy3K |
| `EEPROM_SIZE` | number | 1024 | EEPROM size (bytes) |
| `SCREEN_WIDTH` | number | 128 | OLED pixels wide |
| `SCREEN_HEIGHT` | number | 64 | OLED pixels tall |
| `SCREEN_BYTES` | number | 1024 | Screen buffer size |
| `FX_PAGESIZE` | number | 256 | FX flash page (bytes) |
| `FX_BLOCKSIZE` | number | 65536 | FX flash block/erase unit (64KB) |
| `FX_PAGES_PER_BLOCK` | number | 256 | Pages per FX block |
| `FX_MAX_PAGES` | number | 65536 | Max pages in 16MB flash |
| `FX_FULL_CART_SIZE` | number | 16777216 | 16MB in bytes |
| `FX_SAVE_ALIGNMENT` | number | 4096 | Save data alignment (4KB) |

### FX Cart Header Constants

| Name | Type | Description |
|------|------|-------------|
| `FX_CART_MAGIC` | Uint8Array(7) | "ARDUBOY" magic bytes |
| `FX_HEADER` | Object | Byte offset map: `MAGIC`, `CATEGORY`, `PREV_PAGE`, `NEXT_PAGE`, `SLOT_SIZE`, `PROGRAM_SIZE`, `PROGRAM_PAGE`, `DATA_PAGE`, `SAVE_PAGE`, `DATA_SIZE`, `HASH`, `META_START` |
| `FX_HEADER_SIZE` | number | 256 |
| `FX_TITLE_SIZE` | number | 1024 |
| `FX_META_MAX_LENGTH` | number | 199 |

### Protocol Constants

| Name | Type | Description |
|------|------|-------------|
| `CMD` | Object | AVR109 command bytes: `GET_IDENTIFIER` (0x53), `GET_VERSION` (0x56), `ENTER_PROGRAMMING` (0x50), `LEAVE_PROGRAMMING` (0x4C), `EXIT_BOOTLOADER` (0x45), `READ_LOCK_BITS` (0x72), `SET_ADDRESS` (0x41), `BLOCK_WRITE` (0x42), `BLOCK_READ` (0x67), `GET_JEDEC_ID` (0x6A), `LED_CONTROL` (0x78), `SELECT_CART_SLOT` (0x54) |
| `MEM_TYPE` | Object | `FLASH` (0x46), `EEPROM` (0x45), `FX` (0x43) |
| `ACK` | number | 0x0D |
| `CATHY3K_MIN_VERSION` | number | 13 |
| `LED` | Object | Individual LED flag bits |
| `LED_PRESET` | Object | `RED_LOCKED`, `BLUE_LOCKED`, `OFF_LOCKED`, `GREEN_ACTIVE`, `OFF_ACTIVE` |
| `USB_FILTERS` | Array | 14 entries of `{usbVendorId, usbProductId}` for Web Serial |
| `DEVICE_TYPE` | Object | `ARDUBOY`, `ARDUBOY_FX`, `ARDUBOY_MINI` |
| `DEVICE_DETECT` | Object | SPI chip-select byte patterns for sketch analysis |
| `JEDEC_MANUFACTURERS` | Object | Manufacturer ID → name map |
| `DRAW_MODE` | Object | Drawing mode constants for FX data build |
| `ARDUBOY_SCHEMA_VERSION` | number | 4 |

### Functions

| Name | Signature | Description |
|------|-----------|-------------|
| `isBootloaderFilter` | `(filter: {usbVendorId, usbProductId}) → boolean` | Check if a USB filter represents bootloader mode |

---

## 2. Serial Layer

### SerialTransport (`src/core/serial/transport.js`)

Web Serial wrapper with buffered exact-length reads.

| Member | Signature | Description |
|--------|-----------|-------------|
| `static isSupported()` | `() → boolean` | Check Web Serial availability |
| `setPort(port)` | `(SerialPort) → void` | Set an already-obtained port |
| `requestPort(filters)` | `(Array<{usbVendorId, usbProductId}>) → Promise<void>` | Trigger browser's port picker |
| `open(baudRate, bufferSize?)` | `(number, number=65536) → Promise<void>` | Open serial port |
| `close()` | `() → Promise<void>` | Close port and release resources |
| `write(data)` | `(Uint8Array) → Promise<void>` | Write bytes |
| `read(length, timeout?)` | `(number, number=5000) → Promise<Uint8Array>` | Read exact byte count (buffered) |
| `writeAndRead(data, responseLength?, timeout?)` | `(Uint8Array, number=1, number=5000) → Promise<Uint8Array>` | Command-response pattern |
| `get isOpen` | `→ boolean` | Connection state |
| `getPortInfo()` | `() → {usbVendorId?, usbProductId?} \| null` | USB port info |
| `triggerBootloaderReset()` | `() → Promise<void>` | 1200-baud reset trick |

### ArduboyProtocol (`src/core/serial/protocol.js`)

AVR109/Caterina bootloader command layer.

| Member | Signature | Description |
|--------|-----------|-------------|
| `constructor(transport)` | `(SerialTransport)` | Wrap an open transport |
| `getIdentifier()` | `() → Promise<string>` | 'S' → "ARDUBOY" or "CATERINA" |
| `getVersion()` | `() → Promise<number>` | 'V' → version integer |
| `supportsFx()` | `() → Promise<boolean>` | Version ≥ 13? |
| `enterProgramming()` | `() → Promise<void>` | 'P' command |
| `leaveProgramming()` | `() → Promise<void>` | 'L' command |
| `exitBootloader()` | `() → Promise<void>` | 'E' command (fire-and-forget) |
| `setAddress(address)` | `(number) → Promise<void>` | 'A' + 2 bytes |
| `setFlashPage(page)` | `(number) → Promise<void>` | Set address for internal flash page |
| `setFxPage(page)` | `(number) → Promise<void>` | Set address for FX flash page |
| `blockWrite(memType, data)` | `(number, Uint8Array) → Promise<void>` | 'B' write |
| `blockRead(memType, length)` | `(number, number) → Promise<Uint8Array>` | 'g' read |
| `readLockBits()` | `() → Promise<number>` | 'r' → lock bits byte |
| `getJedecId()` | `() → Promise<JedecInfo>` | 'j' → flash chip info |
| `setLed(flags)` | `(number) → Promise<void>` | 'x' LED/button control |
| `selectCartSlot(slot)` | `(number) → Promise<void>` | 'T' for >16MB flash |
| `writeFlashPage(pageIndex, pageData)` | `(number, Uint8Array(128)) → Promise<void>` | Convenience: set addr + write |
| `readFlashPage(pageIndex)` | `(number) → Promise<Uint8Array(128)>` | Convenience: set addr + read |
| `writeFxBlock(blockIndex, blockData)` | `(number, Uint8Array) → Promise<void>` | Write 64KB FX block |
| `readFxBlock(blockIndex)` | `(number) → Promise<Uint8Array(65536)>` | Read 64KB FX block |
| `readFxPages(page, length)` | `(number, number) → Promise<Uint8Array>` | Read N bytes from FX page |

**JedecInfo type:** `{ manufacturerId, manufacturer, deviceType, capacityId, capacity, raw: Uint8Array(3) }`

### DeviceManager (`src/core/serial/device.js`)

USB discovery and connection management.

| Member | Signature | Description |
|--------|-----------|-------------|
| `get transport` | `→ SerialTransport` | Underlying transport |
| `get protocol` | `→ ArduboyProtocol \| null` | Active protocol |
| `get deviceInfo` | `→ DeviceInfo \| null` | Cached device info |
| `get isConnected` | `→ boolean` | Connection state |
| `connect(options?)` | `({enterBootloader?, baudRate?}) → Promise<DeviceInfo>` | Full connection flow |
| `disconnect()` | `() → Promise<void>` | Disconnect + exit bootloader |
| `closePort()` | `() → Promise<void>` | Close without exiting bootloader |

**DeviceInfo type:** `{ type, bootloaderVersion, identifier, hasFx, jedec: JedecInfo|null }`

---

## 3. Format Parsers

### Intel HEX (`src/core/formats/intelhex.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `parseIntelHex` | `(hexString: string, maxSize?: number = 32768) → ParsedHex` | Parse Intel HEX → binary. `ParsedHex = { data: Uint8Array, pageUsed: boolean[], startAddress, dataLength }` |
| `generateIntelHex` | `(data: Uint8Array, bytesPerLine?: number = 16) → string` | Binary → Intel HEX string |

### FX Cart (`src/core/formats/fxcart.js`)

| Export | Signature | Description |
|--------|-----------|-------------|
| `FxParsedSlot` (class) | `new ({category?, imageRaw?, programRaw?, dataRaw?, saveRaw?, meta?})` | Slot data model. Getters: `isCategory`, `fxEnabled` |
| `isSlotHeader` | `(data, offset?) → boolean` | Check magic bytes at offset |
| `getSlotSizeBytes` | `(header: Uint8Array) → number` | Slot size from 256-byte header |
| `parseFxCart` | `(fullData: Uint8Array) → FxParsedSlot[]` | Parse full cart binary |
| `compileFxCart` | `(slots: FxParsedSlot[]) → Promise<Uint8Array>` | Compile slots to binary |
| `trimFxCart` | `(fullData: Uint8Array) → Uint8Array` | Remove trailing empty data |
| `scanFxCartHeaders` | `(fullData: Uint8Array) → {count, categories, games, totalPages, slots}` | Fast header-only scan |

**FxSlotMeta type:** `{ title, version, developer, info }` (all strings)

### .arduboy Package (`src/core/formats/arduboy.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `readArduboyFile` | `(fileData: File\|Blob\|ArrayBuffer, filename?) → Promise<ArduboyPackage>` | Read .arduboy ZIP (v2/v3/v4) |
| `writeArduboyFile` | `(pkg: ArduboyPackage) → Promise<Blob>` | Write .arduboy ZIP (always v4) |
| `fixJSON` | `(jsonString: string) → string` | Fix trailing commas in JSON |

**ArduboyPackage type:** `{ originalFilename, schemaVersion, title, version, author, description, license, date, genre, url, sourceUrl, email, companion, contributors: ArduboyContributor[], binaries: ArduboyBinary[] }`

**ArduboyBinary type:** `{ device, title, hexFilename, hexRaw: string, dataRaw: Uint8Array, saveRaw: Uint8Array, cartImage, cartImageFilename }`

### Image Conversion (`src/core/formats/image.js`)

| Export | Signature | Description |
|--------|-----------|-------------|
| `OUTPUT_FORMAT` | Object | Format constants: `DRAW_BITMAP`, `DRAW_SLOW_XY`, `SPRITES_OVERWRITE`, `SPRITES_EXT_MASK`, `SPRITES_PLUS_MASK` |
| `screenToImageData` | `(bytes: Uint8Array) → ImageData` | 1024 bytes → 128x64 RGBA ImageData |
| `imageDataToScreen` | `(imageData: ImageData) → Uint8Array` | ImageData → 1024-byte screen buffer |
| `screenToDataURL` | `(bytes: Uint8Array, scale?) → string` | Screen buffer → data:image/png URL |
| `loadImageFile` | `(file: File\|Blob) → Promise<ImageData>` | Load image, resize to 128x64 |
| `loadImageFileOriginal` | `(file: File\|Blob) → Promise<ImageData>` | Load image, preserve original size |
| `convertImage` | `(imageData, name, config: TileConfig) → ConvertedImage` | Image → C++ code + FX binary |
| `convertImageFormat` | `(imageData, name, config: ImageConvertConfig) → {...}` | Image → specific Arduboy format |
| `generateUsageSnippet` | `(name, format, fw, fh, frameCount) → string` | Generate Arduboy2 draw call |
| `generateFullSketch` | `(name, format, fw, fh, code, usageSnippet, frameCount?) → string` | Generate complete .ino sketch |

---

## 4. Device Operations

### Sketch (`src/core/operations/sketch.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `analyzeSketch` | `(input: string\|Uint8Array) → SketchAnalysis` | Analyze hex for upload safety |
| `uploadSketch` | `(protocol, hexData, opts?) → Promise<{success, message}>` | Upload .hex to internal flash |
| `backupSketch` | `(protocol, opts?) → Promise<Uint8Array>` | Read back sketch from flash |
| `eraseSketch` | `(protocol, opts?) → Promise<{success, message}>` | Clear first flash page |

Options: `{ verify?: boolean, onProgress?: (frac: 0..1) => void, onStatus?: (msg: string) => void, includeBootloader?: boolean }`

### FX Flash (`src/core/operations/fx.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `writeFx` | `(protocol, data, startPage?, opts?) → Promise<{success, message}>` | Write to external flash |
| `backupFx` | `(protocol, opts?) → Promise<Uint8Array>` | Backup FX flash |
| `scanFx` | `(protocol, opts?) → Promise<{slotCount, categories, games, totalPages}>` | Scan cart headers |
| `writeFxDev` | `(protocol, data, save?, opts?) → Promise<{success, dataPage, savePage}>` | Write dev FX data to flash end |

Options: `{ verify?, maxPages?, onProgress?, onStatus? }`

### EEPROM (`src/core/operations/eeprom.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `readEeprom` | `(protocol, opts?) → Promise<Uint8Array(1024)>` | Read 1KB EEPROM |
| `writeEeprom` | `(protocol, data: Uint8Array(1024), opts?) → Promise<void>` | Write 1KB EEPROM |
| `eraseEeprom` | `(protocol, opts?) → Promise<void>` | Fill EEPROM with 0xFF |

### Patching (`src/core/operations/patch.js`)

All patch functions operate **in-place** on the provided Uint8Array.

| Function | Signature | Description |
|----------|-----------|-------------|
| `patchSSD1309` | `(flashData: Uint8Array) → {success, count, message}` | Patch charge pump for SSD1309 displays |
| `patchContrast` | `(flashData: Uint8Array, contrast: number) → {success, count, message}` | Patch brightness byte |
| `patchMicroLed` | `(flashData: Uint8Array) → {success, count, message}` | Swap SBI/CBI for Micro LED polarity |
| `patchFxPages` | `(program, dataPage, savePage) → void` | Patch FX page addresses into program |
| `patchMenuButtons` | `(program: Uint8Array) → {success, message}` | Menu button patch (stub) |
| `CONTRAST_PRESETS` | Object | `{ MAX: 0xcf, NORMAL: 0x7f, DIM: 0x3f, DIMMER: 0x1f, DIMMEST: 0x00 }` |

---

## 5. Binary Utilities

**File:** `src/core/utils/binary.js`

| Function | Signature | Description |
|----------|-----------|-------------|
| `concat` | `(...arrays: Uint8Array[]) → Uint8Array` | Concatenate typed arrays |
| `padData` | `(data, alignment, padByte?) → Uint8Array` | Pad to alignment boundary |
| `padSize` | `(length, alignment) → number` | Padding bytes needed |
| `byteBit` | `(byte, pos) → 0\|1` | Extract single bit |
| `intToHex` | `(value, hexChars) → string` | Fixed-width hex string |
| `readUint16BE` | `(data, offset) → number` | Read big-endian uint16 |
| `writeUint16BE` | `(data, offset, value) → void` | Write big-endian uint16 |
| `readUint24BE` | `(data, offset) → number` | Read big-endian uint24 |
| `writeUint24BE` | `(data, offset, value) → void` | Write big-endian uint24 |
| `countUnusedPages` | `(data, pageSize?) → number` | Count trailing 0xFF pages |
| `isEmpty` | `(data, offset?, length?) → boolean` | Check if region is all 0xFF |
| `arraysEqual` | `(a, b) → boolean` | Compare two Uint8Arrays |
| `filledArray` | `(length, fillByte?) → Uint8Array` | Create filled Uint8Array |
| `sha256` | `(data: Uint8Array) → Promise<Uint8Array(32)>` | SHA-256 via Web Crypto |
| `encodeString` | `(str) → Uint8Array` | UTF-8 encode |
| `decodeString` | `(data) → string` | UTF-8 decode |
| `sleep` | `(ms) → Promise<void>` | Async delay |

---

## 6. Music System

### Song Model (`src/core/music/songModel.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `nextNoteId` | `() → number` | Auto-incrementing note ID |
| `advanceNoteIdCounter` | `(minValue: number) → void` | Sync ID counter after restore |
| `createSong` | `(opts?) → Song` | New song (PPQ 480, 120 BPM, 4/4) |
| `createNote` | `(noteNumber, startTick, endTick, velocity?) → Note` | Create note with unique ID |
| `tickToMs` | `(tick, tempoMap, ppq) → number` | Tick → milliseconds |
| `msToTick` | `(ms, tempoMap, ppq) → number` | Milliseconds → tick |
| `getSongEndTick` | `(song) → number` | Last tick in song |
| `quantizeTick` | `(tick, ppq, division) → number` | Snap to grid |
| `scaleTempo` | `(song, factor) → void` | Scale all tempos (mutates) |
| `sortNotes` | `(notes) → Note[]` | Sort by startTick, noteNumber |
| `findOverlaps` | `(track) → [{a, b}]` | Find overlapping note pairs |
| `resolveOverlaps` | `(track) → void` | Truncate overlaps (mutates) |

### Note Constants (`src/core/music/noteConstants.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `midiNoteToFreq` | `(noteNumber) → number` | MIDI → ArduboyTones Hz |
| `clampFreq` | `(hz) → number` | Clamp to 16-32767 Hz |
| `midiNoteToConstant` | `(noteNumber) → string` | MIDI → "NOTE_C5" |
| `midiNoteToConstantH` | `(noteNumber) → string` | MIDI → "NOTE_C5H" (high volume) |
| `midiNoteToName` | `(noteNumber) → string` | MIDI → "C5" |
| `isBlackKey` | `(noteNumber) → boolean` | Is sharp/flat? |
| `freqToConstant` | `(hz) → string` | Hz → closest NOTE_* |

### MIDI Import (`src/core/music/midiImport.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `parseMidiFile` | `(buffer: ArrayBuffer) → {midi, summary}` | Parse MIDI + track summaries |
| `midiToSong` | `(midi, opts) → Song` | MIDI → internal song model |

Options: `{ trackIndices: number[], targetLibrary: 'tones' | 'playtune' }`

### Export — ArduboyTones (`src/core/music/exportTones.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `exportArduboyTones` | `(song, opts?) → {code, exampleCode, exampleCodeFull, warnings, byteCount}` | Song → ArduboyTones C++ code |

Options: `{ arrayName?: 'song', useConstants?: true, highVolumeThreshold?: 96 }`

### Export — ArduboyPlaytune (`src/core/music/exportPlaytune.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `exportArduboyPlaytune` | `(song, opts?) → {code, exampleCode, exampleCodeFull, warnings, byteCount}` | Song → ArduboyPlaytune C++ code |

Options: `{ arrayName?: 'score' }`

---

## 7. FX Data Build System

### Parser (`src/core/fxdata/fxdataParser.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `parseFxData` | `(sourceText, filename, callbacks, options?) → Promise<ParseResult>` | Parse FX data DSL → binary + symbols + header |

Callbacks: `{ resolveInclude(path, fromFile) → string|null, resolveImage(path, fromFile, options) → Promise<{bytes, width, height, frames, hasTransparency}>, resolveRaw(path, fromFile) → Uint8Array|null }`

ParseResult: `{ bytes, symbols, headerLines, saveStart, diagnostics, memoryMap }`

### Builder (`src/core/fxdata/fxdataBuild.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `buildFxData` | `(project: FxDataProject, entryFile, options?) → Promise<BuildResult>` | Build FX data from project |

BuildResult: `{ success, dataBin, saveBin, devBin, header, diagnostics, memoryMap, symbols, dataSize, saveSize, dataPages, savePages, fxDataPage, fxSavePage }`

### Project Model (`src/core/fxdata/fxdataProject.js`)

`FxDataProject` class — virtual in-memory filesystem.

| Method | Signature | Description |
|--------|-----------|-------------|
| `addFile` | `(path, data) → void` | Add/update file |
| `getFile` | `(path) → ProjectFile\|undefined` | Get file entry |
| `getTextFile` | `(path) → string\|undefined` | Get as string |
| `getBinaryFile` | `(path) → Uint8Array\|undefined` | Get as binary |
| `removeFile` | `(path) → boolean` | Remove file |
| `hasFile` | `(path) → boolean` | Check existence |
| `listFiles` | `() → string[]` | All paths (sorted) |
| `listByExtension` | `(ext) → string[]` | Filter by extension |
| `clear` | `() → void` | Remove all files |
| `get size` | `→ number` | File count |
| `resolvePath` | `(relativePath, fromFile) → string` | Resolve relative path |
| `importFromZip` | `(zipData) → Promise<void>` | Import from ZIP |
| `exportToZip` | `() → Promise<Blob>` | Export as ZIP |
| `importFromFiles` | `(fileList) → Promise<void>` | Import from FileList |
| `importImageFile` | `(file) → Promise<string>` | Import single image |
| `serialize` | `() → Object` | JSON-safe serialization |
| `deserialize` | `(data) → void` | Restore from serialized |

### Image Encoder (`src/core/fxdata/fxdataImageEncoder.js`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `parseDimensionsFromFilename` | `(filename) → {width, height, spacing}` | Parse `NAME_WxH_S.ext` convention |
| `encodeFxImage` | `(imageData, filename, options?) → {bytes, width, height, frames, hasTransparency}` | Encode image for FX binary |
| `getImageConstantNames` | `(label, frames) → {widthName, heightName, framesName, framesType}` | Naming convention for constants |
| `loadImageFromBytes` | `(data: Uint8Array) → Promise<ImageData>` | Raw bytes → ImageData (browser) |

### Symbol Table (`src/core/fxdata/fxdataSymbols.js`)

| Export | Signature | Description |
|--------|-----------|-------------|
| `FX_PREDEFINED_CONSTANTS` | Map<string, number> | 44 predefined drawing-mode constants |
| `SymbolTable` (class) | — | Symbol table for FX data build |

SymbolTable methods: `define(name, value, file?, line?)`, `resolve(name)`, `has(name)`, `getUserSymbols()`, `getAll()`, `reset()`

---

## 8. UI Helpers

These are not part of `src/core/` but are documented for completeness.

### Shared Utilities (`src/ui/`)

| Module | Export | Signature | Description |
|--------|--------|-----------|-------------|
| `tabs.js` | `TabController` | class | Tab switching w/ localStorage persistence |
| `progress.js` | `ProgressController` | class | Progress overlay bar |
| `toast.js` | `showToast` | `(message, type?, duration?) → void` | Pop-up notifications: `'success'`, `'error'`, `'warning'`, `'info'` |
| `modal.js` | `showConfirm` | `(message) → Promise<boolean>` | Confirmation dialog |
| `files.js` | `readFileAsArrayBuffer` | `(file) → Promise<ArrayBuffer>` | File → ArrayBuffer |
| `files.js` | `readFileAsText` | `(file) → Promise<string>` | File → string |
| `files.js` | `downloadBlob` | `(blob, filename) → void` | Trigger browser download |
| `files.js` | `wireFileInput` | `(input, callback) → void` | Wire change handler |

### Feature Editors (`src/ui/`)

| Class | File | Description |
|-------|------|-------------|
| `CartEditor` | `cartEditor.js` | FX flash cart editor (drag-drop reorder, categories, import/export) |
| `PackageEditor` | `packageEditor.js` | .arduboy package metadata editor |
| `ImageConverter` | `imageConverter.js` | Image → Arduboy binary/code converter |
| `MusicEditor` | `musicEditor.js` | Piano roll MIDI editor with playback + C++ export |
| `FxDataEditor` | `fxdataEditor.js` | FX data DSL editor with live build |

All editors are instantiated in `main.js` and operate on DOM elements defined in `index.html`.
