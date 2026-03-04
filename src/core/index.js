/**
 * Arduboy Web Tools — Core Library Entry Point
 *
 * Re-exports all core modules for convenient imports.
 */

// Constants
export * from './constants.js';

// Serial
export { SerialTransport } from './serial/transport.js';
export { ArduboyProtocol } from './serial/protocol.js';
export { DeviceManager } from './serial/device.js';

// Formats
export { parseIntelHex, generateIntelHex } from './formats/intelhex.js';
export { FxParsedSlot, parseFxCart, compileFxCart, trimFxCart, scanFxCartHeaders } from './formats/fxcart.js';
export { readArduboyFile, writeArduboyFile } from './formats/arduboy.js';
export { screenToImageData, imageDataToScreen, convertImage, loadImageFile, loadImageFileOriginal, screenToDataURL, convertImageFormat, generateUsageSnippet, generateFullSketch, OUTPUT_FORMAT } from './formats/image.js';

// Operations
export { uploadSketch, backupSketch, eraseSketch, analyzeSketch } from './operations/sketch.js';
export { writeFx, backupFx, scanFx, writeFxDev } from './operations/fx.js';
export { readEeprom, writeEeprom, eraseEeprom } from './operations/eeprom.js';
export { patchSSD1309, patchContrast, patchMicroLed, patchFxPages, patchMenuButtons, CONTRAST_PRESETS } from './operations/patch.js';

// Utils
export * from './utils/binary.js';

// Music
export * from './music/index.js';
