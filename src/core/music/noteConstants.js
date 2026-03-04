/**
 * MIDI note ↔ frequency and ArduboyTones NOTE_* constant mappings.
 *
 * Frequency values are taken directly from ArduboyTonesPitches.h.
 */

const NOTE_NAMES = ['C', 'CS', 'D', 'DS', 'E', 'F', 'FS', 'G', 'GS', 'A', 'AS', 'B'];
const DISPLAY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Frequency lookup table indexed by MIDI note number (0–119 = C0–B9).
 * Values match ArduboyTonesPitches.h exactly.
 */
// prettier-ignore
const FREQ_TABLE = [
  // C0-B0 (MIDI 0-11)  — octave -1 in some conventions, but ArduboyTones calls it 0
  16, 17, 18, 19, 21, 22, 23, 25, 26, 28, 29, 31,
  // C1-B1 (MIDI 12-23)
  33, 35, 37, 39, 41, 44, 46, 49, 52, 55, 58, 62,
  // C2-B2 (MIDI 24-35)
  65, 69, 73, 78, 82, 87, 93, 98, 104, 110, 117, 123,
  // C3-B3 (MIDI 36-47)
  131, 139, 147, 156, 165, 175, 185, 196, 208, 220, 233, 247,
  // C4-B4 (MIDI 48-59)
  262, 277, 294, 311, 330, 349, 370, 392, 415, 440, 466, 494,
  // C5-B5 (MIDI 60-71)
  523, 554, 587, 622, 659, 698, 740, 784, 831, 880, 932, 988,
  // C6-B6 (MIDI 72-83)
  1047, 1109, 1175, 1245, 1319, 1397, 1480, 1568, 1661, 1760, 1865, 1976,
  // C7-B7 (MIDI 84-95)
  2093, 2218, 2349, 2489, 2637, 2794, 2960, 3136, 3322, 3520, 3729, 3951,
  // C8-B8 (MIDI 96-107)
  4186, 4435, 4699, 4978, 5274, 5588, 5920, 6272, 6645, 7040, 7459, 7902,
  // C9-B9 (MIDI 108-119)
  8372, 8870, 9397, 9956, 10548, 11175, 11840, 12544, 13290, 14080, 14917, 15804,
];

/**
 * MIDI note number → ArduboyTones frequency (Hz).
 * Uses the exact values from ArduboyTonesPitches.h for notes 0–119.
 * Falls back to computed value for out-of-range notes.
 * @param {number} noteNumber  MIDI note (0–127)
 * @returns {number}  Frequency in Hz (integer)
 */
export function midiNoteToFreq(noteNumber) {
  if (noteNumber >= 0 && noteNumber < FREQ_TABLE.length) {
    return FREQ_TABLE[noteNumber];
  }
  // Fallback: compute from formula
  return Math.round(440 * Math.pow(2, (noteNumber - 69) / 12));
}

/**
 * Clamp frequency to the ArduboyTones valid range.
 * @param {number} hz
 * @returns {number}  Clamped Hz, or 0 for rests
 */
export function clampFreq(hz) {
  if (hz <= 0) return 0;
  return Math.max(16, Math.min(32767, hz));
}

/**
 * MIDI note number → NOTE_* constant name (e.g. 60 → "NOTE_C5").
 *
 * Note: In ArduboyTones, MIDI note 0 = C0, so MIDI 60 = C5 (not C4 as in
 * standard MIDI convention). We follow the ArduboyTones convention here
 * where octave = floor(midiNote / 12).
 *
 * @param {number} noteNumber
 * @returns {string}
 */
export function midiNoteToConstant(noteNumber) {
  if (noteNumber < 0 || noteNumber >= 120) return String(midiNoteToFreq(noteNumber));
  const octave = Math.floor(noteNumber / 12);
  const semitone = noteNumber % 12;
  return `NOTE_${NOTE_NAMES[semitone]}${octave}`;
}

/**
 * MIDI note number → high-volume NOTE_*H constant name.
 * @param {number} noteNumber
 * @returns {string}
 */
export function midiNoteToConstantH(noteNumber) {
  if (noteNumber < 0 || noteNumber >= 120) return `(${midiNoteToFreq(noteNumber)} + TONE_HIGH_VOLUME)`;
  const octave = Math.floor(noteNumber / 12);
  const semitone = noteNumber % 12;
  return `NOTE_${NOTE_NAMES[semitone]}${octave}H`;
}

/**
 * MIDI note number → display name (e.g. 60 → "C5").
 * Uses ArduboyTones octave convention: octave = floor(midiNote / 12).
 * @param {number} noteNumber
 * @returns {string}
 */
export function midiNoteToName(noteNumber) {
  const octave = Math.floor(noteNumber / 12);
  const semitone = noteNumber % 12;
  return `${DISPLAY_NAMES[semitone]}${octave}`;
}

/**
 * Returns true if the MIDI note is a "black key" (sharp/flat).
 * @param {number} noteNumber
 * @returns {boolean}
 */
export function isBlackKey(noteNumber) {
  const semitone = noteNumber % 12;
  // C# D# F# G# A# → indices 1, 3, 6, 8, 10
  return semitone === 1 || semitone === 3 || semitone === 6 || semitone === 8 || semitone === 10;
}

/**
 * Reverse lookup: frequency → closest NOTE_* constant name.
 * @param {number} hz
 * @returns {string}
 */
export function freqToConstant(hz) {
  if (hz === 0) return 'NOTE_REST';
  let closest = 0;
  let closestDiff = Infinity;
  for (let i = 0; i < FREQ_TABLE.length; i++) {
    const diff = Math.abs(FREQ_TABLE[i] - hz);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = i;
    }
  }
  return midiNoteToConstant(closest);
}
