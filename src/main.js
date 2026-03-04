/**
 * Arduboy Web Tools — Application entry point.
 *
 * Wires up the UI shell: tab switching, file inputs, device connection,
 * action buttons, and progress overlay.
 */

// Styles (Vite CSS pipeline)
import './ui/styles/variables.css';
import './ui/styles/main.css';
import './ui/styles/components.css';

// UI helpers
import { TabController } from './ui/tabs.js';
import { ProgressController } from './ui/progress.js';
import { showToast } from './ui/toast.js';
import { showConfirm } from './ui/modal.js';
import { readFileAsArrayBuffer, readFileAsText, downloadBlob, wireFileInput } from './ui/files.js';
import { CartEditor } from './ui/cartEditor.js';
import { PackageEditor } from './ui/packageEditor.js';
import { ImageConverter } from './ui/imageConverter.js';
import { MusicEditor } from './ui/musicEditor.js';

// Core library
import {
  USB_FILTERS,
  FX_BLOCKSIZE, FX_PAGESIZE, FX_MAX_PAGES,
  SerialTransport,
  ArduboyProtocol,
  DeviceManager,
  parseIntelHex,
  readArduboyFile,
  uploadSketch,
  backupSketch,
  generateIntelHex,
  eraseSketch,
  writeFx,
  backupFx,
  scanFx,
  readEeprom,
  writeEeprom,
  eraseEeprom,
  patchSSD1309,
  padData,
  concat,
  scanFxCartHeaders,
} from './core/index.js';

// ---------------------------------------------------------------------------
// Feature detect
// ---------------------------------------------------------------------------

if (!('serial' in navigator)) {
  document.getElementById('panels').innerHTML = `
    <div class="panel active" style="text-align:center; padding: 4rem 2rem;">
      <h2>Browser Not Supported</h2>
      <p class="panel-description">
        This application requires the <strong>Web Serial API</strong>.<br>
        Please use <a href="https://www.google.com/chrome/">Google Chrome</a> or
        <a href="https://www.microsoft.com/edge">Microsoft Edge</a> (desktop) version 89+.
      </p>
    </div>`;
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------------------------------------------------------------------
// Tab Controller
// ---------------------------------------------------------------------------

const tabs = new TabController(
  $$('.tab-btn'),
  $$('.panel'),
  'active',
  'panel',
);
// Activate default tab
tabs.activate('sketch');

// ---------------------------------------------------------------------------
// Progress Controller
// ---------------------------------------------------------------------------

const progress = new ProgressController(
  $('#progress-overlay'),
  $('#progress-bar'),
  $('#progress-status'),
  $('#progress-percent'),
  $('#progress-title'),
);

// ---------------------------------------------------------------------------
// Device Manager
// ---------------------------------------------------------------------------

const device = new DeviceManager();

/** @type {ArduboyProtocol|null} */
let protocol = null;

function setConnectionStatus(state, text) {
  const dot = $('.status-dot');
  const label = $('.status-text');
  const resetBtn = $('#btn-reset');
  dot.className = `status-dot ${state}`;
  label.textContent = text;
  if (resetBtn) resetBtn.disabled = state !== 'connected';
}

/** @type {SerialTransport|null} */
let transport = null;

async function connectDevice() {
  try {
    setConnectionStatus('connecting', 'Connecting...');
    const port = await navigator.serial.requestPort({ filters: USB_FILTERS });
    transport = new SerialTransport();
    transport.setPort(port);
    await transport.open(115200);

    protocol = new ArduboyProtocol(transport);

    // Verify we're talking to an Arduboy bootloader
    const id = await protocol.getIdentifier();
    setConnectionStatus('connected', `Connected (${id})`);
    showToast(`Device connected: ${id}`, 'success');
    return protocol;
  } catch (err) {
    setConnectionStatus('disconnected', 'No device');
    if (transport) {
      try { await transport.close(); } catch { /* ignore */ }
      transport = null;
    }
    protocol = null;
    if (err.name !== 'NotFoundError') {
      showToast(`Connection failed: ${err.message}`, 'error');
      console.error(err);
    }
    return null;
  }
}

async function ensureDevice() {
  if (protocol) return protocol;
  return connectDevice();
}

async function disconnectDevice() {
  protocol = null;
  if (transport) {
    try { await transport.close(); } catch { /* ignore */ }
    transport = null;
  }
  setConnectionStatus('disconnected', 'No device');
}

// Connect on status area click
$('#connection-status').addEventListener('click', async () => {
  if (protocol) {
    await disconnectDevice();
    showToast('Disconnected', 'info');
  } else {
    await connectDevice();
  }
});

// Reset button — uses the active transport's port to do a 1200-baud reset
$('#btn-reset')?.addEventListener('click', async () => {
  if (!transport) {
    showToast('No device connected', 'warning');
    return;
  }
  try {
    showToast('Resetting device...', 'info');
    setConnectionStatus('connecting', 'Resetting...');
    protocol = null;
    await transport.triggerBootloaderReset();
    transport = null;
    setConnectionStatus('disconnected', 'No device');
    showToast('Device reset — reconnect when bootloader is ready', 'success');
  } catch (err) {
    setConnectionStatus('disconnected', 'No device');
    transport = null;
    protocol = null;
    showToast(`Reset failed: ${err.message}`, 'error');
    console.error(err);
  }
});

// ---------------------------------------------------------------------------
// Selected files cache
// ---------------------------------------------------------------------------

/** @type {Record<string, File>} */
const selectedFiles = {};

function onFileSelected(key) {
  return (file) => { selectedFiles[key] = file; };
}

// Wire file inputs
const sketchInput = $('#sketch-file');
const fxInput = $('#fx-file');
const eepromInput = $('#eeprom-file');

if (sketchInput) {
  sketchInput.addEventListener('change', () => {
    const file = sketchInput.files?.[0];
    if (file) {
      selectedFiles['sketch'] = file;
      const label = $('label[for="sketch-file"]');
      if (label) { label.textContent = file.name; label.classList.add('has-file'); }
      // Show upload controls when file is selected
      const controls = $('#sketch-upload-controls');
      if (controls) { controls.classList.remove('hidden'); }
    }
  });
}

if (fxInput) {
  fxInput.addEventListener('change', async () => {
    const file = fxInput.files?.[0];
    if (file) {
      selectedFiles['fx'] = file;
      const label = $('label[for="fx-file"]');
      if (label) { label.textContent = file.name; label.classList.add('has-file'); }

      // Show write controls when file is selected
      const controls = $('#fx-write-controls');
      if (controls) { controls.classList.remove('hidden'); }

      // Scan the .bin file locally and show cart info
      try {
        const buffer = await readFileAsArrayBuffer(file);
        const data = new Uint8Array(buffer);
        const info = scanFxCartHeaders(data);

        if (info.count > 0) {
          $('#file-scan-slots').textContent = info.count;
          $('#file-scan-games').textContent = info.games;
          $('#file-scan-categories').textContent = info.categories;
          $('#file-scan-pages').textContent = info.totalPages.toLocaleString();
          const sizeKB = data.length / 1024;
          $('#file-scan-size').textContent = sizeKB >= 1024
            ? `${(sizeKB / 1024).toFixed(1)} MB`
            : `${sizeKB.toFixed(0)} KB`;
          $('#fx-file-info')?.classList.remove('hidden');
        } else {
          // Not a valid cart (maybe raw FX data) — hide the info
          $('#fx-file-info')?.classList.add('hidden');
        }
      } catch {
        $('#fx-file-info')?.classList.add('hidden');
      }
    }
  });
}

if (eepromInput) {
  eepromInput.addEventListener('change', () => {
    const file = eepromInput.files?.[0];
    if (file) {
      selectedFiles['eeprom'] = file;
      const label = $('label[for="eeprom-file"]');
      if (label) { label.textContent = file.name; label.classList.add('has-file'); }
      // Show restore button when file is selected
      const btn = $('#btn-eeprom-restore');
      if (btn) { btn.classList.remove('hidden'); btn.style.display = ''; }
    }
  });
}

// ---------------------------------------------------------------------------
// Sketch actions
// ---------------------------------------------------------------------------

async function handleSketchUpload() {
  const file = selectedFiles['sketch'];
  if (!file) { showToast('Select a .hex or .arduboy file first', 'warning'); return; }

  const proto = await ensureDevice();
  if (!proto) return;

  try {
    progress.show('Uploading');
    const buffer = await readFileAsArrayBuffer(file);
    const data = new Uint8Array(buffer);
    const verify = $('#sketch-verify')?.checked ?? true;
    const ssd1309 = $('#sketch-patch-ssd1309')?.checked ?? false;
    const onProgress = (frac) => progress.update(frac * 100);

    if (file.name.endsWith('.arduboy')) {
      // ---- .arduboy file: extract hex + FX data from ZIP, flash both ----
      await handleArduboyUpload(proto, data, file.name, verify, ssd1309, onProgress);
    } else if (file.name.endsWith('.hex')) {
      // ---- Plain .hex file ----
      const text = new TextDecoder().decode(data);
      let sketchInput;
      if (ssd1309) {
        const parsed = parseIntelHex(text);
        const patchResult = patchSSD1309(parsed.data);
        if (!patchResult.success) {
          showToast(patchResult.message, 'warning');
        }
        sketchInput = parsed.data;
      } else {
        sketchInput = text;
      }
      const result = await uploadSketch(proto, sketchInput, { verify, onProgress });
      await progress.finish();
      showToast(result.success ? result.message : result.message, result.success ? 'success' : 'error');
      if (result.success) await disconnectDevice();
      return;
    } else {
      // ---- Raw .bin treated as sketch binary ----
      const result = await uploadSketch(proto, data, { verify, onProgress });
      await progress.finish();
      showToast(result.success ? result.message : result.message, result.success ? 'success' : 'error');
      if (result.success) await disconnectDevice();
      return;
    }
  } catch (err) {
    progress.hide();
    showToast(`Upload failed: ${err.message}`, 'error');
    console.error(err);
  }
}

/**
 * Handle .arduboy file upload:
 * 1. Extract hex, FX data, FX save from the ZIP
 * 2. If FX data exists, pad and write it to the end of the external flash
 * 3. Flash the hex to internal flash
 *
 * Mirrors the ArduboyWebFlasher's loadFile() + flashArduboy() flow.
 */
async function handleArduboyUpload(proto, data, filename, verify, ssd1309, onProgress) {
  progress.update(0, 'Extracting .arduboy package...');

  const pkg = await readArduboyFile(data, filename);
  if (!pkg.binaries || pkg.binaries.length === 0) {
    progress.hide();
    showToast('No binaries found in .arduboy file', 'error');
    return;
  }

  const bin = pkg.binaries[0];
  const hexRaw = bin.hexRaw;
  if (!hexRaw) {
    progress.hide();
    showToast('No hex data found in .arduboy file', 'error');
    return;
  }

  // Build combined FX dev data (data + save), same as WebFlasher's loadFile()
  let devData = null;
  if (bin.dataRaw && bin.dataRaw.length > 0) {
    let flashData = padData(bin.dataRaw, FX_PAGESIZE); // pad to 256-byte multiple
    devData = flashData;

    if (bin.saveRaw && bin.saveRaw.length > 0) {
      const saveData = padData(bin.saveRaw, 4096); // pad save to 4KB multiple
      devData = concat(flashData, saveData);
    }

    // Pad to block boundary from the front (so data aligns to end of flash)
    // Same as WebFlasher's padDataToBlockSize — prepend 0xFF padding
    const remainder = devData.length % FX_BLOCKSIZE;
    if (remainder !== 0) {
      const paddingSize = FX_BLOCKSIZE - remainder;
      const padded = new Uint8Array(paddingSize + devData.length).fill(0xFF);
      padded.set(devData, paddingSize);
      devData = padded;
    }
  }

  // Step 1: Write FX data (if present) to end of external flash
  if (devData) {
    const devBlocks = devData.length / FX_BLOCKSIZE;
    const FX_BLOCKS_TOTAL = 256; // 16MB / 64KB
    const blockStartAddr = FX_BLOCKS_TOTAL - devBlocks;

    progress.update(0, `Writing ${devBlocks} FX blocks...`);

    for (let block = 0; block < devBlocks; block++) {
      const writeBlock = blockStartAddr + block;
      const blockPage = writeBlock * (FX_BLOCKSIZE / FX_PAGESIZE);
      const blockData = devData.slice(block * FX_BLOCKSIZE, (block + 1) * FX_BLOCKSIZE);

      // Set address and write entire 64KB block (same as WebFlasher's flashBlock)
      await proto.setFxPage(blockPage);
      await proto.blockWrite(0x43, blockData); // 'C' = FX memory type

      const totalSteps = devBlocks + 10; // rough: FX blocks + hex pages placeholder
      onProgress?.((block + 1) / totalSteps);
    }
  }

  // Step 2: Flash the hex to internal flash
  progress.update(devData ? 80 : 0, 'Writing sketch...');
  let sketchInput = hexRaw;
  if (ssd1309) {
    const parsed = parseIntelHex(hexRaw);
    const patchResult = patchSSD1309(parsed.data);
    if (!patchResult.success) {
      showToast(patchResult.message, 'warning');
    }
    sketchInput = parsed.data;
  }

  const result = await uploadSketch(proto, sketchInput, {
    verify,
    onProgress: (frac) => {
      const base = devData ? 80 : 0;
      progress.update(base + frac * (100 - base));
    },
  });

  await progress.finish();
  if (result.success) {
    showToast(`${pkg.title || filename} uploaded successfully!`, 'success');
    await disconnectDevice();
  } else {
    showToast(result.message, 'error');
  }
}

async function handleSketchBackup() {
  const proto = await ensureDevice();
  if (!proto) return;

  try {
    progress.show('Backing Up Sketch');
    const data = await backupSketch(proto, { onProgress: progress.callback() });
    progress.hide();
    const hexString = generateIntelHex(data);
    const blob = new Blob([hexString], { type: 'text/plain' });
    downloadBlob(blob, 'arduboy-sketch-backup.hex');
    showToast('Sketch backed up', 'success');
  } catch (err) {
    progress.hide();
    showToast(`Backup failed: ${err.message}`, 'error');
    console.error(err);
  }
}

async function handleSketchErase() {
  if (!await showConfirm('This will erase the game on your Arduboy. Continue?')) return;

  const proto = await ensureDevice();
  if (!proto) return;

  try {
    progress.show('Erasing Sketch');
    await eraseSketch(proto, { onProgress: progress.callback() });
    progress.hide();
    showToast('Sketch erased', 'success');
  } catch (err) {
    progress.hide();
    showToast(`Erase failed: ${err.message}`, 'error');
    console.error(err);
  }
}

$('#btn-sketch-upload')?.addEventListener('click', handleSketchUpload);
$('#btn-sketch-backup')?.addEventListener('click', handleSketchBackup);
$('#btn-sketch-erase')?.addEventListener('click', handleSketchErase);

// ---------------------------------------------------------------------------
// FX actions
// ---------------------------------------------------------------------------

async function handleFxWrite() {
  const file = selectedFiles['fx'];
  if (!file) { showToast('Select a .bin flash image first', 'warning'); return; }

  const proto = await ensureDevice();
  if (!proto) return;

  try {
    progress.show('Writing FX Flash');
    const buffer = await readFileAsArrayBuffer(file);
    const data = new Uint8Array(buffer);
    const verify = $('#fx-verify')?.checked ?? false;
    const ssd1309 = $('#fx-patch-ssd1309')?.checked ?? false;

    // Apply SSD1309 display patch to all games in the flash image
    if (ssd1309) {
      progress.update(0, 'Applying SSD1309 patch...');
      const patchResult = patchSSD1309(data);
      if (patchResult.success) {
        showToast(patchResult.message, 'info');
      } else {
        showToast(patchResult.message, 'warning');
      }
    }

    await writeFx(proto, data, 0, {
      verify,
      onProgress: (frac) => progress.update(frac * 100),
      onStatus: (msg) => progress.update(undefined, msg),
    });
    progress.hide();
    showToast('FX Flash written successfully!', 'success');
  } catch (err) {
    progress.hide();
    showToast(`FX write failed: ${err.message}`, 'error');
    console.error(err);
  }
}

async function handleFxBackup() {
  const proto = await ensureDevice();
  if (!proto) return;

  const cartOnly = $('#fx-cart-only')?.checked ?? false;

  try {
    progress.show('Backing Up FX Flash');

    // Always scan first to show cart info during download
    progress.update(0, 'Scanning cart headers...');
    const scan = await scanFx(proto, {
      onProgress: (frac) => progress.update(frac * 5, 'Scanning cart headers...'),
    });

    // Populate the scan results panel
    $('#scan-slots').textContent = scan.slotCount;
    $('#scan-games').textContent = scan.games;
    $('#scan-categories').textContent = scan.categories;
    $('#scan-pages').textContent = scan.totalPages.toLocaleString();
    const usedBytes = scan.totalPages * 256;
    const usedKB = usedBytes / 1024;
    $('#scan-size').textContent = usedKB >= 1024
      ? `${(usedKB / 1024).toFixed(1)} MB`
      : `${usedKB.toFixed(0)} KB`;
    $('#fx-scan-results')?.classList.remove('hidden');

    // Build status summary to show during download
    const cartInfo = `${scan.games} games, ${scan.categories} categories`;
    const downloadPages = cartOnly ? scan.totalPages : FX_MAX_PAGES;
    const downloadMB = (downloadPages * 256 / 1024 / 1024).toFixed(1);
    const modeLabel = cartOnly ? `cart data (${downloadMB}MB)` : `full flash (16MB)`;

    progress.update(5, `Downloading ${modeLabel} — ${cartInfo}`);

    const data = await backupFx(proto, {
      maxPages: cartOnly ? scan.totalPages : undefined,
      onProgress: (frac) => {
        const pct = 5 + frac * 95;
        progress.update(pct, `Downloading ${modeLabel} — ${cartInfo}`);
      },
      onStatus: () => {}, // we handle status ourselves
    });

    progress.hide();
    downloadBlob(data, 'arduboy-fx-backup.bin');
    showToast(`FX backup complete (${modeLabel})`, 'success');
  } catch (err) {
    progress.hide();
    showToast(`Backup failed: ${err.message}`, 'error');
    console.error(err);
  }
}

async function handleFxScan() {
  const proto = await ensureDevice();
  if (!proto) return;

  try {
    progress.show('Scanning Cart');
    const result = await scanFx(proto, {
      onProgress: (frac) => progress.update(frac * 100),
    });
    progress.hide();

    // Populate results
    $('#scan-slots').textContent = result.slotCount;
    $('#scan-games').textContent = result.games;
    $('#scan-categories').textContent = result.categories;
    $('#scan-pages').textContent = result.totalPages.toLocaleString();
    const usedBytes = result.totalPages * 256;
    const usedKB = usedBytes / 1024;
    $('#scan-size').textContent = usedKB >= 1024
      ? `${(usedKB / 1024).toFixed(1)} MB`
      : `${usedKB.toFixed(0)} KB`;

    $('#fx-scan-results')?.classList.remove('hidden');
    showToast(`Found ${result.games} games in ${result.categories} categories`, 'success');
  } catch (err) {
    progress.hide();
    showToast(`Scan failed: ${err.message}`, 'error');
    console.error(err);
  }
}

$('#btn-fx-write')?.addEventListener('click', handleFxWrite);
$('#btn-fx-backup')?.addEventListener('click', handleFxBackup);
$('#btn-fx-scan')?.addEventListener('click', handleFxScan);

// ---------------------------------------------------------------------------
// EEPROM actions
// ---------------------------------------------------------------------------

async function handleEepromRestore() {
  const file = selectedFiles['eeprom'];
  if (!file) { showToast('Select an EEPROM backup file first', 'warning'); return; }

  const proto = await ensureDevice();
  if (!proto) return;

  try {
    progress.show('Restoring EEPROM');
    const buffer = await readFileAsArrayBuffer(file);
    const data = new Uint8Array(buffer);
    await writeEeprom(proto, data, { onProgress: (frac) => progress.update(frac * 100, 'Writing EEPROM...') });
    progress.hide();
    showToast('EEPROM restored!', 'success');
  } catch (err) {
    progress.hide();
    showToast(`Restore failed: ${err.message}`, 'error');
    console.error(err);
  }
}

async function handleEepromBackup() {
  const proto = await ensureDevice();
  if (!proto) return;

  try {
    progress.show('Backing Up EEPROM');
    const data = await readEeprom(proto, { onProgress: (frac) => progress.update(frac * 100, 'Reading EEPROM...') });
    progress.hide();
    downloadBlob(data, 'arduboy-eeprom-backup.bin');
    showToast('EEPROM backed up', 'success');
  } catch (err) {
    progress.hide();
    showToast(`Backup failed: ${err.message}`, 'error');
    console.error(err);
  }
}

async function handleEepromErase() {
  if (!await showConfirm('This will erase all game save data (EEPROM → 0xFF). Continue?')) return;

  const proto = await ensureDevice();
  if (!proto) return;

  try {
    progress.show('Erasing EEPROM');
    await eraseEeprom(proto, { onProgress: (frac) => progress.update(frac * 100, 'Erasing EEPROM...') });
    progress.hide();
    showToast('EEPROM erased', 'success');
  } catch (err) {
    progress.hide();
    showToast(`Erase failed: ${err.message}`, 'error');
    console.error(err);
  }
}

$('#btn-eeprom-restore')?.addEventListener('click', handleEepromRestore);
$('#btn-eeprom-backup')?.addEventListener('click', handleEepromBackup);
$('#btn-eeprom-erase')?.addEventListener('click', handleEepromErase);

// ---------------------------------------------------------------------------
// Global Drag-and-Drop
// ---------------------------------------------------------------------------

// Extension → which tabs accept it and what the default is
const DROP_ROUTES = {
  '.hex':     { tabs: ['sketch', 'cart'], defaultTab: 'sketch' },
  '.arduboy': { tabs: ['sketch', 'package', 'cart'], defaultTab: 'package' },
  '.bin':     { tabs: ['fx', 'cart', 'eeprom'], defaultTab: 'fx' },
  '.eep':     { tabs: ['eeprom'], defaultTab: 'eeprom' },
  '.png':     { tabs: ['image'], defaultTab: 'image' },
  '.jpg':     { tabs: ['image'], defaultTab: 'image' },
  '.jpeg':    { tabs: ['image'], defaultTab: 'image' },
  '.gif':     { tabs: ['image'], defaultTab: 'image' },
  '.bmp':     { tabs: ['image'], defaultTab: 'image' },
  '.webp':    { tabs: ['image'], defaultTab: 'image' },
  '.mid':     { tabs: ['music'], defaultTab: 'music' },
  '.midi':    { tabs: ['music'], defaultTab: 'music' },
};

const TAB_LABELS = {
  sketch: 'Sketch Manager',
  fx: 'FX Flash',
  eeprom: 'EEPROM',
  cart: 'Cart Editor',
  image: 'Image Converter',
  package: 'Package Editor',
  music: 'Music Editor',
};

// Build full-page drop overlay
const dropOverlay = document.createElement('div');
dropOverlay.className = 'page-drop-overlay';
const fileTypes = ['.hex', '.bin', '.arduboy', '.mid', 'Image'];
const fileTypesHTML = fileTypes.map(ext => `
  <div class="file-type-card">
    <svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg" class="file-svg">
      <!-- Paper body with rounded corners and clean 45-degree fold -->
      <path d="M 5,12 L 5,110 Q 5,118 12,118 L 88,118 Q 95,118 95,110 L 95,21 L 76,5 L 12,5 Q 5,5 5,12 Z" fill="rgba(139,45,180,0.12)" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
      <!-- Fold flap with minimal fill -->
      <path d="M 76,5 L 95,21 L 76,21 Z" fill="rgba(255,255,255,0.12)" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
      <!-- Extension label -->
      <text x="50" y="70" text-anchor="middle" dominant-baseline="middle" fill="white" class="file-text">${ext}</text>
    </svg>
  </div>
`).join('');
dropOverlay.innerHTML = `
  <div class="drop-overlay-border"></div>
  <div class="drop-overlay-content">
    <span class="drop-overlay-icon">&#x1F4E5;</span>
    <span class="drop-overlay-label">Drop file here</span>
    <div class="drop-overlay-file-types">
      ${fileTypesHTML}
    </div>
  </div>`;
document.getElementById('app').appendChild(dropOverlay);

// Build cart-specific drop overlay — just a backdrop + .bin hint banner.
// The real slot list and detail panel float ABOVE this and serve as their own drop targets.
const cartDropOverlay = document.createElement('div');
cartDropOverlay.className = 'cart-drop-overlay';
cartDropOverlay.innerHTML = `
  <div class="cart-drop-backdrop"></div>
  <div class="cart-drop-bin-banner">
    <span>&#x1F4BE; Drop <strong>.bin</strong> here to load entire cart</span>
  </div>`;
document.getElementById('app').appendChild(cartDropOverlay);

function resolveDropTarget(fileName) {
  const name = fileName.toLowerCase();
  for (const [ext, route] of Object.entries(DROP_ROUTES)) {
    if (name.endsWith(ext)) {
      const target = route.tabs.includes(tabs.current) ? tabs.current : route.defaultTab;
      return { ext, target };
    }
  }
  return null;
}

/** Populate a file-input label and cache the file, matching the manual-pick flow. */
function loadFileIntoInput(file, labelSel, cacheKey) {
  selectedFiles[cacheKey] = file;
  const label = $(labelSel);
  if (label) { label.textContent = file.name; label.classList.add('has-file'); }
}

async function handleDroppedFile(file, tab) {
  const name = file.name.toLowerCase();

  switch (tab) {
    case 'sketch':
      loadFileIntoInput(file, 'label[for="sketch-file"]', 'sketch');
      showToast(`Loaded: ${file.name}`, 'info');
      break;

    case 'fx':
      loadFileIntoInput(file, 'label[for="fx-file"]', 'fx');
      showToast(`Loaded: ${file.name}`, 'info');
      // Auto-scan cart info
      try {
        const buffer = await readFileAsArrayBuffer(file);
        const data = new Uint8Array(buffer);
        const info = scanFxCartHeaders(data);
        if (info.count > 0) {
          $('#file-scan-slots').textContent = info.count;
          $('#file-scan-games').textContent = info.games;
          $('#file-scan-categories').textContent = info.categories;
          $('#file-scan-pages').textContent = info.totalPages.toLocaleString();
          const sizeKB = data.length / 1024;
          $('#file-scan-size').textContent = sizeKB >= 1024
            ? `${(sizeKB / 1024).toFixed(1)} MB`
            : `${sizeKB.toFixed(0)} KB`;
          $('#fx-file-info')?.classList.remove('hidden');
        } else {
          $('#fx-file-info')?.classList.add('hidden');
        }
      } catch {
        $('#fx-file-info')?.classList.add('hidden');
      }
      break;

    case 'eeprom':
      loadFileIntoInput(file, 'label[for="eeprom-file"]', 'eeprom');
      showToast(`Loaded: ${file.name}`, 'info');
      break;

    case 'cart':
      if (name.endsWith('.bin')) {
        await cartEditor.openBinFile(file);
      } else {
        await cartEditor.addGameFromFile(file);
      }
      break;

    case 'package':
      await packageEditor._doLoad(file);
      break;

    case 'image':
      await imageConverter.loadFile(file);
      showToast(`Loaded: ${file.name}`, 'info');
      break;

    case 'music':
      await musicEditor.loadFile(file);
      showToast(`Loaded: ${file.name}`, 'info');
      break;
  }
}

// --- Global drag/drop listeners ---

let _pageDragCounter = 0;

// Capture phase: always clean up overlay & prevent browser default on any drop
document.addEventListener('drop', (e) => {
  e.preventDefault();
  _pageDragCounter = 0;
  dropOverlay.classList.remove('active');
  cartDropOverlay.classList.remove('active');
  cartEditor.setDragHover(false);
}, true);

// Also block default on dragover so the drop event fires
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
}, true);

document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  _pageDragCounter++;
  if (tabs.current === 'cart') {
    cartDropOverlay.classList.add('active');
    cartEditor.setDragHover(true);
  } else {
    dropOverlay.classList.add('active');
  }
});

document.addEventListener('dragleave', () => {
  _pageDragCounter--;
  if (_pageDragCounter <= 0) {
    _pageDragCounter = 0;
    dropOverlay.classList.remove('active');
    cartDropOverlay.classList.remove('active');
    cartEditor.setDragHover(false);
  }
});

// Bubble phase: route the file (won't fire if a child called stopPropagation)
document.addEventListener('drop', async (e) => {
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  const route = resolveDropTarget(file.name);
  if (!route) {
    showToast(`Unsupported file type: ${file.name}`, 'warning');
    return;
  }

  // Switch to the target tab, then handle the file
  tabs.activate(route.target);
  await handleDroppedFile(file, route.target);
});

// ---------------------------------------------------------------------------
// Cart Editor
// ---------------------------------------------------------------------------

const cartEditor = new CartEditor({
  ensureDevice,
  progress,
  disconnectDevice,
});

// ---------------------------------------------------------------------------
// Package Editor
// ---------------------------------------------------------------------------

const packageEditor = new PackageEditor();

// ---------------------------------------------------------------------------
// Image Converter
// ---------------------------------------------------------------------------

const imageConverter = new ImageConverter();

// ---------------------------------------------------------------------------
// Music Editor
// ---------------------------------------------------------------------------

const musicEditor = new MusicEditor();

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

console.log('%c🎮 Arduboy Web Tools loaded', 'color: #8B2DB4; font-weight: bold; font-size: 14px;');
