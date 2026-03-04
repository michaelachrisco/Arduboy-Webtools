/**
 * Export song model as ArduboyPlaytune format.
 *
 * Generates a byte command stream compatible with the ArduboyPlaytune library.
 *
 * Command encoding:
 *   Note On:  0x90 | channel, noteNumber
 *   Note Off: 0x80 | channel
 *   Wait:     high_byte (bit7=0), low_byte  (15-bit big-endian ms, max 32767)
 *   Stop:     0xF0
 *   Restart:  0xE0
 */

import { tickToMs, sortNotes, getSongEndTick } from './songModel.js';

/**
 * Emit wait command bytes. Splits at 32767ms boundary.
 * @param {number[]} bytes  Output array
 * @param {number} ms  Duration to wait
 */
function emitWaits(bytes, ms) {
  ms = Math.round(ms);
  while (ms > 32767) {
    bytes.push((32767 >> 8) & 0x7F);
    bytes.push(32767 & 0xFF);
    ms -= 32767;
  }
  if (ms > 0) {
    bytes.push((ms >> 8) & 0x7F);
    bytes.push(ms & 0xFF);
  }
}

/**
 * Format a byte as a hex string: "0x1A"
 * @param {number} b
 * @returns {string}
 */
function hex(b) {
  return '0x' + b.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Export the song model to ArduboyPlaytune C code.
 *
 * @param {Object} song  Song model
 * @param {Object} [opts]
 * @param {string} [opts.arrayName='score']
 * @returns {{ code: string, exampleCode: string, warnings: string[], byteCount: number }}
 */
export function exportArduboyPlaytune(song, opts = {}) {
  const { arrayName = 'score' } = opts;

  const warnings = [];

  // Build event list from all tracks (max 2 channels)
  const events = [];
  const maxChannels = Math.min(song.tracks.length, 2);

  for (let ch = 0; ch < maxChannels; ch++) {
    const track = song.tracks[ch];
    for (const note of track.notes) {
      if (note.muted) continue;
      const startMs = tickToMs(note.startTick, song.tempoMap, song.ppq);
      const endMs = tickToMs(note.endTick, song.tempoMap, song.ppq);

      events.push({
        ms: startMs,
        type: 'noteOn',
        ch,
        noteNumber: note.noteNumber,
        sortOrder: 1,
      });
      events.push({
        ms: endMs,
        type: 'noteOff',
        ch,
        noteNumber: 0,
        sortOrder: 0, // note-offs sort before note-ons at the same ms
      });
    }
  }

  if (song.tracks.length > 2) {
    warnings.push(`Song has ${song.tracks.length} tracks but ArduboyPlaytune supports max 2 channels — only first 2 exported`);
  }

  // Stable sort: by ms, then note-off before note-on
  events.sort((a, b) => {
    if (a.ms !== b.ms) return a.ms - b.ms;
    return a.sortOrder - b.sortOrder;
  });

  if (events.length === 0) {
    const termByte = song.loopEnabled ? '0xE0' : '0xF0';
    return {
      code: `const byte ${arrayName}[] PROGMEM = {\n  ${termByte}\n};`,
      exampleCode: generatePlaytuneExampleMinimal(arrayName),
      exampleCodeFull: generatePlaytuneExampleFull(arrayName, `const byte ${arrayName}[] PROGMEM = {\n  ${termByte}\n};`),
      warnings: ['No notes to export'],
      byteCount: 1,
    };
  }

  // Generate byte stream
  const bytes = [];
  const comments = []; // Parallel array of comments for each byte group
  let prevMs = 0;

  for (const event of events) {
    const deltaMs = event.ms - prevMs;
    if (deltaMs > 0) {
      const waitBytes = [];
      emitWaits(waitBytes, deltaMs);
      bytes.push(...waitBytes);
      comments.push({ start: bytes.length - waitBytes.length, len: waitBytes.length, text: `wait ${Math.round(deltaMs)}ms` });
    }
    prevMs = event.ms;

    if (event.type === 'noteOn') {
      bytes.push(0x90 | event.ch);
      bytes.push(event.noteNumber);
      comments.push({ start: bytes.length - 2, len: 2, text: `ch${event.ch} on note ${event.noteNumber}` });
    } else {
      bytes.push(0x80 | event.ch);
      comments.push({ start: bytes.length - 1, len: 1, text: `ch${event.ch} off` });
    }
  }

  // Terminator
  if (song.loopEnabled) {
    bytes.push(0xE0);
    comments.push({ start: bytes.length - 1, len: 1, text: 'restart' });
  } else {
    bytes.push(0xF0);
    comments.push({ start: bytes.length - 1, len: 1, text: 'stop' });
  }

  // Format as C code with hex values, 12 bytes per line
  const BYTES_PER_LINE = 12;
  const lines = [];
  for (let i = 0; i < bytes.length; i += BYTES_PER_LINE) {
    const chunk = bytes.slice(i, i + BYTES_PER_LINE);
    lines.push('  ' + chunk.map(b => hex(b)).join(', '));
  }

  const code = `const byte ${arrayName}[] PROGMEM = {\n${lines.join(',\n')}\n};`;
  const byteCount = bytes.length;

  if (byteCount > 28000) {
    warnings.push(`Score is ${byteCount} bytes — may exceed Arduboy program memory`);
  }

  return {
    code,
    exampleCode: generatePlaytuneExampleMinimal(arrayName),
    exampleCodeFull: generatePlaytuneExampleFull(arrayName, code),
    warnings,
    byteCount,
  };
}

function generatePlaytuneExampleMinimal(arrayName) {
  return `tune.playScore(${arrayName});`;
}

function generatePlaytuneExampleSimple(arrayName) {
  return `// Declare the array as a global:
// const byte ${arrayName}[] PROGMEM = { ... };

void playMusicButtonExample() {
  static ArduboyPlaytune tune(arduboy.audio.enabled);
  static boolean isPlaying = false;

  if (arduboy.pressed(A_BUTTON)) {
    if (!isPlaying) {
      tune.initChannel(PIN_SPEAKER_1);
      tune.initChannel(PIN_SPEAKER_2);
      tune.playScore(${arrayName});
      isPlaying = true;
    }
  }
  
  if (arduboy.pressed(B_BUTTON)) {
    tune.stopScore();
    isPlaying = false;
  }
  
  // Check if music finished playing
  if (!tune.isPlaying()) {
    isPlaying = false;
  }
}`;
}

function generatePlaytuneExampleFull(arrayName, arrayCode) {
  return `#include <Arduboy2.h>
#include <ArduboyPlaytune.h>

Arduboy2 arduboy;
ArduboyPlaytune tune(arduboy.audio.enabled);

// Song array
${arrayCode}

boolean isMusicPlaying = false;

void setup() {
  arduboy.begin();
  arduboy.audio.on();
  tune.initChannel(PIN_SPEAKER_1);
  tune.initChannel(PIN_SPEAKER_2);
}

void loop() {
  if (!arduboy.nextFrame()) return;
  
  // A button: play/restart
  if (arduboy.pressed(A_BUTTON)) {
    if (!isMusicPlaying) {
      tune.playScore(${arrayName});
      isMusicPlaying = true;
    }
  }
  
  // B button: pause/stop
  if (arduboy.pressed(B_BUTTON)) {
    tune.stopScore();
    isMusicPlaying = false;
  }
  
  // Check if music finished
  if (!tune.isPlaying()) {
    isMusicPlaying = false;
  }

  arduboy.clear();
  // your game code here
  arduboy.display();
}`;
}
