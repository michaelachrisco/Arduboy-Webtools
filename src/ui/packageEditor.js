/**
 * Package Editor — create and edit .arduboy game packages.
 *
 * Two-pane layout:
 *   Left  – Package Info (metadata fields, contributors, license)
 *   Right – Binaries list (each with hex, FX data, FX save, cart image, device)
 *
 * Modelled after arduboy_toolset's widget_package.py.
 */

import {
  readArduboyFile, writeArduboyFile,
  SCREEN_WIDTH, SCREEN_HEIGHT,
} from '../core/index.js';
import { readFileAsArrayBuffer, downloadBlob } from './files.js';
import { showToast } from './toast.js';
import { showConfirm } from './modal.js';

const ALLOWED_DEVICES = ['Arduboy', 'ArduboyFX', 'ArduboyMini'];
const LICENSE_HELP_URL = 'https://choosealicense.com/';

// ─────────────────────────────────────────────────────────────────────────────
// PackageEditor
// ─────────────────────────────────────────────────────────────────────────────

export class PackageEditor {
  /** @type {Object[]} Binary entries */
  _binaries = [];

  /** @type {number} Selected binary index */
  _selectedBinary = -1;



  constructor() {
    this._bindToolbar();
    this._bindFields();
    this._bindResizeHandle();
    this._addBinary(); // Start with one empty binary
    this._renderBinaryList();
    this._renderBinaryDetail();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Toolbar
  // ═══════════════════════════════════════════════════════════════════════════

  _bindToolbar() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };

    on('btn-pkg-load', () => this._loadPackage());
    on('btn-pkg-save', () => this._savePackage());
    on('btn-pkg-reset', () => this._resetPackage());

    // Binary controls
    on('btn-pkg-add-binary', () => {
      this._addBinary();
      this._renderBinaryList();
      this._renderBinaryDetail();
    });
    on('btn-pkg-remove-binary', () => {
      this._removeBinary();
    });

    // Contributor controls
    on('btn-pkg-add-contributor', () => this._addContributorRow());
    on('btn-pkg-remove-contributor', () => this._removeContributorRow());

    // Load file input
    document.getElementById('pkg-load-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await this._doLoad(file);
      e.target.value = '';
    });
  }

  _bindFields() {
    // No-op — fields are read at save time. Contributor table is dynamic.
  }

  _bindResizeHandle() {
    const handle = document.getElementById('pkg-resize-handle');
    const container = document.querySelector('.pkg-content');
    const rightPane = document.getElementById('pkg-right-pane');
    if (!handle || !container || !rightPane) return;

    let dragging = false;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = container.getBoundingClientRect();
      const rightWidth = rect.right - e.clientX - 5;
      const clamped = Math.max(250, Math.min(rightWidth, rect.width - 250));
      rightPane.style.flex = `0 0 ${clamped}px`;
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Load / Save / Reset
  // ═══════════════════════════════════════════════════════════════════════════

  _loadPackage() {
    document.getElementById('pkg-load-file')?.click();
  }

  async _doLoad(file) {
    try {
      const buffer = await readFileAsArrayBuffer(file);
      const pkg = await readArduboyFile(new Uint8Array(buffer), file.name);
      this._fillFromPackage(pkg);
      showToast(`Loaded: ${pkg.title || file.name}`, 'success');
    } catch (err) {
      showToast(`Failed to load: ${err.message}`, 'error');
      console.error(err);
    }
  }

  async _savePackage() {
    try {
      const pkg = this._buildPackage();
      const blob = await writeArduboyFile(pkg);
      const filename = (pkg.title || 'package').replace(/[^a-zA-Z0-9_-]/g, '_') + '.arduboy';
      downloadBlob(blob, filename, 'application/zip');
      showToast(`Saved: ${filename}`, 'success');
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
      console.error(err);
    }
  }

  async _resetPackage() {
    if (!await showConfirm('Reset all package editor fields?')) return;

    // Clear metadata fields
    const fields = ['pkg-title', 'pkg-version', 'pkg-author', 'pkg-description',
      'pkg-genre', 'pkg-url', 'pkg-sourceurl', 'pkg-email'];
    fields.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    // Clear license
    const licenseEl = document.getElementById('pkg-license');
    if (licenseEl) licenseEl.value = '';

    // Clear contributors
    const tbody = document.querySelector('#pkg-contributors-table tbody');
    if (tbody) tbody.innerHTML = '';

    // Reset binaries
    this._binaries = [];
    this._selectedBinary = -1;
    this._addBinary();
    this._renderBinaryList();
    this._renderBinaryDetail();

    showToast('Package editor reset', 'info');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Fill / Build Package
  // ═══════════════════════════════════════════════════════════════════════════

  _fillFromPackage(pkg) {
    // Metadata
    this._setField('pkg-title', pkg.title);
    this._setField('pkg-version', pkg.version);
    this._setField('pkg-author', pkg.author);
    this._setField('pkg-description', pkg.description);
    this._setField('pkg-genre', pkg.genre);
    this._setField('pkg-url', pkg.url);
    this._setField('pkg-sourceurl', pkg.sourceUrl);
    this._setField('pkg-email', pkg.email);

    // License
    const licenseEl = document.getElementById('pkg-license');
    if (licenseEl) licenseEl.value = pkg.license || '';

    // Contributors
    const tbody = document.querySelector('#pkg-contributors-table tbody');
    if (tbody) tbody.innerHTML = '';
    (pkg.contributors || []).forEach((c) => {
      this._addContributorRow(c.name, (c.roles || []).join(', '), (c.urls || []).join(', '));
    });

    // Binaries
    this._binaries = [];
    this._selectedBinary = -1;

    for (const bin of (pkg.binaries || [])) {
      // Create a blob URL from the image blob for display
      let cartImageUrl = null;
      const blob = bin.cartImageBlob || null;
      if (blob) {
        cartImageUrl = URL.createObjectURL(blob);
      }

      this._binaries.push({
        title: bin.title || '',
        device: bin.device || 'Arduboy',
        hexRaw: bin.hexRaw || '',
        hexFilename: bin.hexFilename || '',
        dataRaw: bin.dataRaw || new Uint8Array(0),
        saveRaw: bin.saveRaw || new Uint8Array(0),
        cartImage: bin.cartImage || null,
        cartImageFilename: bin.cartImageFilename || '',
        cartImageBlob: blob,
        cartImageUrl,
      });
    }

    if (this._binaries.length === 0) {
      this._addBinary();
    } else {
      this._selectedBinary = 0;
    }

    this._renderBinaryList();
    this._renderBinaryDetail();
  }

  _buildPackage() {
    const title = this._getField('pkg-title');
    const version = this._getField('pkg-version');
    const author = this._getField('pkg-author');

    if (!title) throw new Error('Title is required!');
    if (!version) throw new Error('Version is required! (e.g. 1.0)');
    if (!author) throw new Error('Author is required!');

    // Read contributors from table
    const contributors = [];
    const rows = document.querySelectorAll('#pkg-contributors-table tbody tr');
    rows.forEach((row) => {
      const cells = row.querySelectorAll('input');
      const name = cells[0]?.value?.trim() || '';
      const roles = (cells[1]?.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      const urls = (cells[2]?.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (name) contributors.push({ name, roles, urls });
    });

    // Build binaries
    if (this._binaries.length === 0) throw new Error('At least one binary is required!');

    const binaries = this._binaries.map((b) => {
      if (!b.hexRaw) throw new Error(`Binary "${b.title || '(untitled)'}" is missing a .hex file!`);

      const safeName = (b.title || title || 'game').replace(/[^a-zA-Z0-9_-]/g, '_');
      const hexFilename = b.hexFilename || `${safeName}.hex`;

      if ((b.dataRaw?.length > 0 || b.saveRaw?.length > 0) && b.device === 'Arduboy') {
        throw new Error(`Binary "${b.title}" has FX data but device is set to "Arduboy". Use "ArduboyFX" or "ArduboyMini".`);
      }

      return {
        device: b.device,
        title: b.title || title,
        hexFilename,
        hexRaw: b.hexRaw,
        dataRaw: b.dataRaw || new Uint8Array(0),
        saveRaw: b.saveRaw || new Uint8Array(0),
        cartImage: b.cartImage,
        cartImageFilename: b.cartImageFilename || '',
        cartImageBlob: b.cartImageBlob || null,
      };
    });

    return {
      originalFilename: title,
      schemaVersion: 4,
      title,
      version,
      author,
      description: this._getField('pkg-description'),
      license: document.getElementById('pkg-license')?.value || '',
      date: new Date().toISOString().slice(0, 10),
      genre: this._getField('pkg-genre'),
      url: this._getField('pkg-url'),
      sourceUrl: this._getField('pkg-sourceurl'),
      email: this._getField('pkg-email'),
      companion: '',
      contributors,
      binaries,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Contributors
  // ═══════════════════════════════════════════════════════════════════════════

  _addContributorRow(name = '', roles = '', urls = '') {
    const tbody = document.querySelector('#pkg-contributors-table tbody');
    if (!tbody) return;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><input type="text" class="pkg-contrib-input" value="${this._escAttr(name)}" placeholder="Name"></td>
      <td><input type="text" class="pkg-contrib-input" value="${this._escAttr(roles)}" placeholder="Code, Art, Sound..."></td>
      <td><input type="text" class="pkg-contrib-input" value="${this._escAttr(urls)}" placeholder="https://..."></td>`;
    tbody.appendChild(row);
  }

  _removeContributorRow() {
    const tbody = document.querySelector('#pkg-contributors-table tbody');
    if (!tbody) return;
    const lastRow = tbody.querySelector('tr:last-child');
    if (lastRow) lastRow.remove();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Binaries
  // ═══════════════════════════════════════════════════════════════════════════

  _addBinary(data = null) {
    this._binaries.push(data || {
      title: '',
      device: 'Arduboy',
      hexRaw: '',
      hexFilename: '',
      dataRaw: new Uint8Array(0),
      saveRaw: new Uint8Array(0),
      cartImage: null,
      cartImageFilename: '',
      cartImageBlob: null,
      cartImageUrl: null,
    });
    this._selectedBinary = this._binaries.length - 1;
  }

  _removeBinary() {
    if (this._selectedBinary < 0 || this._binaries.length === 0) return;
    this._binaries.splice(this._selectedBinary, 1);
    if (this._selectedBinary >= this._binaries.length) {
      this._selectedBinary = this._binaries.length - 1;
    }
    this._renderBinaryList();
    this._renderBinaryDetail();
  }

  _renderBinaryList() {
    const list = document.getElementById('pkg-binary-list');
    if (!list) return;
    list.innerHTML = '';

    this._binaries.forEach((bin, i) => {
      const el = document.createElement('div');
      el.className = 'pkg-binary-item' + (i === this._selectedBinary ? ' selected' : '');
      const label = bin.title || `Binary ${i + 1}`;
      const device = bin.device || 'Arduboy';
      const hasHex = bin.hexRaw ? '✓' : '✗';
      const hasData = bin.dataRaw?.length > 0 ? '✓' : '—';
      const hasSave = bin.saveRaw?.length > 0 ? '✓' : '—';
      el.innerHTML = `
        <span class="pkg-binary-name">${this._esc(label)}</span>
        <span class="pkg-binary-device">${device}</span>
        <span class="pkg-binary-flags">hex:${hasHex} data:${hasData} save:${hasSave}</span>`;
      el.addEventListener('click', () => {
        this._selectedBinary = i;
        this._renderBinaryList();
        this._renderBinaryDetail();
      });
      list.appendChild(el);
    });
  }

  _renderBinaryDetail() {
    const panel = document.getElementById('pkg-binary-detail');
    if (!panel) return;

    if (this._selectedBinary < 0 || this._selectedBinary >= this._binaries.length) {
      panel.innerHTML = '<p class="pkg-binary-empty">No binary selected</p>';
      return;
    }

    const bin = this._binaries[this._selectedBinary];
    const hexSize = bin.hexRaw ? new TextEncoder().encode(bin.hexRaw).length : 0;
    const dataSize = bin.dataRaw?.length || 0;
    const saveSize = bin.saveRaw?.length || 0;

    const imgSrc = bin.cartImageUrl || '';
    const imgClass = imgSrc ? 'pkg-binary-preview' : 'pkg-binary-preview pkg-binary-preview-empty';

    panel.innerHTML = `
      <div class="pkg-binary-form">
        <input type="text" id="pkg-binary-title" class="pkg-field-input" value="${this._escAttr(bin.title)}" placeholder="Binary title (optional)">

        <div class="pkg-binary-image-section">
          <img id="pkg-binary-img" class="${imgClass}" src="${imgSrc}" alt="Cart image">
          <div class="pkg-binary-image-buttons">
            <button class="btn btn-sm btn-secondary" id="btn-pkg-binary-image">Set Image</button>
            <input type="file" id="pkg-binary-image-file" accept="image/*" class="file-input">
            <button class="btn btn-sm btn-outline" id="btn-pkg-binary-clear-image">Clear</button>
          </div>
        </div>

        <div class="pkg-binary-device-row">
          <span class="pkg-binary-device-label">Device:</span>
          <select id="pkg-binary-device" class="pkg-field-select">
            ${ALLOWED_DEVICES.map((d) => `<option value="${d}" ${d === bin.device ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </div>

        <div class="pkg-binary-files">
          <div class="pkg-binary-file-row">
            <span class="pkg-binary-file-label">Program</span>
            <span class="pkg-binary-file-size">${hexSize ? this._formatBytes(hexSize) : 'None'}</span>
            <button class="btn btn-sm btn-secondary" id="btn-pkg-binary-hex">Set .hex</button>
            <input type="file" id="pkg-binary-hex-file" accept=".hex" class="file-input">
            <button class="btn btn-sm btn-outline" id="btn-pkg-binary-clear-hex" ${!hexSize ? 'disabled' : ''}>Clear</button>
          </div>
          <div class="pkg-binary-file-row">
            <span class="pkg-binary-file-label">FX Data</span>
            <span class="pkg-binary-file-size">${dataSize ? this._formatBytes(dataSize) : 'None'}</span>
            <button class="btn btn-sm btn-secondary" id="btn-pkg-binary-data">Set .bin</button>
            <input type="file" id="pkg-binary-data-file" accept=".bin" class="file-input">
            <button class="btn btn-sm btn-outline" id="btn-pkg-binary-clear-data" ${!dataSize ? 'disabled' : ''}>Clear</button>
          </div>
          <div class="pkg-binary-file-row">
            <span class="pkg-binary-file-label">FX Save</span>
            <span class="pkg-binary-file-size">${saveSize ? this._formatBytes(saveSize) : 'None'}</span>
            <button class="btn btn-sm btn-secondary" id="btn-pkg-binary-save">Set .bin</button>
            <input type="file" id="pkg-binary-save-file" accept=".bin" class="file-input">
            <button class="btn btn-sm btn-outline" id="btn-pkg-binary-clear-save" ${!saveSize ? 'disabled' : ''}>Clear</button>
          </div>
        </div>
      </div>`;

    this._bindBinaryDetailEvents(panel, bin);
  }

  _bindBinaryDetailEvents(panel, bin) {
    // Title
    panel.querySelector('#pkg-binary-title')?.addEventListener('input', (e) => {
      bin.title = e.target.value;
      this._renderBinaryList();
    });

    // Device
    panel.querySelector('#pkg-binary-device')?.addEventListener('change', (e) => {
      bin.device = e.target.value;
      this._renderBinaryList();
    });

    // Cart image
    panel.querySelector('#btn-pkg-binary-image')?.addEventListener('click', () => {
      panel.querySelector('#pkg-binary-image-file')?.click();
    });
    panel.querySelector('#pkg-binary-image-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        // Revoke old URL
        if (bin.cartImageUrl) URL.revokeObjectURL(bin.cartImageUrl);
        // Store file as blob for saving, and create URL for display
        bin.cartImageBlob = file;
        bin.cartImageUrl = URL.createObjectURL(file);
        bin.cartImage = null; // not needed for img-based display
        bin.cartImageFilename = (bin.title || 'cart').replace(/[^a-zA-Z0-9_-]/g, '_') + '_cartimage.png';
        this._renderBinaryDetail();
      } catch (err) {
        showToast(`Image load failed: ${err.message}`, 'error');
      }
    });
    panel.querySelector('#btn-pkg-binary-clear-image')?.addEventListener('click', () => {
      if (bin.cartImageUrl) URL.revokeObjectURL(bin.cartImageUrl);
      bin.cartImage = null;
      bin.cartImageFilename = '';
      bin.cartImageBlob = null;
      bin.cartImageUrl = null;
      this._renderBinaryDetail();
    });

    // Hex
    panel.querySelector('#btn-pkg-binary-hex')?.addEventListener('click', () => {
      panel.querySelector('#pkg-binary-hex-file')?.click();
    });
    panel.querySelector('#pkg-binary-hex-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const buffer = await readFileAsArrayBuffer(file);
      bin.hexRaw = new TextDecoder().decode(buffer);
      bin.hexFilename = file.name;
      this._renderBinaryDetail();
      this._renderBinaryList();
    });
    panel.querySelector('#btn-pkg-binary-clear-hex')?.addEventListener('click', () => {
      bin.hexRaw = '';
      bin.hexFilename = '';
      this._renderBinaryDetail();
      this._renderBinaryList();
    });

    // FX Data
    panel.querySelector('#btn-pkg-binary-data')?.addEventListener('click', () => {
      panel.querySelector('#pkg-binary-data-file')?.click();
    });
    panel.querySelector('#pkg-binary-data-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const buffer = await readFileAsArrayBuffer(file);
      bin.dataRaw = new Uint8Array(buffer);
      this._renderBinaryDetail();
      this._renderBinaryList();
    });
    panel.querySelector('#btn-pkg-binary-clear-data')?.addEventListener('click', () => {
      bin.dataRaw = new Uint8Array(0);
      this._renderBinaryDetail();
      this._renderBinaryList();
    });

    // FX Save
    panel.querySelector('#btn-pkg-binary-save')?.addEventListener('click', () => {
      panel.querySelector('#pkg-binary-save-file')?.click();
    });
    panel.querySelector('#pkg-binary-save-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const buffer = await readFileAsArrayBuffer(file);
      bin.saveRaw = new Uint8Array(buffer);
      this._renderBinaryDetail();
      this._renderBinaryList();
    });
    panel.querySelector('#btn-pkg-binary-clear-save')?.addEventListener('click', () => {
      bin.saveRaw = new Uint8Array(0);
      this._renderBinaryDetail();
      this._renderBinaryList();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  _setField(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value || '';
  }

  _getField(id) {
    return document.getElementById(id)?.value?.trim() || '';
  }

  _esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  _escAttr(str) {
    return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${(bytes / Math.pow(k, i)).toFixed(i ? 1 : 0)} ${sizes[i]}`;
  }
}
