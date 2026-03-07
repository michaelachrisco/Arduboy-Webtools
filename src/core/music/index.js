/**
 * Music modules — re-exports for convenient imports.
 */

export {
  createSong,
  createNote,
  nextNoteId,
  advanceNoteIdCounter,
  tickToMs,
  msToTick,
  getSongEndTick,
  quantizeTick,
  scaleTempo,
  sortNotes,
  findOverlaps,
  resolveOverlaps,
} from './songModel.js';

export {
  midiNoteToFreq,
  clampFreq,
  midiNoteToConstant,
  midiNoteToConstantH,
  midiNoteToName,
  isBlackKey,
  freqToConstant,
} from './noteConstants.js';

export {
  parseMidiFile,
  midiToSong,
} from './midiImport.js';

export {
  exportArduboyTones,
} from './exportTones.js';

export {
  exportArduboyPlaytune,
} from './exportPlaytune.js';
