/**
 * Cart Editor — visual editor for Arduboy FX flash cart images.
 *
 * Features:
 *   - Load / save cart .bin files
 *   - Visual slot list with 128×64 thumbnails
 *   - Add games from .arduboy/.hex files
 *   - Add / delete / reorder categories & game slots
 *   - Edit slot metadata (title, version, developer, info)
 *   - Replace title images, program hex, FX data, FX save
 *   - Drag-and-drop reordering
 *   - Search / filter
 *   - Load from / write to connected Arduboy device
 *
 * Modelled after arduboy_toolset's cart editor (main_cart.py + widget_fx.py).
 */

import {
  FxParsedSlot, parseFxCart, compileFxCart,
  parseIntelHex, generateIntelHex,
  readArduboyFile, writeArduboyFile,
  screenToImageData, imageDataToScreen, loadImageFile,
  SCREEN_WIDTH, SCREEN_HEIGHT, FX_META_MAX_LENGTH, FX_PAGESIZE,
  FX_SAVE_ALIGNMENT, FLASH_PAGESIZE, FX_TITLE_SIZE, FX_FULL_CART_SIZE,
  encodeString,
  writeFx, backupFx, scanFx,
  patchSSD1309,
} from '../core/index.js';
import JSZip from 'jszip';
import { readFileAsArrayBuffer, downloadBlob } from './files.js';
import { showToast } from './toast.js';
import { showConfirm } from './modal.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_IMAGE = new Uint8Array(FX_TITLE_SIZE); // all 0x00 = blank screen

// ─────────────────────────────────────────────────────────────────────────────
// CartEditor
// ─────────────────────────────────────────────────────────────────────────────

export class CartEditor {
  /** @type {FxParsedSlot[]} */
  slots = [];

  /** @type {number} Currently selected slot index (-1 = none) */
  selectedIndex = -1;

  /** @type {boolean} Whether the cart has unsaved changes */
  dirty = false;

  /** @type {string} Filename of the loaded cart */
  filename = '';

  /** @type {Function|null} Callback to get the serial protocol */
  _ensureDevice = null;

  /** @type {Object|null} Progress controller */
  _progress = null;

  /** @type {Function|null} Disconnect callback */
  _disconnectDevice = null;

  /** @type {boolean} Whether to confirm before deleting a slot */
  _confirmDelete = true;

  // ── DOM references ──

  /** @type {HTMLElement} */ _slotList = null;
  /** @type {HTMLElement} */ _detailPanel = null;
  /** @type {HTMLElement} */ _countsEl = null;
  /** @type {HTMLElement} */ _searchInput = null;

  // ── Drag state ──
  _dragSourceIndex = -1;

  /**
   * @param {Object} opts
   * @param {Function} opts.ensureDevice - async fn that returns a connected protocol
   * @param {Object} opts.progress - ProgressController instance
   * @param {Function} opts.disconnectDevice - async fn to disconnect
   */
  constructor({ ensureDevice, progress, disconnectDevice } = {}) {
    this._ensureDevice = ensureDevice;
    this._progress = progress;
    this._disconnectDevice = disconnectDevice;

    this._slotList = document.getElementById('cart-slot-list');
    this._detailPanel = document.getElementById('cart-detail');
    this._countsEl = document.getElementById('cart-counts');
    this._searchInput = document.getElementById('cart-search');

    this._bindToolbar();
    this._bindSearch();
    this._bindExternalDrop();
    this._bindDetailDrop();

    // Confirm delete checkbox
    const confirmCb = document.getElementById('cart-confirm-delete');
    if (confirmCb) {
      confirmCb.addEventListener('change', () => { this._confirmDelete = confirmCb.checked; });
    }

    this._bindResizeHandle();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Toolbar bindings
  // ═══════════════════════════════════════════════════════════════════════════

  _bindToolbar() {
    const on = (id, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', handler);
    };

    // File: New, Open, Save
    on('btn-cart-new', () => this.newCart());
    on('btn-cart-open', () => document.getElementById('cart-open-file')?.click());
    on('btn-cart-save', () => this.saveBinFile());

    // Open file input
    document.getElementById('cart-open-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await this.openBinFile(file);
      e.target.value = ''; // reset so same file can be re-opened
    });

    // Edit: Add Game, Add Category, Delete
    on('btn-cart-add-game', () => document.getElementById('cart-game-file')?.click());
    document.getElementById('cart-game-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await this.addGameFromFile(file);
      e.target.value = '';
    });
    on('btn-cart-add-category', () => this.addCategory());
    on('btn-cart-delete', () => this.deleteSelected());
    on('btn-cart-delete-category', () => this.deleteCategory());

    // Move Up / Down
    on('btn-cart-move-up', () => this.moveSelectedUp());
    on('btn-cart-move-down', () => this.moveSelectedDown());

    // Move entire category up / down
    on('btn-cart-move-cat-up', () => this.moveCategoryUp());
    on('btn-cart-move-cat-down', () => this.moveCategoryDown());

    // Device: Load / Write
    on('btn-cart-load-device', () => this.loadFromDevice());
    on('btn-cart-write-device', () => this.writeToDevice());

    // Export selected slot to .arduboy
    on('btn-cart-export-slot', () => this.exportSelectedSlot());

    // Export all slots as .arduboy files in a ZIP
    on('btn-cart-export-all', () => this.exportAllSlots());
  }

  _bindSearch() {
    this._searchInput?.addEventListener('input', (e) => {
      this._applySearch(e.target.value);
    });
  }

  /**
   * Toggle the elevated drag-hover state on both panels.
   * Called from global drag listeners when the cart overlay is shown / hidden.
   */
  setDragHover(active) {
    const container = this._slotList?.closest('.cart-slot-list-container');
    const panel = this._detailPanel;
    if (active) {
      container?.classList.add('cart-drag-hover');
      panel?.classList.add('cart-drag-hover');
    } else {
      container?.classList.remove('cart-drag-hover');
      panel?.classList.remove('cart-drag-hover');
    }
  }

  /**
   * Allow dropping .arduboy/.hex/.bin files onto the slot list from outside.
   * Shows an insert-line indicator at the hovered position.
   */
  _bindExternalDrop() {
    const list = this._slotList;
    const container = list?.closest('.cart-slot-list-container');
    if (!list || !container) return;

    let listDragCounter = 0;
    let _extDropIndex = -1;  // where to insert (updated on dragover)

    const clearIndicators = () => {
      list.querySelectorAll('.slot-item').forEach((el) => {
        el.classList.remove('drag-above', 'drag-below');
      });
      _extDropIndex = -1;
    };

    const updateInsertLine = (e) => {
      const items = [...list.querySelectorAll('.slot-item')];
      if (items.length === 0) { _extDropIndex = -1; return; }

      // Find the slot item closest to the cursor
      let best = null;
      let bestDist = Infinity;
      for (const el of items) {
        const rect = el.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const dist = Math.abs(e.clientY - midY);
        if (dist < bestDist) { bestDist = dist; best = el; }
      }
      if (!best) return;

      // Clear old indicators
      items.forEach((el) => el.classList.remove('drag-above', 'drag-below'));

      const rect = best.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const idx = parseInt(best.dataset.index, 10);

      if (e.clientY < midY) {
        best.classList.add('drag-above');
        _extDropIndex = idx;
      } else {
        best.classList.add('drag-below');
        _extDropIndex = idx + 1;
      }
      // Never insert before slot 0 (bootloader)
      if (_extDropIndex < 1) _extDropIndex = 1;
    };

    container.addEventListener('dragover', (e) => {
      // Only act on external file drags (not internal slot reorder)
      if (!e.dataTransfer?.types?.includes('Files')) return;
      if (this._dragSourceIndex >= 0) return;  // internal reorder in progress
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      updateInsertLine(e);
    });

    container.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      if (this._dragSourceIndex >= 0) return;
      listDragCounter++;
    });

    container.addEventListener('dragleave', () => {
      listDragCounter--;
      if (listDragCounter <= 0) {
        listDragCounter = 0;
        clearIndicators();
      }
    });

    container.addEventListener('drop', async (e) => {
      // Only handle external file drops, not internal reorder
      if (this._dragSourceIndex >= 0) return;
      e.preventDefault();
      e.stopPropagation();
      const insertAt = _extDropIndex;
      listDragCounter = 0;
      clearIndicators();
      const files = e.dataTransfer?.files;
      if (!files) return;
      if (!this.slots || this.slots.length === 0) {
        showToast('No cart loaded', 'warning');
      }
      for (const file of files) {
        if (file.name.endsWith('.arduboy') || file.name.endsWith('.hex')) {
          await this.addGameFromFile(file, insertAt >= 1 ? insertAt : undefined);
        } else {
          const ext = file.name.split('.').pop()?.toLowerCase();
          if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'bin'].includes(ext)) {
            showToast(`Drop ${file.name} onto a slot's detail panel instead`, 'warning');
          } else {
            showToast(`Unsupported file type: ${file.name}`, 'warning');
          }
        }
      }
    });
  }

  /**
   * Set up the detail panel as a drag-and-drop target.
   * Accepts: .png/image → replace image, .hex → replace program, .bin → FX data or save.
   */
  _bindDetailDrop() {
    const panel = this._detailPanel;
    if (!panel) return;

    let detailDragCounter = 0;

    panel.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    panel.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      detailDragCounter++;
      panel.classList.add('cart-detail-drop-active');
    });

    panel.addEventListener('dragleave', () => {
      detailDragCounter--;
      if (detailDragCounter <= 0) {
        detailDragCounter = 0;
        panel.classList.remove('cart-detail-drop-active');
      }
    });

    panel.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      detailDragCounter = 0;
      panel.classList.remove('cart-detail-drop-active');

      if (!this.slots || this.slots.length === 0) {
        showToast('No cart loaded', 'warning');
        return;
      }
      if (this.selectedIndex < 0 || this.selectedIndex >= this.slots.length) {
        showToast('Select a slot first to drop files onto', 'warning');
        return;
      }

      const slot = this.slots[this.selectedIndex];
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const file = files[0];
      const name = file.name.toLowerCase();

      // Image files → replace slot image
      if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') ||
          name.endsWith('.gif') || name.endsWith('.bmp') || name.endsWith('.webp')) {
        const hasExisting = slot.imageRaw && slot.imageRaw.some((b) => b !== 0);
        if (this._confirmDelete && hasExisting && !await showConfirm('Replace the current slot image?')) return;
        await this._setSlotImage(slot, file);
        this.render();
        return;
      }

      // .hex → replace program data
      if (name.endsWith('.hex')) {
        if (slot.isCategory) {
          showToast('Cannot set program data on a category slot', 'warning');
          return;
        }
        const hasProgram = slot.programRaw.length > 0;
        if (this._confirmDelete && hasProgram && !await showConfirm('Replace the current program data?')) return;
        await this._setSlotProgram(slot, file);
        this.render();
        return;
      }

      // .bin → determine if FX data or FX save based on file size
      if (name.endsWith('.bin')) {
        if (slot.isCategory) {
          showToast('Cannot set binary data on a category slot', 'warning');
          return;
        }

        const fileSize = file.size;

        // Too large for anything
        if (fileSize > FX_FULL_CART_SIZE) {
          showToast(`File too large (${(fileSize / 1024 / 1024).toFixed(1)} MB) — max FX data is 16 MB`, 'error');
          return;
        }

        let choice;

        if (fileSize > FX_SAVE_ALIGNMENT) {
          // Larger than save alignment (4 KB) — must be FX data
          choice = 'data';
          const hasData = slot.dataRaw && slot.dataRaw.length > 0;
          if (this._confirmDelete && hasData && !await showConfirm('Replace the current FX data?')) return;
          showToast(`Auto-detected as FX data (${fileSize >= 1024 ? (fileSize / 1024).toFixed(1) + ' KB' : fileSize + ' B'})`, 'info');
        } else {
          // Could be either — ask the user
          choice = await showConfirm('What is this .bin file?', {
            title: 'Import Binary',
            buttons: [
              { label: 'FX Data', value: 'data', className: 'btn btn-primary', default: true },
              { label: 'FX Save', value: 'save', className: 'btn btn-outline' },
              { label: 'Cancel', value: null, className: 'btn btn-secondary' },
            ],
          });
          if (!choice) return;

          // Check for existing data in the chosen slot
          if (this._confirmDelete) {
            if (choice === 'save' && slot.saveRaw && slot.saveRaw.length > 0) {
              if (!await showConfirm('Replace the current FX save data?')) return;
            } else if (choice === 'data' && slot.dataRaw && slot.dataRaw.length > 0) {
              if (!await showConfirm('Replace the current FX data?')) return;
            }
          }
        }

        const buffer = await readFileAsArrayBuffer(file);
        const binData = new Uint8Array(buffer);
        if (choice === 'save') {
          slot.saveRaw = binData;
          this._markDirty();
          this.render();
          showToast('FX save set', 'success');
        } else {
          slot.dataRaw = binData;
          this._markDirty();
          this.render();
          showToast('FX data set', 'success');
        }
        return;
      }

      // .arduboy → replace entire slot contents
      if (name.endsWith('.arduboy')) {
        const hasProgram = slot.programRaw.length > 0;
        if (this._confirmDelete && hasProgram && !await showConfirm('Replace this slot with the dropped .arduboy file?')) return;
        try {
          const newSlot = await this._slotFromArduboyFile(file);
          // Copy new slot data into existing slot
          slot.programRaw = newSlot.programRaw;
          slot.dataRaw = newSlot.dataRaw;
          slot.saveRaw = newSlot.saveRaw;
          slot.imageRaw = newSlot.imageRaw;
          slot.meta = newSlot.meta;
          this._markDirty();
          this.render();
          showToast(`Slot updated from ${file.name}`, 'success');
        } catch (err) {
          showToast(`Failed to load: ${err.message}`, 'error');
        }
        return;
      }

      showToast(`Unsupported file type: ${file.name}`, 'warning');
    });
  }

  /**
   * Bind mouse drag on the resize handle between slot list and detail panel.
   */
  _bindResizeHandle() {
    const handle = document.getElementById('cart-resize-handle');
    const container = document.querySelector('.cart-content');
    const detailPanel = document.getElementById('cart-detail');
    if (!handle || !container || !detailPanel) return;

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
      const containerRect = container.getBoundingClientRect();
      const detailWidth = containerRect.right - e.clientX - 5; // 5 = half of handle + margins
      const clamped = Math.max(280, Math.min(detailWidth, containerRect.width - 200));
      detailPanel.style.flex = `0 0 ${clamped}px`;
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
  // File Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /** Start a fresh empty cart with bootloader image + one default category. */
  async newCart() {
    if (this.dirty && !await showConfirm('Discard unsaved changes and create a new cart?')) return;

    this.slots = [
      // Slot 0: Bootloader image (category 0) — the Cathy3K bootloader
      // reads this title image from FX page 0 and displays it on the OLED.
      new FxParsedSlot({ category: 0, meta: { title: '', version: '', developer: '', info: '' } }),
      // Slot 1: First game category
      new FxParsedSlot({ category: 1, meta: { title: 'Games', version: '', developer: '', info: 'My Arduboy Collection' } }),
    ];
    this.filename = 'cart.bin';
    this.dirty = false;
    this.selectedIndex = 0;
    this.render();
    showToast('New cart created', 'info');
  }

  /**
   * Open a .bin cart file and parse it.
   * @param {File} file
   */
  async openBinFile(file) {
    if (this.dirty && !await showConfirm('Discard unsaved changes and open a new cart?')) return;

    try {
      const buffer = await readFileAsArrayBuffer(file);
      const data = new Uint8Array(buffer);
      this.slots = parseFxCart(data);

      if (this.slots.length === 0) {
        showToast('No valid cart data found in file', 'error');
        return;
      }

      this.filename = file.name;
      this.dirty = false;
      this.selectedIndex = 0;
      this.render();
      showToast(`Loaded ${file.name}: ${this._gameCount()} games, ${this._categoryCount()} categories`, 'success');
    } catch (err) {
      showToast(`Failed to open cart: ${err.message}`, 'error');
      console.error(err);
    }
  }

  /** Compile and download the cart as .bin. */
  async saveBinFile() {
    if (this.slots.length === 0) {
      showToast('No cart data to save', 'warning');
      return;
    }

    if (this.slots.length < 2 || !this.slots[1].isCategory) {
      showToast('Slot 2 must be a Category', 'error');
      return;
    }

    try {
      const binary = await compileFxCart(this.slots);
      downloadBlob(binary, this.filename || 'cart.bin');
      this.dirty = false;
      showToast('Cart saved', 'success');
    } catch (err) {
      showToast(`Failed to compile cart: ${err.message}`, 'error');
      console.error(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Slot Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add a game slot from a .arduboy or .hex file.
   * Inserts after the currently selected slot (or at end).
   * @param {File} file
   */
  async addGameFromFile(file, insertAt) {
    try {
      let slot;

      if (file.name.endsWith('.arduboy')) {
        slot = await this._slotFromArduboyFile(file);
      } else if (file.name.endsWith('.hex')) {
        slot = await this._slotFromHexFile(file);
      } else {
        showToast('Unsupported file type. Use .arduboy or .hex', 'warning');
        return;
      }

      // Ensure there's at least a bootloader image + one category
      if (this.slots.length === 0) {
        this.slots.push(
          new FxParsedSlot({ category: 0, meta: { title: '', version: '', developer: '', info: '' } }),
          new FxParsedSlot({ category: 1, meta: { title: 'Games', version: '', developer: '', info: '' } }),
        );
      }

      // Use explicit insertAt if provided, else insert before selected, or at end.
      let idx = (insertAt != null && insertAt >= 1) ? insertAt : (this.selectedIndex >= 1 ? this.selectedIndex : this.slots.length);
      if (idx < 1) idx = 1;
      if (idx > this.slots.length) idx = this.slots.length;
      this.slots.splice(idx, 0, slot);
      this.selectedIndex = idx;
      this._markDirty();
      this.render();
      showToast(`Added: ${slot.meta.title || file.name}`, 'success');
    } catch (err) {
      showToast(`Failed to add game: ${err.message}`, 'error');
      console.error(err);
    }
  }

  /**
   * Add a new category slot.
   * @param {string} [title='New Category']
   * @param {string} [info='']
   */
  addCategory(title = 'New Category', info = '') {
    const slot = new FxParsedSlot({
      category: 0, // will be reassigned on compile
      meta: { title, version: '', developer: '', info },
    });

    // Insert before selected, or at end. Never insert before slot 0 (bootloader image).
    let insertAt = this.selectedIndex >= 1 ? this.selectedIndex : this.slots.length;
    if (insertAt < 1) insertAt = 1;
    this.slots.splice(insertAt, 0, slot);
    this.selectedIndex = insertAt;
    this._markDirty();
    this.render();
    showToast('Category added', 'info');
  }

  /** Delete the currently selected slot. */
  async deleteSelected() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.slots.length) {
      showToast('No slot selected', 'warning');
      return;
    }

    // Protect the bootloader image slot (always slot 0)
    if (this.selectedIndex === 0 && this.slots[0].isCategory) {
      showToast('Cannot delete the bootloader image slot', 'warning');
      return;
    }

    const slot = this.slots[this.selectedIndex];
    const label = slot.isCategory ? 'category' : 'game';
    if (this._confirmDelete && !await showConfirm(`Delete this ${label}: "${slot.meta.title || '(untitled)'}"?`)) return;

    this.slots.splice(this.selectedIndex, 1);
    if (this.selectedIndex >= this.slots.length) {
      this.selectedIndex = this.slots.length - 1;
    }
    this._markDirty();
    this.render();
  }

  /** Delete the entire category (header + all games) that the selected slot belongs to. */
  async deleteCategory() {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.slots.length) {
      showToast('No slot selected', 'warning');
      return;
    }

    const block = this._getCategoryBlock(this.selectedIndex);
    if (!block) return;

    // Protect the bootloader image slot
    if (block.start === 0) {
      showToast('Cannot delete the bootloader image slot', 'warning');
      return;
    }

    const catSlot = this.slots[block.start];
    const count = block.end - block.start - 1; // games in this category
    const catTitle = catSlot.meta.title || '(untitled)';
    const msg = count > 0
      ? `Delete category "${catTitle}" and its ${count} game${count !== 1 ? 's' : ''}?`
      : `Delete empty category "${catTitle}"?`;

    if (this._confirmDelete && !await showConfirm(msg)) return;

    this.slots.splice(block.start, block.end - block.start);
    this.selectedIndex = Math.min(block.start, this.slots.length - 1);
    if (this.selectedIndex < 0) this.selectedIndex = -1;
    this._markDirty();
    this.render();
    showToast(`Deleted category: ${catTitle}`, 'info');
  }

  /** Move the selected slot up by one position. */
  moveSelectedUp() {
    // Cannot move above bootloader image (slot 0), and cannot move slot 1 above slot 0
    if (this.selectedIndex <= 1) return;
    this._swapSlots(this.selectedIndex, this.selectedIndex - 1);
    this.selectedIndex--;
    this._markDirty();
    this.render();
  }

  /** Move the selected slot down by one position. */
  moveSelectedDown() {
    // Cannot move the bootloader image slot (slot 0)
    if (this.selectedIndex === 0) return;
    if (this.selectedIndex < 0 || this.selectedIndex >= this.slots.length - 1) return;
    this._swapSlots(this.selectedIndex, this.selectedIndex + 1);
    this.selectedIndex++;
    this._markDirty();
    this.render();
  }

  // ── Move entire category ──────────────────────────────────────────────────

  /**
   * Find the category block that the given slot index belongs to.
   * Returns { start, end } where start is the category header index
   * and end is one-past the last slot in that category.
   */
  _getCategoryBlock(index) {
    if (index < 0 || index >= this.slots.length) return null;

    // Walk backwards to find the category header
    let start = index;
    while (start > 0 && !this.slots[start].isCategory) {
      start--;
    }
    // If we landed on a non-category (edge case: no category header at top), use 0
    if (!this.slots[start].isCategory) start = 0;

    // Walk forward to find the end (next category or end of list)
    let end = start + 1;
    while (end < this.slots.length && !this.slots[end].isCategory) {
      end++;
    }
    return { start, end };
  }

  /** Move the entire category (header + its games) up above the previous category. */
  moveCategoryUp() {
    if (this.selectedIndex < 0) return;

    const block = this._getCategoryBlock(this.selectedIndex);
    if (!block || block.start <= 1) return; // can't move above bootloader image (slot 0)

    const prevBlock = this._getCategoryBlock(block.start - 1);
    if (!prevBlock || prevBlock.start === 0) return; // can't move above bootloader image

    // Extract this category block and re-insert before the previous block
    const items = this.slots.splice(block.start, block.end - block.start);
    this.slots.splice(prevBlock.start, 0, ...items);

    // Adjust selection to follow the moved block
    const offset = this.selectedIndex - block.start;
    this.selectedIndex = prevBlock.start + offset;

    this._markDirty();
    this.render();
  }

  /** Move the entire category (header + its games) down below the next category. */
  moveCategoryDown() {
    if (this.selectedIndex < 0) return;

    const block = this._getCategoryBlock(this.selectedIndex);
    // Cannot move bootloader image slot (slot 0) down, and cannot move past end
    if (!block || block.start === 0 || block.end >= this.slots.length) return;

    const nextBlock = this._getCategoryBlock(block.end);
    if (!nextBlock) return;

    // Extract the next block and re-insert before current block
    const nextItems = this.slots.splice(nextBlock.start, nextBlock.end - nextBlock.start);
    this.slots.splice(block.start, 0, ...nextItems);

    // Adjust selection to follow the moved block
    const offset = this.selectedIndex - block.start;
    this.selectedIndex = block.start + nextItems.length + offset;

    this._markDirty();
    this.render();
  }

  /**
   * Move a slot from one position to another (drag-drop).
   * @param {number} from
   * @param {number} to
   */
  moveSlot(from, to) {
    if (from === to) return;
    // Prevent moving the bootloader image slot (index 0) or placing anything before it
    if (from === 0) return;
    if (to === 0) to = 1;
    const [slot] = this.slots.splice(from, 1);
    this.slots.splice(to, 0, slot);
    this.selectedIndex = to;
    this._markDirty();
    this.render();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Device Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /** Load cart from connected Arduboy device. */
  async loadFromDevice() {
    if (!this._ensureDevice) {
      showToast('Device connection not available', 'error');
      return;
    }
    if (this.dirty && !await showConfirm('Discard unsaved changes and load from device?')) return;

    const proto = await this._ensureDevice();
    if (!proto) return;

    try {
      this._progress?.show('Loading Cart from Device');

      // Scan first to know how much to read
      this._progress?.update(0, 'Scanning cart headers...');
      const scan = await scanFx(proto, {
        onProgress: (frac) => this._progress?.update(frac * 5, 'Scanning...'),
      });

      if (scan.totalPages === 0) {
        this._progress?.hide();
        showToast('No cart data found on device', 'warning');
        return;
      }

      // Download cart data
      this._progress?.update(5, 'Downloading cart data...');
      const data = await backupFx(proto, {
        maxPages: scan.totalPages,
        onProgress: (frac) => {
          this._progress?.update(5 + frac * 95, 'Downloading...');
        },
        onStatus: () => {},
      });

      this._progress?.hide();

      // Parse
      this.slots = parseFxCart(new Uint8Array(data));
      this.filename = 'device-cart.bin';
      this.dirty = false;
      this.selectedIndex = this.slots.length > 0 ? 0 : -1;
      this.render();

      showToast(`Loaded from device: ${this._gameCount()} games, ${this._categoryCount()} categories`, 'success');
    } catch (err) {
      this._progress?.hide();
      showToast(`Failed to load from device: ${err.message}`, 'error');
      console.error(err);
    }
  }

  /** Compile and write cart to connected Arduboy device. */
  async writeToDevice() {
    if (this.slots.length === 0) {
      showToast('No cart data to write', 'warning');
      return;
    }

    if (this.slots.length < 2 || !this.slots[1].isCategory) {
      showToast('Cart must have a category as the first slot after the bootloader image', 'error');
      return;
    }

    if (!this._ensureDevice) {
      showToast('Device connection not available', 'error');
      return;
    }

    const proto = await this._ensureDevice();
    if (!proto) return;

    const ssd1309 = document.getElementById('cart-patch-ssd1309')?.checked ?? false;

    try {
      this._progress?.show('Writing Cart to Device');
      this._progress?.update(0, 'Compiling cart...');

      const binary = await compileFxCart(this.slots);

      // Apply SSD1309 display patch to all games in the compiled cart
      if (ssd1309) {
        this._progress?.update(2, 'Applying SSD1309 patch...');
        const patchResult = patchSSD1309(binary);
        if (patchResult.success) {
          showToast(patchResult.message, 'info');
        } else {
          showToast(patchResult.message, 'warning');
        }
      }

      this._progress?.update(5, 'Writing to FX flash...');
      await writeFx(proto, binary, 0, {
        verify: false,
        onProgress: (frac) => this._progress?.update(5 + frac * 95),
        onStatus: (msg) => this._progress?.update(undefined, msg),
      });

      this._progress?.hide();
      this.dirty = false;
      showToast('Cart written to device!', 'success');
    } catch (err) {
      this._progress?.hide();
      showToast(`Failed to write to device: ${err.message}`, 'error');
      console.error(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Export
  // ═══════════════════════════════════════════════════════════════════════════

  /** Export the selected game slot as a standalone .bin snippet (compiled single slot). */
  async exportSelectedSlot() {
    if (this.selectedIndex < 0) {
      showToast('No slot selected', 'warning');
      return;
    }
    const slot = this.slots[this.selectedIndex];
    if (slot.isCategory) {
      showToast('Cannot export category slots', 'warning');
      return;
    }

    try {
      const safeName = (slot.meta.title || 'slot').replace(/[^a-zA-Z0-9_-]/g, '_');
      const hexFilename = `${safeName}.hex`;
      const cartImageFilename = `${safeName}_cartimage.png`;

      // Convert program binary back to Intel HEX
      const hexRaw = slot.programRaw.length > 0
        ? generateIntelHex(slot.programRaw)
        : '';

      // Determine device type based on FX data presence
      const device = slot.fxEnabled ? 'ArduboyFX' : 'Arduboy';

      // Convert screen buffer to PNG blob for cart image
      let cartImageBlob = null;
      const hasImage = slot.imageRaw && slot.imageRaw.some((b) => b !== 0);
      if (hasImage) {
        const imgData = screenToImageData(slot.imageRaw);
        const canvas = new OffscreenCanvas(SCREEN_WIDTH, SCREEN_HEIGHT);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(imgData, 0, 0);
        cartImageBlob = await canvas.convertToBlob({ type: 'image/png' });
      }

      // Build the ArduboyPackage
      const pkg = {
        originalFilename: safeName,
        schemaVersion: 4,
        title: slot.meta.title || '',
        version: slot.meta.version || '',
        author: slot.meta.developer || '',
        description: slot.meta.info || '',
        license: '',
        date: '',
        genre: '',
        url: '',
        sourceUrl: '',
        email: '',
        companion: '',
        contributors: slot.meta.developer
          ? [{ name: slot.meta.developer, roles: ['Developer'], urls: [] }]
          : [],
        binaries: [{
          device,
          title: slot.meta.title || safeName,
          hexFilename,
          hexRaw,
          dataRaw: slot.dataRaw || new Uint8Array(0),
          saveRaw: slot.saveRaw || new Uint8Array(0),
          cartImage: null,
          cartImageFilename: hasImage ? cartImageFilename : '',
          cartImageBlob,
        }],
      };

      const blob = await writeArduboyFile(pkg);
      downloadBlob(blob, `${safeName}.arduboy`, 'application/zip');
      showToast(`Exported: ${slot.meta.title || safeName}.arduboy`, 'success');
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'error');
      console.error(err);
    }
  }

  /**
   * Export all slots as a ZIP of category folders, each containing .arduboy files
   * and a category.json + category.png for the category header.
   *
   * Structure mirrors the toolset's "Export slots to .arduboy":
   *   000_category-name/
   *     category.json   — { title, info, image }
   *     category.png    — title screen image
   *     001_game-name.arduboy
   *     002_game-name.arduboy
   *   001_another-category/
   *     ...
   */
  async exportAllSlots() {
    if (this.slots.length === 0) {
      showToast('No slots to export', 'warning');
      return;
    }

    // Filter out the bootloader slot (index 0 if it's a category with category === 0)
    const slotsToExport = this.slots.filter((s, i) => !(i === 0 && s.isCategory && s.category === 0));
    if (slotsToExport.length === 0) {
      showToast('No slots to export', 'warning');
      return;
    }

    try {
      const outerZip = new JSZip();

      let categoryIndex = -1;
      let programIndex = 0;
      let currentFolder = outerZip; // root fallback for games before any category
      let currentFolderName = '';

      for (const slot of slotsToExport) {
        const safeName = (slot.meta.title || 'untitled').replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-').toLowerCase();

        if (slot.isCategory) {
          categoryIndex++;
          programIndex = 0;
          currentFolderName = `${String(categoryIndex).padStart(3, '0')}_${safeName}`;
          currentFolder = outerZip.folder(currentFolderName);

          // Category image → PNG
          const hasImage = slot.imageRaw && slot.imageRaw.some((b) => b !== 0);
          if (hasImage) {
            const imgData = screenToImageData(slot.imageRaw);
            const canvas = new OffscreenCanvas(SCREEN_WIDTH, SCREEN_HEIGHT);
            const ctx = canvas.getContext('2d');
            ctx.putImageData(imgData, 0, 0);
            const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
            currentFolder.file('category.png', pngBlob);
          }

          // Category metadata JSON
          const catMeta = {
            title: slot.meta.title || '',
            info: slot.meta.info || '',
            image: hasImage ? 'category.png' : undefined,
          };
          currentFolder.file('category.json', JSON.stringify(catMeta, null, 2));
        } else {
          // Game slot → .arduboy file
          programIndex++;
          const slotFileName = `${String(programIndex).padStart(3, '0')}_${safeName}.arduboy`;
          const hexFilename = `${safeName}.hex`;
          const cartImageFilename = `${safeName}_cartimage.png`;

          // Convert program binary back to Intel HEX
          const hexRaw = slot.programRaw.length > 0
            ? generateIntelHex(slot.programRaw)
            : '';

          const device = slot.fxEnabled ? 'ArduboyFX' : 'Arduboy';

          // Convert screen buffer to PNG blob
          let cartImageBlob = null;
          const hasImage = slot.imageRaw && slot.imageRaw.some((b) => b !== 0);
          if (hasImage) {
            const imgData = screenToImageData(slot.imageRaw);
            const canvas = new OffscreenCanvas(SCREEN_WIDTH, SCREEN_HEIGHT);
            const ctx = canvas.getContext('2d');
            ctx.putImageData(imgData, 0, 0);
            cartImageBlob = await canvas.convertToBlob({ type: 'image/png' });
          }

          const pkg = {
            originalFilename: safeName,
            schemaVersion: 4,
            title: slot.meta.title || '',
            version: slot.meta.version || '',
            author: slot.meta.developer || '',
            description: slot.meta.info || '',
            license: '',
            date: '',
            genre: '',
            url: '',
            sourceUrl: '',
            email: '',
            companion: '',
            contributors: slot.meta.developer
              ? [{ name: slot.meta.developer, roles: ['Developer'], urls: [] }]
              : [],
            binaries: [{
              device,
              title: slot.meta.title || safeName,
              hexFilename,
              hexRaw,
              dataRaw: slot.dataRaw || new Uint8Array(0),
              saveRaw: slot.saveRaw || new Uint8Array(0),
              cartImage: null,
              cartImageFilename: hasImage ? cartImageFilename : '',
              cartImageBlob,
            }],
          };

          const arduboyBlob = await writeArduboyFile(pkg);
          currentFolder.file(slotFileName, arduboyBlob);
        }
      }

      const zipBlob = await outerZip.generateAsync({ type: 'blob' });
      const cartName = (this.filename || 'cart').replace(/\.[^.]+$/, '');
      downloadBlob(zipBlob, `${cartName}_export.zip`, 'application/zip');
      showToast('Exported all slots as .arduboy files', 'success');
    } catch (err) {
      showToast(`Export All failed: ${err.message}`, 'error');
      console.error(err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Rendering
  // ═══════════════════════════════════════════════════════════════════════════

  /** Full re-render of slot list + detail panel + counts. */
  render() {
    this._renderSlotList();
    this._renderDetail();
    this._updateCounts();
  }

  /** Render the scrollable slot list. */
  _renderSlotList() {
    const list = this._slotList;
    if (!list) return;
    list.innerHTML = '';

    if (this.slots.length === 0) {
      list.innerHTML = `
        <div class="cart-empty-state">
          <p>No cart loaded</p>
          <p class="cart-empty-hint">Open a .bin cart file, load from device, or create a new cart.</p>
        </div>`;
      return;
    }

    this.slots.forEach((slot, index) => {
      const el = this._createSlotElement(slot, index);
      list.appendChild(el);
    });

    // Scroll selected into view
    if (this.selectedIndex >= 0) {
      const selected = list.querySelector('.cart-slot-selected');
      selected?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /**
   * Create a DOM element for a slot in the list.
   * @param {FxParsedSlot} slot
   * @param {number} index
   * @returns {HTMLElement}
   */
  _createSlotElement(slot, index) {
    const el = document.createElement('div');
    el.className = 'slot-item';
    const isBootloaderSlot = index === 0 && slot.isCategory;
    if (isBootloaderSlot) el.classList.add('bootloader-image');
    else if (slot.isCategory) el.classList.add('category');
    if (index === this.selectedIndex) el.classList.add('cart-slot-selected');
    el.dataset.index = index;

    // Drag attributes (bootloader image slot at index 0 is not draggable)
    if (isBootloaderSlot) {
      el.draggable = false;
    } else {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => this._onDragStart(e, index));
      el.addEventListener('dragover', (e) => this._onDragOver(e, index));
      el.addEventListener('dragend', () => this._onDragEnd());
      el.addEventListener('drop', (e) => this._onDrop(e, index));
    }

    // Click to select
    el.addEventListener('click', () => this.selectSlot(index));

    // Thumbnail canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'slot-thumbnail';
    canvas.width = SCREEN_WIDTH;
    canvas.height = SCREEN_HEIGHT;
    this._drawThumbnail(canvas, slot.imageRaw);

    // Info section
    const info = document.createElement('div');
    info.className = 'slot-info';

    if (isBootloaderSlot) {
      info.innerHTML = `
        <div class="slot-category-header slot-bootloader-label">Bootloader Image</div>
        <div class="slot-meta">Title screen</div>`;
    } else if (slot.isCategory) {
      info.innerHTML = `
        <div class="slot-category-header">${this._esc(slot.meta.title || 'Untitled Category')}</div>
        <div class="slot-meta">${this._esc(slot.meta.info || '')}</div>`;
    } else {
      const fxBadge = slot.fxEnabled ? '<span class="slot-badge slot-badge-fx">FX</span>' : '';
      info.innerHTML = `
        <div class="slot-title">${this._esc(slot.meta.title || 'Untitled')} ${fxBadge}</div>
        <div class="slot-meta">
          ${slot.meta.developer ? this._esc(slot.meta.developer) : ''}
        </div>`;
    }

    // Slot number
    const num = document.createElement('div');
    num.className = 'slot-number';
    num.textContent = `${index + 1}`;

    el.appendChild(num);
    el.appendChild(canvas);
    el.appendChild(info);

    return el;
  }

  /** Render the detail panel for the selected slot. */
  _renderDetail() {
    const panel = this._detailPanel;
    if (!panel) return;

    if (this.selectedIndex < 0 || this.selectedIndex >= this.slots.length) {
      panel.innerHTML = `
        <div class="cart-detail-empty">
          <p>Select a slot to view and edit its details</p>
        </div>`;
      return;
    }

    const slot = this.slots[this.selectedIndex];
    const isBootloaderSlot = this.selectedIndex === 0 && slot.isCategory;

    if (isBootloaderSlot) {
      this._renderBootloaderDetail(panel, slot);
    } else if (slot.isCategory) {
      this._renderCategoryDetail(panel, slot);
    } else {
      this._renderGameDetail(panel, slot);
    }
  }

  /**
   * Render the detail panel for the bootloader image slot (slot 0).
   * Only allows editing the title screen image — no metadata fields.
   * @param {HTMLElement} panel
   * @param {FxParsedSlot} slot
   */
  _renderBootloaderDetail(panel, slot) {
    panel.innerHTML = `
      <div class="cart-detail-header">
        <h3>Bootloader Image</h3>
      </div>

      <p class="cart-bootloader-hint">
        This is the title screen image displayed by the Cathy3K bootloader when the device is in bootloader mode.
        It is stored as the first slot (page 0) of the FX flash cart.
      </p>

      <div class="cart-detail-image-section">
        <canvas id="cart-detail-canvas" class="cart-detail-canvas" width="${SCREEN_WIDTH}" height="${SCREEN_HEIGHT}"></canvas>
        <div class="cart-detail-image-actions">
          <button class="btn btn-sm btn-secondary" id="btn-detail-image">Change</button>
          <input type="file" id="detail-image-file" accept="image/*" class="file-input">
          <button class="btn btn-sm btn-outline" id="btn-detail-save-image">Save</button>
          <button class="btn btn-sm btn-danger" id="btn-detail-clear-image">Clear</button>
        </div>
      </div>`;

    this._bindDetailEvents(panel, slot);
  }

  /**
   * Render the detail panel for a category slot.
   * @param {HTMLElement} panel
   * @param {FxParsedSlot} slot
   */
  _renderCategoryDetail(panel, slot) {
    const metaUsed = this._getMetaBytesUsed(slot);

    panel.innerHTML = `
      <div class="cart-detail-header">
        <h3>Category</h3>
        <span class="cart-meta-counter ${metaUsed > FX_META_MAX_LENGTH ? 'over-limit' : ''}">${metaUsed} / ${FX_META_MAX_LENGTH} bytes</span>
      </div>

      <div class="cart-detail-image-section">
        <canvas id="cart-detail-canvas" class="cart-detail-canvas" width="${SCREEN_WIDTH}" height="${SCREEN_HEIGHT}"></canvas>
        <div class="cart-detail-image-actions">
          <button class="btn btn-sm btn-secondary" id="btn-detail-image">Change</button>
          <input type="file" id="detail-image-file" accept="image/*" class="file-input">
          <button class="btn btn-sm btn-outline" id="btn-detail-save-image">Save</button>
          <button class="btn btn-sm btn-danger" id="btn-detail-clear-image">Clear</button>
        </div>
      </div>

      <div class="cart-detail-fields">
        <label class="cart-field-label">Title</label>
        <input type="text" class="cart-field-input" id="detail-title" value="${this._escAttr(slot.meta.title)}" maxlength="60">

        <label class="cart-field-label">Info</label>
        <textarea class="cart-field-textarea" id="detail-info" rows="3" maxlength="180">${this._esc(slot.meta.info)}</textarea>
      </div>`;

    this._bindDetailEvents(panel, slot);
  }

  /**
   * Render the detail panel for a game slot.
   * @param {HTMLElement} panel
   * @param {FxParsedSlot} slot
   */
  _renderGameDetail(panel, slot) {
    const metaUsed = this._getMetaBytesUsed(slot);
    const progSize = slot.programRaw.length;
    const dataSize = slot.dataRaw.length;
    const saveSize = slot.saveRaw.length;

    panel.innerHTML = `
      <div class="cart-detail-header">
        <h3>Game Slot</h3>
        <span class="cart-meta-counter ${metaUsed > FX_META_MAX_LENGTH ? 'over-limit' : ''}">${metaUsed} / ${FX_META_MAX_LENGTH} bytes</span>
      </div>

      <div class="cart-detail-image-section">
        <canvas id="cart-detail-canvas" class="cart-detail-canvas" width="${SCREEN_WIDTH}" height="${SCREEN_HEIGHT}"></canvas>
        <div class="cart-detail-image-actions">
          <button class="btn btn-sm btn-secondary" id="btn-detail-image">Change</button>
          <input type="file" id="detail-image-file" accept="image/*" class="file-input">
          <button class="btn btn-sm btn-outline" id="btn-detail-save-image">Save</button>
          <button class="btn btn-sm btn-danger" id="btn-detail-clear-image">Clear</button>
        </div>
      </div>

      <div class="cart-detail-fields">
        <label class="cart-field-label">Title</label>
        <input type="text" class="cart-field-input" id="detail-title" value="${this._escAttr(slot.meta.title)}" maxlength="60">

        <label class="cart-field-label">Version</label>
        <input type="text" class="cart-field-input" id="detail-version" value="${this._escAttr(slot.meta.version)}" maxlength="20">

        <label class="cart-field-label">Developer</label>
        <input type="text" class="cart-field-input" id="detail-developer" value="${this._escAttr(slot.meta.developer)}" maxlength="40">

        <label class="cart-field-label">Info</label>
        <textarea class="cart-field-textarea" id="detail-info" rows="3" maxlength="180">${this._esc(slot.meta.info)}</textarea>
      </div>

      <div class="cart-detail-binaries">
        <h4>Binary Data</h4>

        <div class="cart-binary-row">
          <span class="cart-binary-label">Program</span>
          <span class="cart-binary-size">${this._formatBytes(progSize)}</span>
          <button class="btn btn-sm btn-secondary" id="btn-detail-program">Set .hex</button>
          <input type="file" id="detail-program-file" accept=".hex" class="file-input">
        </div>

        <div class="cart-binary-row">
          <span class="cart-binary-label">FX Data</span>
          <span class="cart-binary-size">${this._formatBytes(dataSize)}</span>
          <button class="btn btn-sm btn-secondary" id="btn-detail-data">Set .bin</button>
          <input type="file" id="detail-data-file" accept=".bin" class="file-input">
          <button class="btn btn-sm btn-outline" id="btn-detail-clear-data" ${dataSize === 0 ? 'disabled' : ''}>Clear</button>
        </div>

        <div class="cart-binary-row">
          <span class="cart-binary-label">FX Save</span>
          <span class="cart-binary-size">${this._formatBytes(saveSize)}</span>
          <button class="btn btn-sm btn-secondary" id="btn-detail-save">Set .bin</button>
          <input type="file" id="detail-save-file" accept=".bin" class="file-input">
          <button class="btn btn-sm btn-outline" id="btn-detail-clear-save" ${saveSize === 0 ? 'disabled' : ''}>Clear</button>
        </div>
        <div class="cart-binary-row cart-binary-row-indent">
          <button class="btn btn-sm btn-outline" id="btn-detail-add-save" ${saveSize > 0 ? 'disabled' : ''} title="Add 4KB save area">+4K Save</button>
        </div>
      </div>`;

    this._bindDetailEvents(panel, slot);
  }

  /**
   * Bind event listeners for the detail panel.
   * @param {HTMLElement} panel
   * @param {FxParsedSlot} slot
   */
  _bindDetailEvents(panel, slot) {
    // Draw the large detail canvas
    const canvas = panel.querySelector('#cart-detail-canvas');
    if (canvas) this._drawThumbnail(canvas, slot.imageRaw);

    // Image change
    panel.querySelector('#btn-detail-image')?.addEventListener('click', () => {
      panel.querySelector('#detail-image-file')?.click();
    });
    panel.querySelector('#detail-image-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        await this._setSlotImage(slot, file);
        this.render();
      }
    });
    panel.querySelector('#btn-detail-clear-image')?.addEventListener('click', async () => {
      if (this._confirmDelete && !await showConfirm('Clear this cart image?')) return;
      slot.imageRaw = new Uint8Array(FX_TITLE_SIZE);
      this._markDirty();
      this.render();
    });

    // Image save as PNG
    panel.querySelector('#btn-detail-save-image')?.addEventListener('click', async () => {
      const hasImage = slot.imageRaw && slot.imageRaw.some((b) => b !== 0);
      if (!hasImage) {
        showToast('No image to save', 'warning');
        return;
      }
      const imgData = screenToImageData(slot.imageRaw);
      const offscreen = new OffscreenCanvas(SCREEN_WIDTH, SCREEN_HEIGHT);
      const ctx = offscreen.getContext('2d');
      ctx.putImageData(imgData, 0, 0);
      const blob = await offscreen.convertToBlob({ type: 'image/png' });
      const safeName = (slot.meta.title || 'image').replace(/[^a-zA-Z0-9_-]/g, '_');
      downloadBlob(blob, `${safeName}.png`, 'image/png');
    });

    // Metadata fields — update on input
    const bindField = (id, field) => {
      const input = panel.querySelector(`#detail-${id}`);
      if (!input) return;
      input.addEventListener('input', () => {
        slot.meta[field] = input.value;
        this._markDirty();
        this._updateMetaCounter(panel, slot);
        // Update the slot list item title in real time
        this._updateSlotListItem(this.selectedIndex, slot);
      });
    };
    bindField('title', 'title');
    bindField('version', 'version');
    bindField('developer', 'developer');
    bindField('info', 'info');

    // Program change
    panel.querySelector('#btn-detail-program')?.addEventListener('click', () => {
      panel.querySelector('#detail-program-file')?.click();
    });
    panel.querySelector('#detail-program-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        await this._setSlotProgram(slot, file);
        this.render();
      }
    });

    // FX Data change
    panel.querySelector('#btn-detail-data')?.addEventListener('click', () => {
      panel.querySelector('#detail-data-file')?.click();
    });
    panel.querySelector('#detail-data-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        const buffer = await readFileAsArrayBuffer(file);
        slot.dataRaw = new Uint8Array(buffer);
        this._markDirty();
        this.render();
        showToast('FX data set', 'success');
      }
    });
    panel.querySelector('#btn-detail-clear-data')?.addEventListener('click', () => {
      slot.dataRaw = new Uint8Array(0);
      this._markDirty();
      this.render();
    });

    // FX Save change
    panel.querySelector('#btn-detail-save')?.addEventListener('click', () => {
      panel.querySelector('#detail-save-file')?.click();
    });
    panel.querySelector('#detail-save-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) {
        const buffer = await readFileAsArrayBuffer(file);
        slot.saveRaw = new Uint8Array(buffer);
        this._markDirty();
        this.render();
        showToast('FX save set', 'success');
      }
    });
    panel.querySelector('#btn-detail-clear-save')?.addEventListener('click', () => {
      slot.saveRaw = new Uint8Array(0);
      this._markDirty();
      this.render();
    });
    panel.querySelector('#btn-detail-add-save')?.addEventListener('click', () => {
      slot.saveRaw = new Uint8Array(FX_SAVE_ALIGNMENT).fill(0xFF);
      this._markDirty();
      this.render();
      showToast('4KB save area added', 'info');
    });
  }

  /** Select a slot by index. */
  selectSlot(index) {
    this.selectedIndex = index;
    // Update selection visual without full re-render of the list
    this._slotList?.querySelectorAll('.slot-item').forEach((el, i) => {
      el.classList.toggle('cart-slot-selected', i === index);
    });
    this._renderDetail();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Drag & Drop (internal reorder)
  // ═══════════════════════════════════════════════════════════════════════════

  _onDragStart(e, index) {
    this._dragSourceIndex = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    e.currentTarget.classList.add('dragging');
  }

  _onDragOver(e, index) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Visual drop target indicator
    this._slotList?.querySelectorAll('.slot-item').forEach((el) => {
      el.classList.remove('drag-above', 'drag-below');
    });
    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      target.classList.add('drag-above');
    } else {
      target.classList.add('drag-below');
    }
  }

  _onDrop(e, targetIndex) {
    e.preventDefault();
    const fromIndex = this._dragSourceIndex;

    this._slotList?.querySelectorAll('.slot-item').forEach((el) => {
      el.classList.remove('drag-above', 'drag-below', 'dragging');
    });

    if (fromIndex < 0 || fromIndex === targetIndex) return;

    // Determine final index based on drop position
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    let to = e.clientY < midY ? targetIndex : targetIndex + 1;
    if (fromIndex < to) to--; // adjust for removal

    this.moveSlot(fromIndex, to);
  }

  _onDragEnd() {
    this._dragSourceIndex = -1;
    this._slotList?.querySelectorAll('.slot-item').forEach((el) => {
      el.classList.remove('drag-above', 'drag-below', 'dragging');
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Search
  // ═══════════════════════════════════════════════════════════════════════════

  _applySearch(query) {
    const q = query.toLowerCase().trim();
    this._slotList?.querySelectorAll('.slot-item').forEach((el) => {
      if (!q) {
        el.classList.remove('cart-search-hidden', 'cart-search-highlight');
        return;
      }
      const index = parseInt(el.dataset.index, 10);
      const slot = this.slots[index];
      const text = [slot.meta.title, slot.meta.version, slot.meta.developer, slot.meta.info]
        .join(' ').toLowerCase();
      const matches = text.includes(q);
      el.classList.toggle('cart-search-hidden', !matches);
      el.classList.toggle('cart-search-highlight', matches);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create an FxParsedSlot from a .arduboy file.
   * @param {File} file
   * @returns {Promise<FxParsedSlot>}
   */
  async _slotFromArduboyFile(file) {
    const buffer = await readFileAsArrayBuffer(file);
    const pkg = await readArduboyFile(new Uint8Array(buffer), file.name);

    if (!pkg.binaries || pkg.binaries.length === 0) {
      throw new Error('No binaries found in .arduboy file');
    }

    // Prefer ArduboyFX/Mini binary; fallback to first
    const bin = pkg.binaries.find((b) => b.device === 'ArduboyFX' || b.device === 'ArduboyMini')
      || pkg.binaries[0];

    // Parse hex to binary
    let programRaw = new Uint8Array(0);
    if (bin.hexRaw) {
      const parsed = parseIntelHex(bin.hexRaw);
      programRaw = this._trimProgram(parsed.data);
    }

    // Convert cart image to screen buffer
    let imageRaw = new Uint8Array(FX_TITLE_SIZE);
    if (bin.cartImage) {
      try {
        const canvas = new OffscreenCanvas(SCREEN_WIDTH, SCREEN_HEIGHT);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bin.cartImage, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
        const imgData = ctx.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
        imageRaw = imageDataToScreen(imgData);
      } catch {
        // Failed to convert image, use blank
      }
    }

    return new FxParsedSlot({
      category: 0,
      imageRaw,
      programRaw,
      dataRaw: bin.dataRaw || new Uint8Array(0),
      saveRaw: bin.saveRaw || new Uint8Array(0),
      meta: {
        title: pkg.title || bin.title || '',
        version: pkg.version || '',
        developer: pkg.author || '',
        info: pkg.description || '',
      },
    });
  }

  /**
   * Create an FxParsedSlot from a .hex file.
   * @param {File} file
   * @returns {Promise<FxParsedSlot>}
   */
  async _slotFromHexFile(file) {
    const buffer = await readFileAsArrayBuffer(file);
    const text = new TextDecoder().decode(buffer);
    const parsed = parseIntelHex(text);
    const programRaw = this._trimProgram(parsed.data);

    const name = file.name.replace(/\.hex$/i, '');

    return new FxParsedSlot({
      category: 0,
      programRaw,
      meta: { title: name, version: '', developer: '', info: '' },
    });
  }

  /**
   * Trim trailing 0xFF bytes from program data, rounding up to FLASH_PAGESIZE.
   * @param {Uint8Array} data
   * @returns {Uint8Array}
   */
  _trimProgram(data) {
    let end = data.length;
    while (end > 0 && data[end - 1] === 0xFF) end--;
    if (end === 0) return new Uint8Array(0);
    // Round up to 128-byte boundary (half-page)
    end = Math.ceil(end / FLASH_PAGESIZE) * FLASH_PAGESIZE;
    return data.slice(0, end);
  }

  /**
   * Replace a slot's title image from an image file.
   * @param {FxParsedSlot} slot
   * @param {File} file
   */
  async _setSlotImage(slot, file) {
    try {
      const imgData = await loadImageFile(file);
      slot.imageRaw = imageDataToScreen(imgData);
      this._markDirty();
      showToast('Image updated', 'success');
    } catch (err) {
      showToast(`Failed to load image: ${err.message}`, 'error');
    }
  }

  /**
   * Replace a slot's program from a .hex file.
   * @param {FxParsedSlot} slot
   * @param {File} file
   */
  async _setSlotProgram(slot, file) {
    try {
      const buffer = await readFileAsArrayBuffer(file);
      const text = new TextDecoder().decode(buffer);
      const parsed = parseIntelHex(text);
      slot.programRaw = this._trimProgram(parsed.data);
      this._markDirty();
      showToast('Program updated', 'success');
    } catch (err) {
      showToast(`Failed to load hex: ${err.message}`, 'error');
    }
  }

  /**
   * Draw a 128×64 1-bit screen buffer onto a canvas element.
   * @param {HTMLCanvasElement} canvas
   * @param {Uint8Array} imageRaw - 1024-byte screen buffer
   */
  _drawThumbnail(canvas, imageRaw) {
    const ctx = canvas.getContext('2d');
    if (!imageRaw || imageRaw.length < FX_TITLE_SIZE) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const imgData = screenToImageData(imageRaw);
    // If the canvas is the native size, put directly; otherwise draw scaled
    if (canvas.width === SCREEN_WIDTH && canvas.height === SCREEN_HEIGHT) {
      ctx.putImageData(imgData, 0, 0);
    } else {
      const temp = new OffscreenCanvas(SCREEN_WIDTH, SCREEN_HEIGHT);
      temp.getContext('2d').putImageData(imgData, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(temp, 0, 0, canvas.width, canvas.height);
    }
  }

  /**
   * Update the slot list item at a given index without full re-render.
   * @param {number} index
   * @param {FxParsedSlot} slot
   */
  _updateSlotListItem(index, slot) {
    const items = this._slotList?.querySelectorAll('.slot-item');
    if (!items || !items[index]) return;
    const info = items[index].querySelector('.slot-info');
    if (!info) return;

    if (slot.isCategory) {
      const header = info.querySelector('.slot-category-header');
      if (header) header.textContent = slot.meta.title || 'Untitled Category';
      const meta = info.querySelector('.slot-meta');
      if (meta) meta.textContent = slot.meta.info || '';
    } else {
      const titleEl = info.querySelector('.slot-title');
      if (titleEl) {
        const fxBadge = slot.fxEnabled ? ' <span class="slot-badge slot-badge-fx">FX</span>' : '';
        titleEl.innerHTML = `${this._esc(slot.meta.title || 'Untitled')}${fxBadge}`;
      }
    }
  }

  /** Update the meta byte counter in the detail panel. */
  _updateMetaCounter(panel, slot) {
    const counter = panel.querySelector('.cart-meta-counter');
    if (!counter) return;
    const used = this._getMetaBytesUsed(slot);
    counter.textContent = `${used} / ${FX_META_MAX_LENGTH} bytes`;
    counter.classList.toggle('over-limit', used > FX_META_MAX_LENGTH);
  }

  /** Compute bytes used by slot metadata strings. */
  _getMetaBytesUsed(slot) {
    const str = `${slot.meta.title}\0${slot.meta.version}\0${slot.meta.developer}\0${slot.meta.info}\0`;
    return encodeString(str).length;
  }

  /** Mark the cart as modified. */
  _markDirty() {
    this.dirty = true;
    this._updateCounts();
  }

  /** Update the footer counts display. */
  _updateCounts() {
    if (!this._countsEl) return;
    if (this.slots.length === 0) {
      this._countsEl.textContent = 'No cart loaded';
      return;
    }
    const games = this._gameCount();
    const categories = this._categoryCount();
    const dirty = this.dirty ? ' (modified)' : '';
    this._countsEl.textContent = `Categories: ${categories} | Games: ${games} | Total slots: ${this.slots.length}${dirty}`;
  }

  _gameCount() {
    return this.slots.filter((s) => !s.isCategory).length;
  }

  _categoryCount() {
    return this.slots.filter((s) => s.isCategory).length;
  }

  _swapSlots(a, b) {
    [this.slots[a], this.slots[b]] = [this.slots[b], this.slots[a]];
  }

  /** Format byte sizes for display. */
  _formatBytes(bytes) {
    if (bytes === 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  /** Format the size summary for a slot. */
  _formatSizes(slot) {
    const parts = [];
    if (slot.programRaw.length > 0) parts.push(`Prog: ${this._formatBytes(slot.programRaw.length)}`);
    if (slot.dataRaw.length > 0) parts.push(`Data: ${this._formatBytes(slot.dataRaw.length)}`);
    if (slot.saveRaw.length > 0) parts.push(`Save: ${this._formatBytes(slot.saveRaw.length)}`);
    return parts.length > 0 ? parts.join(' · ') : 'No binary data';
  }

  /** HTML-escape a string. */
  _esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Escape for use in attribute values. */
  _escAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
