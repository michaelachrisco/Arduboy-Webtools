/**
 * Canonical song model for the Arduboy music editor.
 *
 * All note positions are stored in ticks (musical time).
 * Conversion to real-time (ms) uses the tempo map and PPQ.
 */

let _noteIdCounter = 0;

/** Generate a unique ID for a note. */
export function nextNoteId() {
  return ++_noteIdCounter;
}

/** Advance the counter so it's at least `minValue`. Used after restoring persisted notes. */
export function advanceNoteIdCounter(minValue) {
  if (minValue > _noteIdCounter) _noteIdCounter = minValue;
}

/**
 * Create a new empty song.
 * @param {Object} [opts]
 * @returns {Object}
 */
export function createSong(opts = {}) {
  return {
    ppq: opts.ppq ?? 480,
    tempoMap: opts.tempoMap ?? [{ tick: 0, bpm: 120 }],
    timeSig: opts.timeSig ?? { num: 4, denom: 4 },
    tracks: opts.tracks ?? [
      { id: 'voice0', name: 'Voice 1', notes: [] },
    ],
    loopStartTick: opts.loopStartTick ?? 0,
    loopEndTick: opts.loopEndTick ?? 1920,
    loopEnabled: opts.loopEnabled ?? false,
  };
}

/**
 * Create a note object.
 * @param {number} noteNumber  MIDI note (0-127)
 * @param {number} startTick
 * @param {number} endTick
 * @param {number} [velocity=100]
 * @returns {Object}
 */
export function createNote(noteNumber, startTick, endTick, velocity = 100) {
  return {
    id: nextNoteId(),
    noteNumber,
    startTick,
    endTick,
    velocity,
    muted: false,
  };
}

/**
 * Convert a tick position to milliseconds using the tempo map.
 *
 * The tempo map is a sorted array of { tick, bpm } entries.
 * Between tempo changes, time flows linearly at the current BPM.
 *
 * @param {number} tick
 * @param {Array<{tick:number, bpm:number}>} tempoMap
 * @param {number} ppq  Ticks per quarter note
 * @returns {number} Milliseconds
 */
export function tickToMs(tick, tempoMap, ppq) {
  let ms = 0;
  let prevTick = 0;
  let bpm = 120;

  for (let i = 0; i < tempoMap.length; i++) {
    const entry = tempoMap[i];
    if (entry.tick >= tick) break;

    // Accumulate time from prevTick to this entry's tick
    if (entry.tick > prevTick) {
      const delta = entry.tick - prevTick;
      const msPerTick = (60000 / bpm) / ppq;
      ms += delta * msPerTick;
    }
    prevTick = entry.tick;
    bpm = entry.bpm;
  }

  // Remaining ticks at current BPM
  const remaining = tick - prevTick;
  if (remaining > 0) {
    const msPerTick = (60000 / bpm) / ppq;
    ms += remaining * msPerTick;
  }

  return ms;
}

/**
 * Convert milliseconds to ticks using the tempo map.
 * @param {number} ms
 * @param {Array<{tick:number, bpm:number}>} tempoMap
 * @param {number} ppq
 * @returns {number}
 */
export function msToTick(ms, tempoMap, ppq) {
  let accMs = 0;
  let prevTick = 0;
  let bpm = 120;

  for (let i = 0; i < tempoMap.length; i++) {
    const entry = tempoMap[i];
    const msPerTick = (60000 / bpm) / ppq;
    const entryMs = accMs + (entry.tick - prevTick) * msPerTick;

    if (entryMs >= ms) break;

    accMs = entryMs;
    prevTick = entry.tick;
    bpm = entry.bpm;
  }

  const msPerTick = (60000 / bpm) / ppq;
  const remaining = ms - accMs;
  return Math.round(prevTick + remaining / msPerTick);
}

/**
 * Get the last tick in the song (end of the last note across all tracks).
 * @param {Object} song
 * @returns {number}
 */
export function getSongEndTick(song) {
  let maxTick = 0;
  for (const track of song.tracks) {
    for (const note of track.notes) {
      if (note.endTick > maxTick) maxTick = note.endTick;
    }
  }
  return maxTick;
}

/**
 * Quantize a tick value to the nearest grid division.
 * @param {number} tick
 * @param {number} ppq   Ticks per quarter note
 * @param {number} division  Grid division (4=quarter, 8=eighth, 16=sixteenth, 32=thirty-second)
 * @returns {number}
 */
export function quantizeTick(tick, ppq, division) {
  if (!division || division <= 0) return tick;
  const gridSize = (ppq * 4) / division;
  return Math.round(tick / gridSize) * gridSize;
}

/**
 * Scale all tempos in the tempo map by a factor.
 * @param {Object} song
 * @param {number} factor  e.g. 0.5 = half speed, 2 = double speed
 */
export function scaleTempo(song, factor) {
  for (const entry of song.tempoMap) {
    entry.bpm = Math.max(30, Math.min(3000, Math.round(entry.bpm * factor)));
  }
}

/**
 * Sort notes by startTick, then by noteNumber (ascending).
 * @param {Array} notes
 * @returns {Array}
 */
export function sortNotes(notes) {
  return notes.slice().sort((a, b) => {
    if (a.startTick !== b.startTick) return a.startTick - b.startTick;
    return a.noteNumber - b.noteNumber;
  });
}

/**
 * Find overlapping notes within a single track.
 * Two notes overlap if their time ranges intersect.
 * @param {Object} track
 * @returns {Array<{a: Object, b: Object}>}  Pairs of overlapping notes
 */
export function findOverlaps(track) {
  const sorted = sortNotes(track.notes);
  const overlaps = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startTick >= sorted[i].endTick) break;
      overlaps.push({ a: sorted[i], b: sorted[j] });
    }
  }
  return overlaps;
}

/**
 * Resolve overlaps by truncating earlier notes.
 * For monophonic output: at each point in time, keep only the highest-pitched note.
 * In-place mutation of the track's notes array.
 * @param {Object} track
 */
export function resolveOverlaps(track) {
  if (track.notes.length <= 1) return;

  // Sort by start time, then highest note first
  track.notes.sort((a, b) => {
    if (a.startTick !== b.startTick) return a.startTick - b.startTick;
    return b.noteNumber - a.noteNumber;
  });

  // Walk through and truncate overlapping notes
  for (let i = 0; i < track.notes.length - 1; i++) {
    const current = track.notes[i];
    const next = track.notes[i + 1];
    if (current.endTick > next.startTick) {
      current.endTick = next.startTick;
    }
    // Remove zero-duration notes
    if (current.endTick <= current.startTick) {
      track.notes.splice(i, 1);
      i--;
    }
  }
}
