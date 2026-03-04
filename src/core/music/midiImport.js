/**
 * MIDI file import — wraps @tonejs/midi and converts to the internal song model.
 */

import { Midi } from '@tonejs/midi';
import { createSong, createNote, resolveOverlaps } from './songModel.js';
import { midiNoteToName } from './noteConstants.js';

/**
 * Parse a MIDI file and return track summaries for the selection dialog.
 * @param {ArrayBuffer} buffer
 * @returns {{ midi: Midi, summary: Array<TrackSummary> }}
 */
export function parseMidiFile(buffer) {
  const midi = new Midi(buffer);
  const summary = [];

  for (let i = 0; i < midi.tracks.length; i++) {
    const track = midi.tracks[i];
    if (track.notes.length === 0) continue;

    let minNote = 127;
    let maxNote = 0;
    const channels = new Set();

    for (const note of track.notes) {
      if (note.midi < minNote) minNote = note.midi;
      if (note.midi > maxNote) maxNote = note.midi;
      channels.add(note.channel ?? 0);
    }

    summary.push({
      index: i,
      name: track.name || `Track ${i + 1}`,
      channel: [...channels].join(', '),
      noteCount: track.notes.length,
      minNote,
      maxNote,
      pitchRange: `${midiNoteToName(minNote)}–${midiNoteToName(maxNote)}`,
    });
  }

  return { midi, summary };
}

/**
 * Convert selected MIDI tracks into the internal song model.
 * @param {Midi} midi  Parsed MIDI object from @tonejs/midi
 * @param {Object} opts
 * @param {number[]} opts.trackIndices  Which MIDI tracks to import
 * @param {'tones'|'playtune'} opts.targetLibrary
 * @returns {Object}  Song model
 */
export function midiToSong(midi, opts) {
  const { trackIndices, targetLibrary } = opts;

  const ppq = midi.header.ppq || 480;

  // Build tempo map from @tonejs/midi's header.tempos
  const tempoMap = [];
  if (midi.header.tempos && midi.header.tempos.length > 0) {
    for (const t of midi.header.tempos) {
      tempoMap.push({
        tick: Math.round(t.ticks),
        bpm: Math.round(t.bpm),
      });
    }
  }
  if (tempoMap.length === 0) {
    tempoMap.push({ tick: 0, bpm: 120 });
  }

  // Extract time signature (first one)
  let timeSig = { num: 4, denom: 4 };
  if (midi.header.timeSignatures && midi.header.timeSignatures.length > 0) {
    const ts = midi.header.timeSignatures[0];
    timeSig = {
      num: ts.timeSignature?.[0] ?? 4,
      denom: ts.timeSignature?.[1] ?? 4,
    };
  }

  // Convert selected tracks
  const tracks = [];
  for (let v = 0; v < trackIndices.length; v++) {
    const midiTrack = midi.tracks[trackIndices[v]];
    const notes = [];

    for (const note of midiTrack.notes) {
      const startTick = Math.round(note.ticks);
      const endTick = Math.round(note.ticks + note.durationTicks);
      const velocity = Math.round((note.velocity ?? 0.5) * 127);
      notes.push(createNote(note.midi, startTick, endTick, velocity));
    }

    tracks.push({
      id: `voice${v}`,
      name: midiTrack.name || `Voice ${v + 1}`,
      notes,
    });
  }

  // Every track is mono (one note at a time per voice) regardless of target library
  for (const track of tracks) {
    resolveOverlaps(track);
  }

  // For Playtune, ensure exactly 2 tracks
  if (targetLibrary === 'playtune') {
    while (tracks.length < 2) {
      tracks.push({ id: `voice${tracks.length}`, name: `Voice ${tracks.length + 1}`, notes: [] });
    }
  }

  return createSong({
    ppq,
    tempoMap,
    timeSig,
    tracks,
  });
}
