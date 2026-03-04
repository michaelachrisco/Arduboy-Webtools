# Arduboy Music Helper Tool — Agent Brief (ArduboyTones + ArduboyPlaytune + midi2tones)

**Goal:** Build a JavaScript (web) tool that helps users create/convert/edit Arduboy music for **either**:
- **ArduboyTones** (monophonic tone sequences as frequency/duration pairs)
- **ArduboyPlaytune** (1–2 voice “score” bytestream with note on/off + waits)

This tool must:
1. Import MIDI (and optionally export MIDI).
2. Provide a lightweight in-browser editor (piano-roll style) scoped to Arduboy capabilities.
3. Export **ready-to-paste** C/C++ code arrays **in the exact formats these libraries expect**, plus example usage code.
4. Allow choosing the target library per project/song (switchable, with clear constraints & conversion rules).

---

## 1) What these libraries are and why they differ

### 1.1 ArduboyTones (MLXXXp/ArduboyTones)
ArduboyTones is a compact library for playing **square-wave tones** (and sequences) on Arduboy speaker pins. It supports:
- `tone(freq [,dur])` for 1 tone (or 2/3 tones in sequence)
- `tones(const uint16_t[] PROGMEM)` for sequences in flash
- `tonesInRAM(uint16_t[])` for sequences in RAM
- `noTone()`, `playing()`, `volumeMode(...)`

**Key data format:** A *monotonic* stream of `uint16_t` values interpreted as **pairs**:
```
frequency, duration, frequency, duration, ... , TERMINATOR
```

The array ends with one **single** terminator value:
- `TONES_END` → stop at end
- `TONES_REPEAT` → loop from start

**Important nuance:** ArduboyTones treats durations as **1024ths of a second**, not exact milliseconds (≈2.34% shorter than ms). If you need “real ms”, multiply desired ms by 1.024 before writing durations. (See ArduboyTones README.)  
Also, frequency range supported is **16 Hz to 32767 Hz**; `0` means rest/silence. (See ArduboyTones README.)

**Volume:** Arduboy can drive speaker across two pins to get “high volume”. In the frequency/duration stream, **high volume is indicated by setting the high bit of the frequency (adding `0x8000`)**. (This is the convention used by `midi2tones` alternate format.)

Sources (read these in the provided repos):
- ArduboyTones README (functions, array termination, 1024ths-second durations)
- `ArduboyTonesPitches.h` (NOTE_* constants; also NOTE_*H for high volume notes)

---

### 1.2 ArduboyPlaytune (Ar-zz-duboy/ArduboyPlaytune)
ArduboyPlaytune plays a “score” represented as a **byte command stream**, supporting up to **two simultaneous notes** (two channels). It’s still square waves, but it’s event-based:
- Note on/off commands
- Wait commands (delays)
- End / loop commands
- Also supports `tone(freq, dur)` on channel 1 (can optionally mute channel 0 while tone is playing)

**Key data format:** `const byte score[] PROGMEM = { ... }`

From the ArduboyPlaytune README, the core commands are:

#### Commands (high bit set)
- `0x9t, nn` → **note on** for channel `t` (0 or 1), note number `nn` (MIDI note number; 60=Middle C, 69=A4=440)
- `0x8t` → **note off** for channel `t`
- `0xF0` → **end** (stop)
- `0xE0` → **end** (restart from beginning)

#### Wait command (high bit clear)
If the high bit of a byte is 0, it begins a wait:
- First byte: `0b0xxxxxxx` (7 bits)
- Second byte: `0..255`
- Together: a **15-bit big-endian** integer = milliseconds to wait before processing next command.
Example: `0x07, 0xD0` => 0x07D0 = 2000 ms.

Sources:
- ArduboyPlaytune README, “The Score bytestream” section.

---

### 1.3 midi2tones (MLXXXp/midi2tones)
`midi2tones` is a CLI converter that can output:
- **Playtune** score format (default, `-o1`)
- **Alternate ArduboyTones** frequency/duration pair format (`-o2`)

Important notes from its documentation (in the repo source comments):
- For the alternate format, output is a stream of **16-bit big-endian** values in binary mode, or C source with `uint16_t` constants in text mode.
- **High volume** for alternate format is indicated by setting frequency high bit (`+0x8000`).
- Alternate format terminators:
  - `0x8000` → end of score (stop)
  - `0x8001` → end of score (restart) if `-r` used

Your web tool does not have to replicate the *exact* CLI UX, but it should implement the same semantics where practical, because lots of Arduboy users know this converter and expect comparable output.

---

## 2) Canonical internal representation (important for an editor + multiple exporters)

To support editing + multiple backends, do **not** store ArduboyTones arrays or Playtune bytes as the primary data model.

Instead, use an internal “project song model”:

### 2.1 Song model
- `ppq` (ticks per quarter note) — e.g. 480 (common)
- `tempoMap`: array of `{tick, bpm}` (for MVP: a single BPM)
- `timeSig` (optional; for MVP, treat as display only)
- `tracks`:
  - For Playtune target: up to **2 tracks/voices** (voice0, voice1)
  - For Tones target: **1 track** (monophonic)
- Each track contains **note events**:
  - `noteNumber` (0–127 MIDI)
  - `startTick`, `endTick` (or `durationTicks`)
  - `velocity` (0–127) (used only for “high volume” heuristics; actual output is binary “normal vs high”)
  - `muted`, `solo` (editor-only)
- Optional meta:
  - `loopStartTick`, `loopEndTick`, `loopEnabled`

### 2.2 Why this matters
- Tempo changes require rescaling or regenerating time deltas.
- Export formats have constraints (15-bit waits, monophonic stream, terminators).
- UI needs editable musical structure, not just raw arrays.

---

## 3) Export formats and exact requirements

### 3.1 Export: ArduboyTones sequence array (PROGMEM)

#### Output (C/C++)
Generate something like:

```cpp
#include <Arduboy2.h>
#include <ArduboyTones.h>

Arduboy2 arduboy;
ArduboyTones sound(arduboy.audio.enabled);

const uint16_t song_title[] PROGMEM = {
  NOTE_C4, 128,  NOTE_REST, 32,  NOTE_E4, 128,
  TONES_END
};

void setup() {
  arduboy.begin();
  arduboy.audio.on(); // or off by default; depends on game
  sound.tones(song_title);
}
```

#### Frequency value encoding
- Either output raw Hz numbers (e.g. `440`) **or** use ArduboyTones note defines from `ArduboyTonesPitches.h`:
  - `NOTE_<letter><S?><octave><H?>`
  - `NOTE_REST` is `0`
- High volume:
  - Either output `NOTE_*H` constants (preferred for readability), **or**
  - Output `(<freq> | 0x8000)` (preferred if using raw Hz)

#### Duration value encoding
- ArduboyTones durations are in **1024ths of a second** (library internal convention).
- Your UI can *display* ms or musical note lengths, but exporter must produce:
  - `duration1024 = round(seconds * 1024)`
  - If converting from ms: `duration1024 = round(ms * 1024 / 1000)`
- Keep durations as `uint16_t` (0..65535). Clamp or split if needed.

#### Terminators
- Export `TONES_END` or `TONES_REPEAT` as the final single value.
- If the project loop is enabled, prefer `TONES_REPEAT`.

#### Monophonic constraint
- ArduboyTones stream is monotonic: one note at a time.
- If the internal song has overlaps/chords:
  - Provide conversion modes:
    1. **Monophonic “melody only”**: keep highest (or lowest) pitch at each time slice.
    2. **Arpeggiate**: convert chords into fast sequential notes within the chord duration (user-configurable pattern).
    3. **Error with guidance**: highlight overlaps.

---

### 3.2 Export: ArduboyPlaytune score bytestream (PROGMEM)

Generate:

```cpp
#include <Arduboy2.h>
#include <ArduboyPlaytune.h>

Arduboy2 arduboy;
ArduboyPlaytune tune(arduboy.audio.enabled);

const byte score_title[] PROGMEM = {
  0x90, 60,  // note on ch0, middle C
  0x00, 0x64, // wait 100ms (0x0064)
  0x80,      // note off ch0
  0xF0       // stop
};

void setup() {
  arduboy.begin();
  arduboy.audio.on();
  tune.playScore(score_title);
}
```

#### Playtune commands
- Note on: `0x90 | channel` then note number
- Note off: `0x80 | channel`
- Wait: 2 bytes, 15-bit big-endian milliseconds
- End: `0xF0` stop, `0xE0` restart

#### Timing constraints
- Wait is a 15-bit value: `0..32767` ms per wait command.
- If any delta exceeds 32767ms, emit multiple waits that sum to the delta.
- If delta is 0, you may omit the wait entirely (but preserve correct note ordering).

#### Two-voice constraint
- Playtune can play up to 2 notes simultaneously.
- Provide voice allocation rules when importing MIDI with more than two parts:
  1. **Keep two tracks** by user selection
  2. Or **auto-pick** two tracks based on note density / range / channel
  3. Or **collapse** to 2 voices by priority (melody + bass), dropping others

#### Looping
- If loop enabled: terminate with `0xE0`
- Else terminate with `0xF0`

---

## 4) MIDI import (and what to support)

### 4.1 MVP MIDI support
- Type 0 and Type 1 MIDI files
- Parse:
  - tempo (Set Tempo meta)
  - note on/off
  - optionally time signature meta for display
- Ignore:
  - instruments, CC, pitch bend, aftertouch
- Velocities:
  - Use velocity to decide “high volume” threshold in ArduboyTones export (user-configurable)

### 4.2 Track/channel selection UX
When a MIDI is loaded:
- Show a list of tracks with:
  - name (if present)
  - channel(s) used
  - note count
  - pitch range
- User chooses:
  - Target library: **Tones** or **Playtune**
  - Which track(s) map into voice lanes (1 lane for Tones; 2 lanes for Playtune)

---

## 5) Tempo scaling and “transcoding time values” (required feature)

Users want to “speed up” or “slow down” music *after* it’s imported/edited.

### 5.1 How to do it correctly
Keep internal events in **ticks**, with a BPM value. When BPM changes:
- Event tick positions don’t change (musical time stays the same)
- Exporter recomputes milliseconds (Playtune waits) or 1024ths durations (Tones)

For a constant BPM:
- `msPerTick = (60000 / bpm) / ppq`
- For each note:
  - `startMs = startTick * msPerTick`
  - `endMs = endTick * msPerTick`
- Then:
  - Playtune deltas are based on sorted event times
  - Tones durations are based on note lengths

For tempo maps (optional advanced):
- Convert tick→ms using piecewise integration across tempo segments.

### 5.2 UI control
- Provide a BPM input (e.g., 30–300)
- Provide “Scale tempo” operations:
  - Set BPM
  - Multiply BPM by factor (e.g., 1.1x, 0.9x)
- Provide quantization (e.g., 1/4, 1/8, 1/16, triplets optional)

---

## 6) Web editor UI spec (piano-roll, Arduboy-scoped)

### 6.1 Layout
- Left: track/voice list + settings
- Center: piano roll grid
- Bottom: transport + zoom

### 6.2 Essential controls
- **Target selector**: “ArduboyTones (mono)” vs “ArduboyPlaytune (2-voice)”
- **Voices**:
  - Tones: 1 lane
  - Playtune: 2 lanes (“Voice 1”, “Voice 2”)
- **Grid / quantize** dropdown:
  - Off, 1/4, 1/8, 1/16, 1/32, (optional) triplets
- **Snap-to-grid** toggle
- **Tempo**:
  - BPM input
  - “×0.5”, “×0.75”, “×1.25”, “×2” buttons
- **Loop**:
  - toggle loop
  - set loop region by drag (optional MVP: loop whole song)
- **Export**:
  - “Copy C code”
  - “Download .h/.cpp snippet” (optional)
  - “Download .mid” (optional)

### 6.3 Editing behavior (like common MIDI tools)
- Click-drag to create note
- Drag note to move; drag edges to resize
- Delete with right click or Delete key
- Box select with shift-drag
- For Playtune:
  - Notes can overlap if they are on different voices
  - Prevent >1 overlap per voice lane (one note at a time per lane)
- For Tones:
  - Prevent overlaps (or auto-resolve by truncating previous note)

### 6.4 Preview audio (WebAudio)
Provide instant preview using WebAudio:
- Use `OscillatorNode` with `type='square'`
- Schedule notes based on the current BPM and ticks
- For “high volume”, you can slightly boost gain or add subtle distortion (optional), but keep it simple.
- Transport: play/pause/stop, play from cursor, loop playback

---

## 7) Conversion rules and edge cases

### 7.1 Note number ↔ frequency
- Playtune output uses **MIDI note numbers** directly.
- ArduboyTones output uses **Hz** (or `NOTE_*` constants).
- Provide helper conversion in JS:
  - `freqHz = 440 * 2^((note-69)/12)`
  - Round to integer Hz for ArduboyTones.
  - Clamp to [16..32767] Hz (and rests = 0).

### 7.2 Rests
- Tones: represent gaps as `0, duration`
- Playtune: represent gaps as wait commands while no notes are on

### 7.3 Splitting long waits
- Playtune waits max 32767 ms, split as needed.
- Tones durations max 65535 “1024ths”, split note or rest into multiple pairs if needed.

### 7.4 Ordering of events (Playtune)
When generating the bytestream:
- Build a sorted list of “state change events”:
  - note on/off for each voice
- Stable ordering at same timestamp:
  1. note off events
  2. note on events
This avoids accidental note stealing on a voice.

### 7.5 Voice allocation (Playtune)
If user imports a single polyphonic track:
- Offer “Auto-voice split”:
  - Greedy assign each new note to a free voice
  - If both busy, either:
    - drop lowest priority note, or
    - steal voice with nearest end time, etc.
- Prefer to keep melody intact (highest pitch or highest velocity) if needing to drop notes.

### 7.6 High volume heuristics
Expose settings:
- `highVolumeVelocityThreshold` (0–127)
- Per-note override toggle
For ArduboyTones export:
- If note velocity >= threshold → set 0x8000 high bit (or use NOTE_*H)

---

## 8) Export UX: give users exactly what they need

When exporting, include:
1. The data array (`song[]` / `score[]`) with `PROGMEM`
2. Minimal example usage code:
   - includes
   - object construction (with Arduboy2 audio enabled callback)
   - how to start playback
   - how to stop / loop
3. Notes about:
   - memory usage (array size)
   - monophonic/2-voice constraints
   - any dropped notes / arpeggiation applied

Also provide “Copy as header snippet”:
- e.g. `music/song_title.h` containing the array and `extern` if desired.

---

## 9) Implementation guidance (JavaScript, one-shot friendly)

### 9.1 Recommended module breakdown
- `midi/parseMidi.js`  
  Parse MIDI into `{ppq, tempoMap, tracks[]}`
- `model/songModel.js`  
  Canonical representation + helpers (quantize, transpose, scaleTempo)
- `editor/pianoRoll.js`  
  Render grid, handle input, selection, drag/resizing
- `audio/preview.js`  
  WebAudio scheduling
- `export/arduboyTones.js`  
  Convert songModel → `{cCode, arrayData, warnings}`
- `export/arduboyPlaytune.js`  
  Convert songModel → `{cCode, byteStream, warnings}`
- `ui/app.js`  
  Glue + state management

### 9.2 Output validation tests (must-have)
Write unit tests for:
- Playtune wait encoding (15-bit big-endian)
- Splitting waits > 32767ms
- Playtune command stream ends with E0/F0 correctly
- Tones array ends with TONES_END/REPEAT and contains even pairs
- High volume bit (0x8000) applied correctly

### 9.3 “Golden file” tests
Include a few small hardcoded songs in the repo:
- “scale up/down”
- “two-voice harmony”
- “rest + long wait”
Export them and compare output to expected arrays.

---

## 10) UX polish (still MVP-friendly)
- Warnings panel:
  - dropped notes
  - clamped frequencies
  - overlapping notes resolved
  - waits split
- Stats panel:
  - total notes
  - total duration
  - exported array sizes (bytes)
- “Arduboy constraints” tooltip next to the target selector.

---

## 11) Optional follow-up questions for the human (if needed)
If you need to clarify before coding, ask:
1. Should ArduboyTones exporter prefer `NOTE_*` names or raw frequencies by default?
2. For Playtune, do we want to support the optional midi2tones header (`-d`) and velocity/instrument bytes, or keep the simpler core subset?
3. Should the editor allow multiple tempo changes, or just one global BPM for now?
4. Which integration framework is expected in the “wider array of tools” (plain JS, React, Svelte, etc.)?

---

## 12) Primary references (repos)
- ArduboyTones: https://github.com/MLXXXp/ArduboyTones
- ArduboyPlaytune: https://github.com/Ar-zz-duboy/ArduboyPlaytune
- midi2tones: https://github.com/MLXXXp/midi2tones
