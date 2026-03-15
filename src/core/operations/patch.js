/**
 * Binary patching operations.
 *
 * All patches modify program bytearrays in-place and return
 * success/failure with messages.
 *
 * Ported from:
 *   - arduboy_toolset/arduboy/patch.py
 *   - Arduboy-Python-Utilities/uploader.py (SSD1309, Micro LED patches)
 */

import { RETI_BYTES, FX_DATA_PAGE_OFFSET, FX_SAVE_PAGE_OFFSET } from '../constants.js';
import { writeUint16BE } from '../utils/binary.js';

// =============================================================================
// SSD1309 Display Patch
// =============================================================================

/** LCD boot program signature to search for */
const LCD_BOOT_PATTERN = new Uint8Array([0xd5, 0xf0, 0x8d, 0x14, 0xa1, 0xc8, 0x81, 0xcf, 0xd9, 0xf1, 0xaf, 0x20, 0x00]);

/**
 * Patch hex data for SSD1309 displays.
 *
 * Searches for the LCD boot program pattern and changes charge pump
 * initialization bytes from 0x8D 0x14 (SSD1306) to 0xE3 0xE3 (SSD1309 NOP).
 *
 * @param {Uint8Array} flashData - Flash data to patch (modified in-place)
 * @returns {{success: boolean, count: number, message: string}}
 */
export function patchSSD1309(flashData) {
  let count = 0;

  for (let i = 0; i <= flashData.length - LCD_BOOT_PATTERN.length; i++) {
    let match = true;
    for (let j = 0; j < LCD_BOOT_PATTERN.length; j++) {
      if (flashData[i + j] !== LCD_BOOT_PATTERN[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Replace charge pump bytes (offset +2 and +3 from pattern start)
      flashData[i + 2] = 0xe3; // NOP (was 0x8D — charge pump enable command)
      flashData[i + 3] = 0xe3; // NOP (was 0x14 — charge pump on)
      count++;
    }
  }

  return {
    success: count > 0,
    count,
    message: count > 0 ? `Patched ${count} LCD boot program(s) for SSD1309.` : 'LCD boot program pattern not found.',
  };
}

/**
 * Patch the contrast/brightness byte in the LCD boot program.
 *
 * @param {Uint8Array} flashData - Flash data to patch (modified in-place)
 * @param {number} contrast - Contrast value (0x00–0xFF). Common: 0xCF=max, 0x7F=normal, 0x3F=dim, 0x1F=dimmer, 0x00=dimmest
 * @returns {{success: boolean, count: number, message: string}}
 */
export function patchContrast(flashData, contrast) {
  let count = 0;

  for (let i = 0; i <= flashData.length - LCD_BOOT_PATTERN.length; i++) {
    let match = true;
    for (let j = 0; j < LCD_BOOT_PATTERN.length; j++) {
      // Allow the charge pump bytes to be already patched (0xE3)
      if (j === 2 || j === 3) continue;
      // Allow the contrast byte to be any value
      if (j === 7) continue;
      if (flashData[i + j] !== LCD_BOOT_PATTERN[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      flashData[i + 7] = contrast; // Contrast byte at offset 7
      count++;
    }
  }

  return {
    success: count > 0,
    count,
    message: count > 0 ? `Set contrast to 0x${contrast.toString(16)} in ${count} location(s).` : 'LCD boot program pattern not found.',
  };
}

// =============================================================================
// Arduino Micro LED Polarity Patch
// =============================================================================

/** SBI/CBI instruction patterns for RXLED and TXLED */
const RXLED_CBI = new Uint8Array([0x47, 0x9a]); // CBI PORTB, 0 (RXLED off)
const RXLED_SBI = new Uint8Array([0x47, 0x98]); // SBI PORTB, 0 (RXLED on)
const TXLED_CBI = new Uint8Array([0x35, 0x9a]); // CBI PORTD, 5 (TXLED off)
const TXLED_SBI = new Uint8Array([0x35, 0x98]); // SBI PORTD, 5 (TXLED on)

/**
 * Patch LED polarity for Arduino Micro clones.
 * Swaps SBI ↔ CBI instructions for RXLED and TXLED pins.
 *
 * @param {Uint8Array} flashData - Flash data to patch (modified in-place)
 * @returns {{success: boolean, count: number, message: string}}
 */
export function patchMicroLed(flashData) {
  let count = 0;

  for (let i = 0; i <= flashData.length - 2; i++) {
    // RXLED: swap CBI ↔ SBI for PORTB bit 0
    if (flashData[i] === RXLED_CBI[0] && flashData[i + 1] === RXLED_CBI[1]) {
      flashData[i + 1] = RXLED_SBI[1]; // CBI → SBI
      count++;
    } else if (flashData[i] === RXLED_SBI[0] && flashData[i + 1] === RXLED_SBI[1]) {
      flashData[i + 1] = RXLED_CBI[1]; // SBI → CBI
      count++;
    }
    // TXLED: swap CBI ↔ SBI for PORTD bit 5
    if (flashData[i] === TXLED_CBI[0] && flashData[i + 1] === TXLED_CBI[1]) {
      flashData[i + 1] = TXLED_SBI[1]; // CBI → SBI
      count++;
    } else if (flashData[i] === TXLED_SBI[0] && flashData[i + 1] === TXLED_SBI[1]) {
      flashData[i + 1] = TXLED_CBI[1]; // SBI → CBI
      count++;
    }
  }

  return {
    success: count > 0,
    count,
    message: count > 0 ? `Swapped ${count} LED instruction(s) for Micro polarity.` : 'No LED instructions found to patch.',
  };
}

// =============================================================================
// FX Data/Save Page Patching
// =============================================================================

/**
 * Patch FX data and save page addresses into a program binary.
 * Used when building flash cart slots to tell the program where its
 * FX data and save data are located.
 *
 * @param {Uint8Array} program - Program binary (modified in-place)
 * @param {number|null} dataPage - FX data page number (null to skip)
 * @param {number|null} savePage - FX save page number (null to skip)
 */
export function patchFxPages(program, dataPage, savePage) {
  if (program.length < 0x1c) return;

  if (dataPage !== null && dataPage !== undefined) {
    program[FX_DATA_PAGE_OFFSET] = RETI_BYTES[0];
    program[FX_DATA_PAGE_OFFSET + 1] = RETI_BYTES[1];
    writeUint16BE(program, FX_DATA_PAGE_OFFSET + 2, dataPage);
  }

  if (savePage !== null && savePage !== undefined) {
    program[FX_SAVE_PAGE_OFFSET] = RETI_BYTES[0];
    program[FX_SAVE_PAGE_OFFSET + 1] = RETI_BYTES[1];
    writeUint16BE(program, FX_SAVE_PAGE_OFFSET + 2, savePage);
  }
}

// =============================================================================
// Menu Button Patch (Timer0 ISR replacement)
// =============================================================================

/**
 * The menu button patch AVR machine code (152 bytes).
 * Replaces the Timer0 ISR to detect UP+DOWN held for 2 seconds,
 * then jumps to the bootloader menu.
 *
 * Ported from flashcart-builder.py MenuButtonPatch.
 */
export const MENU_BUTTON_PATCH = new Uint8Array([
  0x0f, 0x92, 0x0f, 0xb6, 0x8f, 0x93, 0x9f, 0x93, 0xef, 0x93, 0xff, 0x93, 0x80, 0x91, 0xcc, 0x01,
  0x8d, 0x5f, 0x8d, 0x37, 0x08, 0xf0, 0x8d, 0x57, 0x80, 0x93, 0xcc, 0x01, 0xe2, 0xe4, 0xf3, 0xe0,
  0x80, 0x81, 0x8e, 0x4f, 0x80, 0x83, 0x91, 0x81, 0x9f, 0x4f, 0x91, 0x83, 0x82, 0x81, 0x8f, 0x4f,
  0x82, 0x83, 0x83, 0x81, 0x8f, 0x4f, 0x83, 0x83, 0xed, 0xec, 0xf1, 0xe0, 0x80, 0x81, 0x8f, 0x5f,
  0x80, 0x83, 0x81, 0x81, 0x8f, 0x4f, 0x81, 0x83, 0x82, 0x81, 0x8f, 0x4f, 0x82, 0x83, 0x83, 0x81,
  0x8f, 0x4f, 0x83, 0x83, 0x8f, 0xb1, 0x8f, 0x60, 0x66, 0x99, 0x1c, 0x9b, 0x88, 0x27, 0x8f, 0x36,
  0x81, 0xf4, 0x80, 0x91, 0xff, 0x0a, 0x98, 0x1b, 0x96, 0x30, 0x68, 0xf0, 0xe0, 0xe0, 0xf8, 0xe0,
  0x87, 0xe7, 0x80, 0x83, 0x81, 0x83, 0x88, 0xe1, 0x80, 0x93, 0x60, 0x00, 0xf0, 0x93, 0x60, 0x00,
  0xff, 0xcf, 0x90, 0x93, 0xff, 0x0a, 0xff, 0x91, 0xef, 0x91, 0x9f, 0x91, 0x8f, 0x91, 0x0f, 0xbe,
  0x0f, 0x90, 0x18, 0x95,
]);

/** Offsets into the patch where timer variable addresses must be fixed up */
const MBP_FRACT_LDS = 14;
const MBP_FRACT_STS = 26;
const MBP_MILLIS_R30 = 28;
const MBP_MILLIS_R31 = 30;
const MBP_OVERFLOW_R30 = 56;
const MBP_OVERFLOW_R31 = 58;

/**
 * Apply the menu button patch to a program binary.
 * Analyzes the Timer0 ISR and replaces it with code that detects
 * UP+DOWN held for 2 seconds, then jumps to the bootloader menu.
 *
 * Ported from flashcart-builder.py PatchMenuButton().
 *
 * @param {Uint8Array} program - Program binary (modified in-place)
 * @returns {{success: boolean, message: string}}
 */
export function patchMenuButtons(program) {
  if (program.length < 256) {
    return { success: false, message: 'No menu patch applied. Program too small.' };
  }

  // Read the Timer0 ISR vector (vector 23) at address 0x5E
  const vector23 = (program[0x5e] << 1) | (program[0x5f] << 9);

  let p = vector23;
  let isrLen = 0;
  let ldsCount = 0;
  let branch = 0;
  let timer0Millis = 0;
  let timer0Fract = 0;
  let timer0OverflowCount = 0;

  while (p < program.length - 2) {
    p += 2; // advance past current 2-byte instruction

    // RET instruction — ISR contains a subroutine call, can't patch
    if (program[p - 2] === 0x08 && program[p - 1] === 0x95) {
      isrLen = -1;
      break;
    }

    // BRCC instruction — may jump beyond RETI
    if ((program[p - 1] & 0xfc) === 0xf4 && (program[p - 2] & 0x07) === 0x00) {
      branch = ((program[p - 1] & 0x03) << 6) + ((program[p - 2] & 0xf8) >> 2);
      branch = branch < 128 ? p + branch : p - 256 + branch;
    }

    // RETI instruction
    if (program[p - 2] === 0x18 && program[p - 1] === 0x95) {
      isrLen = p - vector23;
      if (p > branch) break; // no branch beyond RETI
    }

    // If we already found RETI but branched past it, look for RJMP
    if (isrLen !== 0) {
      if ((program[p - 1] & 0xf0) === 0xc0) {
        isrLen = p - vector23;
        break;
      }
    }

    // Handle 4-byte instructions: LDS
    if ((program[p - 1] & 0xfe) === 0x90 && (program[p - 2] & 0x0f) === 0x00) {
      ldsCount++;
      if (ldsCount === 1) {
        timer0Millis = program[p] | (program[p + 1] << 8);
      } else if (ldsCount === 5) {
        timer0Fract = program[p] | (program[p + 1] << 8);
      } else if (ldsCount === 6) {
        timer0OverflowCount = program[p] | (program[p + 1] << 8);
      }
      p += 2;
    }

    // Handle 4-byte instructions: STS
    if ((program[p - 1] & 0xfe) === 0x92 && (program[p - 2] & 0x0f) === 0x00) {
      p += 2;
    }
  }

  if (isrLen === -1) {
    return { success: false, message: 'No menu patch applied. ISR contains subroutine.' };
  }
  if (isrLen < MENU_BUTTON_PATCH.length) {
    return { success: false, message: `No menu patch applied. ISR size too small (${isrLen} bytes).` };
  }
  if (timer0Millis === 0 || timer0Fract === 0 || timer0OverflowCount === 0) {
    return { success: false, message: 'No menu patch applied. Custom ISR in use.' };
  }

  // Write the patch into the ISR location
  program.set(MENU_BUTTON_PATCH, vector23);

  // Fix timer0_fract addresses (LDS and STS)
  program[vector23 + MBP_FRACT_LDS + 0] = timer0Fract & 0xff;
  program[vector23 + MBP_FRACT_LDS + 1] = timer0Fract >> 8;
  program[vector23 + MBP_FRACT_STS + 0] = timer0Fract & 0xff;
  program[vector23 + MBP_FRACT_STS + 1] = timer0Fract >> 8;

  // Fix timer0_millis addresses (LDI r30/r31)
  program[vector23 + MBP_MILLIS_R30 + 0] = 0xe0 | ((timer0Millis >> 0) & 0x0f);
  program[vector23 + MBP_MILLIS_R30 + 1] = 0xe0 | ((timer0Millis >> 4) & 0x0f);
  program[vector23 + MBP_MILLIS_R31 + 0] = 0xf0 | ((timer0Millis >> 8) & 0x0f);
  program[vector23 + MBP_MILLIS_R31 + 1] = 0xe0 | ((timer0Millis >> 12) & 0x0f);

  // Fix timer0_overflow_count addresses (LDI r30/r31)
  program[vector23 + MBP_OVERFLOW_R30 + 0] = 0xe0 | ((timer0OverflowCount >> 0) & 0x0f);
  program[vector23 + MBP_OVERFLOW_R30 + 1] = 0xe0 | ((timer0OverflowCount >> 4) & 0x0f);
  program[vector23 + MBP_OVERFLOW_R31 + 0] = 0xf0 | ((timer0OverflowCount >> 8) & 0x0f);
  program[vector23 + MBP_OVERFLOW_R31 + 1] = 0xe0 | ((timer0OverflowCount >> 12) & 0x0f);

  return { success: true, message: 'Menu patch applied.' };
}

// =============================================================================
// Contrast Presets
// =============================================================================

/** Common contrast preset values */
export const CONTRAST_PRESETS = {
  MAX:     0xcf,
  NORMAL:  0x7f,
  DIM:     0x3f,
  DIMMER:  0x1f,
  DIMMEST: 0x00,
};
