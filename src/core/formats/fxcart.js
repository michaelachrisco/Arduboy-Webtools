/**
 * FX Flash Cart binary format parser and compiler.
 *
 * Handles reading, writing, and manipulating the linked-list
 * slot format used by the Arduboy FX flash cart system.
 *
 * Ported from: arduboy_toolset/arduboy/fxcart.py
 */

import {
  FX_PAGESIZE, FX_BLOCKSIZE, FX_PAGES_PER_BLOCK,
  FX_CART_MAGIC, FX_HEADER, FX_HEADER_SIZE, FX_TITLE_SIZE,
  FX_META_MAX_LENGTH, FX_SAVE_ALIGNMENT, FX_DATA_PAGE_OFFSET,
  FX_SAVE_PAGE_OFFSET, RETI_BYTES, FLASH_PAGESIZE,
} from '../constants.js';
import {
  readUint16BE, writeUint16BE, padData, padSize,
  countUnusedPages, isEmpty, concat, sha256, arraysEqual,
  encodeString, decodeString, filledArray,
} from '../utils/binary.js';
import { patchMenuButtons } from '../operations/patch.js';

// =============================================================================
// Data Structures
// =============================================================================

/**
 * @typedef {Object} FxSlotMeta
 * @property {string} title
 * @property {string} version
 * @property {string} developer
 * @property {string} info
 */

/**
 * Represents a single parsed slot in the FX flash cart.
 */
export class FxParsedSlot {
  /**
   * @param {Object} props
   * @param {number} props.category - Category ID
   * @param {Uint8Array} props.imageRaw - 1024-byte title screen image
   * @param {Uint8Array} props.programRaw - Program binary data
   * @param {Uint8Array} props.dataRaw - FX data
   * @param {Uint8Array} props.saveRaw - FX save data
   * @param {FxSlotMeta} props.meta - Metadata strings
   */
  constructor({ category = 0, imageRaw = null, programRaw = null, dataRaw = null, saveRaw = null, meta = null } = {}) {
    this.category = category;
    this.imageRaw = imageRaw || new Uint8Array(FX_TITLE_SIZE).fill(0x00);
    this.programRaw = programRaw || new Uint8Array(0);
    this.dataRaw = dataRaw || new Uint8Array(0);
    this.saveRaw = saveRaw || new Uint8Array(0);
    this.meta = meta || { title: '', version: '', developer: '', info: '' };
  }

  /** @returns {boolean} True if this is a category header (no program) */
  get isCategory() {
    return this.programRaw.length === 0;
  }

  /** @returns {boolean} True if this slot has FX data or save data */
  get fxEnabled() {
    return this.dataRaw.length > 0 || this.saveRaw.length > 0;
  }
}

// =============================================================================
// Header Inspection (without full parse)
// =============================================================================

/**
 * Check if data at offset is a valid slot header.
 * @param {Uint8Array} data
 * @param {number} [offset=0]
 * @returns {boolean}
 */
export function isSlotHeader(data, offset = 0) {
  if (offset + FX_CART_MAGIC.length > data.length) return false;
  for (let i = 0; i < FX_CART_MAGIC.length; i++) {
    if (data[offset + i] !== FX_CART_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Get the total size of a slot in bytes from its header.
 * @param {Uint8Array} header - 256-byte header
 * @returns {number} Size in bytes
 */
export function getSlotSizeBytes(header) {
  return readUint16BE(header, FX_HEADER.SLOT_SIZE) * FX_PAGESIZE;
}

// =============================================================================
// Parse
// =============================================================================

/**
 * Parse a complete FX flash cart binary into an array of slots.
 *
 * Walks the header chain using slot sizes (not next-page pointers,
 * which may be stale). Stops when magic bytes are not found.
 *
 * @param {Uint8Array} fullData - Complete cart binary
 * @returns {FxParsedSlot[]}
 */
export function parseFxCart(fullData) {
  const slots = [];
  let offset = 0;

  while (offset + FX_HEADER_SIZE <= fullData.length) {
    if (!isSlotHeader(fullData, offset)) break;

    const header = fullData.slice(offset, offset + FX_HEADER_SIZE);
    const slotSizePages = readUint16BE(header, FX_HEADER.SLOT_SIZE);
    const slotSize = slotSizePages * FX_PAGESIZE;

    // Extract slot data
    const slotData = fullData.slice(offset, Math.min(offset + slotSize, fullData.length));

    // Parse meta strings (null-separated: title\0version\0developer\0info\0)
    const meta = parseMetaStrings(header);

    // Category ID
    const category = header[FX_HEADER.CATEGORY];

    // Title screen image (follows header)
    const imageStart = FX_HEADER_SIZE;
    const imageRaw = slotData.length >= imageStart + FX_TITLE_SIZE
      ? slotData.slice(imageStart, imageStart + FX_TITLE_SIZE)
      : new Uint8Array(FX_TITLE_SIZE);

    // Program data
    const programSizeHalfPages = header[FX_HEADER.PROGRAM_SIZE];
    const programSize = programSizeHalfPages * FLASH_PAGESIZE;
    const programStart = imageStart + FX_TITLE_SIZE;
    const programRaw = programSize > 0 && slotData.length >= programStart + programSize
      ? slotData.slice(programStart, programStart + programSize)
      : new Uint8Array(0);

    // Data and save (use header pointers for offsets)
    const currentPage = offset / FX_PAGESIZE;
    const dataPage = readUint16BE(header, FX_HEADER.DATA_PAGE);
    const savePage = readUint16BE(header, FX_HEADER.SAVE_PAGE);
    const dataSizePages = readUint16BE(header, FX_HEADER.DATA_SIZE);

    let dataRaw = new Uint8Array(0);
    let saveRaw = new Uint8Array(0);

    if (dataPage > 0 && dataSizePages > 0) {
      const dataOffset = (dataPage - currentPage) * FX_PAGESIZE;
      const dataLen = dataSizePages * FX_PAGESIZE;
      if (dataOffset >= 0 && dataOffset + dataLen <= slotData.length) {
        dataRaw = slotData.slice(dataOffset, dataOffset + dataLen);
        // Trim trailing 0xFF pages from data
        const unusedPages = countUnusedPages(dataRaw, FX_PAGESIZE);
        if (unusedPages > 0) {
          dataRaw = dataRaw.slice(0, dataRaw.length - unusedPages * FX_PAGESIZE);
        }
      }
    }

    if (savePage > 0) {
      const saveOffset = (savePage - currentPage) * FX_PAGESIZE;
      if (saveOffset >= 0 && saveOffset < slotData.length) {
        saveRaw = slotData.slice(saveOffset);
        // Trim trailing 0xFF pages from save
        const unusedPages = countUnusedPages(saveRaw, FX_PAGESIZE);
        if (unusedPages > 0 && unusedPages * FX_PAGESIZE < saveRaw.length) {
          saveRaw = saveRaw.slice(0, saveRaw.length - unusedPages * FX_PAGESIZE);
        }
      }
    }

    slots.push(new FxParsedSlot({
      category, imageRaw, programRaw, dataRaw, saveRaw, meta,
    }));

    offset += slotSize;
  }

  return slots;
}

/**
 * Parse null-separated metadata strings from a header.
 *
 * Category slots store: title\0info\0  (2 fields)
 * Program slots store:  title\0version\0developer\0info\0  (4 fields)
 *
 * @param {Uint8Array} header - 256-byte header
 * @returns {FxSlotMeta}
 */
function parseMetaStrings(header) {
  const metaBytes = header.slice(FX_HEADER.META_START, FX_HEADER_SIZE);
  const str = decodeString(metaBytes);
  const parts = str.split('\0');

  // Check if this is a category (program page = 0xFFFF means no program)
  const programPage = readUint16BE(header, FX_HEADER.PROGRAM_PAGE);
  if (programPage === 0xFFFF) {
    // Category: title\0info
    return {
      title: parts[0] || '',
      version: '',
      developer: '',
      info: parts[1] || '',
    };
  }
  // Program: title\0version\0developer\0info
  return {
    title: parts[0] || '',
    version: parts[1] || '',
    developer: parts[2] || '',
    info: parts[3] || '',
  };
}

// =============================================================================
// Compile
// =============================================================================

/**
 * Compile an array of parsed slots into a complete FX flash cart binary.
 *
 * @param {FxParsedSlot[]} slots - Slots to compile
 * @returns {Promise<Uint8Array>} Complete cart binary
 */
export async function compileFxCart(slots) {
  if (slots.length === 0) return new Uint8Array(0);

  // Fix up slots: assign categories, ensure structure
  const fixedSlots = fixParsedSlots(slots);

  // First pass: compute sizes to determine page offsets
  const slotBinaries = [];
  let currentPage = 0;
  let previousPage = 0xFFFF; // First slot has no predecessor

  for (let i = 0; i < fixedSlots.length; i++) {
    const slot = fixedSlots[i];
    const compiled = await compileSingleSlot(slot, currentPage, previousPage);
    slotBinaries.push(compiled);
    previousPage = currentPage;
    currentPage += compiled.length / FX_PAGESIZE;
  }

  // Second pass: fix next-page pointers now that we know final sizes
  let page = 0;
  for (let i = 0; i < slotBinaries.length; i++) {
    const nextPage = i < slotBinaries.length - 1
      ? page + slotBinaries[i].length / FX_PAGESIZE
      : 0xFFFF; // Last slot points to 0xFFFF
    writeUint16BE(slotBinaries[i], FX_HEADER.NEXT_PAGE, nextPage);
    page += slotBinaries[i].length / FX_PAGESIZE;
  }

  // Concatenate all slot binaries + end sentinel
  const endSentinel = filledArray(FX_PAGESIZE); // All 0xFF = end marker
  return concat(...slotBinaries, endSentinel);
}

/**
 * Compile a single slot into its binary representation.
 *
 * @param {FxParsedSlot} slot
 * @param {number} currentPage - Starting page for this slot
 * @param {number} previousPage - Starting page of preceding slot
 * @returns {Promise<Uint8Array>}
 */
async function compileSingleSlot(slot, currentPage, previousPage) {
  // Pad program to page boundary
  const program = slot.programRaw.length > 0
    ? padData(new Uint8Array(slot.programRaw), FX_PAGESIZE)
    : new Uint8Array(0);

  // Pad data to page boundary
  const data = slot.dataRaw.length > 0
    ? padData(new Uint8Array(slot.dataRaw), FX_PAGESIZE)
    : new Uint8Array(0);

  // Pad save to 4KB alignment
  const save = slot.saveRaw.length > 0
    ? padData(new Uint8Array(slot.saveRaw), FX_SAVE_ALIGNMENT)
    : new Uint8Array(0);

  // Calculate page offsets
  const headerPages = 1; // 256 bytes = 1 page
  const imagePages = FX_TITLE_SIZE / FX_PAGESIZE; // 1024 / 256 = 4 pages
  const programPages = program.length / FX_PAGESIZE;
  const dataPages = data.length / FX_PAGESIZE;

  const programPage = currentPage + headerPages + imagePages;
  const dataPage = programPage + programPages;

  // Save must be aligned to 4KB (16 pages)
  let savePage = dataPage + dataPages;
  if (save.length > 0) {
    const saveAlignment = FX_SAVE_ALIGNMENT / FX_PAGESIZE; // 16
    const alignPad = padSize(savePage, saveAlignment);
    savePage += alignPad;
  }

  const savePages = save.length / FX_PAGESIZE;
  const totalPages = headerPages + imagePages + programPages + dataPages +
    (save.length > 0 ? (savePage - dataPage - dataPages) + savePages : 0);

  // Apply menu button patch (Timer0 ISR replacement)
  if (program.length > 0) {
    patchMenuButtons(program);
  }

  // Patch FX data/save page addresses into program
  if (program.length > 0 && (data.length > 0 || save.length > 0)) {
    if (data.length > 0) {
      program[FX_DATA_PAGE_OFFSET] = RETI_BYTES[0];
      program[FX_DATA_PAGE_OFFSET + 1] = RETI_BYTES[1];
      writeUint16BE(program, FX_DATA_PAGE_OFFSET + 2, dataPage);
    }
    if (save.length > 0) {
      program[FX_SAVE_PAGE_OFFSET] = RETI_BYTES[0];
      program[FX_SAVE_PAGE_OFFSET + 1] = RETI_BYTES[1];
      writeUint16BE(program, FX_SAVE_PAGE_OFFSET + 2, savePage);
    }
  }

  // Compute SHA-256 hash of program + data
  const hashInput = concat(program, data);
  const hash = hashInput.length > 0 ? await sha256(hashInput) : new Uint8Array(32);

  // Build header (256 bytes)
  const header = filledArray(FX_HEADER_SIZE);

  // Magic
  header.set(FX_CART_MAGIC, FX_HEADER.MAGIC);

  // Category
  header[FX_HEADER.CATEGORY] = slot.category;

  // Page pointers (next_page is filled in during second pass)
  writeUint16BE(header, FX_HEADER.PREV_PAGE, previousPage);
  writeUint16BE(header, FX_HEADER.NEXT_PAGE, 0xFFFF); // placeholder

  // Sizes
  writeUint16BE(header, FX_HEADER.SLOT_SIZE, totalPages);

  // Program size in half-pages (128-byte units).
  // Don't flash the last half-page if it's all 0xFF (matches Python reference).
  let programFlashSize = program.length / FLASH_PAGESIZE;
  if (programFlashSize > 0) {
    const lastHalfPage = program.slice(program.length - FLASH_PAGESIZE);
    if (lastHalfPage.every((b) => b === 0xFF)) {
      programFlashSize--;
    }
  }
  header[FX_HEADER.PROGRAM_SIZE] = programFlashSize;
  writeUint16BE(header, FX_HEADER.PROGRAM_PAGE, program.length > 0 ? programPage : 0xFFFF);
  writeUint16BE(header, FX_HEADER.DATA_PAGE, data.length > 0 ? dataPage : 0xFFFF);
  writeUint16BE(header, FX_HEADER.SAVE_PAGE, save.length > 0 ? savePage : 0xFFFF);
  writeUint16BE(header, FX_HEADER.DATA_SIZE, dataPages);

  // Hash
  header.set(hash, FX_HEADER.HASH);

  // Metadata strings
  // Categories store: title\0info\0  (2 fields)
  // Programs store:   title\0version\0developer\0info\0  (4 fields)
  let metaStr;
  if (program.length === 0) {
    // Category slot (including bootloader image)
    metaStr = `${slot.meta.title}\0${slot.meta.info}\0`;
  } else {
    metaStr = `${slot.meta.title}\0${slot.meta.version}\0${slot.meta.developer}\0${slot.meta.info}\0`;
  }
  const metaBytes = encodeString(metaStr);
  const metaLen = Math.min(metaBytes.length, FX_META_MAX_LENGTH);
  header.set(metaBytes.slice(0, metaLen), FX_HEADER.META_START);

  // Assemble: header + image + program + data + alignment padding + save
  const parts = [header, slot.imageRaw];
  if (program.length > 0) parts.push(program);
  if (data.length > 0) parts.push(data);

  if (save.length > 0) {
    // Add alignment padding between data and save
    const currentEnd = currentPage + headerPages + imagePages + programPages + dataPages;
    const paddingPages = savePage - currentEnd;
    if (paddingPages > 0) {
      parts.push(filledArray(paddingPages * FX_PAGESIZE));
    }
    parts.push(save);
  }

  return concat(...parts);
}

/**
 * Fix parsed slots for compilation:
 * - Ensure first slot is the bootloader image (category 0)
 * - Ensure second slot is a category (first game category)
 * - Assign sequential category IDs starting from 0
 *
 * The Cathy3K bootloader reads the title image from page 0 of the
 * FX flash. That image lives in the first slot (always a category
 * with ID 0). The second slot must also be a category — this is
 * the first actual game category shown in the bootloader menu.
 *
 * @param {FxParsedSlot[]} slots
 * @returns {FxParsedSlot[]}
 */
function fixParsedSlots(slots) {
  // Clone so we don't mutate the caller's array
  slots = [...slots];

  // Ensure slot 0 is a category (the bootloader image).
  // If the first slot isn't a category, insert a blank bootloader image.
  if (slots.length === 0 || !slots[0].isCategory) {
    slots.unshift(new FxParsedSlot({
      category: 0,
      meta: { title: '', version: '', developer: '', info: '' },
    }));
  }

  // Ensure slot 1 is also a category (first game category).
  // The bootloader requires at least two categories.
  if (slots.length < 2 || !slots[1].isCategory) {
    slots.splice(1, 0, new FxParsedSlot({
      category: 1,
      meta: { title: 'Games', version: '', developer: '', info: '' },
    }));
  }

  // Assign category IDs starting from 0 (matching Python reference).
  // Category 0 = bootloader image, 1 = first game category, etc.
  let categoryId = -1;
  for (const slot of slots) {
    if (slot.isCategory) {
      categoryId++;
    }
    slot.category = categoryId;
  }

  return slots;
}

// =============================================================================
// Trim
// =============================================================================

/**
 * Trim a flash cart binary, removing everything after the last valid slot.
 *
 * @param {Uint8Array} fullData - Complete cart binary (may have trailing empty space)
 * @returns {Uint8Array} Trimmed binary
 */
export function trimFxCart(fullData) {
  let offset = 0;
  let lastValidEnd = 0;

  while (offset + FX_HEADER_SIZE <= fullData.length) {
    if (!isSlotHeader(fullData, offset)) break;
    const slotSize = getSlotSizeBytes(fullData.slice(offset, offset + FX_HEADER_SIZE));
    if (slotSize === 0) break;
    offset += slotSize;
    lastValidEnd = offset;
  }

  // Include one extra page as end sentinel
  const trimEnd = Math.min(lastValidEnd + FX_PAGESIZE, fullData.length);
  return fullData.slice(0, trimEnd);
}

/**
 * Scan cart headers only (fast, without reading full data).
 * Returns metadata for each slot without program/data/save content.
 *
 * @param {Uint8Array} fullData
 * @returns {{ count: number, categories: number, games: number, totalPages: number, slots: FxSlotMeta[] }}
 */
export function scanFxCartHeaders(fullData) {
  const slots = [];
  let offset = 0;
  let categories = 0;
  let games = 0;

  while (offset + FX_HEADER_SIZE <= fullData.length) {
    if (!isSlotHeader(fullData, offset)) break;

    const header = fullData.slice(offset, offset + FX_HEADER_SIZE);
    const meta = parseMetaStrings(header);
    const programSize = header[FX_HEADER.PROGRAM_SIZE];
    const slotSize = getSlotSizeBytes(header);

    if (programSize === 0) {
      categories++;
    } else {
      games++;
    }

    slots.push(meta);
    if (slotSize === 0) break;
    offset += slotSize;
  }

  return {
    count: slots.length,
    categories,
    games,
    totalPages: offset / FX_PAGESIZE,
    slots,
  };
}
