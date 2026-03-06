/**
 * FX Data Editor — UI Controller
 *
 * Manages the FX Data tab: graphical entries panel (above assets),
 * bidirectional source editor, memory map, build output, and exports.
 *
 * Primary data model: _entries (Array<FxEntry>)
 * The fxdata.txt source is generated from entries at build time.
 */

import { FxDataProject } from '../core/fxdata/fxdataProject.js';
import { buildFxData } from '../core/fxdata/fxdataBuild.js';
import { parseDimensionsFromFilename } from '../core/fxdata/fxdataImageEncoder.js';
import { downloadBlob } from './files.js';
import { showToast } from './toast.js';

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Entry type classification
// ---------------------------------------------------------------------------

const NUMERIC_TYPES = new Set([
  'uint8_t', 'uint16_t', 'uint24_t', 'uint32_t',
  'int8_t', 'int16_t', 'int24_t', 'int32_t',
]);
const DATA_TYPES = new Set([
  ...NUMERIC_TYPES,
  'string',
]);
const ASSET_TYPES = new Set(['image_t', 'raw_t']);
const DIRECTIVE_TYPES = new Set([
  'align', 'savesection', 'datasection', 'namespace', 'namespace_end',
]);
const ALL_TYPES = new Set([...DATA_TYPES, ...ASSET_TYPES, ...DIRECTIVE_TYPES]);

// Integer range limits per type
const INT_RANGES = {
  uint8_t:  { min: 0, max: 255 },
  uint16_t: { min: 0, max: 65535 },
  uint24_t: { min: 0, max: 16777215 },
  uint32_t: { min: 0, max: 4294967295 },
  int8_t:   { min: -128, max: 127 },
  int16_t:  { min: -32768, max: 32767 },
  int24_t:  { min: -8388608, max: 8388607 },
  int32_t:  { min: -2147483648, max: 2147483647 },
};

const VALID_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const RESERVED_WORDS = new Set([
  'const', 'PROGMEM', 'align', 'include', 'datasection', 'savesection',
  'namespace', 'namespace_end', 'uint8_t', 'uint16_t', 'uint24_t', 'uint32_t',
  'int8_t', 'int16_t', 'int24_t', 'int32_t', 'string', 'String', 'image_t', 'raw_t',
]);

/** Maps "+" dropdown category labels → default entry type */
const CATEGORY_DEFAULT = {
  number: 'uint8_t',
  string: 'string',
  image: 'image_t',
  raw: 'raw_t',
  directive: 'savesection',
};

/** Return 'data' | 'asset' | 'directive' for a given type string */
function getEntryCategory(type) {
  if (DIRECTIVE_TYPES.has(type)) return 'directive';
  if (ASSET_TYPES.has(type)) return 'asset';
  return 'data';
}

/** Map simplified memory map type names to categories */
function getMemoryMapTypeCategory(type) {
  if (['image', 'raw'].includes(type)) return 'asset';
  if (['align', 'save', 'datasection'].includes(type)) return 'directive';
  return 'data';
}

/** Whether this type has a name field rendered */
function typeHasName(type) {
  return !['savesection', 'datasection', 'namespace_end'].includes(type);
}

/** Whether this type has a value field rendered */
function typeHasValue(type) {
  return !['savesection', 'datasection', 'namespace_end', 'namespace'].includes(type);
}

/** Create a new blank FxEntry */
function makeEntry(type = 'uint8_t') {
  return {
    id: typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    name: '',
    value: '',
    comment: '',
  };
}

// ---------------------------------------------------------------------------
// Source ↔ Entries converters (no DOM dependency — can be unit tested)
// ---------------------------------------------------------------------------

/**
 * Convert entries array → fxdata.txt source string.
 * @param {FxEntry[]} entries
 * @returns {string}
 */
/**
 * Ensure a value for a string-type entry is properly quoted.
 * If the user typed: hello world  → returns "hello world"
 * If already quoted: "hello world" → returns as-is
 */
function ensureQuoted(val) {
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed;
  }
  return `"${trimmed}"`;
}

export function entriesToSource(entries) {
  const lines = [];
  for (const entry of entries) {
    if (entry.type === '__placeholder__') continue; // transient UI state, not real data
    const { type, name, comment } = entry;
    let { value } = entry;
    let line = '';

    // Auto-quote string values if user omitted quotes
    if (type === 'string' && value && !(/^["']/.test(value.trim()))) {
      value = ensureQuoted(value);
    }

    switch (type) {
      case 'savesection':
      case 'datasection':
      case 'namespace_end':
        line = type;
        break;
      case 'namespace':
        line = name ? `namespace ${name}` : 'namespace';
        break;
      case 'align':
        line = `align ${value || '256'}`;
        break;
      default: {
        // Check if this is a numeric array (multiple comma-separated values)
        const isArray = NUMERIC_TYPES.has(type) && value && value.includes(',');
        if (name) {
          if (isArray) {
            line = `${type} ${name}[] = {\n\t${value}\n}`;
          } else {
            line = `${type} ${name} = ${value}`;
          }
        } else if (value) {
          if (isArray) {
            line = `${type} [] = {\n\t${value}\n}`;
          } else {
            line = `${type} ${value}`;
          }
        } else {
          line = `${type} `;
        }
      }
    }

    if (comment) {
      line += `  // ${comment}`;
    }
    lines.push(line);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/**
 * Best-effort parse of fxdata.txt source → entries array.
 * Handles comments, multi-line {} blocks, C-style noise (const, PROGMEM, etc.).
 * @param {string} source
 * @returns {FxEntry[]}
 */
export function sourceToEntries(source) {
  const entries = [];
  const IGNORED = new Set(['const', 'PROGMEM']);

  // Strip block comments
  let text = source.replace(/\/\*[\s\S]*?\*\//g, ' ');

  // Join multi-line {} blocks: replace newlines inside {} with spaces,
  // and strip the {} braces themselves
  let joinedLines = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { depth++; joinedLines += ' '; continue; }
    if (ch === '}') {
      if (depth > 0) depth--;
      joinedLines += ' ';
      continue;
    }
    if (depth > 0 && ch === '\n') { joinedLines += ' '; continue; }
    joinedLines += ch;
  }

  for (const rawLine of joinedLines.split('\n')) {
    // Extract inline comment
    let line = rawLine;
    let comment = '';
    const commentIdx = line.indexOf('//');
    if (commentIdx !== -1) {
      comment = line.slice(commentIdx + 2).trim();
      line = line.slice(0, commentIdx);
    }

    // Strip C-isms
    line = line
      .replace(/\bconst\b/g, '')
      .replace(/\bPROGMEM\b/g, '')
      .replace(/;/g, '')
      .replace(/\[\]/g, '')
      .trim();

    if (!line) continue;

    // Tokenize preserving quoted strings
    const tokens = tokenizeLine(line);
    if (!tokens.length) continue;

    // Find the first known type token
    const firstType = tokens.find((t) => ALL_TYPES.has(t));
    if (!firstType) continue;

    const typeIdx = tokens.indexOf(firstType);
    const afterType = tokens.slice(typeIdx + 1);

    const entry = makeEntry(firstType);
    entry.comment = comment;

    // Directive with no fields
    if (firstType === 'savesection' || firstType === 'datasection' || firstType === 'namespace_end') {
      entries.push(entry);
      continue;
    }

    // Namespace with optional name
    if (firstType === 'namespace') {
      entry.name = afterType[0] || '';
      entries.push(entry);
      continue;
    }

    // Align with optional boundary value
    if (firstType === 'align') {
      entry.value = afterType.join(' ').trim();
      entries.push(entry);
      continue;
    }

    // General: look for '=' to split name from value
    const eqIdx = afterType.indexOf('=');
    if (eqIdx !== -1) {
      entry.name = afterType.slice(0, eqIdx).join(' ').trim();
      const valTokens = afterType.slice(eqIdx + 1);
      // For numeric types with multiple values, join with commas to preserve array format
      entry.value = NUMERIC_TYPES.has(firstType) && valTokens.length > 1
        ? valTokens.join(', ')
        : valTokens.join(' ').trim();
    } else if (afterType.length > 0) {
      // No name — unlabeled data
      const valTokens = afterType;
      entry.value = NUMERIC_TYPES.has(firstType) && valTokens.length > 1
        ? valTokens.join(', ')
        : valTokens.join(' ');
    }

    entries.push(entry);
  }

  return entries;
}

/** Tokenize a line, preserving quoted strings as single tokens. */
function tokenizeLine(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === '\\') j++;
        j++;
      }
      tokens.push(line.slice(i, j + 1));
      i = j + 1;
    } else if (/[\s,]/.test(ch)) {
      i++;
    } else if (ch === '=') {
      tokens.push('=');
      i++;
    } else {
      let j = i;
      while (j < line.length && !/[\s=,]/.test(line[j]) && line[j] !== '"' && line[j] !== "'") j++;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// File type icons for asset tree
// ---------------------------------------------------------------------------

const FILE_TYPE_MAP = {
  '.png': 'image', '.bmp': 'image', '.jpg': 'image',
  '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.bin': 'binary', '.dat': 'binary',
};

function getFileType(path) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return FILE_TYPE_MAP[ext] || 'generic';
}

// ---------------------------------------------------------------------------
// Main editor class
// ---------------------------------------------------------------------------

export class FxDataEditor {
  constructor() {
    /** @type {FxDataProject} */
    this._project = new FxDataProject();

    /** @type {FxEntry[]} — authoritative data model for the FX spec */
    this._entries = [];

    /** @type {import('../core/fxdata/fxdataBuild.js').BuildResult | null} */
    this._lastBuild = null;

    /** True when the source textarea has been manually edited but not yet re-parsed */
    this._sourceDirty = false;

    /** Guard to prevent infinite sync loops */
    this._syncingSource = false;

    /** @type {Set<string>} Explicitly created folders (may be empty) */
    this._folders = new Set();

    /** @type {string|null} Currently previewed asset path */
    this._currentPreviewPath = null;

    /** @type {string|null} Variable name associated with current preview */
    this._currentPreviewVar = null;

    /** @type {{width: number, height: number}|null} Dimensions of currently previewed image */
    this._currentImageDimensions = null;

    /**
     * Sprite-setting overrides keyed by the *original* asset path.
     * Each value: { active: boolean, width: number, height: number, spacing: number, originalFilename: string }
     */
    this._spriteOverrides = new Map();

    this._grabRefs();
    this._bindEvents();
    this._initEditorTabs();
    this._initColumnResize();
    this._initPreviewResize();
    this._initEntriesResize();
    this._initMobileResizeHandles();
    this._initLayoutSwitchReset();
    this._initAddRowStickyDetection();
    this._restoreFromStorage();
    // Ensure the add-row is always inside the entries list on first paint,
    // even when storage is empty and _restoreFromStorage skips _renderEntriesPanel.
    this._renderEntriesPanel();
  }

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------

  _grabRefs() {
    // Toolbar
    this._btnNew = $('#fxdata-btn-new');
    this._btnImport = $('#fxdata-btn-import');
    this._importInput = $('#fxdata-import-input');
    this._importFolder = $('#fxdata-import-folder');
    this._btnBuild = $('#fxdata-btn-build');
    this._btnExport = $('#fxdata-btn-export');

    // Entries panel
    this._btnAddEntry = $('#fxdata-btn-add-entry');
    this._addHub = $('#fxdata-add-hub');
    this._addRow = $('#fxdata-add-row');
    this._entriesList = $('#fxdata-entries-list');

    // Assets panel
    this._btnAddFile = $('#fxdata-btn-add-file');
    this._btnAddFolder = $('#fxdata-btn-add-folder');
    this._addFileInput = $('#fxdata-add-file-input');
    this._overwriteToggle = $('#fxdata-overwrite-toggle');
    this._fileTree = $('#fxdata-file-tree');

    // Overwrite preference (persisted)
    this._overwriteByDefault = localStorage.getItem('fxdata-overwriteByDefault') === 'true';
    if (this._overwriteToggle) this._overwriteToggle.checked = this._overwriteByDefault;

    // Editor
    this._editorTabs = $('#fxdata-editor-tabs');
    this._sourcePane = $('#fxdata-tab-fxdata-source');
    this._structuredPane = $('#fxdata-structured-pane');
    this._previewPane = $('#fxdata-preview-pane');
    this._sourceEditor = $('#fxdata-source-editor');
    this._sourceFilename = $('#fxdata-source-filename');
    this._dirtyIndicator = $('#fxdata-dirty-indicator');

    // Structured / preview
    this._structuredList = $('#fxdata-structured-list');
    this._assetPreview = $('#fxdata-asset-preview');
    this._previewSection = $('#fxdata-preview-section');
    this._hexToggle = $('#fxdata-hex-toggle');
    this._hexBody = $('#fxdata-preview-hex');
    this._hexAccordion = document.querySelector('.fxdata-preview-hex-accordion');

    // Memory map + build output
    this._memoryMap = $('#fxdata-memory-map');
    this._memorySummary = $('#fxdata-memory-summary');
    this._buildOutput = $('#fxdata-build-output');
    this._buildActions = $('#fxdata-build-actions');
    this._downloadContainer = $('#fxdata-download-container');

    // Build accordion
    this._buildAccordion = $('#fxdata-build-accordion');
    this._buildAccordionToggle = $('#fxdata-build-accordion-toggle');
    this._dlHeader = $('#fxdata-dl-header');
    this._dlData = $('#fxdata-dl-data');
    this._dlDev = $('#fxdata-dl-dev');
    this._dlSave = $('#fxdata-dl-save');

    // Settings / image controls
    this._thresholdSlider = $('#fxdata-threshold');
    this._thresholdValue = $('#fxdata-threshold-value');
    this._imageControls = $('#fxdata-image-controls');
    this._spriteOverrideCheckbox = $('#fxdata-sprite-override');
    this._spriteOverrideFields = $('#fxdata-sprite-override-fields');
    this._spriteWidthInput = $('#fxdata-sprite-width');
    this._spriteHeightInput = $('#fxdata-sprite-height');
    this._spriteSpacingInput = $('#fxdata-sprite-spacing');
    this._framesView = $('#fxdata-frames-view');
  }

  // ---------------------------------------------------------------------------
  // Event binding
  // ---------------------------------------------------------------------------

  _bindEvents() {
    // Toolbar
    this._btnNew?.addEventListener('click', () => this._newProject());
    this._btnImport?.addEventListener('click', () => this._importInput?.click());
    this._importInput?.addEventListener('change', (e) => this._handleImportFiles(e));
    this._importFolder?.addEventListener('change', (e) => this._handleImportFiles(e));
    this._btnBuild?.addEventListener('click', () => this._doBuild());
    this._btnExport?.addEventListener('click', () => this._doExport());

    // Add entry button → toggle flyout
    this._btnAddEntry?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleAddFlyout();
    });

    // Flyout chip clicks → animate clone left, then add entry
    this._addHub?.querySelectorAll('.fxdata-add-flyout-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        this._commitChip(chip, chip.dataset.category);
      });
    });

    // Click outside hub → close flyout
    document.addEventListener('click', (e) => {
      if (this._addHub && !this._addHub.contains(e.target)) {
        this._closeAddFlyout();
      }
    }, true);

    // Overwrite toggle
    this._overwriteToggle?.addEventListener('change', () => {
      this._overwriteByDefault = this._overwriteToggle.checked;
      localStorage.setItem('fxdata-overwriteByDefault', this._overwriteByDefault);
    });

    // Add asset file button
    this._btnAddFile?.addEventListener('click', () => this._addFileInput?.click());
    this._addFileInput?.addEventListener('change', (e) => this._handleAddAssets(e));
    this._btnAddFolder?.addEventListener('click', () => this._addFolder());

    // Root-level drop zone for moving files and folders out of parent folders
    this._fileTree?.addEventListener('dragover', (e) => {
      const isFile = e.dataTransfer.types.includes('application/fxdata-file');
      const isFolder = e.dataTransfer.types.includes('application/fxdata-folder');
      if ((isFile || isFolder) && !e.target.closest?.('.fxdata-folder-section')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this._fileTree.classList.add('fxdata-root-drag-over');
      }
    });
    this._fileTree?.addEventListener('dragleave', (e) => {
      if (!this._fileTree.contains(e.relatedTarget)) {
        this._fileTree.classList.remove('fxdata-root-drag-over');
      }
    });
    this._fileTree?.addEventListener('drop', (e) => {
      const fileSrc = e.dataTransfer.getData('application/fxdata-file');
      const folderSrc = e.dataTransfer.getData('application/fxdata-folder');
      if (!fileSrc && !folderSrc) return;
      if (!e.target.closest?.('.fxdata-folder-section')) {
        e.preventDefault();
        this._fileTree.classList.remove('fxdata-root-drag-over');
        if (fileSrc) {
          this._moveFile(fileSrc, '');
        } else if (folderSrc) {
          this._moveFolder(folderSrc, '');
        }
      }
    });

    // Source editor: manual edit marks dirty
    this._sourceEditor?.addEventListener('input', () => {
      if (!this._syncingSource) {
        this._sourceDirty = true;
        this._dirtyIndicator?.classList.remove('hidden');
      }
    });

    // Source editor: on blur, sync source back to entries
    this._sourceEditor?.addEventListener('blur', () => {
      if (this._sourceDirty) {
        this._syncSourceToEntries();
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const panel = $('#panel-fxdata');
      if (!panel?.classList.contains('active')) return;
      if (e.ctrlKey && e.key === 's' && !e.shiftKey) {
        e.preventDefault();
        if (this._sourceDirty) this._syncSourceToEntries();
        this._doBuild();
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        this._doExport();
      }
    });

    // Build accordion toggle
    this._buildAccordionToggle?.addEventListener('click', () => {
      this._toggleBuildAccordion();
    });

    // Hex data accordion toggle
    this._hexToggle?.addEventListener('click', () => {
      this._toggleHexAccordion();
    });
    this._thresholdSlider?.addEventListener('input', () => {
      if (this._thresholdValue) {
        this._thresholdValue.textContent = this._thresholdSlider.value;
      }
      // Re-render current image preview with new threshold
      if (this._currentPreviewPath) {
        this._showAssetPreviewByPath(this._currentPreviewPath, this._currentPreviewVar, this._currentPreviewSourceType);
      }
    });

    // Sprite override checkbox
    this._spriteOverrideCheckbox?.addEventListener('change', () => {
      this._handleSpriteOverrideToggle();
    });

    // Sprite dimension inputs
    const onSpriteFieldChange = () => this._handleSpriteFieldChange();
    this._spriteWidthInput?.addEventListener('change', onSpriteFieldChange);
    this._spriteHeightInput?.addEventListener('change', onSpriteFieldChange);
    this._spriteSpacingInput?.addEventListener('change', onSpriteFieldChange);

    // Tab switching in right column
    this._initTabSwitching();

    // Download buttons
    this._dlHeader?.addEventListener('click', () => this._downloadFile('header', 'fxdata.h', 'text/plain'));
    this._dlData?.addEventListener('click', () => this._downloadFile('dataBin', 'fxdata-data.bin'));
    this._dlDev?.addEventListener('click', () => this._downloadFile('devBin', 'fxdata.bin'));
    this._dlSave?.addEventListener('click', () => this._downloadFile('saveBin', 'fxdata-save.bin'));
  }

  // ---------------------------------------------------------------------------
  // Build accordion helpers
  // ---------------------------------------------------------------------------

  _toggleBuildAccordion(forceOpen) {
    if (!this._buildOutput || !this._buildAccordionToggle) return;
    const isOpen = forceOpen !== undefined
      ? forceOpen
      : !this._buildOutput.classList.contains('open');
    this._buildOutput.classList.toggle('open', isOpen);
    this._buildAccordionToggle.setAttribute('aria-expanded', String(isOpen));
  }

  // ---------------------------------------------------------------------------
  // Preview hex accordion helpers
  // ---------------------------------------------------------------------------

  _toggleHexAccordion(forceOpen) {
    if (!this._hexBody || !this._hexToggle) return;
    const isOpen = forceOpen !== undefined
      ? forceOpen
      : !this._hexBody.classList.contains('open');
    this._hexBody.classList.toggle('open', isOpen);
    this._hexToggle.setAttribute('aria-expanded', String(isOpen));
  }

  _showHexAccordion() {
    if (!this._hexAccordion) return;
    this._hexAccordion.classList.remove('fxdata-accordion-hidden');
    // Default to expanded
    this._toggleHexAccordion(true);
  }

  _hideHexAccordion() {
    if (!this._hexAccordion) return;
    this._hexAccordion.classList.add('fxdata-accordion-hidden');
    this._toggleHexAccordion(false);
  }

  // ---------------------------------------------------------------------------
  // Column resize
  // ---------------------------------------------------------------------------

  _initColumnResize() {
    const colLeft = document.getElementById('fxdata-col-left');
    const colRight = document.getElementById('fxdata-col-right');
    const handle1 = document.getElementById('fxdata-resize-1');
    const handle2 = document.getElementById('fxdata-resize-2');
    if (!colLeft || !colRight || !handle1 || !handle2) return;

    const attachResizer = (handle, getStartWidth, applyWidth, minWidth, direction = 1) => {
      let startX = 0;
      let startWidth = 0;

      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startWidth = getStartWidth();
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });

      handle.addEventListener('pointermove', (e) => {
        if (!handle.hasPointerCapture(e.pointerId)) return;
        applyWidth(Math.max(minWidth, startWidth + direction * (e.clientX - startX)));
      });

      const stop = () => {
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('lostpointercapture', stop);
    };

    // handle1: dragging right expands left col (center is flex:1, auto-shrinks)
    attachResizer(
      handle1,
      () => colLeft.getBoundingClientRect().width,
      (w) => { colLeft.style.flex = `0 0 ${w}px`; colLeft.style.width = `${w}px`; },
      140
    );

    // handle2: dragging right shrinks right col (center is flex:1, auto-grows)
    attachResizer(
      handle2,
      () => colRight.getBoundingClientRect().width,
      (w) => { colRight.style.flex = `0 0 ${w}px`; colRight.style.width = `${w}px`; },
      180,
      -1
    );
  }

  // ---------------------------------------------------------------------------
  // Preview height resize
  // ---------------------------------------------------------------------------

  _initPreviewResize() {
    // Preview now stretches full height — no resize needed
  }

  _initTabSwitching() {
    const tabBar = document.querySelector('.fxdata-tab-bar');
    if (!tabBar) return;
    tabBar.addEventListener('click', (e) => {
      const tab = e.target.closest('.fxdata-tab');
      if (!tab) return;
      const tabId = tab.dataset.tab;
      // Deactivate all tabs and contents
      tabBar.querySelectorAll('.fxdata-tab').forEach((t) => t.classList.remove('active'));
      const container = tabBar.parentElement;
      container.querySelectorAll('.fxdata-tab-content').forEach((c) => c.classList.remove('active'));
      // Activate selected
      tab.classList.add('active');
      const content = container.querySelector(`.fxdata-tab-content[data-tab="${tabId}"]`);
      content?.classList.add('active');
    });
  }

  /**
   * Add scroll listener to entries list to toggle 'stuck' class when scrolling
   * is necessary (i.e., when content overflows). Background gradient only appears
   * when the add-row is actually pinned to the bottom by scrolling.
   */
  _initAddRowStickyDetection() {
    if (!this._addRow || !this._entriesList) return;

    const updateStuckState = () => {
      const isOverflowing = this._entriesList.scrollHeight > this._entriesList.clientHeight;
      if (isOverflowing) {
        this._addRow.classList.add('stuck');
      } else {
        this._addRow.classList.remove('stuck');
      }
    };

    // Check on init
    updateStuckState();

    // Check on scroll
    this._entriesList.addEventListener('scroll', updateStuckState);

    // Check on resize
    const resizeObserver = new ResizeObserver(updateStuckState);
    resizeObserver.observe(this._entriesList);
  }

  _initEntriesResize() {
    const entriesSection = document.querySelector('.fxdata-entries-section');
    const resizeHandle = document.getElementById('fxdata-resize-entries');
    const projectSection = document.querySelector('.fxdata-project-section');
    if (!entriesSection || !resizeHandle || !projectSection) return;

    let startY = 0;
    let startEntriesHeight = 0;

    resizeHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startEntriesHeight = entriesSection.getBoundingClientRect().height;
      resizeHandle.setPointerCapture(e.pointerId);
      resizeHandle.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    });

    resizeHandle.addEventListener('pointermove', (e) => {
      if (!resizeHandle.hasPointerCapture(e.pointerId)) return;
      const dy = e.clientY - startY;
      const newHeight = Math.max(60, startEntriesHeight + dy); // min 60px
      const isMobile = window.matchMedia('(max-width: 900px)').matches;
      if (isMobile) {
        // In mobile layout, just set height/max-height directly
        entriesSection.style.maxHeight = `${newHeight}px`;
        entriesSection.style.height = `${newHeight}px`;
      } else {
        // Pin entries to the new height; assets (flex:1) fills the rest
        entriesSection.style.flex = `0 0 ${newHeight}px`;
        entriesSection.style.minHeight = '60px';
      }
    });

    const stop = () => {
      resizeHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    resizeHandle.addEventListener('pointerup', stop);
    resizeHandle.addEventListener('lostpointercapture', stop);
  }

  /**
   * Bind mobile vertical resize handles for assets and preview sections.
   * These are only visible at <=900px and let the user drag to increase
   * the height of each section independently.
   */
  _initMobileResizeHandles() {
    const pairs = [
      { handleId: 'fxdata-mobile-resize-assets', sectionSelector: '.fxdata-project-section' },
      { handleId: 'fxdata-mobile-resize-preview', sectionId: 'fxdata-col-center' },
      { handleId: 'fxdata-mobile-resize-content', sectionSelector: '.fxdata-content-container' },
    ];

    for (const { handleId, sectionSelector, sectionId } of pairs) {
      const handle = document.getElementById(handleId);
      const section = sectionId
        ? document.getElementById(sectionId)
        : document.querySelector(sectionSelector);
      if (!handle || !section) continue;

      let startY = 0;
      let startH = 0;

      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        startY = e.clientY;
        startH = section.offsetHeight;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('active');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
      });

      handle.addEventListener('pointermove', (e) => {
        if (!handle.hasPointerCapture(e.pointerId)) return;
        const delta = e.clientY - startY;
        const newH = Math.max(100, startH + delta);
        section.style.maxHeight = `${newH}px`;
        section.style.height = `${newH}px`;
      });

      const stop = () => {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('lostpointercapture', stop);
    }
  }

  /**
   * When the viewport crosses the 900px breakpoint, clear all inline resize
   * styles so the desktop and mobile layouts stay independent.
   */
  _initLayoutSwitchReset() {
    const mq = window.matchMedia('(max-width: 900px)');
    mq.addEventListener('change', () => {
      // Elements that get inline styles from desktop column / entries resize
      const colLeft = document.getElementById('fxdata-col-left');
      const colRight = document.getElementById('fxdata-col-right');
      const entries = document.querySelector('.fxdata-entries-section');
      // Elements that get inline styles from mobile section resize
      const project = document.querySelector('.fxdata-project-section');
      const panelCenter = document.getElementById('fxdata-col-center');
      const contentContainer = document.querySelector('.fxdata-content-container');

      const clearProps = (el, props) => {
        if (!el) return;
        for (const p of props) el.style.removeProperty(p);
      };

      clearProps(colLeft, ['flex', 'width']);
      clearProps(colRight, ['flex', 'width']);
      clearProps(entries, ['flex', 'min-height', 'height', 'max-height']);
      clearProps(project, ['height', 'max-height']);
      clearProps(panelCenter, ['height', 'max-height']);
      clearProps(contentContainer, ['height', 'max-height']);
    });
  }

  // ---------------------------------------------------------------------------
  // Editor sub-tabs (Source / Structured / Preview)
  // ---------------------------------------------------------------------------

  _initEditorTabs() {
    const tabs = this._editorTabs?.querySelectorAll('.fxdata-editor-tab');
    const panes = {
      source: this._sourcePane,
      structured: this._structuredPane,
      preview: this._previewPane,
    };

    const switchToTab = (tabElement) => {
      // If leaving source tab and it's dirty, sync back
      const prevActive = this._editorTabs.querySelector('.fxdata-editor-tab.active');
      if (prevActive?.dataset.fxeditor === 'source' && this._sourceDirty) {
        this._syncSourceToEntries();
      }

      tabs.forEach((t) => t.classList.remove('active'));
      tabElement.classList.add('active');
      const target = tabElement.dataset.fxeditor;
      Object.entries(panes).forEach(([key, pane]) => {
        pane?.classList.toggle('active', key === target);
      });
      
      // Save active tab to localStorage
      localStorage.setItem('fxdata-activeTab', target);
    };

    tabs?.forEach((tab) => {
      tab.addEventListener('click', () => {
        switchToTab(tab);
      });
    });

    // Restore active tab from localStorage
    const savedTab = localStorage.getItem('fxdata-activeTab');
    if (savedTab) {
      const tabToRestore = Array.from(tabs || []).find(t => t.dataset.fxeditor === savedTab);
      if (tabToRestore) {
        switchToTab(tabToRestore);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Project management
  // ---------------------------------------------------------------------------

  _newProject() {
    this._project.clear();
    this._entries = [];
    this._lastBuild = null;
    this._folders = new Set();
    this._renderEntriesPanel();
    this._renderAssetTree();
    this._syncEntriesToSource();
    this._clearBuildOutput();
    this._clearMemoryMap();
    this._clearStructuredView();
    this._clearPreview();
    if (this._btnExport) this._btnExport.disabled = false;
    this._saveToStorage();
    showToast('New FX Data project created', 'info');
  }

  async _handleImportFiles(e) {
    const files = e.target?.files;
    if (!files || files.length === 0) return;

    const firstFile = files[0];

    // Single ZIP: import all files from it
    if (files.length === 1 && firstFile.name.toLowerCase().endsWith('.zip')) {
      const buffer = await firstFile.arrayBuffer();
      this._project.clear();
      this._entries = [];
      await this._project.importFromZip(buffer);

      // Check if the zip contains a fxdata.txt to parse
      const txtFiles = this._project.listByExtension('.txt');
      const entryTxt = txtFiles.find((f) => f.toLowerCase().includes('fxdata')) || txtFiles[0];
      if (entryTxt) {
        const src = this._project.getTextFile(entryTxt);
        if (src) {
          this._entries = sourceToEntries(src);
          this._project.removeFile(entryTxt); // don't keep raw .txt in assets
          this._remapAssetPaths();
        }
      }

      this._renderEntriesPanel();
      this._renderAssetTree();
      this._syncEntriesToSource();
      showToast(`Imported ${this._project.size} asset(s) from ZIP`, 'success');

    } else {
      // Multiple files (or a single non-zip)

      // Pre-scan for asset conflicts (skip .txt files)
      const assetFiles = [...files].filter(f => !f.name.toLowerCase().endsWith('.txt'));
      const conflicts = assetFiles.filter(f => this._project.hasFile(f.name)).map(f => f.name);
      const decisions = await this._resolveConflictBatch(conflicts);

      for (const file of files) {
        const name = file.name.toLowerCase();

        if (name.endsWith('.txt')) {
          // Parse as fxdata source → entries; don't add to project VFS
          const text = await file.text();
          this._entries = sourceToEntries(text);
          this._renderEntriesPanel();
          this._syncEntriesToSource();
          showToast(`Parsed ${file.name} into ${this._entries.length} entr${this._entries.length === 1 ? 'y' : 'ies'}`, 'success');
        } else {
          // Asset file → add to project VFS
          const path = file.name;
          if (this._project.hasFile(path) && !decisions.get(path)) continue;
          const buffer = await file.arrayBuffer();
          this._project.addFile(path, new Uint8Array(buffer));
        }
      }
      this._renderAssetTree();
      this._renderEntriesPanel();
    }

    if (this._btnExport) this._btnExport.disabled = false;
    this._clearBuildOutput();
    this._clearMemoryMap();
    this._clearStructuredView();
    this._clearPreview();
    this._saveToStorage();

    e.target.value = '';
  }

  async _handleAddAssets(e) {
    const files = e.target?.files;
    if (!files || files.length === 0) return;

    // Pre-scan for conflicts
    const conflicts = [];
    for (const file of files) {
      if (this._project.hasFile(file.name)) conflicts.push(file.name);
    }

    // Resolve all conflicts as a batch
    const decisions = await this._resolveConflictBatch(conflicts);

    let added = 0;
    for (const file of files) {
      const path = file.name;
      if (this._project.hasFile(path) && !decisions.get(path)) continue;
      const buffer = await file.arrayBuffer();
      this._project.addFile(path, new Uint8Array(buffer));
      added++;
    }

    this._renderAssetTree();
    this._renderEntriesPanel();
    this._saveToStorage();
    if (added > 0) {
      showToast(`Added ${added} asset file(s)`, 'info');
    }
    e.target.value = '';
  }

  /**
   * After ZIP import, remap asset paths in entries to match actual VFS paths.
   * The fxdata.txt may reference images by basename (e.g. "player.png") but
   * the ZIP may store them in subdirectories (e.g. "images/player.png").
   */
  _remapAssetPaths() {
    const allFiles = this._project.listFiles();
    // Build a lookup: basename → full path (first match wins)
    const basenameMap = new Map();
    for (const fp of allFiles) {
      const base = fp.split('/').pop();
      if (!basenameMap.has(base)) basenameMap.set(base, fp);
    }

    for (const entry of this._entries) {
      if (entry.type !== 'image_t' && entry.type !== 'raw_t') continue;
      const raw = (entry.value || '').replace(/^["']|["']$/g, '').trim();
      if (!raw) continue;
      // Already exists at that exact path — no remap needed
      if (this._project.hasFile(raw)) continue;
      // Try matching by basename
      const basename = raw.split('/').pop();
      const match = basenameMap.get(basename);
      if (match) {
        entry.value = `"${match}"`;
      }
    }
  }

  async _doExport() {
    // Include generated source in export
    this._project.addFile('fxdata.txt', entriesToSource(this._entries));

    // Include build outputs if available
    if (this._lastBuild?.success) {
      this._project.addFile('fxdata.h', this._lastBuild.header);
      this._project.addFile('fxdata-data.bin', this._lastBuild.dataBin);
      this._project.addFile('fxdata.bin', this._lastBuild.devBin);
      if (this._lastBuild.saveBin) {
        this._project.addFile('fxdata-save.bin', this._lastBuild.saveBin);
      }
    }

    const blob = await this._project.exportToZip();
    this._project.removeFile('fxdata.txt'); // clean up after export
    downloadBlob(blob, 'fxdata-project.zip', 'application/zip');
    showToast('Project exported as ZIP', 'success');
  }

  // ---------------------------------------------------------------------------
  // Entries data model
  // ---------------------------------------------------------------------------

  _addEntry(type) {
    const entry = makeEntry(type);
    if (type === 'align') entry.value = '256';
    this._entries.push(entry);
    this._renderEntriesPanel();
    this._syncEntriesToSource();
    this._saveToStorage();

    // Scroll to bottom, focus the new card, and show its preview
    const list = this._entriesList;
    if (list) {
      setTimeout(() => {
        list.scrollTop = list.scrollHeight;
        const lastCard = list.querySelector('.fxdata-entry-card:last-child');
        if (lastCard) {
          const input = lastCard.querySelector('.fxdata-entry-name, .fxdata-entry-value');
          input?.focus();
        }
        this._showEntryPreview(entry);
      }, 20);
    }
  }

  _removeEntry(id) {
    const idx = this._entries.findIndex((e) => e.id === id);
    if (idx === -1) return;
    this._entries.splice(idx, 1);
    this._renderEntriesPanel();
    this._syncEntriesToSource();
    this._saveToStorage();
  }

  _updateEntry(id, fields) {
    const entry = this._entries.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, fields);
    this._syncEntriesToSource();
    this._saveToStorage();
  }

  _reorderEntries(draggedId, targetId) {
    const fromIdx = this._entries.findIndex((e) => e.id === draggedId);
    const toIdx = this._entries.findIndex((e) => e.id === targetId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

    const [moved] = this._entries.splice(fromIdx, 1);
    const insertAt = fromIdx < toIdx ? toIdx : toIdx;
    this._entries.splice(insertAt, 0, moved);

    this._renderEntriesPanel();
    this._syncEntriesToSource();
    this._saveToStorage();
  }

  // ---------------------------------------------------------------------------
  // Bidirectional sync
  // ---------------------------------------------------------------------------

  /** Entries → source textarea (no parse-back triggered) */
  _syncEntriesToSource() {
    if (!this._sourceEditor) return;
    this._syncingSource = true;
    this._sourceEditor.value = entriesToSource(this._entries);
    this._sourceDirty = false;
    this._dirtyIndicator?.classList.add('hidden');
    if (this._sourceFilename) {
      this._sourceFilename.textContent = 'fxdata.txt (generated)';
    }
    this._syncingSource = false;
  }

  /** Source textarea → entries (parses source, re-renders panel) */
  _syncSourceToEntries() {
    if (!this._sourceEditor) return;
    const src = this._sourceEditor.value;
    this._entries = sourceToEntries(src);
    this._sourceDirty = false;
    this._dirtyIndicator?.classList.add('hidden');
    this._renderEntriesPanel();
    this._saveToStorage();
  }

  // ---------------------------------------------------------------------------
  // Entries panel rendering
  // ---------------------------------------------------------------------------

  _renderEntriesPanel() {
    if (!this._entriesList) return;

    if (this._entries.length === 0) {
      this._entriesList.innerHTML = `
        <div class="fxdata-empty-entries">
          <p>No entries yet.</p>
          <p class="fxdata-hint">Click + to add an entry, or import a fxdata.txt.</p>
        </div>`;
    } else {
      this._entriesList.innerHTML = '';
      for (const entry of this._entries) {
        this._entriesList.appendChild(this._createEntryCard(entry));
      }
    }

    // Always move the add-row into the list as the last child.
    // appendChild moves the real DOM node (event listeners intact),
    // so it flows naturally as the last item and sticks to the bottom when overflowing.
    if (this._addRow) {
      this._entriesList.appendChild(this._addRow);
    }
  }

  _createEntryCard(entry) {
    // Placeholder — a reserved slot shown while the flyout is open
    if (entry.type === '__placeholder__') {
      const card = document.createElement('div');
      card.className = 'fxdata-entry-card fxdata-entry-placeholder';
      card.dataset.id = '__placeholder__';
      return card;
    }

    const category = getEntryCategory(entry.type);
    const card = document.createElement('div');
    card.className = 'fxdata-entry-card';
    card.dataset.id = entry.id;
    card.draggable = true;

    // Drag handle
    const drag = document.createElement('div');
    drag.className = 'fxdata-entry-drag';
    drag.title = 'Drag to reorder';
    drag.textContent = '\u28FF';

    // Body
    const body = document.createElement('div');
    body.className = 'fxdata-entry-body';

    // Fields
    const hasName = typeHasName(entry.type);
    const hasValue = typeHasValue(entry.type);

    const isNumber = NUMERIC_TYPES.has(entry.type);
    const isDirective = DIRECTIVE_TYPES.has(entry.type);

    if (isNumber || isDirective) {
      const select = document.createElement('select');
      select.className = `fxdata-entry-type-select fxdata-type-${category}`;
      const options = isNumber
        ? ['uint8_t', 'uint16_t', 'uint24_t', 'uint32_t', 'int8_t', 'int16_t', 'int24_t', 'int32_t']
        : ['savesection', 'datasection', 'namespace', 'namespace_end', 'align'];
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === entry.type) o.selected = true;
        select.appendChild(o);
      }
      select.addEventListener('change', () => {
        entry.type = select.value;
        this._updateEntry(entry.id, { type: select.value });
        if (this._activePreviewEntryId === entry.id) this._showEntryPreview(entry);
        this._renderEntriesPanel();
      });
      body.appendChild(select);
    } else {
      // Static badge for string / image_t / raw_t
      const badge = document.createElement('span');
      badge.className = `fxdata-entry-type-badge fxdata-type-${category}`;
      badge.textContent = entry.type;
      body.appendChild(badge);
    }

    if (hasName && entry.type !== 'align') {
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'fxdata-entry-name';
      nameInput.value = entry.name;
      nameInput.placeholder = entry.type === 'namespace' ? 'Name' : 'name';
      nameInput.title = 'Symbol name';
      nameInput.addEventListener('change', () => {
        this._updateEntry(entry.id, { name: nameInput.value });
      });
      nameInput.addEventListener('input', () => {
        entry.name = nameInput.value;
        if (this._activePreviewEntryId === entry.id) this._showEntryPreview(entry);
      });
      body.appendChild(nameInput);
    }

    if (hasValue) {
      if (entry.type !== 'align') {
        const sep = document.createElement('span');
        sep.className = 'fxdata-entry-sep';
        sep.textContent = '=';
        body.appendChild(sep);
      }

      if (entry.type === 'image_t' || entry.type === 'raw_t') {
        // Asset file dropdown + browse button
        const valueDisplay = entry.value.replace(/^["']|["']$/g, ''); // unquote for display
        const allFiles = this._project.listFiles();
        const imgExts = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'];
        const binExts = ['.bin', '.dat', '.raw'];
        const validExts = entry.type === 'image_t' ? imgExts : binExts;
        const matchingFiles = allFiles.filter((f) => {
          const ext = f.slice(f.lastIndexOf('.')).toLowerCase();
          return validExts.includes(ext);
        });
        const assetExists = valueDisplay && allFiles.includes(valueDisplay);

        const valueSelect = document.createElement('select');
        valueSelect.className = 'fxdata-entry-value fxdata-entry-asset-select';
        if (this._isFileOverridden(valueDisplay)) {
          valueSelect.classList.add('fxdata-name-overridden');
        } else if (valueDisplay && !assetExists) {
          valueSelect.classList.add('fxdata-asset-missing');
        }

        // Empty option
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = entry.type === 'image_t' ? 'Select image...' : 'Select file...';
        emptyOpt.hidden = true;
        valueSelect.appendChild(emptyOpt);

        // If current value doesn't match any file, add it as a special option
        if (valueDisplay && !matchingFiles.includes(valueDisplay)) {
          const missingOpt = document.createElement('option');
          missingOpt.value = valueDisplay;
          missingOpt.textContent = valueDisplay + ' (missing)';
          missingOpt.className = 'fxdata-option-missing';
          valueSelect.appendChild(missingOpt);
        }

        for (const file of matchingFiles) {
          const opt = document.createElement('option');
          opt.value = file;
          opt.textContent = file;
          valueSelect.appendChild(opt);
        }

        valueSelect.value = valueDisplay;

        valueSelect.addEventListener('change', () => {
          const selected = valueSelect.value;
          this._updateEntry(entry.id, { value: selected ? `"${selected}"` : '""' });
          // Update styling
          const exists = selected && this._project.listFiles().includes(selected);
          valueSelect.classList.toggle('fxdata-asset-missing', selected && !exists);
          valueSelect.classList.toggle('fxdata-name-overridden', this._isFileOverridden(selected));
          // Auto-preview the selected asset
          entry.value = selected ? `"${selected}"` : '""';
          this._showEntryPreview(entry);
        });
        body.appendChild(valueSelect);

        // Browse button — always opens file dialog to add a new file
        const browseBtn = document.createElement('button');
        browseBtn.className = 'fxdata-entry-browse';
        browseBtn.textContent = '...';
        browseBtn.title = 'Import file and assign to this entry';
        browseBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._importFileForEntry(entry, valueSelect);
        });
        body.appendChild(browseBtn);
      } else {
        const valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.className = 'fxdata-entry-value';
        valueInput.value = entry.value;
        valueInput.placeholder = entry.type === 'align' ? '256' : 'value(s)';
        valueInput.title = entry.type === 'align' ? 'Page alignment size' : 'Value(s)';
        valueInput.addEventListener('change', () => {
          this._updateEntry(entry.id, { value: valueInput.value });
        });
        valueInput.addEventListener('input', () => {
          entry.value = valueInput.value;
          if (this._activePreviewEntryId === entry.id) this._showEntryPreview(entry);
        });
        body.appendChild(valueInput);
      }
    }

    // Delete button
    const del = document.createElement('button');
    del.className = 'fxdata-entry-delete';
    del.textContent = '\u00D7';
    del.title = 'Remove entry';
    del.addEventListener('click', () => this._removeEntry(entry.id));

    // Click anywhere on card to preview
    card.addEventListener('click', () => {
      this._entriesList?.querySelectorAll('.fxdata-entry-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      this._activePreviewEntryId = entry.id;
      this._showEntryPreview(entry);
    });

    // Drag events
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', entry.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      this._entriesList?.querySelectorAll('.fxdata-entry-card').forEach((c) =>
        c.classList.remove('drag-over'),
      );
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this._entriesList?.querySelectorAll('.fxdata-entry-card').forEach((c) =>
        c.classList.remove('drag-over'),
      );
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', (e) => {
      if (!card.contains(e.relatedTarget)) {
        card.classList.remove('drag-over');
      }
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (draggedId && draggedId !== entry.id) {
        this._reorderEntries(draggedId, entry.id);
      }
    });

    card.appendChild(drag);
    card.appendChild(body);
    card.appendChild(del);
    return card;
  }

  // ---------------------------------------------------------------------------
  // Add-entry flyout hub
  // ---------------------------------------------------------------------------

  _toggleAddFlyout() {
    if (this._addHub?.classList.contains('open')) {
      this._closeAddFlyout();
    } else {
      this._openAddFlyout();
    }
  }

  _openAddFlyout() {
    if (this._addHub?.classList.contains('open')) return;

    // Snapshot add-row position BEFORE inserting placeholder
    const beforeTop = this._addRow?.getBoundingClientRect().top ?? null;

    // Insert placeholder at end of entries — this reserves space and
    // naturally pushes the add-row downward
    const placeholder = makeEntry('uint8_t');
    placeholder.id   = '__placeholder__';
    placeholder.type = '__placeholder__';
    this._entries.push(placeholder);
    this._renderEntriesPanel();

    // FLIP: animate add-row from its old position to the new (lower) one
    this._flipAddRow(beforeTop);

    // Expand chips
    this._addHub.classList.add('open');
  }

  _closeAddFlyout() {
    if (!this._addHub?.classList.contains('open')) return;
    this._addHub.classList.remove('open');

    // Remove placeholder if it's still there (cancel path;
    // commit path replaces it before calling closeAddFlyout)
    const idx = this._entries.findIndex((e) => e.id === '__placeholder__');
    if (idx !== -1) {
      const beforeTop = this._addRow?.getBoundingClientRect().top ?? null;
      this._entries.splice(idx, 1);
      this._renderEntriesPanel();
      this._flipAddRow(beforeTop);
    }
  }

  /** FLIP-animate the add-row from `beforeTop` to wherever it is now. */
  _flipAddRow(beforeTop) {
    if (!this._addRow || beforeTop == null) return;
    // Clear any in-progress FLIP to avoid compounding transforms
    this._addRow.style.transition = 'none';
    this._addRow.style.transform  = '';
    const afterTop = this._addRow.getBoundingClientRect().top;
    const dy = beforeTop - afterTop;
    if (Math.abs(dy) < 1) return;
    this._addRow.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._addRow.style.transition = 'transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)';
        this._addRow.style.transform  = 'translateY(0)';
      });
    });
    this._addRow.addEventListener('transitionend', () => {
      if (this._addRow) {
        this._addRow.style.transition = '';
        this._addRow.style.transform  = '';
      }
    }, { once: true });
  }

  /**
   * Chip selected: clone flies UP to the placeholder card, placeholder is
   * replaced in-place with the real entry (no layout shift), chips collapse.
   */
  _commitChip(chipEl, category) {
    const chipRect = chipEl.getBoundingClientRect();

    // Where does the placeholder card sit right now?
    const placeholderCard = this._entriesList?.querySelector('[data-id="__placeholder__"]');
    const placeholderRect = placeholderCard?.getBoundingClientRect();
    const DRAG_HANDLE_W   = 28;
    const targetLeft = placeholderRect
      ? placeholderRect.left + DRAG_HANDLE_W
      : chipRect.left;
    const targetTop = placeholderRect
      ? placeholderRect.top + (placeholderRect.height - chipRect.height) / 2
      : chipRect.top - 80;

    // Clone the chip for the animation — original stays in hub
    const clone = chipEl.cloneNode(true);
    clone.classList.add('fxdata-chip-flying');
    clone.style.top     = `${chipRect.top}px`;
    clone.style.left    = `${chipRect.left}px`;
    clone.style.width   = `${chipRect.width}px`;
    clone.style.height  = `${chipRect.height}px`;
    clone.style.padding = window.getComputedStyle(chipEl).padding;
    clone.style.opacity = '1';
    clone.style.transform = 'none';
    document.body.appendChild(clone);

    // Collapse chips immediately — button already at correct position
    // since the placeholder (same height as real card) keeps layout stable.
    this._addHub?.classList.remove('open');

    // Fly the clone to the placeholder position
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clone.style.transition = [
          'left 0.36s cubic-bezier(0.22, 1, 0.36, 1)',
          'top  0.36s cubic-bezier(0.22, 1, 0.36, 1)',
          'opacity 0.22s ease 0.16s',
        ].join(', ');
        clone.style.left    = `${targetLeft}px`;
        clone.style.top     = `${targetTop}px`;
        clone.style.opacity = '0';
      });
    });

    setTimeout(() => {
      clone.remove();
      // Replace placeholder in-place — same height, so no layout shift
      const idx = this._entries.findIndex((e) => e.id === '__placeholder__');
      if (idx !== -1) {
        const newEntry = makeEntry(CATEGORY_DEFAULT[category]);
        if (newEntry.type === 'align') newEntry.value = '256';
        this._entries[idx] = newEntry;
        this._renderEntriesPanel();
        this._syncEntriesToSource();
        this._saveToStorage();
        // Focus the new card's first input
        setTimeout(() => {
          const card  = this._entriesList?.querySelector(`[data-id="${newEntry.id}"]`);
          const input = card?.querySelector('.fxdata-entry-name, .fxdata-entry-value');
          input?.focus();
        }, 40);
      }
    }, 220);
  }

  // ---------------------------------------------------------------------------
  // Import file for entry (always opens file dialog)
  // ---------------------------------------------------------------------------

  _importFileForEntry(entry, selectEl) {
    const tempInput = document.createElement('input');
    tempInput.type = 'file';
    tempInput.accept = entry.type === 'image_t' ? 'image/*' : '*/*';
    tempInput.addEventListener('change', async () => {
      const file = tempInput.files?.[0];
      if (!file) return;
      const path = file.name;
      if (this._project.hasFile(path)) {
        const allowed = await this._confirmOverwrite(path);
        if (!allowed) return;
      }
      const buffer = await file.arrayBuffer();
      this._project.addFile(path, new Uint8Array(buffer));
      this._renderAssetTree();

      // Update the entry to point to the new file
      entry.value = `"${path}"`;
      this._updateEntry(entry.id, { value: `"${path}"` });
      this._syncEntriesToSource();
      this._saveToStorage();

      // Re-render to update the dropdown with the new file
      this._renderEntriesPanel();

      // Show preview of the newly added asset
      this._showEntryPreview(entry);
      showToast(`Added and selected: ${file.name}`, 'success');
    });
    tempInput.click();
  }

  // ---------------------------------------------------------------------------
  // Asset picker for image_t / raw_t entries
  // ---------------------------------------------------------------------------

  _showAssetPicker(entryId, valueInput, type) {
    const imgExts = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp']);
    const binExts = new Set(['.bin', '.dat', '.raw']);
    const validExts = type === 'image_t' ? imgExts : type === 'raw_t' ? binExts : null;

    const files = this._project.listFiles().filter((f) => {
      if (!validExts) return true;
      const ext = f.slice(f.lastIndexOf('.')).toLowerCase();
      return validExts.has(ext);
    });

    // Remove existing picker
    document.getElementById('fxdata-asset-picker')?.remove();

    if (files.length === 0) {
      // No matching assets — open file picker to add one, then re-prompt
      const tempInput = document.createElement('input');
      tempInput.type = 'file';
      tempInput.accept = type === 'image_t' ? 'image/*' : '*/*';
      tempInput.addEventListener('change', async () => {
        const file = tempInput.files?.[0];
        if (!file) return;
        const buffer = await file.arrayBuffer();
        const path = file.name;
        this._project.addFile(path, new Uint8Array(buffer));
        this._renderAssetTree();
        this._saveToStorage();
        const unquoted = path;
        valueInput.value = unquoted;
        this._updateEntry(entryId, { value: `"${unquoted}"` });
        showToast(`Added and selected: ${file.name}`, 'success');
      });
      tempInput.click();
      return;
    }

    const picker = document.createElement('div');
    picker.id = 'fxdata-asset-picker';
    picker.className = 'fxdata-type-dropdown';

    const rect = valueInput.getBoundingClientRect();
    picker.style.left = `${rect.left}px`;
    picker.style.top = `${rect.bottom + 2}px`;

    for (const file of files) {
      const btn = document.createElement('button');
      btn.textContent = file;
      btn.addEventListener('click', () => {
        valueInput.value = file;
        this._updateEntry(entryId, { value: `"${file}"` });
        picker.remove();
      });
      picker.appendChild(btn);
    }

    document.body.appendChild(picker);
    const dismiss = (e) => {
      if (!picker.contains(e.target) && e.target !== valueInput) {
        picker.remove();
        document.removeEventListener('click', dismiss, true);
      }
    };
    setTimeout(() => document.addEventListener('click', dismiss, true), 0);
  }

  // ---------------------------------------------------------------------------
  // Asset tree (folder view — nested)
  // ---------------------------------------------------------------------------

  /**
   * Build hierarchical tree structure from VFS paths.
   * Returns a map of parentPath → { files: [], folders: [] }
   */
  _buildAssetTree() {
    const files = this._project.listFiles();

    // Discover all implicit directories from file paths
    const implicitFolders = new Set();
    for (const path of files) {
      let slashIdx = path.indexOf('/');
      while (slashIdx !== -1) {
        implicitFolders.add(path.slice(0, slashIdx));
        slashIdx = path.indexOf('/', slashIdx + 1);
      }
    }

    // Include all explicit folders (even empty ones) and implicit ones
    const allFolders = new Set([...this._folders, ...implicitFolders]);

    // For each path, determine its parent and add to parent's children
    const folderChildren = new Map();

    // Register all folders under their parents first
    for (const folder of allFolders) {
      const slashIdx = folder.lastIndexOf('/');
      const parentPath = slashIdx === -1 ? '' : folder.slice(0, slashIdx);
      if (!folderChildren.has(parentPath)) {
        folderChildren.set(parentPath, { files: [], folders: [] });
      }
      folderChildren.get(parentPath).folders.push(folder);
      // Ensure the folder itself has an entry (even if empty)
      if (!folderChildren.has(folder)) {
        folderChildren.set(folder, { files: [], folders: [] });
      }
    }

    // Register files under their parent folders
    for (const path of files) {
      const slashIdx = path.lastIndexOf('/');
      const parentPath = slashIdx === -1 ? '' : path.slice(0, slashIdx);
      if (!folderChildren.has(parentPath)) {
        folderChildren.set(parentPath, { files: [], folders: [] });
      }
      folderChildren.get(parentPath).files.push(path);
    }

    // Ensure root entry exists
    if (!folderChildren.has('')) {
      folderChildren.set('', { files: [], folders: [] });
    }

    // Sort children
    for (const { files: fileList, folders: folderList } of folderChildren.values()) {
      fileList.sort();
      folderList.sort();
    }

    return folderChildren;
  }

  _renderAssetTree() {
    if (!this._fileTree) return;
    const folderChildren = this._buildAssetTree();

    const rootContent = folderChildren.get('') || { files: [], folders: [] };
    if (rootContent.files.length === 0 && rootContent.folders.length === 0) {
      this._fileTree.innerHTML = `
        <div class="fxdata-empty-tree">
          <p class="fxdata-hint">Images and binary files appear here.</p>
         </div>`;
      return;
    }

    this._fileTree.innerHTML = '';

    // Root files
    for (const path of rootContent.files) {
      this._fileTree.appendChild(this._createFileItem(path, ''));
    }

    // Root folders (recursively)
    for (const folderPath of rootContent.folders) {
      this._fileTree.appendChild(this._createFolderSection(folderPath, folderChildren, 0));
    }
  }

  /**
   * Create a folder section with recursive child folders.
   * @param {string} folderPath - The full path of this folder
   * @param {Map} folderChildren - Map from parentPath → { files, folders }
   * @param {number} depth - For indentation purposes
   */
  _createFolderSection(folderPath, folderChildren, depth = 0) {
    const section = document.createElement('div');
    section.className = 'fxdata-folder-section';
    section.dataset.folder = folderPath;
    section.style.marginLeft = `${depth * 12}px`;
    section.draggable = true;

    // Header row
    const header = document.createElement('div');
    header.className = 'fxdata-folder-header';

    const arrow = document.createElement('span');
    arrow.className = 'fxdata-folder-arrow';
    arrow.textContent = '▾';

    const folderIcon = document.createElement('span');
    folderIcon.className = 'fxdata-folder-icon';
    folderIcon.textContent = '📁';

    // Display only the last component of the path (for nested folders)
    const displayName = folderPath.slice(folderPath.lastIndexOf('/') + 1);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'fxdata-folder-name';
    nameSpan.textContent = displayName;
    nameSpan.title = `Click to rename folder`;

    nameSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      this._startFolderRename(nameSpan, folderPath);
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'fxdata-file-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.title = 'Remove folder and all its contents';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._removeFolder(folderPath);
    });

    header.appendChild(arrow);
    header.appendChild(folderIcon);
    header.appendChild(nameSpan);
    header.appendChild(removeBtn);

    // Content (files + subfolders)
    const content = document.createElement('div');
    content.className = 'fxdata-folder-content';

    const children = folderChildren.get(folderPath) || { files: [], folders: [] };

    // Files in this folder
    for (const path of children.files) {
      content.appendChild(this._createFileItem(path, folderPath));
    }

    // Subfolders
    for (const subfolderPath of children.folders) {
      content.appendChild(this._createFolderSection(subfolderPath, folderChildren, depth + 1));
    }

    // Collapse/expand toggle
    let collapsed = false;
    header.addEventListener('click', () => {
      collapsed = !collapsed;
      arrow.textContent = collapsed ? '▸' : '▾';
      content.style.display = collapsed ? 'none' : '';
    });

    // Drag to move folder
    section.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/fxdata-folder', folderPath);
      e.dataTransfer.effectAllowed = 'move';
      section.classList.add('fxdata-dragging');
      e.stopPropagation();
    });
    section.addEventListener('dragend', () => {
      section.classList.remove('fxdata-dragging');
    });

    // Drag-over folder drop target (accept both files and folders)
    section.addEventListener('dragover', (e) => {
      const isFile = e.dataTransfer.types.includes('application/fxdata-file');
      const isFolder = e.dataTransfer.types.includes('application/fxdata-folder');
      if (isFile || isFolder) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        section.classList.add('fxdata-drag-over');
      }
    });
    section.addEventListener('dragleave', (e) => {
      if (!section.contains(e.relatedTarget)) {
        section.classList.remove('fxdata-drag-over');
      }
    });
    section.addEventListener('drop', (e) => {
      const fileSrc = e.dataTransfer.getData('application/fxdata-file');
      const folderSrc = e.dataTransfer.getData('application/fxdata-folder');
      if (!fileSrc && !folderSrc) return;
      e.preventDefault();
      e.stopPropagation();
      section.classList.remove('fxdata-drag-over');
      if (fileSrc) {
        this._moveFile(fileSrc, folderPath);
      } else if (folderSrc && folderSrc !== folderPath) {
        this._moveFolder(folderSrc, folderPath);
      }
    });

    section.appendChild(header);
    section.appendChild(content);
    return section;
  }

  _createFileItem(path, folder) {
    const item = document.createElement('div');
    item.className = 'fxdata-file-item';
    if (folder) item.classList.add('fxdata-file-item-nested');
    item.draggable = true;

    const icon = document.createElement('span');
    icon.className = `fxdata-file-icon fxdata-file-type-${getFileType(path)}`;

    const displayName = path.slice(path.lastIndexOf('/') + 1);
    const name = document.createElement('span');
    name.className = 'fxdata-file-name';
    name.textContent = displayName;
    name.title = `${path} — click to rename`;

    // Highlight overridden filenames in yellow
    if (this._isFileOverridden(path)) {
      name.classList.add('fxdata-name-overridden');
    }

    name.addEventListener('click', (e) => {
      e.stopPropagation();
      this._startFileRename(name, path);
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'fxdata-file-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.title = 'Remove from project';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._project.removeFile(path);
      this._renderAssetTree();
      this._saveToStorage();
      showToast(`Removed: ${path}`, 'info');
    });

    // Click to preview (excluding clicks on name/remove)
    item.addEventListener('click', (e) => {
      if (e.target !== name && e.target !== removeBtn) {
        this._showAssetPreviewByPath(path);
      }
    });

    // Drag to move file
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/fxdata-file', path);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('fxdata-dragging');
      e.stopPropagation();
    });
    item.addEventListener('dragend', () => item.classList.remove('fxdata-dragging'));

    item.appendChild(icon);
    item.appendChild(name);
    item.appendChild(removeBtn);
    return item;
  }

  // ---------------------------------------------------------------------------
  // Folder management
  // ---------------------------------------------------------------------------

  _addFolder() {
    const base = 'new-folder';
    let name = base;
    let n = 1;
    // Find a unique name
    const existing = new Set([...this._folders, ...this._project.listFiles().map((p) => p.split('/')[0])]);
    while (existing.has(name)) name = `${base}-${n++}`;

    this._folders.add(name);
    this._renderAssetTree();
    this._saveToStorage();

    // Immediately trigger inline rename of the new folder
    setTimeout(() => {
      const nameEls = this._fileTree?.querySelectorAll('.fxdata-folder-name');
      for (const el of nameEls ?? []) {
        if (el.textContent === name) {
          this._startFolderRename(el, name);
          break;
        }
      }
    }, 0);
  }

  _startFolderRename(nameEl, oldFolder) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fxdata-inline-rename';
    input.value = oldFolder;
    nameEl.replaceWith(input);
    input.select();
    input.focus();

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      // Allow slashes to create nested structure (e.g., "images/sprites")
      const newFolder = input.value.trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
      if (newFolder && newFolder !== oldFolder) {
        // Rename all files in the old folder to be under the new path
        const toMove = this._project.listFiles().filter((p) => {
          const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
          return dir === oldFolder;
        });
        // Check for collisions at destination before moving
        const conflicts = toMove.filter((p) => {
          const fileName = p.slice(p.lastIndexOf('/') + 1);
          return this._project.hasFile(`${newFolder}/${fileName}`);
        });
        if (conflicts.length > 0) {
          const names = conflicts.map(p => p.slice(p.lastIndexOf('/') + 1)).join(', ');
          showToast(`Cannot rename folder — files already exist at destination: ${names}`, 'error');
          this._renderAssetTree();
          return;
        }
        for (const p of toMove) {
          const fileName = p.slice(p.lastIndexOf('/') + 1);
          const fileData = this._project.getFile(p);
          this._project.addFile(`${newFolder}/${fileName}`, fileData.data);
          this._project.removeFile(p);
        }
        // Update explicit folder set
        if (this._folders.has(oldFolder)) {
          this._folders.delete(oldFolder);
          this._folders.add(newFolder);
        }
        this._saveToStorage();
        showToast(`Folder renamed to: ${newFolder}`, 'info');
      } else if (!newFolder) {
        // cancelled/empty — remove if it was explicit and empty
        if (this._folders.has(oldFolder)) {
          const hasFiles = this._project.listFiles().some((p) => {
            const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
            return dir === oldFolder;
          });
          if (!hasFiles) this._folders.delete(oldFolder);
        }
        this._saveToStorage();
      }
      this._renderAssetTree();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') {
        committed = true; // skip commit
        this._renderAssetTree();
      }
    });
  }

  _startFileRename(nameEl, oldPath) {
    const folder = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
    const oldName = oldPath.slice(oldPath.lastIndexOf('/') + 1);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fxdata-inline-rename';
    input.value = oldName;
    nameEl.replaceWith(input);
    input.select();
    input.focus();

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (newName && newName !== oldName) {
        const newPath = folder ? `${folder}/${newName}` : newName;
        if (this._project.hasFile(newPath)) {
          showToast(`A file named "${newName}" already exists here`, 'error');
        } else {
          const fileData = this._project.getFile(oldPath);
          this._project.addFile(newPath, fileData.data);
          this._project.removeFile(oldPath);
          this._saveToStorage();
          showToast(`Renamed to: ${newName}`, 'info');
        }
      }
      this._renderAssetTree();
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') {
        committed = true;
        this._renderAssetTree();
      }
    });
  }

  _removeFolder(folder) {
    const toRemove = this._project.listFiles().filter((p) => {
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      return dir === folder;
    });
    for (const p of toRemove) this._project.removeFile(p);
    this._folders.delete(folder);
    this._renderAssetTree();
    this._saveToStorage();
    const msg = toRemove.length > 0
      ? `Removed folder "${folder}" and ${toRemove.length} file(s)`
      : `Removed folder: ${folder}`;
    showToast(msg, 'info');
  }

  _moveFile(oldPath, targetFolder) {
    const fileName = oldPath.slice(oldPath.lastIndexOf('/') + 1);
    const newPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;
    if (newPath === oldPath) return;
    if (this._project.hasFile(newPath)) {
      showToast(`"${fileName}" already exists in the target location`, 'error');
      return;
    }
    const fileData = this._project.getFile(oldPath);
    this._project.addFile(newPath, fileData.data);
    this._project.removeFile(oldPath);
    this._renderAssetTree();
    this._saveToStorage();
    const dest = targetFolder || '(root)';
    showToast(`Moved "${fileName}" → ${dest}`, 'info');
  }

  _moveFolder(oldPath, targetFolder) {
    // Prevent moving a folder into itself or its children
    if (oldPath === targetFolder) return;
    if (targetFolder.startsWith(oldPath + '/')) {
      showToast(`Cannot move "${oldPath}" into itself`, 'error');
      return;
    }

    const folderName = oldPath.slice(oldPath.lastIndexOf('/') + 1);
    const newPath = targetFolder ? `${targetFolder}/${folderName}` : folderName;

    if (newPath === oldPath) return;

    // Check if a folder with this name already exists at target
    const files = this._project.listFiles();
    const existingAtTarget = files.some((p) => p.startsWith(newPath + '/')) ||
                             this._folders.has(newPath);
    if (existingAtTarget) {
      showToast(`A folder named "${folderName}" already exists in the target location`, 'error');
      return;
    }

    // Move all files and subfolders: oldPath/* → newPath/*
    const toMove = files.filter((p) => {
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      return dir === oldPath || p.startsWith(oldPath + '/');
    });

    // Check for individual file collisions at destination
    const fileConflicts = toMove.filter((p) => {
      const suffix = p.slice(oldPath.length);
      const newP = newPath + suffix;
      return this._project.hasFile(newP);
    });
    if (fileConflicts.length > 0) {
      const names = fileConflicts.map(p => p.slice(p.lastIndexOf('/') + 1)).join(', ');
      showToast(`Cannot move folder — files already exist at destination: ${names}`, 'error');
      return;
    }

    for (const p of toMove) {
      const suffix = p.slice(oldPath.length); // includes the leading /
      const newP = newPath + suffix;
      const fileData = this._project.getFile(p);
      this._project.addFile(newP, fileData.data);
      this._project.removeFile(p);
    }

    // Update explicit folders set
    if (this._folders.has(oldPath)) {
      this._folders.delete(oldPath);
      this._folders.add(newPath);
    }

    // Also update any subfolders in the set
    const subFolders = [...this._folders].filter((f) => f.startsWith(oldPath + '/'));
    for (const f of subFolders) {
      this._folders.delete(f);
      const newF = newPath + f.slice(oldPath.length);
      this._folders.add(newF);
    }

    this._renderAssetTree();
    this._saveToStorage();
    const dest = targetFolder || '(root)';
    showToast(`Moved folder "${folderName}" → ${dest}`, 'info');
  }

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------

  async _doBuild() {
    // Sync source first if dirty
    if (this._sourceDirty) {
      this._syncSourceToEntries();
    }

    // Run client-side validation first
    this._clearFieldErrors();
    const validationErrors = this._validateEntries();
    if (validationErrors.length > 0) {
      this._applyFieldErrors(validationErrors);
      // Build validation-only result for the output panel
      const valResult = {
        success: false,
        diagnostics: validationErrors.map((d) => ({
          severity: d.severity,
          message: d.message,
          file: 'fxdata.txt',
          line: d.line ?? 0,
        })),
      };
      this._renderBuildOutput(valResult, validationErrors);
      showToast('Fix validation errors before building', 'error');
      return;
    }

    const source = entriesToSource(this._entries);
    if (!source.trim()) {
      showToast('No entries to build. Add some entries first.', 'warning');
      return;
    }

    const threshold = parseInt(this._thresholdSlider?.value ?? '128', 10);

    if (this._buildOutput) {
      this._buildOutput.innerHTML = '<div class="fxdata-build-msg info">Building...</div>';
    }

    try {
      // Put generated source into the VFS temporarily
      this._project.addFile('fxdata.txt', source);

      const result = await buildFxData(this._project, 'fxdata.txt', { threshold });

      // Remove the temporary file
      this._project.removeFile('fxdata.txt');

      this._lastBuild = result;
      this._renderBuildOutput(result);
      this._renderMemoryMap(result);
      this._renderStructuredView(result);

      if (result.success) {
        if (this._btnExport) this._btnExport.disabled = false;
        showToast(`Build succeeded — ${result.dataSize} bytes data`, 'success');
      } else {
        showToast('Build completed with errors', 'error');
      }
    } catch (err) {
      this._project.removeFile('fxdata.txt');
      if (this._buildOutput) {
        this._buildOutput.innerHTML = `<div class="fxdata-build-msg error">Build failed: ${escapeHtml(err.message)}</div>`;
      }
      this._toggleBuildAccordion(true);
      this._buildAccordionToggle?.classList.add('has-errors');
      showToast(`Build failed: ${err.message}`, 'error');
      console.error('FX Data build error:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Build output rendering
  // ---------------------------------------------------------------------------

  /**
   * Validate entries before build and return diagnostics with field info.
   * Each diagnostic: { severity, message, entryId, field: 'name'|'value'|null }
   */
  _validateEntries() {
    const diagnostics = [];
    const seenNames = new Map(); // name → first entry id
    const needsName = (type) => typeHasName(type) && type !== 'align';

    for (const entry of this._entries) {
      if (entry.type === '__placeholder__') continue;
      const { id, type, name, value } = entry;

      // --- Name validation ---
      if (needsName(type)) {
        if (!name || !name.trim()) {
          diagnostics.push({ severity: 'error', message: `Missing symbol name for ${type}`, entryId: id, field: 'name' });
        } else if (!VALID_NAME_RE.test(name)) {
          diagnostics.push({ severity: 'error', message: `Invalid symbol name "${name}" — must start with a letter or underscore and contain only letters, digits, underscores`, entryId: id, field: 'name' });
        } else if (RESERVED_WORDS.has(name)) {
          diagnostics.push({ severity: 'error', message: `"${name}" is a reserved keyword`, entryId: id, field: 'name' });
        } else if (seenNames.has(name)) {
          diagnostics.push({ severity: 'error', message: `Duplicate symbol name "${name}"`, entryId: id, field: 'name' });
        } else {
          seenNames.set(name, id);
        }
      }

      // --- Value validation ---
      if (typeHasValue(type)) {
        const trimVal = (value || '').trim();

        if (NUMERIC_TYPES.has(type)) {
          if (!trimVal) {
            diagnostics.push({ severity: 'error', message: `Missing value for ${type} "${name || '(unnamed)'}"`, entryId: id, field: 'value' });
          } else {
            // Check each comma-separated numeric value
            const range = INT_RANGES[type];
            const parts = trimVal.split(/[,\s]+/).filter(Boolean);
            for (const p of parts) {
              const n = p.startsWith('0x') || p.startsWith('0X') ? parseInt(p, 16)
                      : p.startsWith('0b') || p.startsWith('0B') ? parseInt(p.slice(2), 2)
                      : Number(p);
              if (isNaN(n)) continue; // Could be a symbol reference — parser handles this
              if (range && (n < range.min || n > range.max)) {
                diagnostics.push({ severity: 'error', message: `Value ${p} out of range for ${type} (${range.min} to ${range.max})`, entryId: id, field: 'value' });
              }
            }
          }
        } else if (type === 'image_t' || type === 'raw_t') {
          if (!trimVal || trimVal === '""' || trimVal === "''") {
            diagnostics.push({ severity: 'error', message: `No file selected for ${type} "${name || '(unnamed)'}"`, entryId: id, field: 'value' });
          }
        } else if (type === 'align') {
          const n = Number(trimVal);
          if (!trimVal || isNaN(n) || n <= 0 || !Number.isInteger(n)) {
            diagnostics.push({ severity: 'error', message: `Align value must be a positive integer`, entryId: id, field: 'value' });
          }
        } else if (type === 'string') {
          const stripped = trimVal.replace(/^["']|["']$/g, '');
          if (!trimVal || stripped.length === 0) {
            diagnostics.push({ severity: 'error', message: `Empty string value for "${name || '(unnamed)'}"`, entryId: id, field: 'value' });
          }
        }
      }
    }
    // Assign 1-based line numbers matching entriesToSource output order
    const visibleForLines = this._entries.filter((e) => e.type !== '__placeholder__');
    for (const d of diagnostics) {
      if (!d.line) {
        const idx = visibleForLines.findIndex((e) => e.id === d.entryId);
        d.line = idx >= 0 ? idx + 1 : 0;
      }
    }
    return diagnostics;
  }

  /** Clear error highlights from all entry fields */
  _clearFieldErrors() {
    this._entriesList?.querySelectorAll('.has-error').forEach((el) => {
      el.classList.remove('has-error');
    });
  }

  /** Apply field-level error highlights from diagnostics */
  _applyFieldErrors(diagnostics) {
    for (const d of diagnostics) {
      if (d.severity !== 'error' || !d.entryId) continue;
      const card = this._entriesList?.querySelector(`.fxdata-entry-card[data-id="${CSS.escape(d.entryId)}"]`);
      if (!card) continue;
      if (d.field === 'name') {
        card.querySelector('.fxdata-entry-name')?.classList.add('has-error');
      } else if (d.field === 'value') {
        const el = card.querySelector('.fxdata-entry-value, .fxdata-entry-asset-select');
        el?.classList.add('has-error');
      }
    }
  }

  /** Map parser diagnostics (line-based) to entry field errors */
  _mapParserDiagnostics(diagnostics) {
    const mapped = [];
    const visibleEntries = this._entries.filter((e) => e.type !== '__placeholder__');
    for (const d of diagnostics) {
      if (d.severity !== 'error' || d.file !== 'fxdata.txt') continue;
      const entry = visibleEntries[d.line - 1];
      if (!entry) continue;
      // Infer which field the error is about from the message
      let field = 'value'; // default: most errors relate to values
      if (/symbol|label|name/i.test(d.message) && !/undefined symbol/i.test(d.message)) {
        field = 'name';
      }
      mapped.push({ severity: 'error', message: d.message, entryId: entry.id, field });
    }
    return mapped;
  }

  _renderBuildOutput(result, precomputedFieldErrors = null) {
    // Clear all previous error states
    this._clearFieldErrors();

    // Apply field-level error highlights
    if (precomputedFieldErrors) {
      this._applyFieldErrors(precomputedFieldErrors);
    } else {
      const parserErrors = this._mapParserDiagnostics(result.diagnostics);
      if (parserErrors.length > 0) {
        this._applyFieldErrors(parserErrors);
      }
    }

    // Build a unified list of field-mapped diagnostics for hover behaviour
    const fieldDiagnostics = precomputedFieldErrors
      ? precomputedFieldErrors
      : this._mapParserDiagnostics(result.diagnostics);
    const fieldDiagByMsg = new Map(fieldDiagnostics.map((d) => [d.message, d]));

    if (this._buildOutput) {
      this._buildOutput.innerHTML = '';
    }
    const frag = document.createDocumentFragment();

    const addMsg = (cls, text, entryId = null, field = null) => {
      const el = document.createElement('div');
      el.className = `fxdata-build-msg ${cls}`;
      el.textContent = text;
      if (entryId && field) {
        el.dataset.entryId = entryId;
        el.dataset.field = field;
        el.classList.add('fxdata-build-msg-linked');
        el.addEventListener('mouseenter', () => {
          const card = this._entriesList?.querySelector(`.fxdata-entry-card[data-id="${CSS.escape(entryId)}"]`);
          if (!card) return;
          const target = field === 'name'
            ? card.querySelector('.fxdata-entry-name')
            : card.querySelector('.fxdata-entry-value, .fxdata-entry-asset-select');
          target?.classList.add('hover-highlight');
        });
        el.addEventListener('mouseleave', () => {
          this._entriesList?.querySelectorAll('.hover-highlight').forEach((el) => el.classList.remove('hover-highlight'));
        });
      }
      frag.appendChild(el);
    };

    if (result.success) {
      addMsg('success', 'Build succeeded');
    } else {
      addMsg('error', 'Build completed with errors');
    }

    for (const d of result.diagnostics) {
      const loc = d.file && d.line ? `${d.file}:${d.line} ` : '';
      const linked = fieldDiagByMsg.get(d.message);
      addMsg(d.severity, `${loc}${d.message}`, linked?.entryId ?? null, linked?.field ?? null);
    }

    if (this._buildOutput) {
      this._buildOutput.appendChild(frag);
    }

    // Auto-open accordion on build failure; close/leave closed on success
    const hasErrors = !result.success || result.diagnostics.some((d) => d.severity === 'error');
    if (hasErrors) {
      this._toggleBuildAccordion(true);
      this._buildAccordionToggle?.classList.add('has-errors');
    } else {
      this._buildAccordionToggle?.classList.remove('has-errors');
    }

    this._buildActions?.classList.remove('hidden');
    if (this._downloadContainer) {
      if (!this._downloadContainer.classList.contains('hidden')) {
        // Already visible — flash it to signal a new build result
        this._downloadContainer.classList.remove('flash');
        void this._downloadContainer.offsetWidth; // force reflow to restart animation
        this._downloadContainer.classList.add('flash');
        this._downloadContainer.addEventListener('animationend', () => {
          this._downloadContainer.classList.remove('flash');
        }, { once: true });
      } else {
        // First reveal — slide it in
        this._downloadContainer.classList.remove('hidden');
        this._downloadContainer.classList.add('revealing');
        this._downloadContainer.addEventListener('animationend', () => {
          this._downloadContainer.classList.remove('revealing');
        }, { once: true });
      }
    }
    if (result.saveBin) {
      this._dlSave?.classList.remove('hidden');
    } else {
      this._dlSave?.classList.add('hidden');
    }
  }

  _clearBuildOutput() {
    if (this._buildOutput) {
      this._buildOutput.innerHTML = '<div class="fxdata-empty-output">No build results yet.</div>';
    }
    this._toggleBuildAccordion(false);
    this._buildAccordionToggle?.classList.remove('has-errors');
    this._buildActions?.classList.add('hidden');
    this._downloadContainer?.classList.add('hidden');
    this._clearFieldErrors();
  }

  // ---------------------------------------------------------------------------
  // Memory map rendering
  // ---------------------------------------------------------------------------

  _renderMemoryMap(result) {
    if (!result.memoryMap || result.memoryMap.length === 0) {
      if (this._memoryMap) {
        this._memoryMap.innerHTML = '<div class="fxdata-empty-map">No entries in memory map.</div>';
      }
      this._memorySummary?.classList.add('hidden');
      return;
    }

    const totalSize = result.dataSize + result.saveSize;
    
    // Filter out zero-size markers from bar calculation
    const nonZeroEntries = result.memoryMap.filter(e => e.size > 0);

    // Create continuous horizontal bar
    const barSegments = nonZeroEntries.map((entry) => {
      const fraction = totalSize > 0 ? entry.size / totalSize : 0;
      const percentage = (fraction * 100).toFixed(1);
      return `
        <div class="fxdata-map-bar-segment type-${entry.type}" 
             style="width: ${percentage}%"
             title="${escapeHtml(entry.name)} - ${formatSize(entry.size)}"
             data-offset="${entry.offset}" 
             data-name="${escapeHtml(entry.name)}"
             data-size="${entry.size}">
          <span class="fxdata-map-label">${escapeHtml(entry.name)}</span>
        </div>`;
    });

    if (this._memoryMap) {
      this._memoryMap.innerHTML = `
        <div class="fxdata-map-bar-container">
          <div class="fxdata-map-bar-track">
            ${barSegments.join('')}
          </div>
        </div>`;
      
      
      // Add bar segment click handlers and hover state
      this._memoryMap.querySelectorAll('.fxdata-map-bar-segment').forEach((seg) => {
        seg.addEventListener('click', () => {
          const name = seg.dataset.name;
          this._showAssetPreview(name, parseInt(seg.dataset.offset, 10), 'memorymap');
        });
        seg.addEventListener('mouseenter', () => {
          const name = seg.dataset.name;
          // Highlight the bar segment
          seg.classList.add('active');
          // Also highlight corresponding structured entry
          this._structuredList?.querySelectorAll('.fxdata-struct-entry').forEach((entry) => {
            if (entry.dataset.name === name) {
              entry.classList.add('hover');
            }
          });
        });
        seg.addEventListener('mouseleave', () => {
          const name = seg.dataset.name;
          seg.classList.remove('active');
          this._structuredList?.querySelectorAll('.fxdata-struct-entry').forEach((entry) => {
            if (entry.dataset.name === name) {
              entry.classList.remove('hover');
            }
          });
        });
      });
    }

    if (this._memorySummary) {
      this._memorySummary.innerHTML = `
        <dl>
          <dt>Data</dt><dd>${result.dataSize} B (${result.dataPages} pages)</dd>
          ${result.saveSize > 0 ? `<dt>Save</dt><dd>${result.saveSize} B (${result.savePages} pages)</dd>` : ''}
          <dt>Dev binary</dt><dd>${result.devBin.length} B</dd>
          <dt>FX_DATA_PAGE</dt><dd>0x${result.fxDataPage.toString(16).padStart(4, '0')}</dd>
          ${result.fxSavePage !== null ? `<dt>FX_SAVE_PAGE</dt><dd>0x${result.fxSavePage.toString(16).padStart(4, '0')}</dd>` : ''}
        </dl>`;
      this._memorySummary.classList.remove('hidden');
    }
  }

  _clearMemoryMap() {
    if (this._memoryMap) {
      this._memoryMap.innerHTML = '<div class="fxdata-empty-map">Build to see memory layout.</div>';
    }
    this._memorySummary?.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Structured view (after build)
  // ---------------------------------------------------------------------------

  _renderStructuredView(result) {
    if (!result.symbols || result.symbols.length === 0) {
      if (this._structuredList) {
        this._structuredList.innerHTML = '<div class="fxdata-empty-structured"><p>No symbols found.</p></div>';
      }
      return;
    }

    const mapByOffset = new Map();
    for (const entry of (result.memoryMap || [])) {
      mapByOffset.set(entry.offset, entry);
    }

    const html = result.symbols.map((sym) => {
      const mapEntry = mapByOffset.get(sym.offset);
      const type = mapEntry?.type || 'data';
      const size = mapEntry?.size || '?';
      const offsetHex = `0x${sym.offset.toString(16).padStart(6, '0').toUpperCase()}`;

      const category = getMemoryMapTypeCategory(type);
      return `
        <div class="fxdata-struct-entry" data-offset="${sym.offset}" data-name="${escapeHtml(sym.name)}">
          <div class="fxdata-struct-header">
            <span class="fxdata-struct-type fxdata-type-${category}">${type}</span>
            <span class="fxdata-struct-name">${escapeHtml(sym.name)}</span>
            <span class="fxdata-struct-offset">${offsetHex} (${size} B)</span>
          </div>
        </div>`;
    });

    if (this._structuredList) {
      this._structuredList.innerHTML = html.join('');
      this._structuredList.querySelectorAll('.fxdata-struct-entry').forEach((el) => {
        el.addEventListener('click', () => {
          this._structuredList.querySelectorAll('.fxdata-struct-entry').forEach((e) => e.classList.remove('active'));
          el.classList.add('active');
          this._showAssetPreview(el.dataset.name, parseInt(el.dataset.offset, 10), 'structured');
        });
        // Add hover highlighting for memory map
        el.addEventListener('mouseenter', () => {
          el.classList.add('hover-active');
          const name = el.dataset.name;
          this._memoryMap?.querySelectorAll('.fxdata-map-bar-segment').forEach((seg) => {
            if (seg.dataset.name === name) {
              seg.classList.add('active');
            }
          });
        });
        el.addEventListener('mouseleave', () => {
          el.classList.remove('hover-active');
          const name = el.dataset.name;
          this._memoryMap?.querySelectorAll('.fxdata-map-bar-segment').forEach((seg) => {
            if (seg.dataset.name === name) {
              seg.classList.remove('active');
            }
          });
        });
      });
    }
  }

  _clearStructuredView() {
    if (this._structuredList) {
      this._structuredList.innerHTML = '<div class="fxdata-empty-structured"><p>Build the project to see structured entries.</p></div>';
    }
  }

  _clearPreview() {
    if (this._assetPreview) {
      this._assetPreview.innerHTML = '<div class="fxdata-empty-preview"><p>Select an asset to preview.</p></div>';
    }
    this._currentPreviewPath = null;
    this._currentPreviewVar = null;
    this._currentPreviewSourceType = null;
    this._currentImageDimensions = null;
    this._activePreviewEntryId = null;
    this._hideImageControls();
    this._hideHexAccordion();
  }

  // ---------------------------------------------------------------------------
  // Asset preview
  // ---------------------------------------------------------------------------

  /**
   * Render a modular card layout for data type previews (numbers, strings, etc).
   */
  _renderDataPreviewCard({ variableName, fileName, type, value, size, offset, sourceType }) {
    // Title depends on source context
    let title;
    if (sourceType === 'memorymap' || sourceType === 'structured') {
      title = escapeHtml(variableName || 'Unknown');
    } else if (sourceType === 'fxdata' && fileName) {
      title = `${escapeHtml(variableName)} \u2192 ${escapeHtml(fileName)}`;
    } else {
      title = escapeHtml(variableName || 'Data');
    }

    let html = `<h4>${title}</h4>`;
    html += `<div class="fxdata-data-preview-card">`;

    // Type field
    html += `<div class="fxdata-data-field">`;
    html += `<span class="fxdata-data-label">Type</span>`;
    html += `<span class="fxdata-data-value">${escapeHtml(type)}</span>`;
    html += `</div>`;

    // Value field
    if (value) {
      html += `<div class="fxdata-data-field">`;
      html += `<span class="fxdata-data-label">Value</span>`;
      html += `<span class="fxdata-data-value fxdata-data-value-mono">${escapeHtml(value)}</span>`;
      html += `</div>`;
    }

    // Size field (only if build data available)
    if (size != null) {
      html += `<div class="fxdata-data-field">`;
      html += `<span class="fxdata-data-label">Size (bytes)</span>`;
      html += `<span class="fxdata-data-value">${size}</span>`;
      html += `</div>`;
    }

    // Offset field (only if build data available)
    if (offset != null) {
      html += `<div class="fxdata-data-field">`;
      html += `<span class="fxdata-data-label">Offset</span>`;
      html += `<span class="fxdata-data-value fxdata-data-value-mono">0x${offset.toString(16).padStart(6, '0')}</span>`;
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  _showAssetPreview(name, offset, sourceType = 'memorymap') {
    if (!this._lastBuild || !this._assetPreview) return;

    const mapEntry = this._lastBuild.memoryMap?.find((e) => e.name === name);
    if (!mapEntry) {
      this._assetPreview.innerHTML = `<div class="fxdata-empty-preview"><p>No data for ${escapeHtml(name)}</p></div>`;
      this._hideHexAccordion();
      return;
    }

    // If this is an image with an asset path, load and display the original asset
    if (mapEntry.type === 'image' && mapEntry.assetPath) {
      return this._showAssetPreviewByPath(mapEntry.assetPath, name, sourceType);
    }
    if (mapEntry.type === 'raw' && mapEntry.assetPath) {
      return this._showAssetPreviewByPath(mapEntry.assetPath, name, sourceType);
    }

    // Non-image entry selected — hide image controls
    this._hideImageControls();

    // Look up the entry value from the entries list
    const fxEntry = this._entries.find((e) => e.name === name);
    const entryValue = fxEntry?.value || '';

    const bytes = this._lastBuild.dataBin.slice(mapEntry.offset, mapEntry.offset + mapEntry.size);
    const html = this._renderDataPreviewCard({
      variableName: name,
      type: mapEntry.type,
      value: entryValue,
      size: mapEntry.size,
      offset: mapEntry.offset,
      sourceType,
    });
    
    this._assetPreview.innerHTML = html;

    // Populate hex data in accordion
    const previewBytes = bytes.slice(0, 256);
    const hexStr = Array.from(previewBytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const fullHex = hexStr + (bytes.length > 256 ? '...' : '');
    if (this._hexBody) {
      this._hexBody.textContent = fullHex;
    }
    this._showHexAccordion();
  }

  _showAssetPreviewByPath(path, variableName, sourceType) {
    if (!this._assetPreview) return;
    const data = this._project.getBinaryFile(path);
    if (!data) return;

    this._currentPreviewPath = path;
    this._currentPreviewVar = variableName || null;
    this._currentPreviewSourceType = sourceType || null;

    // Title depends on source context
    let title;
    if (sourceType === 'memorymap' || sourceType === 'structured') {
      // From memory map / structured: show only variable name
      title = escapeHtml(variableName || path);
    } else if (variableName) {
      // From fxdata entries: show variable name + filename
      title = `${escapeHtml(variableName)} → ${escapeHtml(path)}`;
    } else {
      // From assets panel: show just filename
      title = escapeHtml(path);
    }

    let html = `<h4>${title}</h4>`;
    html += `<div class="fxdata-data-preview-card">`;
    html += `<div class="fxdata-data-field">`;
    html += `<span class="fxdata-data-label">Size (bytes)</span>`;
    html += `<span class="fxdata-data-value">${data.length}</span>`;
    html += `</div>`;
    html += `</div>`;

    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const isImage = ['.png', '.bmp', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);

    if (isImage) {
      // Load image to render threshold-adjusted preview and frames
      const blob = new Blob([data], { type: `image/${ext.slice(1)}` });
      const url = URL.createObjectURL(blob);
      // Show original image first; canvas rendering will replace it once loaded
      html += `<img src="${url}" class="fxdata-preview-img" alt="${escapeHtml(path)}" id="fxdata-preview-source-img">`;
      this._assetPreview.innerHTML = html;

      // Load image data for threshold rendering + frames
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        this._renderThresholdPreview(img, path);
        // Show controls after image loads so dimensions are available
        this._showImageControls(path);
      };
      img.src = url;
    } else {
      this._assetPreview.innerHTML = html;
      this._hideImageControls();
    }

    // Populate hex data in accordion
    const previewBytes = data.slice(0, 256);
    const hexStr = Array.from(previewBytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const fullHex = hexStr + (data.length > 256 ? '...' : '');
    if (this._hexBody) {
      this._hexBody.textContent = fullHex;
    }
    this._showHexAccordion();
  }

  /**
   * Render threshold-adjusted 1-bit preview and frames grid for an image.
   */
  _renderThresholdPreview(img, path) {
    if (!this._assetPreview) return;
    const threshold = parseInt(this._thresholdSlider?.value ?? '128', 10);

    // Get sprite dimensions from override or filename
    const filename = path.slice(path.lastIndexOf('/') + 1);
    const override = this._spriteOverrides.get(path);
    let dims;
    if (override?.active) {
      dims = { width: override.width, height: override.height, spacing: override.spacing };
    } else {
      dims = parseDimensionsFromFilename(filename);
    }

    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;

    // Store current image dimensions for sprite override defaults
    this._currentImageDimensions = { width: imgW, height: imgH };

    // Draw to offscreen canvas to get pixel data
    const offCanvas = document.createElement('canvas');
    offCanvas.width = imgW;
    offCanvas.height = imgH;
    const offCtx = offCanvas.getContext('2d');
    offCtx.drawImage(img, 0, 0);
    const imageData = offCtx.getImageData(0, 0, imgW, imgH);
    const pixels = imageData.data;

    // Render 1-bit threshold preview
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = imgW;
    previewCanvas.height = imgH;
    previewCanvas.className = 'fxdata-preview-img';
    const ctx = previewCanvas.getContext('2d');
    const out = ctx.createImageData(imgW, imgH);

    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      const green = pixels[i + 1]; // green channel, matching encoder
      if (alpha < 128) {
        // Transparent → show as app green matte
        out.data[i] = 52;
        out.data[i + 1] = 211;
        out.data[i + 2] = 153;
        out.data[i + 3] = 255;
      } else if (green > threshold) {
        out.data[i] = out.data[i + 1] = out.data[i + 2] = 255;
        out.data[i + 3] = 255;
      } else {
        out.data[i] = out.data[i + 1] = out.data[i + 2] = 0;
        out.data[i + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);

    // Replace the <img> with the canvas
    const existing = this._assetPreview.querySelector('#fxdata-preview-source-img');
    if (existing) {
      existing.replaceWith(previewCanvas);
    }

    // Render frames grid
    this._renderFramesView(img, pixels, dims, imgW, imgH, threshold);
  }

  /**
   * Render individual sprite frames as a grid of small canvases.
   */
  _renderFramesView(img, pixels, dims, imgW, imgH, threshold) {
    if (!this._framesView) return;

    // Only show frames if dimensions are explicitly defined
    if (!dims || !dims.width || !dims.height) {
      this._framesView.classList.add('hidden');
      return;
    }

    let { width: sw, height: sh, spacing } = dims;
    // spacing is optional and defaults to 0 if undefined
    spacing = spacing || 0;

    const hframes = Math.max(1, Math.floor((imgW - spacing) / (sw + spacing)));
    const vframes = Math.max(1, Math.floor((imgH - spacing) / (sh + spacing)));
    const total = hframes * vframes;

    this._framesView.innerHTML = '';
    this._framesView.classList.remove('hidden');

    const info = document.createElement('div');
    info.className = 'fxdata-frames-info';
    info.textContent = `${total} frame${total !== 1 ? 's' : ''} — ${sw}×${sh}${spacing ? ` spacing ${spacing}` : ''}`;
    this._framesView.appendChild(info);

    // Determine scale: keep frames small but readable
    const maxCellSize = 48;
    const scale = Math.max(1, Math.min(Math.floor(maxCellSize / Math.max(sw, sh)), 4));

    for (let v = 0; v < vframes; v++) {
      for (let h = 0; h < hframes; h++) {
        const fx = spacing + h * (sw + spacing);
        const fy = spacing + v * (sh + spacing);

        const canvas = document.createElement('canvas');
        canvas.width = sw * scale;
        canvas.height = sh * scale;
        canvas.className = 'fxdata-frame-cell';
        canvas.title = `Frame ${v * hframes + h}`;
        const ctx = canvas.getContext('2d');

        // Render each pixel of the frame
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            const srcX = fx + x;
            const srcY = fy + y;
            if (srcX >= imgW || srcY >= imgH) continue;
            const idx = (srcY * imgW + srcX) * 4;
            const alpha = pixels[idx + 3];
            const green = pixels[idx + 1];
            if (alpha < 128) {
              ctx.fillStyle = '#34d399'; // app green matte
            } else if (green > threshold) {
              ctx.fillStyle = '#ffffff';
            } else {
              ctx.fillStyle = '#000000';
            }
            ctx.fillRect(x * scale, y * scale, scale, scale);
          }
        }

        this._framesView.appendChild(canvas);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Image controls visibility
  // ---------------------------------------------------------------------------

  _showImageControls(path) {
    if (!this._imageControls) return;
    this._imageControls.classList.remove('hidden');

    // Populate sprite override fields from current state
    const override = this._spriteOverrides.get(path);
    const filename = path.slice(path.lastIndexOf('/') + 1);
    const parsed = parseDimensionsFromFilename(filename);

    if (override?.active) {
      this._spriteOverrideCheckbox.checked = true;
      this._spriteOverrideFields?.classList.remove('hidden');
      this._spriteWidthInput.value = override.width;
      this._spriteHeightInput.value = override.height;
      this._spriteSpacingInput.value = override.spacing;
    } else {
      this._spriteOverrideCheckbox.checked = false;
      this._spriteOverrideFields?.classList.add('hidden');
      // Use image dimensions as default, fall back to filename parse
      const imageDims = this._currentImageDimensions || {};
      this._spriteWidthInput.value = parsed.width || imageDims.width || '';
      this._spriteHeightInput.value = parsed.height || imageDims.height || '';
      this._spriteSpacingInput.value = parsed.spacing || 0;
    }
  }

  _hideImageControls() {
    this._imageControls?.classList.add('hidden');
    this._framesView?.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Sprite override handlers
  // ---------------------------------------------------------------------------

  _handleSpriteOverrideToggle() {
    const path = this._currentPreviewPath;
    if (!path) return;

    const checked = this._spriteOverrideCheckbox?.checked;
    if (checked) {
      this._spriteOverrideFields?.classList.remove('hidden');
      // Initialize override with image dimensions as defaults
      const filename = path.slice(path.lastIndexOf('/') + 1);
      const imageDims = this._currentImageDimensions || {};
      const w = parseInt(this._spriteWidthInput?.value, 10) || imageDims.width || 0;
      const h = parseInt(this._spriteHeightInput?.value, 10) || imageDims.height || 0;
      const s = parseInt(this._spriteSpacingInput?.value, 10) || 0;
      this._spriteOverrides.set(path, {
        active: true,
        width: w,
        height: h,
        spacing: s,
        originalFilename: filename,
      });
      this._applySpriteOverrideToFilename(path);
    } else {
      this._spriteOverrideFields?.classList.add('hidden');
      // Revert to original filename
      this._revertSpriteOverride(path);
      // If revert was blocked due to collision, restore UI state
      const override = this._spriteOverrides.get(this._currentPreviewPath);
      if (override?.active) {
        this._spriteOverrideCheckbox.checked = true;
        this._spriteOverrideFields?.classList.remove('hidden');
      }
    }
  }

  _handleSpriteFieldChange() {
    const path = this._currentPreviewPath;
    if (!path) return;
    const override = this._spriteOverrides.get(path);
    if (!override?.active) return;

    override.width = parseInt(this._spriteWidthInput?.value, 10) || 0;
    override.height = parseInt(this._spriteHeightInput?.value, 10) || 0;
    override.spacing = parseInt(this._spriteSpacingInput?.value, 10) || 0;

    this._applySpriteOverrideToFilename(path);
  }

  /**
   * Build filename with dimensions encoded, rename the file in the project,
   * update any entries referencing it, and re-render.
   */
  _applySpriteOverrideToFilename(originalPath) {
    const override = this._spriteOverrides.get(originalPath);
    if (!override) return;

    const { width, height, spacing, originalFilename } = override;

    // Build the new filename: strip old dimensions, add new ones
    const ext = originalFilename.slice(originalFilename.lastIndexOf('.'));
    const nameOnly = originalFilename.slice(0, originalFilename.lastIndexOf('.'));

    // Strip existing dimension segments from the end
    const elements = nameOnly.split('_');
    const cleaned = [];
    let foundDims = false;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (!foundDims && i > 0) {
        const parts = el.split('x').filter(s => s.length > 0);
        if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
          foundDims = true;
          // Skip this element and possibly the next (spacing)
          if (i + 1 < elements.length && /^\d+$/.test(elements[i + 1])) {
            i++; // skip spacing too
          }
          continue;
        }
      }
      cleaned.push(el);
    }

    // Append new dimensions
    let baseName = cleaned.join('_');
    if (!baseName) baseName = 'sprite';
    let newFilename;
    if (width > 0 && height > 0) {
      newFilename = `${baseName}_${width}x${height}`;
      if (spacing > 0) newFilename += `_${spacing}`;
      newFilename += ext;
    } else {
      newFilename = baseName + ext;
    }

    // Compute full new path
    const folder = originalPath.includes('/') ? originalPath.slice(0, originalPath.lastIndexOf('/')) : '';
    const newPath = folder ? `${folder}/${newFilename}` : newFilename;

    if (newPath !== originalPath) {
      // Check for collision before renaming
      if (this._project.hasFile(newPath)) {
        showToast(`Cannot apply sprite override — "${newFilename}" already exists`, 'warning');
        return;
      }

      // Rename in project
      const fileData = this._project.getFile(originalPath);
      if (fileData) {
        this._project.addFile(newPath, fileData.data);
        this._project.removeFile(originalPath);
      }

      // Update entries referencing the old path
      for (const entry of this._entries) {
        if (entry.type === 'image_t' || entry.type === 'raw_t') {
          const val = entry.value.replace(/^["']|["']$/g, '');
          if (val === originalPath) {
            entry.value = `"${newPath}"`;
          }
        }
      }

      // Move the override to the new path key
      this._spriteOverrides.delete(originalPath);
      this._spriteOverrides.set(newPath, override);

      this._currentPreviewPath = newPath;
      this._syncEntriesToSource();
      this._renderEntriesPanel();
      this._renderAssetTree();
      this._saveToStorage();

      // Re-render preview with new path
      this._showAssetPreviewByPath(newPath, this._currentPreviewVar, this._currentPreviewSourceType);
    } else {
      // Path didn't change, just re-render frames
      this._showAssetPreviewByPath(originalPath, this._currentPreviewVar, this._currentPreviewSourceType);
    }
  }

  /**
   * Revert sprite override: rename file back to original, update entries.
   */
  _revertSpriteOverride(currentPath) {
    const override = this._spriteOverrides.get(currentPath);
    if (!override) return;

    const { originalFilename } = override;
    const folder = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
    const originalPath = folder ? `${folder}/${originalFilename}` : originalFilename;

    override.active = false;

    if (currentPath !== originalPath) {
      // Check for collision before reverting
      if (this._project.hasFile(originalPath)) {
        showToast(`Cannot revert sprite override — "${originalFilename}" already exists`, 'warning');
        override.active = true; // keep override active since we can't revert
        return;
      }

      // Rename back
      const fileData = this._project.getFile(currentPath);
      if (fileData) {
        this._project.addFile(originalPath, fileData.data);
        this._project.removeFile(currentPath);
      }

      // Update entries
      for (const entry of this._entries) {
        if (entry.type === 'image_t' || entry.type === 'raw_t') {
          const val = entry.value.replace(/^["']|["']$/g, '');
          if (val === currentPath) {
            entry.value = `"${originalPath}"`;
          }
        }
      }

      // Move override key back
      this._spriteOverrides.delete(currentPath);
      this._spriteOverrides.set(originalPath, override);

      this._currentPreviewPath = originalPath;
      this._syncEntriesToSource();
      this._renderEntriesPanel();
      this._renderAssetTree();
      this._saveToStorage();

      this._showAssetPreviewByPath(originalPath, this._currentPreviewVar, this._currentPreviewSourceType);
    } else {
      this._showAssetPreviewByPath(currentPath, this._currentPreviewVar, this._currentPreviewSourceType);
    }
  }

  /**
   * Check if a file path has an active sprite override.
   */
  _isFileOverridden(path) {
    const override = this._spriteOverrides.get(path);
    return override?.active === true;
  }

  /**
   * Prompt the user to confirm overwriting a single existing file.
   * If "Overwrite" is toggled on, returns true immediately.
   * Used for single-file operations (e.g. import-for-entry).
   * @param {string} filename
   * @returns {Promise<boolean>}
   */
  _confirmOverwrite(filename) {
    if (this._overwriteByDefault) return Promise.resolve(true);
    return this._resolveConflictBatch([filename]).then((m) => m.get(filename) ?? false);
  }

  /**
   * Resolve a batch of file-name conflicts via dialog prompts.
   * Returns a Map<filename, boolean> indicating overwrite (true) or skip (false).
   *
   * If overwrite-by-default is on, all are approved immediately.
   * Otherwise, dialogs are shown one-at-a-time. A "Do this for all remaining
   * conflicts" checkbox lets the user apply one choice to the rest.
   * The "Always ask" checkbox only takes effect after the final conflict is resolved.
   *
   * @param {string[]} conflictPaths
   * @returns {Promise<Map<string, boolean>>}
   */
  async _resolveConflictBatch(conflictPaths) {
    const decisions = new Map();
    if (conflictPaths.length === 0) return decisions;

    // If overwrite is already on, approve all
    if (this._overwriteByDefault) {
      for (const p of conflictPaths) decisions.set(p, true);
      return decisions;
    }

    let disableAlwaysAsk = false;

    for (let i = 0; i < conflictPaths.length; i++) {
      const filename = conflictPaths[i];
      const remaining = conflictPaths.length - i;
      const isLast = remaining === 1;

      const result = await this._showConflictDialog(filename, remaining, conflictPaths.length, disableAlwaysAsk);
      decisions.set(filename, result.overwrite);
      disableAlwaysAsk = result.alwaysAskUnchecked;

      if (result.applyToAll) {
        // Apply this choice to all remaining
        for (let j = i + 1; j < conflictPaths.length; j++) {
          decisions.set(conflictPaths[j], result.overwrite);
        }
        break; // "apply to all" ends the batch, so process always-ask now
      }

      if (!isLast) continue; // defer always-ask until last conflict
    }

    // Apply the "always ask" preference now that the batch is done
    if (disableAlwaysAsk) {
      this._overwriteByDefault = true;
      localStorage.setItem('fxdata-overwriteByDefault', 'true');
      if (this._overwriteToggle) this._overwriteToggle.checked = true;
    }

    return decisions;
  }

  /**
   * Show a single conflict resolution dialog.
   * @param {string} filename
   * @param {number} remaining - How many conflicts remain (including this one)
   * @param {number} total - Total conflicts in the batch
   * @param {boolean} alwaysAskUnchecked - Carried-over state from previous dialog
   * @returns {Promise<{overwrite: boolean, applyToAll: boolean, alwaysAskUnchecked: boolean}>}
   */
  _showConflictDialog(filename, remaining, total, alwaysAskUnchecked) {
    return new Promise((resolve) => {
      document.querySelector('.fxdata-overwrite-dialog-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'fxdata-overwrite-dialog-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'fxdata-overwrite-dialog';

      const msg = document.createElement('p');
      msg.className = 'fxdata-overwrite-dialog-msg';
      msg.textContent = `"${filename}" already exists. Overwrite?`;

      // Conflict counter
      if (total > 1) {
        const counter = document.createElement('p');
        counter.className = 'fxdata-overwrite-dialog-counter';
        counter.textContent = `${remaining} of ${total} conflict${total === 1 ? '' : 's'} remaining`;
        dialog.appendChild(counter);
      }

      dialog.appendChild(msg);

      // Checkboxes section (vertical)
      const checkboxSection = document.createElement('div');
      checkboxSection.className = 'fxdata-overwrite-dialog-checks';

      // Always-ask checkbox
      const alwaysAskRow = document.createElement('label');
      alwaysAskRow.className = 'fxdata-overwrite-dialog-check';
      const alwaysAskCb = document.createElement('input');
      alwaysAskCb.type = 'checkbox';
      alwaysAskCb.checked = !alwaysAskUnchecked;
      const alwaysAskLabel = document.createElement('span');
      alwaysAskLabel.textContent = 'Always ask';
      alwaysAskRow.append(alwaysAskCb, alwaysAskLabel);
      checkboxSection.appendChild(alwaysAskRow);

      // "Do this for all remaining" checkbox (only if >1 remaining)
      let applyAllCb = null;
      if (remaining > 1) {
        const applyAllRow = document.createElement('label');
        applyAllRow.className = 'fxdata-overwrite-dialog-check';
        applyAllCb = document.createElement('input');
        applyAllCb.type = 'checkbox';
        applyAllCb.checked = false;
        const applyAllLabel = document.createElement('span');
        applyAllLabel.textContent = 'Do this for all remaining';
        applyAllRow.append(applyAllCb, applyAllLabel);
        checkboxSection.appendChild(applyAllRow);
      }

      dialog.appendChild(checkboxSection);

      // Buttons section (horizontal)
      const btnRow = document.createElement('div');
      btnRow.className = 'fxdata-overwrite-dialog-buttons';

      const btnCancel = document.createElement('button');
      btnCancel.className = 'fxdata-overwrite-dialog-btn fxdata-overwrite-dialog-btn-cancel';
      btnCancel.textContent = 'Cancel';

      const btnYes = document.createElement('button');
      btnYes.className = 'fxdata-overwrite-dialog-btn fxdata-overwrite-dialog-btn-yes';
      btnYes.textContent = 'Overwrite';

      btnRow.append(btnCancel, btnYes);
      dialog.appendChild(btnRow);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const close = (overwrite) => {
        overlay.remove();
        resolve({
          overwrite,
          applyToAll: applyAllCb?.checked ?? false,
          alwaysAskUnchecked: !alwaysAskCb.checked,
        });
      };

      btnYes.addEventListener('click', () => close(true));
      btnCancel.addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });
      btnYes.focus();
    });
  }

  _showEntryPreview(entry) {
    if (!this._assetPreview) return;
    this._activePreviewEntryId = entry.id;

    // For asset types (image_t / raw_t), show asset directly from entry value without needing build
    if (entry.type === 'image_t' || entry.type === 'raw_t') {
      const assetPath = entry.value.replace(/^["']|["']$/g, ''); // unquote
      if (assetPath) {
        return this._showAssetPreviewByPath(assetPath, entry.name, 'fxdata');
      }
    }

    // Non-image entry selected — hide image controls
    this._hideImageControls();

    // For data types, show preview directly from entry values (no build needed)
    const mapEntry = this._lastBuild?.memoryMap?.find((e) => e.name === entry.name);

    // For asset types from build, show the asset file with variable name
    if (mapEntry?.type === 'image' && mapEntry.assetPath) {
      return this._showAssetPreviewByPath(mapEntry.assetPath, entry.name, 'fxdata');
    }
    if (mapEntry?.type === 'raw' && mapEntry.assetPath) {
      return this._showAssetPreviewByPath(mapEntry.assetPath, entry.name, 'fxdata');
    }

    // Show data preview card — works with or without build
    const html = this._renderDataPreviewCard({
      variableName: entry.name,
      fileName: entry.type === 'image_t' || entry.type === 'raw_t'
        ? entry.value.replace(/^["']|["']$/g, '') : null,
      type: entry.type,
      value: entry.value,
      size: mapEntry?.size,
      offset: mapEntry?.offset,
      sourceType: 'fxdata',
    });
    
    this._assetPreview.innerHTML = html;

    // If build data available, show hex accordion
    if (mapEntry && this._lastBuild) {
      const bytes = this._lastBuild.dataBin.slice(mapEntry.offset, mapEntry.offset + mapEntry.size);
      const previewBytes = bytes.slice(0, 256);
      const hexStr = Array.from(previewBytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const fullHex = hexStr + (bytes.length > 256 ? '...' : '');
      if (this._hexBody) {
        this._hexBody.textContent = fullHex;
      }
      this._showHexAccordion();
    } else {
      this._hideHexAccordion();
    }
  }

  // ---------------------------------------------------------------------------
  // Downloads
  // ---------------------------------------------------------------------------

  _downloadFile(key, filename, mimeType = 'application/octet-stream') {
    if (!this._lastBuild) return;
    const data = this._lastBuild[key];
    if (!data) return;
    downloadBlob(data, filename, mimeType);
  }

  // ---------------------------------------------------------------------------
  // Drop handler (called from main.js)
  // ---------------------------------------------------------------------------

  async handleDrop(file) {
    const name = file.name.toLowerCase();

    if (name.endsWith('.zip')) {
      const buffer = await file.arrayBuffer();
      this._project.clear();
      this._entries = [];
      await this._project.importFromZip(buffer);

      const txtFiles = this._project.listByExtension('.txt');
      const entryTxt = txtFiles.find((f) => f.toLowerCase().includes('fxdata')) || txtFiles[0];
      if (entryTxt) {
        const src = this._project.getTextFile(entryTxt);
        if (src) {
          this._entries = sourceToEntries(src);
          this._project.removeFile(entryTxt);
          this._remapAssetPaths();
        }
      }
      this._renderEntriesPanel();
      this._renderAssetTree();
      this._syncEntriesToSource();
      if (this._btnExport) this._btnExport.disabled = false;
      this._saveToStorage();
      showToast(`Imported ZIP: ${this._project.size} asset(s)`, 'success');

    } else if (name.endsWith('.txt')) {
      const text = await file.text();
      this._entries = sourceToEntries(text);
      this._renderEntriesPanel();
      this._syncEntriesToSource();
      if (this._btnExport) this._btnExport.disabled = false;
      this._saveToStorage();
      showToast(`Parsed ${file.name} → ${this._entries.length} entr${this._entries.length === 1 ? 'y' : 'ies'}`, 'success');

    } else {
      // Asset file
      const buffer = await file.arrayBuffer();
      const path = file.name;
      this._project.addFile(path, new Uint8Array(buffer));
      this._renderAssetTree();
      if (this._btnExport) this._btnExport.disabled = false;
      this._saveToStorage();
      showToast(`Added asset: ${file.name}`, 'info');
    }
  }

  // ---------------------------------------------------------------------------
  // Local storage persistence
  // ---------------------------------------------------------------------------

  _saveToStorage() {
    try {
      const data = {
        entries: this._entries,
        project: this._project.serialize(),
        folders: [...this._folders],
        spriteOverrides: [...this._spriteOverrides.entries()],
      };
      localStorage.setItem('fxdata-project', JSON.stringify(data));
    } catch {
      // Storage full — silently ignore
    }
  }

  _restoreFromStorage() {
    try {
      const raw = localStorage.getItem('fxdata-project');
      if (!raw) return;
      const data = JSON.parse(raw);

      // Restore sprite overrides
      if (Array.isArray(data.spriteOverrides)) {
        this._spriteOverrides = new Map(data.spriteOverrides);
      }

      // Restore folders before rendering so the tree is accurate
      if (Array.isArray(data.folders)) {
        this._folders = new Set(data.folders);
      }
      if (data.project) {
        this._project.deserialize(data.project);
        this._renderAssetTree();
      }
      if (Array.isArray(data.entries)) {
        this._entries = data.entries;
        this._renderEntriesPanel();
        this._syncEntriesToSource();
      }
      if (this._project.size > 0 || this._entries.length > 0) {
        if (this._btnExport) this._btnExport.disabled = false;
      }
    } catch {
      // Corrupted storage — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
