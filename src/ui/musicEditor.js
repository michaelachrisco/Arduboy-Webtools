/**
 * Music Editor — Arduboy music creation and export tool.
 *
 * Features:
 *   - Canvas-based piano roll editor
 *   - MIDI file import
 *   - WebAudio square-wave preview
 *   - Export to ArduboyTones and ArduboyPlaytune formats
 */

import {
  createSong, createNote, tickToMs, msToTick,
  getSongEndTick, quantizeTick, scaleTempo,
  sortNotes, resolveOverlaps,
  parseMidiFile, midiToSong,
  midiNoteToFreq, midiNoteToName, isBlackKey,
  exportArduboyTones, exportArduboyPlaytune,
  advanceNoteIdCounter,
} from '../core/music/index.js';
import { readFileAsArrayBuffer, downloadBlob } from './files.js';
import { showToast } from './toast.js';
import { showConfirm } from './modal.js';

const $ = (sel) => document.querySelector(sel);

// Voice colors
const VOICE_COLORS = ['#A84DD4', '#FBF157'];
const VOICE_COLORS_DIM = ['rgba(168,77,212,0.4)', 'rgba(251,241,87,0.4)'];

// Piano roll constants
const KEYBOARD_WIDTH = 48;
const MIN_NOTE = 12;   // C1 in ArduboyTones convention (MIDI 12)
const MAX_NOTE = 120;  // C10 in ArduboyTones convention (MIDI 120)
const NOTE_HEIGHT = 12;
const RESIZE_EDGE_PX = 6;
const SEEK_BAR_H = 16;   // height of clickable seek/position header bar
const MINIMAP_H = 52;    // height of the minimap strip below the main canvas

export class MusicEditor {
  _song = null;
  _lastExport = null;

  // Canvas
  _ctx = null;
  _scrollX = 0;
  _scrollY = 0;
  _zoomH = 1;
  _pixelsPerTick = 0.15;

  // Display range (viewport)
  _displayMinNote = 36;  // C3 by default
  _displayMaxNote = 84;  // C7 by default
  _showFullRange = false;

  // Scrollbar hover highlight
  _sbHover = { v: false, h: false };

  // Editing
  _selectedNotes = new Set();
  _dragState = null;
  _activeTrackIdx = 0;
  _quantizeDiv = 8;
  _hoveredNote = null;
  _editMode = 'note';        // 'note' | 'select'
  _selectBothVoices = false; // box-select captures all voices in select mode
  _timeSelection = null;     // { startTick, endTick } | null — seek-bar time range

  // Minimap
  _minimapCanvas = null;
  _minimapCtx = null;
  _minimapDrag = null; // { startX, startY, startScrollX, startScrollY }

  // Playback
  _audioCtx = null;
  _isPlaying = false;
  _playStartTime = 0;
  _playSeekMs = 0;        // ms offset into song when play started
  _seekTick = 0;          // tick to start/resume playback from
  _scheduledOscillators = [];
  _playheadAnimFrame = null;

  constructor() {
    this._song = createSong();
    this._updateDisplayRange();  // Initialize display range
    this._grabRefs();
    this._bindEvents();
    this._loadState();   // Restore persisted song + settings (overwrites defaults if found)
    this._renderVoiceList();
    this._resizeCanvas();
    this._render();
    this._updateExport();
  }

  // ─── DOM references ──────────────────────────────────────────────────

  _grabRefs() {
    this._canvas = $('#mus-pianoroll-canvas');
    this._ctx = this._canvas?.getContext('2d');
    this._container = $('#mus-pianoroll-container');
    this._minimapCanvas = $('#mus-minimap-canvas');
    this._minimapCtx = this._minimapCanvas?.getContext('2d');
    this._voiceList = $('#mus-voice-list');

    this._targetSelect = $('#mus-target-library');
    this._bpmInput = $('#mus-bpm');
    this._quantizeSelect = $('#mus-quantize');
    this._midiFileInput = $('#mus-midi-file');
    this._arrayNameInput = $('#mus-array-name');

    this._btnPlay = $('#btn-mus-play');
    this._btnPause = $('#btn-mus-pause');
    this._btnStop = $('#btn-mus-stop');
    this._btnModeNote = $('#btn-mus-mode-note');
    this._btnModeSelect = $('#btn-mus-mode-select');
    this._selectBothVoicesCheckbox = $('#mus-select-both-voices');
    this._selectBothLabel = $('#mus-select-both-label');
    this._positionDisplay = $('#mus-playback-position');
    this._zoomSlider = $('#mus-zoom-h');

    this._velocityThreshold = $('#mus-velocity-threshold');
    this._velocityThresholdValue = $('#mus-velocity-threshold-value');
    this._loopCheckbox = $('#mus-loop-enabled');
    this._useConstants = $('#mus-use-constants');

    this._codeOutput = $('#mus-code-output');
    this._usageOutput = $('#mus-usage-output');
    this._showCompleteSketchCheckbox = $('#mus-show-complete-sketch');
    this._exportInfo = $('#mus-export-info');
    this._warningsGroup = $('#mus-warnings-group');
    this._warningsList = $('#mus-warnings-list');

    // Storage for example code versions
    this._exampleCodeMinimal = '';
    this._exampleCodeFull = '';
  }

  // ─── Event binding ───────────────────────────────────────────────────

  _bindEvents() {
    // New / Import
    $('#btn-mus-new')?.addEventListener('click', () => this._newSong());
    $('#btn-mus-import-midi')?.addEventListener('click', () => this._midiFileInput?.click());
    this._midiFileInput?.addEventListener('change', () => this._handleMidiFile());

    // Target library
    this._targetSelect?.addEventListener('change', () => this._onTargetChange());

    // BPM
    this._bpmInput?.addEventListener('change', () => this._onBpmChange());
    $('#btn-mus-bpm-dec')?.addEventListener('click', () => this._adjustBpm(-1));
    $('#btn-mus-bpm-inc')?.addEventListener('click', () => this._adjustBpm(1));

    // Tempo scaling
    $('#btn-mus-tempo-half')?.addEventListener('click', () => this._doScaleTempo(0.5));
    $('#btn-mus-tempo-075')?.addEventListener('click', () => this._doScaleTempo(0.75));
    $('#btn-mus-tempo-125')?.addEventListener('click', () => this._doScaleTempo(1.25));
    $('#btn-mus-tempo-double')?.addEventListener('click', () => this._doScaleTempo(2));

    // Quantize
    this._quantizeSelect?.addEventListener('change', () => {
      this._quantizeDiv = parseInt(this._quantizeSelect.value, 10) || 0;
      this._render();
    });

    // Zoom
    this._zoomSlider?.addEventListener('input', () => {
      this._zoomH = parseFloat(this._zoomSlider.value);
      this._render();
    });

    // Transport
    this._btnPlay?.addEventListener('click', () => this._play());
    this._btnPause?.addEventListener('click', () => this._pause());
    this._btnStop?.addEventListener('click', () => this._stop());

    // Edit mode
    this._btnModeNote?.addEventListener('click', () => this._setEditMode('note'));
    this._btnModeSelect?.addEventListener('click', () => this._setEditMode('select'));
    this._selectBothVoicesCheckbox?.addEventListener('change', (e) => {
      this._selectBothVoices = e.target.checked;
    });

    // Settings
    this._velocityThreshold?.addEventListener('input', () => {
      if (this._velocityThresholdValue) {
        this._velocityThresholdValue.textContent = this._velocityThreshold.value;
      }
      this._updateExport();
    });

    this._loopCheckbox?.addEventListener('change', () => {
      this._song.loopEnabled = this._loopCheckbox.checked;
      this._updateExport();
    });

    this._useConstants?.addEventListener('change', () => this._updateExport());
    this._arrayNameInput?.addEventListener('change', () => this._updateExport());

    // Full range checkbox
    const fullRangeCheckbox = $('#mus-show-full-range');
    fullRangeCheckbox?.addEventListener('change', (e) => {
      this._showFullRange = e.target.checked;
      this._updateDisplayRange();
      this._render();
    });

    // Canvas events
    this._canvas?.addEventListener('mousedown', (e) => this._onMouseDown(e));
    this._canvas?.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this._canvas?.addEventListener('mouseup', (e) => this._onMouseUp(e));
    this._canvas?.addEventListener('mouseleave', () => this._onMouseLeave());
    this._canvas?.addEventListener('contextmenu', (e) => { e.preventDefault(); this._onRightClick(e); });
    this._canvas?.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    // Keyboard
    document.addEventListener('keydown', (e) => this._onKeyDown(e));

    // Resize
    this._resizeObserver = new ResizeObserver(() => this._resizeCanvas());
    if (this._container) this._resizeObserver.observe(this._container);

    // Vertical resize handle for piano roll
    this._bindResizeHandle();

    // Export buttons
    $('#btn-mus-copy')?.addEventListener('click', () => this._copyCode());
    $('#btn-mus-copy-icon')?.addEventListener('click', () => this._copyCode());
    $('#btn-mus-download-h')?.addEventListener('click', () => this._downloadH());
    $('#btn-mus-download-mid')?.addEventListener('click', () => this._downloadMid());
    $('#btn-mus-copy-usage')?.addEventListener('click', () => this._copyUsage());
    $('#btn-mus-copy-usage-icon')?.addEventListener('click', () => this._copyUsage());
    this._showCompleteSketchCheckbox?.addEventListener('change', () => this._updateUsageDisplay());

    // Minimap
    this._bindMinimapEvents();
  }

  // ─── Resize handle ──────────────────────────────────────────────────

  _updateDisplayRange() {
    if (this._showFullRange) {
      this._displayMinNote = MIN_NOTE;
      this._displayMaxNote = MAX_NOTE;
    } else {
      this._displayMinNote = 36;  // C3
      this._displayMaxNote = 84;  // C7
    }

    // Clamp scroll to new range
    if (this._canvas) {
      const totalNoteRows = this._displayMaxNote - this._displayMinNote;
      const maxScrollY = Math.max(0, totalNoteRows * NOTE_HEIGHT - this._canvas.height);
      this._scrollY = Math.max(0, Math.min(this._scrollY, maxScrollY));
    }

    // Clamp the resized element's height if it now exceeds the content max.
    // In mobile the pianoroll container is resized independently; in desktop
    // the whole layout is resized.
    const layout = document.getElementById('mus-editor-layout');
    if (layout && this._container) {
      const transport = this._container.querySelector('.mus-transport');
      const transportH = transport?.offsetHeight || 36;
      const totalNoteRows = this._displayMaxNote - this._displayMinNote;
      const maxContentH = totalNoteRows * NOTE_HEIGHT + transportH + MINIMAP_H;
      const isMobile = window.matchMedia('(max-width: 900px)').matches;
      const target = isMobile ? this._container : layout;
      const currentH = target.getBoundingClientRect().height;
      if (currentH > maxContentH) {
        target.style.height = `${maxContentH}px`;
        this._resizeCanvas();
      }
    }
  }

  _autoSetDisplayRange() {
    // Find the range of notes in the song
    let minNote = MAX_NOTE;
    let maxNote = MIN_NOTE;
    
    for (const track of this._song.tracks) {
      for (const note of track.notes) {
        minNote = Math.min(minNote, note.noteNumber);
        maxNote = Math.max(maxNote, note.noteNumber);
      }
    }

    // If no notes found, use default
    if (minNote > maxNote) {
      this._showFullRange = false;
      this._updateDisplayRange();
      const checkbox = $('#mus-show-full-range');
      if (checkbox) checkbox.checked = false;
      return;
    }

    // Check if notes fit in default range (C3-C7)
    const defaultMin = 36;
    const defaultMax = 84;
    if (minNote >= defaultMin && maxNote <= defaultMax) {
      // Fits in default range
      this._showFullRange = false;
      this._updateDisplayRange();
      const checkbox = $('#mus-show-full-range');
      if (checkbox) checkbox.checked = false;
    } else {
      // Need full range
      this._showFullRange = true;
      this._updateDisplayRange();
      const checkbox = $('#mus-show-full-range');
      if (checkbox) checkbox.checked = true;
    }
  }

  _bindResizeHandle() {
    const handle = document.getElementById('mus-pianoroll-resize-handle');
    const layout = document.getElementById('mus-editor-layout');
    if (!handle || !layout || !this._container) return;

    let dragging = false;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      handle.classList.add('active');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;

      // In mobile the layout height is auto; resize only the pianoroll container.
      // In desktop the layout has an explicit height; resize that instead.
      const isMobile = window.matchMedia('(max-width: 900px)').matches;
      const target = isMobile ? this._container : layout;
      const rect = target.getBoundingClientRect();
      const newHeight = e.clientY - rect.top;

      // Calculate transport bar height
      const transport = this._container.querySelector('.mus-transport');
      const transportH = transport?.offsetHeight || 36;

      const totalNoteRows = this._displayMaxNote - this._displayMinNote;
      const maxContentH = totalNoteRows * NOTE_HEIGHT + transportH + MINIMAP_H;
      const minH = 200 + MINIMAP_H;
      const clamped = Math.max(minH, Math.min(newHeight, maxContentH));

      // Auto-scroll: if expanding downward and content would show blank space
      // below the last row, pull scrollY back so bottom row stays at bottom
      const canvasH = clamped - transportH - MINIMAP_H;
      const maxScrollY = Math.max(0, totalNoteRows * NOTE_HEIGHT - canvasH);
      if (this._scrollY > maxScrollY) {
        this._scrollY = maxScrollY;
      }

      target.style.height = `${clamped}px`;
      this._resizeCanvas();
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });

    // Clear inline heights when crossing the 900px responsive breakpoint so
    // desktop and mobile layouts stay independent of each other.
    const mq = window.matchMedia('(max-width: 900px)');
    mq.addEventListener('change', () => {
      layout.style.removeProperty('height');
      this._container.style.removeProperty('height');
      this._resizeCanvas();
    });
  }

  // ─── Song operations ─────────────────────────────────────────────────

  _hasSongContent() {
    return this._song?.tracks?.some(t => t.notes.length > 0) ?? false;
  }

  async _newSong() {
    if (this._hasSongContent()) {
      const ok = await showConfirm('This will discard the current song. Continue?');
      if (!ok) return;
    }
    this._stop();
    const target = this._targetSelect?.value || 'tones';
    const tracks = [{ id: 'voice0', name: 'Voice 1', notes: [] }];
    if (target === 'playtune') {
      tracks.push({ id: 'voice1', name: 'Voice 2', notes: [] });
    }
    this._song = createSong({ tracks });
    this._bpmInput.value = 120;
    this._selectedNotes.clear();
    this._activeTrackIdx = 0;
    this._scrollX = 0;
    this._scrollY = 0;
    
    // Reset to default display range
    this._showFullRange = false;
    this._updateDisplayRange();
    const checkbox = $('#mus-show-full-range');
    if (checkbox) checkbox.checked = false;
    
    // Reset example view to minimal (unchecked)
    if (this._showCompleteSketchCheckbox) {
      this._showCompleteSketchCheckbox.checked = false;
    }
    
    this._renderVoiceList();
    this._render();
    this._updateExport();
  }

  _onBpmChange() {
    const bpm = Math.max(30, Math.min(3000, parseInt(this._bpmInput.value, 10) || 120));
    this._bpmInput.value = bpm;
    this._song.tempoMap = [{ tick: 0, bpm }];
    this._updateExport();
  }

  _adjustBpm(delta) {
    const current = parseInt(this._bpmInput.value, 10) || 120;
    const newBpm = Math.max(30, Math.min(3000, current + delta));
    this._bpmInput.value = newBpm;
    this._song.tempoMap = [{ tick: 0, bpm: newBpm }];
    this._updateExport();
  }

  _doScaleTempo(factor) {
    scaleTempo(this._song, factor);
    this._bpmInput.value = this._song.tempoMap[0]?.bpm || 120;
    this._updateExport();
  }

  _onTargetChange() {
    const target = this._targetSelect?.value || 'tones';

    if (target === 'tones') {
      if (this._song.tracks.length > 1) {
        // Check if Voice 2 has any notes
        const voice2HasNotes = this._song.tracks[1]?.notes?.length > 0;
        
        if (voice2HasNotes) {
          // Show confirmation dialog
          this._showConfirmDialog(
            'Data in Voice 2 will be lost. Do you want to continue?',
            () => {
              // User confirmed: proceed with merge
              this._mergeTracksToTones();
            },
            () => {
              // User cancelled: revert the select element back to playtune
              const select = this._targetSelect;
              if (select) {
                select.value = 'playtune';
              }
            }
          );
        } else {
          // No data in Voice 2, just merge
          this._mergeTracksToTones();
        }
      }
    } else {
      if (this._song.tracks.length < 2) {
        this._song.tracks.push({ id: 'voice1', name: 'Voice 2', notes: [] });
      }
      
      // Reset example view to minimal when switching libraries
      if (this._showCompleteSketchCheckbox) {
        this._showCompleteSketchCheckbox.checked = false;
      }

      this._activeTrackIdx = 0;
      this._renderVoiceList();
      this._render();
      this._updateExport();
    }
  }

  _mergeTracksToTones() {
    // Merge Voice 2 into Voice 1
    for (let i = 1; i < this._song.tracks.length; i++) {
      this._song.tracks[0].notes.push(...this._song.tracks[i].notes);
    }
    this._song.tracks = [this._song.tracks[0]];
    this._song.tracks[0].name = 'Voice 1';  // Keep "Voice 1" instead of renaming to "Melody"
    resolveOverlaps(this._song.tracks[0]);

    // Reset example view to minimal when switching libraries
    if (this._showCompleteSketchCheckbox) {
      this._showCompleteSketchCheckbox.checked = false;
    }

    this._activeTrackIdx = 0;
    this._renderVoiceList();
    this._render();
    this._updateExport();
  }

  // ─── Voice list ──────────────────────────────────────────────────────

  _renderVoiceList() {
    if (!this._voiceList) return;
    this._voiceList.innerHTML = '';

    for (let i = 0; i < this._song.tracks.length; i++) {
      const track = this._song.tracks[i];
      const color = VOICE_COLORS[i] || '#888';
      const isActive = this._activeTrackIdx === i;

      const div = document.createElement('div');
      div.className = `mus-voice-item${isActive ? ' active' : ''}`;
      div.innerHTML = `
        <span class="mus-voice-color" style="background: ${color}"></span>
        <span class="mus-voice-name">${track.name}</span>
        <span class="mus-voice-btn" style="font-size:10px; color: ${isActive ? color : 'inherit'}">${track.notes.length}</span>
      `;
      div.addEventListener('click', () => {
        this._activeTrackIdx = i;
        this._renderVoiceList();
        this._render();
      });
      this._voiceList.appendChild(div);
    }

    // Add swap voices button if there are 2 tracks
    if (this._song.tracks.length === 2) {
      const swapBtn = document.createElement('button');
      swapBtn.className = 'btn btn-sm btn-outline';
      swapBtn.textContent = 'Swap Voices';
      swapBtn.title = 'Swap Voice 1 and Voice 2';
      swapBtn.style.marginTop = '8px';
      swapBtn.style.width = '100%';
      swapBtn.addEventListener('click', () => this._swapVoices());
      this._voiceList.appendChild(swapBtn);
    }
  }

  _swapVoices() {
    if (this._song.tracks.length !== 2) return;

    // Swap the tracks
    const temp = this._song.tracks[0];
    this._song.tracks[0] = this._song.tracks[1];
    this._song.tracks[1] = temp;

    // Update active track index if necessary
    if (this._activeTrackIdx === 0) {
      this._activeTrackIdx = 1;
    } else if (this._activeTrackIdx === 1) {
      this._activeTrackIdx = 0;
    }

    this._renderVoiceList();
    this._render();
    this._updateExport();
  }

  // ─── Canvas rendering ────────────────────────────────────────────────

  _resizeCanvas() {
    if (!this._canvas || !this._container) return;
    const rect = this._container.getBoundingClientRect();
    const transport = this._container.querySelector('.mus-transport');
    const transportH = transport?.offsetHeight || 36;
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height - transportH - MINIMAP_H);
    if (w <= 0 || h <= 0) return;

    this._canvas.width = w;
    this._canvas.height = h;

    // Size minimap canvas to match width
    if (this._minimapCanvas) {
      this._minimapCanvas.width = w;
      this._minimapCanvas.height = MINIMAP_H;
    }

    // Clamp scrollY so we never show blank space below the last row
    const totalNoteRows = this._displayMaxNote - this._displayMinNote;
    const maxScrollY = Math.max(0, totalNoteRows * NOTE_HEIGHT - h);
    this._scrollY = Math.max(0, Math.min(this._scrollY, maxScrollY));

    this._render();
  }

  _render() {
    if (!this._ctx || !this._canvas) return;
    const ctx = this._ctx;
    const W = this._canvas.width;
    const H = this._canvas.height;
    if (W <= 0 || H <= 0) return;

    const pxPerTick = this._pixelsPerTick * this._zoomH;
    const kbW = KEYBOARD_WIDTH;
    const noteH = NOTE_HEIGHT;
    const totalNotes = this._displayMaxNote - this._displayMinNote;

    // Clear
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, W, H);

    // Draw grid
    this._drawGrid(ctx, kbW, W, H, noteH, pxPerTick, totalNotes);

    // Draw notes
    for (let t = 0; t < this._song.tracks.length; t++) {
      const track = this._song.tracks[t];
      const color = VOICE_COLORS[t] || '#888';
      const dimColor = VOICE_COLORS_DIM[t] || 'rgba(128,128,128,0.4)';
      for (const note of track.notes) {
        if (note.muted) continue;
        this._drawNote(ctx, note, t, kbW, noteH, pxPerTick, color, dimColor);
      }
    }

    // Draw keyboard (on top of grid)
    this._drawKeyboard(ctx, kbW, H, noteH, totalNotes);

    // Draw seek bar header (frozen strip above the note rows, right of keyboard)
    this._drawSeekBar(ctx, kbW, W, pxPerTick);

    // Draw time-selection band over the note area
    const tsDs = this._dragState?.type === 'time-select' ? this._dragState : null;
    const tsShow = this._timeSelection
      || (tsDs ? { startTick: Math.min(tsDs.startTick, tsDs.endTick), endTick: Math.max(tsDs.startTick, tsDs.endTick) } : null);
    if (tsShow && tsShow.endTick > tsShow.startTick) {
      const sx = kbW + tsShow.startTick * pxPerTick - this._scrollX;
      const ex = kbW + tsShow.endTick  * pxPerTick - this._scrollX;
      const cx = Math.max(kbW, sx);
      const cw = Math.min(W, ex) - cx;
      if (cw > 0) {
        ctx.fillStyle = 'rgba(255, 195, 50, 0.07)';
        ctx.fillRect(cx, SEEK_BAR_H, cw, H - SEEK_BAR_H);
      }
      // Left boundary
      if (sx >= kbW && sx <= W) {
        ctx.strokeStyle = 'rgba(255, 195, 50, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(sx, SEEK_BAR_H); ctx.lineTo(sx, H); ctx.stroke();
        ctx.setLineDash([]);
      }
      // Right boundary
      if (ex >= kbW && ex <= W) {
        ctx.strokeStyle = 'rgba(255, 195, 50, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(ex, SEEK_BAR_H); ctx.lineTo(ex, H); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draw playhead line and seek cursor
    if (this._isPlaying && this._audioCtx) {
      const elapsedMs = (this._audioCtx.currentTime - this._playStartTime) * 1000;
      const absoluteMs = this._playSeekMs + elapsedMs;
      const tick = msToTick(absoluteMs, this._song.tempoMap, this._song.ppq);
      const x = kbW + tick * pxPerTick - this._scrollX;
      if (x >= kbW && x <= W) {
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, SEEK_BAR_H);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
    } else if (this._seekTick > 0) {
      // Show dashed line at seek cursor when paused (seekTick > 0)
      const seekX = kbW + this._seekTick * pxPerTick - this._scrollX;
      if (seekX >= kbW && seekX <= W) {
        ctx.strokeStyle = 'rgba(255, 100, 100, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(seekX, SEEK_BAR_H);
        ctx.lineTo(seekX, H);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Selection rect
    if (this._dragState?.type === 'select') {
      const ds = this._dragState;
      ctx.strokeStyle = 'rgba(168, 77, 212, 0.7)';
      ctx.fillStyle = 'rgba(168, 77, 212, 0.1)';
      ctx.lineWidth = 1;
      const rx = Math.min(ds.startX, ds.curX);
      const ry = Math.min(ds.startY, ds.curY);
      const rw = Math.abs(ds.curX - ds.startX);
      const rh = Math.abs(ds.curY - ds.startY);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
    }

    // Draw scrollbar indicators
    this._drawScrollbars(ctx, kbW, W, H, pxPerTick, totalNotes, noteH);

    // Render minimap on its own canvas
    this._renderMinimap();
  }

  _getScrollbarGeometry(W, H, kbW, pxPerTick, totalNotes, noteH) {
    const SZ = 6;
    const PAD = 2;
    const MIN_THUMB = 20;

    // ── Vertical ──
    const totalContentH = totalNotes * noteH;
    const vTrackLen = H - PAD * 2;
    const vThumbRatio = H / Math.max(totalContentH, H);
    const vThumbH = Math.max(MIN_THUMB, vTrackLen * vThumbRatio);
    const vMaxScroll = Math.max(0, totalContentH - H);
    const vScrollRatio = vMaxScroll > 0 ? this._scrollY / vMaxScroll : 0;
    const vThumbY = PAD + vScrollRatio * (vTrackLen - vThumbH);
    const vX = W - SZ - PAD;

    // ── Horizontal ──
    const gridW = W - kbW;
    const songEndTick = getSongEndTick(this._song);
    // Add a few bars of padding so the scrollbar always has room
    const paddedEndTick = songEndTick + this._song.ppq * this._song.timeSig.num * 4;
    const totalContentW = Math.max(paddedEndTick * pxPerTick, gridW);
    const hTrackLen = gridW - SZ - PAD * 2; // leave gap where bars cross
    const hThumbRatio = gridW / Math.max(totalContentW, gridW);
    const hThumbW = Math.max(MIN_THUMB, hTrackLen * hThumbRatio);
    const hMaxScroll = Math.max(0, totalContentW - gridW);
    const hScrollRatio = hMaxScroll > 0 ? this._scrollX / hMaxScroll : 0;
    const hThumbX = kbW + PAD + hScrollRatio * (hTrackLen - hThumbW);
    const hY = H - SZ - PAD;

    return {
      SZ, PAD,
      v: { trackX: vX, trackY: PAD, trackW: SZ, trackH: vTrackLen,
            thumbY: vThumbY, thumbH: vThumbH, maxScroll: vMaxScroll, trackLen: vTrackLen },
      h: { trackX: kbW + PAD, trackY: hY, trackW: hTrackLen, trackH: SZ,
            thumbX: hThumbX, thumbW: hThumbW, maxScroll: hMaxScroll, trackLen: hTrackLen },
    };
  }

  _drawScrollbars(ctx, kbW, W, H, pxPerTick, totalNotes, noteH) {
    const geo = this._getScrollbarGeometry(W, H, kbW, pxPerTick, totalNotes, noteH);
    const { SZ, PAD, v, h } = geo;
    const isDraggingV = this._dragState?.type === 'scroll-v';
    const isDraggingH = this._dragState?.type === 'scroll-h';

    // ── Vertical scrollbar ──
    if (v.maxScroll > 0 || true) { // always show
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.beginPath();
      ctx.roundRect(v.trackX, v.trackY, v.trackW, v.trackH, 3);
      ctx.fill();

      ctx.fillStyle = isDraggingV || this._sbHover.v
        ? 'rgba(255,255,255,0.35)'
        : 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.roundRect(v.trackX, v.thumbY, v.trackW, v.thumbH, 3);
      ctx.fill();
    }

    // ── Horizontal scrollbar (always shown) ──
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.beginPath();
    ctx.roundRect(h.trackX, h.trackY, h.trackW, h.trackH, 3);
    ctx.fill();

    ctx.fillStyle = isDraggingH || this._sbHover.h
      ? 'rgba(255,255,255,0.35)'
      : 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.roundRect(h.thumbX, h.trackY, h.thumbW, h.trackH, 3);
    ctx.fill();
  }

  _drawKeyboard(ctx, kbW, H, noteH, totalNotes) {
    // Background
    ctx.fillStyle = '#0e0e1a';
    ctx.fillRect(0, 0, kbW, H);

    for (let i = 0; i < totalNotes; i++) {
      const noteNum = this._displayMaxNote - 1 - i;
      const y = i * noteH - this._scrollY;
      if (y + noteH < 0 || y > H) continue;

      const black = isBlackKey(noteNum);
      ctx.fillStyle = black ? '#1a1a30' : '#22223a';
      ctx.fillRect(0, y, kbW, noteH);

      // Border
      ctx.strokeStyle = '#2a2a44';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y + noteH);
      ctx.lineTo(kbW, y + noteH);
      ctx.stroke();

      // Label on C notes
      if (noteNum % 12 === 0) {
        ctx.fillStyle = '#888';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(midiNoteToName(noteNum), kbW - 4, y + noteH / 2);
      }
    }

    // Right edge line
    ctx.strokeStyle = '#3a3a5a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(kbW, 0);
    ctx.lineTo(kbW, H);
    ctx.stroke();
  }

  // ─── Minimap ─────────────────────────────────────────────────────────

  _getMinimapGeometry() {
    if (!this._minimapCanvas || !this._canvas) return null;
    const mmW = this._minimapCanvas.width;
    const mmH = this._minimapCanvas.height;
    const kbW = KEYBOARD_WIDTH;
    const contentW = mmW - kbW;
    const totalNotes = this._displayMaxNote - this._displayMinNote;
    const mainH = this._canvas.height;
    const gridW = this._canvas.width - kbW;
    const pxPerTick = this._pixelsPerTick * this._zoomH;

    const songEndTick = getSongEndTick(this._song);
    const paddedEndTick = songEndTick + this._song.ppq * this._song.timeSig.num * 4;
    // Total ticks mapped in the minimap content region
    const totalTicks = Math.max(paddedEndTick, (this._scrollX + gridW) / pxPerTick * 1.1);
    const totalContentW_px = Math.max(paddedEndTick * pxPerTick, gridW);
    const totalContentH = totalNotes * NOTE_HEIGHT;

    // Viewport rect in minimap coordinates
    const viewX = kbW + (this._scrollX / totalContentW_px) * contentW;
    const rawViewW = (gridW / totalContentW_px) * contentW;
    const viewW = Math.max(8, rawViewW);

    const maxScrollY = Math.max(0, totalContentH - mainH);
    const rawViewH = totalContentH > mainH ? (mainH / totalContentH) * mmH : mmH;
    const viewH = Math.max(8, rawViewH);
    const viewY = maxScrollY > 0 ? (this._scrollY / maxScrollY) * (mmH - viewH) : 0;

    return { mmW, mmH, kbW, contentW, totalNotes, totalTicks, totalContentW_px, gridW, mainH, totalContentH, viewX, viewW, viewY, viewH };
  }

  _renderMinimap() {
    if (!this._minimapCtx || !this._minimapCanvas) return;
    const ctx = this._minimapCtx;
    const geo = this._getMinimapGeometry();
    if (!geo) return;
    const { mmW, mmH, kbW, contentW, totalNotes, totalTicks, viewX, viewW, viewY, viewH } = geo;

    // Background
    ctx.fillStyle = '#0c0c1e';
    ctx.fillRect(0, 0, mmW, mmH);

    // Faint row alternation (black keys)
    const noteH_mm = mmH / totalNotes;
    for (let i = 0; i < totalNotes; i++) {
      const noteNum = this._displayMaxNote - 1 - i;
      if (isBlackKey(noteNum)) {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(kbW, i * noteH_mm, contentW, noteH_mm);
      }
    }

    // Draw all notes
    for (let t = 0; t < this._song.tracks.length; t++) {
      const track = this._song.tracks[t];
      ctx.fillStyle = VOICE_COLORS[t] || '#888';
      ctx.globalAlpha = 0.80;
      for (const note of track.notes) {
        if (note.muted) continue;
        if (note.noteNumber < this._displayMinNote || note.noteNumber >= this._displayMaxNote) continue;
        const row = this._displayMaxNote - 1 - note.noteNumber;
        const nx = kbW + (note.startTick / totalTicks) * contentW;
        const nw = Math.max(1.5, ((note.endTick - note.startTick) / totalTicks) * contentW);
        const ny = (row / totalNotes) * mmH;
        const nh = Math.max(1, noteH_mm - 0.5);
        ctx.fillRect(nx, ny, nw, nh);
      }
    }
    ctx.globalAlpha = 1.0;

    // Keyboard backdrop strip
    ctx.fillStyle = 'rgba(15, 15, 35, 0.9)';
    ctx.fillRect(0, 0, kbW, mmH);
    // Faint octave lines in keyboard area
    for (let i = 0; i < totalNotes; i++) {
      const noteNum = this._displayMaxNote - 1 - i;
      if (noteNum % 12 === 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, i * noteH_mm);
        ctx.lineTo(kbW, i * noteH_mm);
        ctx.stroke();
      }
    }
    // Keyboard right border
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(kbW, 0);
    ctx.lineTo(kbW, mmH);
    ctx.stroke();

    // Seek cursor line
    if (this._seekTick > 0 || this._isPlaying) {
      let seekTick = this._seekTick;
      if (this._isPlaying && this._audioCtx) {
        const elapsedMs = (this._audioCtx.currentTime - this._playStartTime) * 1000;
        seekTick = msToTick(this._playSeekMs + elapsedMs, this._song.tempoMap, this._song.ppq);
      }
      const sx = kbW + (seekTick / totalTicks) * contentW;
      ctx.strokeStyle = this._isPlaying ? '#ff4444' : 'rgba(255,100,100,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, mmH);
      ctx.stroke();
    }

    // Viewport highlight
    ctx.fillStyle = 'rgba(120, 170, 255, 0.09)';
    ctx.fillRect(viewX, viewY, viewW, viewH);
    ctx.strokeStyle = 'rgba(140, 190, 255, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(viewX + 0.75, viewY + 0.75, viewW - 1.5, viewH - 1.5);

    // Top border
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0.5);
    ctx.lineTo(mmW, 0.5);
    ctx.stroke();
  }

  _bindMinimapEvents() {
    if (!this._minimapCanvas) return;

    this._minimapCanvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const geo = this._getMinimapGeometry();
      if (!geo) return;
      const px = e.offsetX;
      const py = e.offsetY;
      const { viewX, viewW, viewY, viewH } = geo;

      // Hit-test viewport rect (with a small grab zone around edges)
      const hitX = px >= viewX - 4 && px <= viewX + viewW + 4;
      const hitY = py >= viewY - 4 && py <= viewY + viewH + 4;

      if (hitX && hitY) {
        this._minimapDrag = { startX: px, startY: py,
          startScrollX: this._scrollX, startScrollY: this._scrollY };
        this._minimapCanvas.style.cursor = 'grabbing';
      } else if (px >= KEYBOARD_WIDTH) {
        // Click-to-center: instantly jump view to the clicked position
        const ratio = (px - KEYBOARD_WIDTH) / geo.contentW;
        const targetTick = ratio * geo.totalTicks;
        const pxPerTick = this._pixelsPerTick * this._zoomH;
        const newScrollX = targetTick * pxPerTick - geo.gridW / 2;
        this._scrollX = Math.max(0, newScrollX);

        const rowRatio = py / geo.mmH;
        const targetRow = rowRatio * geo.totalNotes;
        const newScrollY = targetRow * NOTE_HEIGHT - geo.mainH / 2;
        const maxScrollY = Math.max(0, geo.totalContentH - geo.mainH);
        this._scrollY = Math.max(0, Math.min(maxScrollY, newScrollY));

        // Begin drag so the user can refine their position immediately
        this._minimapDrag = { startX: px, startY: py,
          startScrollX: this._scrollX, startScrollY: this._scrollY };
        this._minimapCanvas.style.cursor = 'grabbing';
        this._render();
      }
      e.preventDefault();
    });

    this._minimapCanvas.addEventListener('mousemove', (e) => {
      if (!this._minimapDrag) {
        const geo = this._getMinimapGeometry();
        if (geo) {
          const px = e.offsetX;
          const py = e.offsetY;
          const { viewX, viewW, viewY, viewH } = geo;
          const onVp = px >= viewX - 4 && px <= viewX + viewW + 4
                    && py >= viewY - 4 && py <= viewY + viewH + 4;
          this._minimapCanvas.style.cursor = onVp ? 'grab' : (px >= KEYBOARD_WIDTH ? 'pointer' : 'default');
        }
        return;
      }

      const geo = this._getMinimapGeometry();
      if (!geo) return;
      const dx = e.offsetX - this._minimapDrag.startX;
      const dy = e.offsetY - this._minimapDrag.startY;

      // Scale drag deltas: minimap px → scroll px
      const scrollXPerMmPx = geo.totalContentW_px / geo.contentW;
      const scrollYPerMmPx = geo.totalContentH / geo.mmH;

      this._scrollX = Math.max(0, this._minimapDrag.startScrollX + dx * scrollXPerMmPx);
      const maxScrollY = Math.max(0, geo.totalContentH - geo.mainH);
      this._scrollY = Math.max(0, Math.min(maxScrollY,
        this._minimapDrag.startScrollY + dy * scrollYPerMmPx));

      this._render();
      e.preventDefault();
    });

    const stopDrag = () => {
      if (this._minimapDrag) {
        this._minimapDrag = null;
        if (this._minimapCanvas) this._minimapCanvas.style.cursor = 'pointer';
      }
    };
    this._minimapCanvas.addEventListener('mouseup', stopDrag);
    this._minimapCanvas.addEventListener('mouseleave', stopDrag);
  }

  _drawSeekBar(ctx, kbW, W, pxPerTick) {
    const barH = SEEK_BAR_H;
    const ppq = this._song.ppq;
    const measureTicks = ppq * this._song.timeSig.num;

    // Background strip
    ctx.fillStyle = 'rgba(10, 10, 25, 0.92)';
    ctx.fillRect(kbW, 0, W - kbW, barH);

    // Bottom border
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(kbW, barH - 0.5);
    ctx.lineTo(W, barH - 0.5);
    ctx.stroke();

    // Time-selection highlight in seek bar
    const tsDs2 = this._dragState?.type === 'time-select' ? this._dragState : null;
    const ts = this._timeSelection
      || (tsDs2 ? { startTick: Math.min(tsDs2.startTick, tsDs2.endTick), endTick: Math.max(tsDs2.startTick, tsDs2.endTick) } : null);
    if (ts && ts.endTick > ts.startTick) {
      const sx = kbW + ts.startTick * pxPerTick - this._scrollX;
      const ex = kbW + ts.endTick   * pxPerTick - this._scrollX;
      const cx = Math.max(kbW, sx);
      const cw = Math.min(W, ex) - cx;
      if (cw > 0) {
        ctx.fillStyle = 'rgba(255, 195, 50, 0.38)';
        ctx.fillRect(cx, 1, cw, barH - 2);
      }
    }

    // Measure tick marks and numbers
    const startTick = Math.max(0, Math.floor(this._scrollX / pxPerTick));
    const endTick = Math.ceil((this._scrollX + W - kbW) / pxPerTick);
    const measureStart = Math.floor(startTick / measureTicks) * measureTicks;

    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (let tick = measureStart; tick <= endTick; tick += measureTicks) {
      const x = kbW + tick * pxPerTick - this._scrollX;
      if (x < kbW || x > W) continue;

      // Tick mark at bottom of bar
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, barH - 5);
      ctx.lineTo(x, barH - 1);
      ctx.stroke();

      // Measure number
      const measureNum = Math.floor(tick / measureTicks) + 1;
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(String(measureNum), x + 2, 2);
    }

    // "Click to seek" hint label at far left of bar
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillText('seek', kbW + 3, 4);

    // Seek cursor triangle (pointing down into the note area)
    const seekX = kbW + this._seekTick * pxPerTick - this._scrollX;
    if (seekX >= kbW && seekX <= W) {
      ctx.fillStyle = '#7ec8e3';
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(seekX, 2);
      ctx.lineTo(seekX - 5, barH - 2);
      ctx.lineTo(seekX + 5, barH - 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // If playing, also draw a small red tick in the seek bar at the playhead position
    if (this._isPlaying && this._audioCtx) {
      const elapsedMs = (this._audioCtx.currentTime - this._playStartTime) * 1000;
      const absoluteMs = this._playSeekMs + elapsedMs;
      const tick = msToTick(absoluteMs, this._song.tempoMap, this._song.ppq);
      const phX = kbW + tick * pxPerTick - this._scrollX;
      if (phX >= kbW && phX <= W) {
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(phX, 0);
        ctx.lineTo(phX, barH - 1);
        ctx.stroke();
      }
    }
  }

  _drawGrid(ctx, kbW, W, H, noteH, pxPerTick, totalNotes) {
    const ppq = this._song.ppq;

    // Horizontal lines (note rows)
    for (let i = 0; i < totalNotes; i++) {
      const noteNum = this._displayMaxNote - 1 - i;
      const y = i * noteH - this._scrollY;
      if (y + noteH < 0 || y > H) continue;

      const black = isBlackKey(noteNum);
      ctx.fillStyle = black ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.02)';
      ctx.fillRect(kbW, y, W - kbW, noteH);

      // Row border
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(kbW, y + noteH);
      ctx.lineTo(W, y + noteH);
      ctx.stroke();

      // Highlight octave borders (C notes)
      if (noteNum % 12 === 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(kbW, y + noteH);
        ctx.lineTo(W, y + noteH);
        ctx.stroke();
      }
    }

    // Vertical lines (time grid)
    const beatTicks = ppq;
    const measureTicks = ppq * this._song.timeSig.num;
    const gridTicks = this._quantizeDiv > 0 ? (ppq * 4) / this._quantizeDiv : beatTicks;

    // Calculate visible tick range
    const startTick = Math.max(0, Math.floor(this._scrollX / pxPerTick));
    const endTick = Math.ceil((this._scrollX + W - kbW) / pxPerTick);

    // Sub-beat grid lines
    const gridStart = Math.floor(startTick / gridTicks) * gridTicks;
    for (let tick = gridStart; tick <= endTick; tick += gridTicks) {
      const x = kbW + tick * pxPerTick - this._scrollX;
      if (x < kbW || x > W) continue;

      const isMeasure = tick % measureTicks === 0;
      const isBeat = tick % beatTicks === 0;

      if (isMeasure) {
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 1.5;
      } else if (isBeat) {
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 0.5;
      }

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();

      // Measure number
      if (isMeasure) {
        const measureNum = Math.floor(tick / measureTicks) + 1;
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(String(measureNum), x + 3, 2);
      }
    }
  }

  _drawNote(ctx, note, trackIdx, kbW, noteH, pxPerTick, color, dimColor) {
    const row = this._displayMaxNote - 1 - note.noteNumber;
    const x = kbW + note.startTick * pxPerTick - this._scrollX;
    const y = row * noteH - this._scrollY;
    const w = (note.endTick - note.startTick) * pxPerTick;

    if (x + w < kbW || x > this._canvas.width) return;
    if (y + noteH < 0 || y > this._canvas.height) return;

    const isSelected = this._selectedNotes.has(note.id);
    const isActiveTrack = trackIdx === this._activeTrackIdx;

    // Note body
    ctx.fillStyle = isActiveTrack ? color : dimColor;
    ctx.globalAlpha = isSelected ? 1.0 : 0.8;
    const r = 2;
    ctx.beginPath();
    ctx.roundRect(x, y + 1, Math.max(w, 3), noteH - 2, r);
    ctx.fill();

    // Selected outline
    if (isSelected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.globalAlpha = 1.0;

    // Note name label (if wide enough)
    if (w > 24) {
      ctx.fillStyle = isActiveTrack ? '#000' : 'rgba(0,0,0,0.5)';
      ctx.font = '8px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(midiNoteToName(note.noteNumber), x + 3, y + noteH / 2);
    }
  }

  // ─── Coordinate conversion ───────────────────────────────────────────

  _pixelToMusic(px, py) {
    const pxPerTick = this._pixelsPerTick * this._zoomH;
    const tick = Math.max(0, (px - KEYBOARD_WIDTH + this._scrollX) / pxPerTick);
    const row = (py + this._scrollY) / NOTE_HEIGHT;
    const noteNum = this._displayMaxNote - 1 - Math.floor(row);
    return { tick, noteNum };
  }

  _hitTestNote(px, py) {
    const pxPerTick = this._pixelsPerTick * this._zoomH;

    // Test active track first, then others
    const trackOrder = [this._activeTrackIdx];
    for (let i = 0; i < this._song.tracks.length; i++) {
      if (i !== this._activeTrackIdx) trackOrder.push(i);
    }

    for (const t of trackOrder) {
      const track = this._song.tracks[t];
      for (let n = track.notes.length - 1; n >= 0; n--) {
        const note = track.notes[n];
        if (note.muted) continue;

        const row = this._displayMaxNote - 1 - note.noteNumber;
        const nx = KEYBOARD_WIDTH + note.startTick * pxPerTick - this._scrollX;
        const ny = row * NOTE_HEIGHT - this._scrollY;
        const nw = (note.endTick - note.startTick) * pxPerTick;

        if (px >= nx && px <= nx + nw && py >= ny && py <= ny + NOTE_HEIGHT) {
          const edge = (px >= nx + nw - RESIZE_EDGE_PX) ? 'end' : null;
          return { note, trackIdx: t, edge };
        }
      }
    }
    return null;
  }

  // ─── Edit mode ───────────────────────────────────────────────────────

  _setEditMode(mode) {
    this._editMode = mode;
    this._selectedNotes.clear();
    this._timeSelection = null;
    this._dragState = null;
    this._updateModeUI();
    this._render();
  }

  _updateModeUI() {
    const isSelect = this._editMode === 'select';
    this._btnModeNote?.classList.toggle('active', !isSelect);
    this._btnModeSelect?.classList.toggle('active', isSelect);
    if (this._selectBothLabel) {
      this._selectBothLabel.classList.toggle('hidden', !isSelect);
    }
    if (this._canvas) {
      this._canvas.style.cursor = isSelect ? 'crosshair' : 'crosshair';
    }
  }

  // Start a multi-note drag from a single anchor note (used in select mode)
  _startMultiNoteDrag(anchorNote, tick, noteNum, px, py) {
    const selectedSnap = [];
    for (const track of this._song.tracks) {
      for (const note of track.notes) {
        if (this._selectedNotes.has(note.id)) {
          selectedSnap.push({
            note,
            origStart: note.startTick,
            origEnd: note.endTick,
            origNote: note.noteNumber,
          });
        }
      }
    }
    this._dragState = {
      type: 'move-multi',
      selectedSnap,
      anchorOrigStart: anchorNote.startTick,
      anchorOrigNote: anchorNote.noteNumber,
      offsetTick: tick - anchorNote.startTick,
      offsetNote: noteNum - anchorNote.noteNumber,
      startDragX: px,
      startDragY: py,
      hasMoved: false,
    };
  }

  // Delete the time-selected range and shift subsequent notes left
  _deleteTimeRangeAndShift() {
    if (!this._timeSelection) return;
    const { startTick, endTick } = this._timeSelection;
    const span = endTick - startTick;
    if (span <= 0) { this._timeSelection = null; this._render(); return; }

    for (const track of this._song.tracks) {
      // Remove any note that overlaps the range
      track.notes = track.notes.filter(n => !(n.startTick < endTick && n.endTick > startTick));
      // Shift notes that start at or after the end of the range
      for (const n of track.notes) {
        if (n.startTick >= endTick) {
          n.startTick -= span;
          n.endTick -= span;
        }
      }
    }

    // Adjust seek cursor
    if (this._seekTick >= endTick) {
      this._seekTick = Math.max(0, this._seekTick - span);
    } else if (this._seekTick > startTick) {
      this._seekTick = startTick;
    }

    this._timeSelection = null;
    this._selectedNotes.clear();
    this._renderVoiceList();
    this._render();
    this._updateExport();
  }

  // ─── Mouse interaction ───────────────────────────────────────────────

  _onMouseDown(e) {
    if (e.button !== 0) return; // left click only
    const px = e.offsetX;
    const py = e.offsetY;

    // ── Scrollbar hit test ──
    const W = this._canvas.width;
    const H = this._canvas.height;
    const kbW = KEYBOARD_WIDTH;
    const pxPerTick = this._pixelsPerTick * this._zoomH;
    const totalNotes = this._displayMaxNote - this._displayMinNote;
    const geo = this._getScrollbarGeometry(W, H, kbW, pxPerTick, totalNotes, NOTE_HEIGHT);

    // Vertical scrollbar
    const { v, h: hBar } = geo;
    if (px >= v.trackX && px <= v.trackX + v.trackW && py >= v.trackY && py <= v.trackY + v.trackH) {
      e.preventDefault();
      // Click on thumb vs track
      const onThumb = py >= v.thumbY && py <= v.thumbY + v.thumbH;
      if (onThumb) {
        this._dragState = { type: 'scroll-v', startPY: py, startScrollY: this._scrollY,
          thumbOffset: py - v.thumbY, trackLen: v.trackLen, thumbH: v.thumbH, maxScroll: v.maxScroll };
      } else {
        // Jump to clicked position
        const ratio = Math.max(0, Math.min(1, (py - v.trackY - v.thumbH / 2) / (v.trackLen - v.thumbH)));
        this._scrollY = ratio * v.maxScroll;
        this._dragState = { type: 'scroll-v', startPY: py, startScrollY: this._scrollY,
          thumbOffset: v.thumbH / 2, trackLen: v.trackLen, thumbH: v.thumbH, maxScroll: v.maxScroll };
        this._render();
      }
      return;
    }

    // Horizontal scrollbar
    if (py >= hBar.trackY && py <= hBar.trackY + hBar.trackH && px >= hBar.trackX && px <= hBar.trackX + hBar.trackW) {
      e.preventDefault();
      const onThumb = px >= hBar.thumbX && px <= hBar.thumbX + hBar.thumbW;
      if (onThumb) {
        this._dragState = { type: 'scroll-h', startPX: px, startScrollX: this._scrollX,
          thumbOffset: px - hBar.thumbX, trackLen: hBar.trackLen, thumbW: hBar.thumbW, maxScroll: hBar.maxScroll };
      } else {
        const ratio = Math.max(0, Math.min(1, (px - hBar.trackX - hBar.thumbW / 2) / (hBar.trackLen - hBar.thumbW)));
        this._scrollX = ratio * hBar.maxScroll;
        this._dragState = { type: 'scroll-h', startPX: px, startScrollX: this._scrollX,
          thumbOffset: hBar.thumbW / 2, trackLen: hBar.trackLen, thumbW: hBar.thumbW, maxScroll: hBar.maxScroll };
        this._render();
      }
      return;
    }

    // ── Seek bar hit test ──
    if (py < SEEK_BAR_H && px >= kbW) {
      e.preventDefault();
      if (this._editMode === 'select') {
        // In select mode: start a time-range selection drag
        const rawTick = Math.max(0, (px - kbW + this._scrollX) / pxPerTick);
        const snapTick = this._quantizeDiv
          ? quantizeTick(rawTick, this._song.ppq, this._quantizeDiv)
          : Math.round(rawTick);
        if (!e.shiftKey) this._timeSelection = null;
        this._dragState = { type: 'time-select', startTick: snapTick, endTick: snapTick, additive: e.shiftKey };
        this._render();
      } else {
        // In note mode: set playback seek position
        const rawTick = (px - kbW + this._scrollX) / pxPerTick;
        this._seekTick = Math.max(0, Math.min(rawTick, getSongEndTick(this._song)));
        this._dragState = { type: 'seek' };
        if (this._isPlaying) {
          this._isPlaying = false;
          for (const osc of this._scheduledOscillators) {
            try { osc.stop(); } catch { /* already stopped */ }
          }
          this._scheduledOscillators = [];
          if (this._playheadAnimFrame) {
            cancelAnimationFrame(this._playheadAnimFrame);
            this._playheadAnimFrame = null;
          }
          this._play();
        } else {
          this._render();
        }
      }
      return;
    }

    if (px < KEYBOARD_WIDTH) {
      // Click on keyboard — preview note sound
      const { noteNum } = this._pixelToMusic(KEYBOARD_WIDTH, py);
      this._previewNote(noteNum);
      return;
    }

    const { tick, noteNum } = this._pixelToMusic(px, py);
    // Clamp to valid note range
    if (noteNum < MIN_NOTE || noteNum >= MAX_NOTE) return;

    // ── SELECT MODE ──────────────────────────────────────────────────────
    if (this._editMode === 'select') {
      if (!e.shiftKey) {
        // Clicking in the note area clears any time selection
        this._timeSelection = null;
      }

      const selectHit = this._hitTestNote(px, py);
      if (selectHit) {
        const { note } = selectHit;
        if (e.shiftKey) {
          // Shift+click: toggle the note in/out of selection
          if (this._selectedNotes.has(note.id)) {
            this._selectedNotes.delete(note.id);
          } else {
            this._selectedNotes.add(note.id);
          }
          this._render();
          return;
        }
        // If the clicked note is already selected: drag all selected notes
        if (!this._selectedNotes.has(note.id)) {
          this._selectedNotes.clear();
          this._selectedNotes.add(note.id);
        }
        this._startMultiNoteDrag(note, tick, noteNum, px, py);
        this._render();
        return;
      }

      // No note hit: start a box-selection drag
      if (!e.shiftKey) this._selectedNotes.clear();
      this._dragState = {
        type: 'select',
        startX: px, startY: py, curX: px, curY: py,
        additive: e.shiftKey,
      };
      this._render();
      return;
    }

    // ── NOTE MODE ────────────────────────────────────────────────────────
    // Shift-drag: box select
    if (e.shiftKey) {
      this._dragState = { type: 'select', startX: px, startY: py, curX: px, curY: py, additive: false };
      return;
    }

    // Hit test existing note
    const hit = this._hitTestNote(px, py);
    if (hit) {
      const { note, trackIdx, edge } = hit;
      if (edge === 'end') {
        this._dragState = { type: 'resize-end', note, trackIdx, origEnd: note.endTick };
        this._selectedNotes.clear();
        this._selectedNotes.add(note.id);
      } else {
        this._dragState = {
          type: 'move', note, trackIdx,
          offsetTick: tick - note.startTick,
          offsetNote: noteNum - note.noteNumber,
          origStart: note.startTick,
          origEnd: note.endTick,
          origNote: note.noteNumber,
          startDragX: px,
          startDragY: py,
          hasMoved: false,
        };
        if (!this._selectedNotes.has(note.id)) {
          this._selectedNotes.clear();
          this._selectedNotes.add(note.id);
        }
      }
      this._render();
      return;
    }

    // Create new note
    const qTick = this._quantizeDiv
      ? quantizeTick(tick, this._song.ppq, this._quantizeDiv)
      : Math.round(tick);
    const dur = this._quantizeDiv
      ? (this._song.ppq * 4) / this._quantizeDiv
      : this._song.ppq;

    const newNote = createNote(noteNum, qTick, qTick + dur);
    this._song.tracks[this._activeTrackIdx].notes.push(newNote);

    this._selectedNotes.clear();
    this._selectedNotes.add(newNote.id);
    this._dragState = {
      type: 'resize-end',
      note: newNote,
      trackIdx: this._activeTrackIdx,
      origEnd: newNote.endTick,
    };

    this._previewNote(noteNum);
    this._render();
    this._updateExport();
  }

  _onMouseMove(e) {
    const px = e.offsetX;
    const py = e.offsetY;

    // Handle scrollbar dragging
    if (this._dragState?.type === 'scroll-v') {
      const ds = this._dragState;
      const thumbTop = py - ds.thumbOffset;
      // Track starts at PAD = 2
      const ratio = Math.max(0, Math.min(1, (thumbTop - 2) / (ds.trackLen - ds.thumbH)));
      this._scrollY = ratio * ds.maxScroll;
      this._render();
      return;
    }
    if (this._dragState?.type === 'scroll-h') {
      const ds = this._dragState;
      const thumbLeft = px - ds.thumbOffset;
      const ratio = Math.max(0, Math.min(1, (thumbLeft - KEYBOARD_WIDTH - 2) / (ds.trackLen - ds.thumbW)));
      this._scrollX = ratio * ds.maxScroll;
      this._render();
      return;
    }

    // Handle seek bar scrubbing (note mode only)
    if (this._dragState?.type === 'seek') {
      this._canvas.style.cursor = 'col-resize';
      const kbW = KEYBOARD_WIDTH;
      const pxPerTick = this._pixelsPerTick * this._zoomH;
      const rawTick = (px - kbW + this._scrollX) / pxPerTick;
      this._seekTick = Math.max(0, Math.min(rawTick, getSongEndTick(this._song)));
      if (!this._isPlaying) this._render();
      return;
    }

    // Handle time-selection scrubbing (select mode seek bar)
    if (this._dragState?.type === 'time-select') {
      this._canvas.style.cursor = 'col-resize';
      const kbW = KEYBOARD_WIDTH;
      const pxPerTick = this._pixelsPerTick * this._zoomH;
      const rawTick = Math.max(0, (px - kbW + this._scrollX) / pxPerTick);
      this._dragState.endTick = this._quantizeDiv
        ? quantizeTick(rawTick, this._song.ppq, this._quantizeDiv)
        : Math.round(rawTick);
      this._render();
      return;
    }

    if (!this._dragState) {
      // Update scrollbar hover state
      const W = this._canvas.width;
      const H = this._canvas.height;
      const kbW = KEYBOARD_WIDTH;
      const pxPerTick = this._pixelsPerTick * this._zoomH;
      const totalNotes = this._displayMaxNote - this._displayMinNote;
      const geo = this._getScrollbarGeometry(W, H, kbW, pxPerTick, totalNotes, NOTE_HEIGHT);
      const { v, h: hBar } = geo;
      const overV = px >= v.trackX && px <= v.trackX + v.trackW + 4
                 && py >= v.trackY && py <= v.trackY + v.trackH;
      const overH = py >= hBar.trackY && py <= hBar.trackY + hBar.trackH + 4
                 && px >= hBar.trackX && px <= hBar.trackX + hBar.trackW;
      const changed = overV !== this._sbHover.v || overH !== this._sbHover.h;
      this._sbHover = { v: overV, h: overH };
      if (changed) this._render();

      // Update cursor
      if (overV) {
        this._canvas.style.cursor = 'ns-resize';
        return;
      }
      if (overH) {
        this._canvas.style.cursor = 'ew-resize';
        return;
      }
      if (py < SEEK_BAR_H && px >= KEYBOARD_WIDTH) {
        this._canvas.style.cursor = 'col-resize';
        return;
      }
      if (px < KEYBOARD_WIDTH) {
        this._canvas.style.cursor = 'pointer';
      } else if (this._editMode === 'select') {
        const selHit = this._hitTestNote(px, py);
        if (selHit) {
          this._canvas.style.cursor = this._selectedNotes.has(selHit.note.id) ? 'grab' : 'pointer';
        } else {
          this._canvas.style.cursor = 'crosshair';
        }
      } else {
        const hit = this._hitTestNote(px, py);
        if (hit?.edge === 'end') {
          this._canvas.style.cursor = 'ew-resize';
        } else if (hit) {
          this._canvas.style.cursor = 'grab';
        } else {
          this._canvas.style.cursor = 'crosshair';
        }
      }
      return;
    }

    const { tick, noteNum } = this._pixelToMusic(px, py);
    const ds = this._dragState;

    // Show grabbing cursor while moving a note
    if (ds.type === 'move') {
      this._canvas.style.cursor = 'grabbing';
    }

    if (ds.type === 'select') {
      ds.curX = px;
      ds.curY = py;
      this._render();
      return;
    }

    if (ds.type === 'resize-end') {
      const qTick = this._quantizeDiv
        ? quantizeTick(tick, this._song.ppq, this._quantizeDiv)
        : Math.round(tick);
      // When quantize is on, enforce minimum note duration equal to the quantize grid size
      const minDuration = this._quantizeDiv > 0
        ? (this._song.ppq * 4) / this._quantizeDiv
        : 1;
      ds.note.endTick = Math.max(ds.note.startTick + minDuration, qTick);
      this._render();
      return;
    }

    if (ds.type === 'move') {
      const DRAG_THRESHOLD = 4;
      const dxDrag = px - ds.startDragX;
      const dyDrag = py - ds.startDragY;
      if (!ds.hasMoved && Math.sqrt(dxDrag * dxDrag + dyDrag * dyDrag) < DRAG_THRESHOLD) return;
      ds.hasMoved = true;

      const newTick = tick - ds.offsetTick;
      const qTick = this._quantizeDiv
        ? quantizeTick(newTick, this._song.ppq, this._quantizeDiv)
        : Math.round(newTick);
      const dur = ds.origEnd - ds.origStart;
      const clampedNote = Math.max(MIN_NOTE, Math.min(MAX_NOTE - 1, noteNum - ds.offsetNote));

      ds.note.startTick = Math.max(0, qTick);
      ds.note.endTick = ds.note.startTick + dur;
      ds.note.noteNumber = clampedNote;
      this._render();
    }

    if (ds.type === 'move-multi') {
      this._canvas.style.cursor = 'grabbing';
      const DRAG_THRESHOLD = 4;
      const dxDrag = px - ds.startDragX;
      const dyDrag = py - ds.startDragY;
      if (!ds.hasMoved && Math.sqrt(dxDrag * dxDrag + dyDrag * dyDrag) < DRAG_THRESHOLD) return;
      ds.hasMoved = true;

      const newAnchorTick = tick - ds.offsetTick;
      const qAnchorTick = this._quantizeDiv
        ? quantizeTick(newAnchorTick, this._song.ppq, this._quantizeDiv)
        : Math.round(newAnchorTick);
      const deltaTick = qAnchorTick - ds.anchorOrigStart;
      const deltaNote = Math.round(noteNum - ds.offsetNote) - ds.anchorOrigNote;

      for (const { note, origStart, origEnd, origNote } of ds.selectedSnap) {
        note.startTick = Math.max(0, origStart + deltaTick);
        note.endTick = note.startTick + (origEnd - origStart);
        note.noteNumber = Math.max(MIN_NOTE, Math.min(MAX_NOTE - 1, origNote + deltaNote));
      }
      this._render();
    }
  }

  _onMouseUp(e) {
    if (this._dragState?.type === 'scroll-v' || this._dragState?.type === 'scroll-h') {
      this._dragState = null;
      this._render();
      return;
    }
    if (this._dragState?.type === 'seek') {
      this._dragState = null;
      this._render();
      return;
    }
    // Time-range selection: finalise the range and select notes within it
    if (this._dragState?.type === 'time-select') {
      const ds = this._dragState;
      const t0 = Math.min(ds.startTick, ds.endTick);
      const t1 = Math.max(ds.startTick, ds.endTick);
      if (t1 > t0) {
        this._timeSelection = { startTick: t0, endTick: t1 };
        const tracks = this._selectBothVoices
          ? this._song.tracks
          : [this._song.tracks[this._activeTrackIdx]].filter(Boolean);
        // Additive: keep previous selection if shift was held when drag started
        if (!ds.additive) this._selectedNotes.clear();
        for (const track of tracks) {
          for (const note of track.notes) {
            if (note.startTick < t1 && note.endTick > t0) {
              this._selectedNotes.add(note.id);
            }
          }
        }
      } else {
        this._timeSelection = null;
        this._selectedNotes.clear();
      }
      this._dragState = null;
      this._render();
      return;
    }
    // Multi-note drag (select mode)
    if (this._dragState?.type === 'move-multi') {
      const ds = this._dragState;
      if (!ds.hasMoved) {
        for (const { note, origStart, origEnd, origNote } of ds.selectedSnap) {
          note.startTick = origStart;
          note.endTick = origEnd;
          note.noteNumber = origNote;
        }
      } else {
        for (const track of this._song.tracks) resolveOverlaps(track);
        this._updateExport();
      }
      this._dragState = null;
      this._renderVoiceList();
      this._render();
      return;
    }
    if (this._dragState?.type === 'select') {
      this._selectNotesInRect(this._dragState);
    }
    if (this._dragState?.type === 'resize-end' || this._dragState?.type === 'move') {
      const ds = this._dragState;
      // If mouse never moved far enough to drag, restore note to original position
      if (ds.type === 'move' && !ds.hasMoved) {
        ds.note.startTick = ds.origStart;
        ds.note.endTick = ds.origEnd;
        ds.note.noteNumber = ds.origNote;
      } else {
        // Every track is mono regardless of target library — resolve overlaps
        // on the track that was actually edited
        const affectedIdx = ds.trackIdx ?? 0;
        if (this._song.tracks[affectedIdx]) {
          resolveOverlaps(this._song.tracks[affectedIdx]);
        }
        this._updateExport();
      }
    }
    this._dragState = null;
    this._renderVoiceList();
    this._render();
  }

  _onMouseLeave() {
    const wasHovering = this._sbHover.v || this._sbHover.h;
    this._sbHover = { v: false, h: false };
    if (this._dragState) {
      const ds = this._dragState;
      if (ds.type === 'move' && !ds.hasMoved) {
        ds.note.startTick = ds.origStart;
        ds.note.endTick = ds.origEnd;
        ds.note.noteNumber = ds.origNote;
      }
      if (ds.type === 'move-multi' && !ds.hasMoved) {
        for (const { note, origStart, origEnd, origNote } of ds.selectedSnap) {
          note.startTick = origStart;
          note.endTick = origEnd;
          note.noteNumber = origNote;
        }
      }
      this._dragState = null;
      this._render();
    } else if (wasHovering) {
      this._render();
    }
  }

  _onRightClick(e) {
    // Right-click delete is only active in note mode
    if (this._editMode === 'select') return;
    const px = e.offsetX;
    const py = e.offsetY;
    const hit = this._hitTestNote(px, py);
    if (hit) {
      const { note, trackIdx } = hit;
      const track = this._song.tracks[trackIdx];
      const idx = track.notes.indexOf(note);
      if (idx !== -1) {
        track.notes.splice(idx, 1);
        this._selectedNotes.delete(note.id);
        this._renderVoiceList();
        this._render();
        this._updateExport();
      }
    }
  }

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      this._zoomH = Math.max(0.25, Math.min(4, this._zoomH + delta));
      if (this._zoomSlider) this._zoomSlider.value = this._zoomH;
    } else if (e.shiftKey) {
      // Horizontal scroll
      this._scrollX = Math.max(0, this._scrollX + e.deltaY);
    } else {
      // Vertical scroll
      const maxScrollY = Math.max(0, (this._displayMaxNote - this._displayMinNote) * NOTE_HEIGHT - this._canvas.height);
      this._scrollY = Math.max(0, Math.min(maxScrollY, this._scrollY + e.deltaY));
    }
    this._render();
  }

  _selectNotesInRect(ds) {
    const additive = ds.additive ?? false;
    if (!additive) this._selectedNotes.clear();
    const pxPerTick = this._pixelsPerTick * this._zoomH;

    const left = Math.min(ds.startX, ds.curX);
    const right = Math.max(ds.startX, ds.curX);
    const top = Math.min(ds.startY, ds.curY);
    const bottom = Math.max(ds.startY, ds.curY);

    // In select mode respect _selectBothVoices; in note mode always search all tracks
    const tracks = (this._editMode === 'select' && !this._selectBothVoices)
      ? [this._song.tracks[this._activeTrackIdx]].filter(Boolean)
      : this._song.tracks;

    for (const track of tracks) {
      for (const note of track.notes) {
        const row = this._displayMaxNote - 1 - note.noteNumber;
        const nx = KEYBOARD_WIDTH + note.startTick * pxPerTick - this._scrollX;
        const ny = row * NOTE_HEIGHT - this._scrollY;
        const nw = (note.endTick - note.startTick) * pxPerTick;

        if (nx + nw >= left && nx <= right && ny + NOTE_HEIGHT >= top && ny <= bottom) {
          this._selectedNotes.add(note.id);
        }
      }
    }
  }

  // ─── Keyboard shortcuts ──────────────────────────────────────────────

  _onKeyDown(e) {
    if (!document.getElementById('panel-music')?.classList.contains('active')) return;

    // Don't handle key events when focused on inputs
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        if (this._editMode === 'select' && this._timeSelection) {
          this._deleteTimeRangeAndShift();
        } else {
          this._deleteSelectedNotes();
        }
        break;
      case ' ':
        e.preventDefault();
        this._isPlaying ? this._pause() : this._play();
        break;
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this._selectAllNotes();
        }
        break;
      case 'Escape':
        if (this._editMode === 'select') {
          e.preventDefault();
          this._selectedNotes.clear();
          this._timeSelection = null;
          this._render();
        }
        break;
    }
  }

  _deleteSelectedNotes() {
    if (this._selectedNotes.size === 0) return;
    for (const track of this._song.tracks) {
      track.notes = track.notes.filter(n => !this._selectedNotes.has(n.id));
    }
    this._selectedNotes.clear();
    this._renderVoiceList();
    this._render();
    this._updateExport();
  }

  _selectAllNotes() {
    this._selectedNotes.clear();
    for (const track of this._song.tracks) {
      for (const note of track.notes) {
        this._selectedNotes.add(note.id);
      }
    }
    this._render();
  }

  // ─── WebAudio playback ───────────────────────────────────────────────

  _ensureAudioContext() {
    if (!this._audioCtx) {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this._audioCtx.state === 'suspended') {
      this._audioCtx.resume();
    }
  }

  _play() {
    // Stop any current playback, but preserve seekTick (stop resets it)
    if (this._isPlaying) {
      const savedSeekTick = this._seekTick;
      this._stop();
      this._seekTick = savedSeekTick;
    }
    this._ensureAudioContext();

    const endTick = getSongEndTick(this._song);
    if (endTick <= 0) return;

    // Clamp seek position in case song was trimmed
    this._seekTick = Math.min(this._seekTick, endTick);

    const seekMs = tickToMs(this._seekTick, this._song.tempoMap, this._song.ppq);
    this._playSeekMs = seekMs;
    this._isPlaying = true;
    this._playStartTime = this._audioCtx.currentTime;

    // Schedule all notes starting from seekTick
    for (let t = 0; t < this._song.tracks.length; t++) {
      const track = this._song.tracks[t];
      for (const note of track.notes) {
        if (note.muted) continue;
        const startMs = tickToMs(note.startTick, this._song.tempoMap, this._song.ppq);
        const endMs = tickToMs(note.endTick, this._song.tempoMap, this._song.ppq);
        if (endMs <= seekMs) continue; // note already passed seek point
        const startSec = Math.max(0, (startMs - seekMs) / 1000);
        const endSec = (endMs - seekMs) / 1000;
        const durSec = Math.max(0.01, endSec - startSec);
        const freq = midiNoteToFreq(note.noteNumber);

        const osc = this._audioCtx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = freq;

        const gain = this._audioCtx.createGain();
        gain.gain.value = 0.08;
        osc.connect(gain);
        gain.connect(this._audioCtx.destination);

        osc.start(this._playStartTime + startSec);
        osc.stop(this._playStartTime + startSec + durSec);
        this._scheduledOscillators.push(osc);
      }
    }

    this._animatePlayhead();
  }

  _pause() {
    if (!this._isPlaying || !this._audioCtx) return;
    // Save current playhead tick so playback can resume from here
    const elapsedMs = (this._audioCtx.currentTime - this._playStartTime) * 1000;
    const absoluteMs = this._playSeekMs + elapsedMs;
    this._seekTick = msToTick(absoluteMs, this._song.tempoMap, this._song.ppq);

    this._isPlaying = false;
    for (const osc of this._scheduledOscillators) {
      try { osc.stop(); } catch { /* already stopped */ }
    }
    this._scheduledOscillators = [];
    if (this._playheadAnimFrame) {
      cancelAnimationFrame(this._playheadAnimFrame);
      this._playheadAnimFrame = null;
    }
    // Keep position display showing current time (don't reset)
    this._render();
  }

  _stop() {
    this._isPlaying = false;
    for (const osc of this._scheduledOscillators) {
      try { osc.stop(); } catch { /* already stopped */ }
    }
    this._scheduledOscillators = [];
    if (this._playheadAnimFrame) {
      cancelAnimationFrame(this._playheadAnimFrame);
      this._playheadAnimFrame = null;
    }
    // Reset seek position to start
    this._seekTick = 0;
    this._playSeekMs = 0;
    if (this._positionDisplay) {
      this._positionDisplay.textContent = '0:00.000';
    }
    this._render();
  }

  _animatePlayhead() {
    if (!this._isPlaying || !this._audioCtx) return;

    const elapsedMs = (this._audioCtx.currentTime - this._playStartTime) * 1000;
    const ms = this._playSeekMs + elapsedMs; // absolute song position in ms

    // Update time display
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    const msec = Math.floor(ms % 1000);
    if (this._positionDisplay) {
      this._positionDisplay.textContent = `${min}:${String(sec).padStart(2, '0')}.${String(msec).padStart(3, '0')}`;
    }

    this._render();

    // Check if playback is done
    const totalMs = tickToMs(getSongEndTick(this._song), this._song.tempoMap, this._song.ppq);
    if (ms >= totalMs) {
      if (this._song.loopEnabled) {
        this._stop(); // resets seekTick → loop always restarts from beginning
        this._play();
      } else {
        this._stop();
      }
      return;
    }

    this._playheadAnimFrame = requestAnimationFrame(() => this._animatePlayhead());
  }

  _previewNote(noteNum) {
    if (noteNum < 0 || noteNum > 127) return;
    this._ensureAudioContext();
    const freq = midiNoteToFreq(noteNum);
    const osc = this._audioCtx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const gain = this._audioCtx.createGain();
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(this._audioCtx.destination);
    osc.start();
    osc.stop(this._audioCtx.currentTime + 0.15);
  }

  // ─── MIDI import ─────────────────────────────────────────────────────

  async _handleMidiFile() {
    const file = this._midiFileInput?.files?.[0];
    if (!file) return;
    this._midiFileInput.value = '';

    try {
      const buffer = await readFileAsArrayBuffer(file);
      const { midi, summary } = parseMidiFile(buffer);

      if (summary.length === 0) {
        showToast('No note data found in MIDI file', 'warning');
        return;
      }

      if (this._hasSongContent()) {
        const ok = await showConfirm(`Import "${file.name}" and discard the current song?`);
        if (!ok) return;
      }

      // Auto-switch to Playtune if more than 1 track is detected
      let target = this._targetSelect?.value || 'tones';
      if (summary.length > 1) {
        target = 'playtune';
        this._targetSelect.value = 'playtune';
      }
      const maxSelectable = target === 'tones' ? 1 : 2;

      const selected = await this._showMidiTrackDialog(summary, maxSelectable);
      if (!selected || selected.length === 0) return;

      this._stop();
      const song = midiToSong(midi, {
        trackIndices: selected,
        targetLibrary: target,
      });

      this._song = song;
      this._bpmInput.value = song.tempoMap[0]?.bpm || 120;
      this._scrollX = 0;
      this._scrollY = 0;
      this._selectedNotes.clear();
      this._activeTrackIdx = 0;
      
      // Auto-set display range based on imported notes
      this._autoSetDisplayRange();
      
      // Reset example view to minimal after import
      if (this._showCompleteSketchCheckbox) {
        this._showCompleteSketchCheckbox.checked = false;
      }
      
      this._renderVoiceList();
      this._render();
      this._updateExport();
      showToast(`Imported ${file.name} (${selected.length} track${selected.length > 1 ? 's' : ''})`, 'success');
    } catch (err) {
      showToast(`MIDI import failed: ${err.message}`, 'error');
      console.error(err);
    }
  }

  _showMidiTrackDialog(summary, maxSelectable) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'mus-midi-overlay';

      const selectedIndices = new Set();
      // Pre-select first track(s)
      for (let i = 0; i < Math.min(maxSelectable, summary.length); i++) {
        selectedIndices.add(summary[i].index);
      }

      const render = () => {
        overlay.innerHTML = `
          <div class="mus-midi-dialog">
            <h3>Select Track${maxSelectable > 1 ? 's' : ''}</h3>
            <p>Choose ${maxSelectable > 1 ? 'up to ' + maxSelectable + ' tracks' : 'a track'} to import:</p>
            <div class="mus-midi-track-list">
              ${summary.map(s => `
                <div class="mus-midi-track-row${selectedIndices.has(s.index) ? ' selected' : ''}" data-index="${s.index}">
                  <div class="mus-midi-track-info">
                    <div class="mus-midi-track-name">${s.name}</div>
                    <div class="mus-midi-track-meta">Ch ${s.channel} &middot; ${s.noteCount} notes &middot; ${s.pitchRange}</div>
                  </div>
                </div>
              `).join('')}
            </div>
            <div class="button-row">
              <button class="btn btn-secondary" id="mus-midi-cancel">Cancel</button>
              <button class="btn btn-primary" id="mus-midi-ok" ${selectedIndices.size === 0 ? 'disabled' : ''}>Import</button>
            </div>
          </div>
        `;

        // Re-bind handlers after re-render
        overlay.querySelectorAll('.mus-midi-track-row').forEach(row => {
          row.addEventListener('click', () => {
            const idx = parseInt(row.dataset.index, 10);
            if (selectedIndices.has(idx)) {
              selectedIndices.delete(idx);
            } else {
              if (selectedIndices.size >= maxSelectable) {
                // Replace oldest
                const first = selectedIndices.values().next().value;
                selectedIndices.delete(first);
              }
              selectedIndices.add(idx);
            }
            render();
          });
        });

        overlay.querySelector('#mus-midi-cancel')?.addEventListener('click', () => {
          overlay.remove();
          resolve(null);
        });

        overlay.querySelector('#mus-midi-ok')?.addEventListener('click', () => {
          overlay.remove();
          resolve([...selectedIndices]);
        });
      };

      render();
      document.body.appendChild(overlay);

      // Escape to close
      const onKey = (e) => {
        if (e.key === 'Escape') {
          overlay.remove();
          document.removeEventListener('keydown', onKey);
          resolve(null);
        }
      };
      document.addEventListener('keydown', onKey);
    });
  }

  _showConfirmDialog(message, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.className = 'mus-midi-overlay';
    overlay.innerHTML = `
      <div class="mus-midi-dialog" style="max-width: 400px;">
        <p>${message}</p>
        <div class="button-row">
          <button class="btn btn-secondary" id="mus-confirm-cancel">Cancel</button>
          <button class="btn btn-primary" id="mus-confirm-ok">Continue</button>
        </div>
      </div>
    `;

    overlay.querySelector('#mus-confirm-cancel')?.addEventListener('click', () => {
      overlay.remove();
      if (onCancel) onCancel();
    });

    overlay.querySelector('#mus-confirm-ok')?.addEventListener('click', () => {
      overlay.remove();
      if (onConfirm) onConfirm();
    });

    const onKey = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        if (onCancel) onCancel();
      }
    };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
  }

  // ─── Export ──────────────────────────────────────────────────────────

  _updateExport() {
    if (!this._song) return;
    const target = this._targetSelect?.value || 'tones';
    const arrayName = this._arrayNameInput?.value?.trim() || 'song';
    const threshold = parseInt(this._velocityThreshold?.value, 10) || 96;
    const useConstants = this._useConstants?.checked ?? true;

    let result;
    if (target === 'tones') {
      result = exportArduboyTones(this._song, {
        arrayName,
        useConstants,
        highVolumeThreshold: threshold,
      });
    } else {
      result = exportArduboyPlaytune(this._song, { arrayName });
    }

    this._lastExport = result;

    if (this._codeOutput) this._codeOutput.textContent = result.code;
    
    // Store minimal and full example code
    this._exampleCodeMinimal = result.exampleCode;
    this._exampleCodeFull = result.exampleCodeFull || result.exampleCode;
    
    // Display the appropriate version
    this._updateUsageDisplay();

    // Stats info
    if (this._exportInfo) {
      const notes = this._song.tracks.reduce((s, t) => s + t.notes.length, 0);
      const totalMs = tickToMs(getSongEndTick(this._song), this._song.tempoMap, this._song.ppq);
      const durSec = (totalMs / 1000).toFixed(1);
      this._exportInfo.innerHTML = [
        `<span class="img-info-item">Notes: <span class="img-info-value">${notes}</span></span>`,
        `<span class="img-info-item">Duration: <span class="img-info-value">${durSec}s</span></span>`,
        `<span class="img-info-item">Bytes: <span class="img-info-value">${result.byteCount}</span></span>`,
        `<span class="img-info-item">Target: <span class="img-info-value">${target === 'tones' ? 'ArduboyTones' : 'ArduboyPlaytune'}</span></span>`,
      ].join('');
    }

    // Warnings
    if (result.warnings.length > 0) {
      this._warningsGroup?.classList.remove('hidden');
      if (this._warningsList) {
        this._warningsList.innerHTML = result.warnings.map(w => `<li>${w}</li>`).join('');
      }
    } else {
      this._warningsGroup?.classList.add('hidden');
    }

    this._saveState();
  }

  async _copyCode() {
    if (!this._lastExport) return;
    try {
      await navigator.clipboard.writeText(this._lastExport.code);
      showToast('Code copied to clipboard', 'success');
    } catch {
      showToast('Failed to copy', 'error');
    }
  }

  _updateUsageDisplay() {
    const showFull = this._showCompleteSketchCheckbox?.checked || false;
    const exampleText = showFull ? this._exampleCodeFull : this._exampleCodeMinimal;
    if (this._usageOutput) {
      this._usageOutput.textContent = exampleText;
    }
  }

  async _copyUsage() {
    if (!this._lastExport) return;
    try {
      const showFull = this._showCompleteSketchCheckbox?.checked || false;
      const textToCopy = showFull ? this._exampleCodeFull : this._exampleCodeMinimal;
      await navigator.clipboard.writeText(textToCopy);
      showToast('Example code copied to clipboard', 'success');
    } catch {
      showToast('Failed to copy', 'error');
    }
  }

  _downloadH() {
    if (!this._lastExport) return;
    const arrayName = this._arrayNameInput?.value?.trim() || 'song';
    const filename = `${arrayName}.h`;
    const guard = `${arrayName.toUpperCase()}_H`;
    const content = `#ifndef ${guard}\n#define ${guard}\n\n#include <avr/pgmspace.h>\n\n${this._lastExport.code}\n\n#endif\n`;
    const blob = new Blob([content], { type: 'text/plain' });
    downloadBlob(blob, filename);
    showToast(`Downloaded ${filename}`, 'success');
  }

  async _downloadMid() {
    // MIDI export is non-trivial; use @tonejs/midi to create it
    try {
      const { Midi } = await import('@tonejs/midi');
      const midi = new Midi();
      midi.header.setTempo(this._song.tempoMap[0]?.bpm || 120);
      midi.header.ppq = this._song.ppq;

      for (const track of this._song.tracks) {
        const midiTrack = midi.addTrack();
        midiTrack.name = track.name;
        for (const note of track.notes) {
          midiTrack.addNote({
            midi: note.noteNumber,
            ticks: note.startTick,
            durationTicks: note.endTick - note.startTick,
            velocity: note.velocity / 127,
          });
        }
      }

      const data = midi.toArray();
      downloadBlob(new Uint8Array(data), 'song.mid', 'audio/midi');
      showToast('Downloaded song.mid', 'success');
    } catch {
      showToast('MIDI export not available', 'warning');
    }
  }

  // ─── Public API (for main.js drag-and-drop) ──────────────────────────

  // ─── Persistence ─────────────────────────────────────────────────────

  static get _STORAGE_KEY() { return 'arduboy-music-state'; }

  _saveState() {
    try {
      const state = {
        song: this._song,
        target: this._targetSelect?.value,
        arrayName: this._arrayNameInput?.value,
        velocityThreshold: this._velocityThreshold?.value,
        useConstants: this._useConstants?.checked,
        showFullRange: this._showFullRange,
      };
      localStorage.setItem(MusicEditor._STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage unavailable or quota exceeded — silently skip
    }
  }

  _loadState() {
    try {
      const raw = localStorage.getItem(MusicEditor._STORAGE_KEY);
      if (!raw) return false;
      const state = JSON.parse(raw);
      if (!state?.song?.tracks) return false;

      this._song = state.song;

      // Advance the note ID counter past any restored IDs to prevent collisions
      let maxId = 0;
      for (const track of this._song.tracks) {
        for (const note of track.notes) {
          if (note.id > maxId) maxId = note.id;
        }
      }
      advanceNoteIdCounter(maxId);

      // Restore UI inputs
      if (this._targetSelect && state.target) this._targetSelect.value = state.target;
      if (this._arrayNameInput && state.arrayName != null) this._arrayNameInput.value = state.arrayName;
      if (this._velocityThreshold && state.velocityThreshold != null) {
        this._velocityThreshold.value = state.velocityThreshold;
        if (this._velocityThresholdValue) this._velocityThresholdValue.textContent = state.velocityThreshold;
      }
      if (this._useConstants && state.useConstants != null) this._useConstants.checked = state.useConstants;
      if (this._loopCheckbox && this._song.loopEnabled != null) this._loopCheckbox.checked = this._song.loopEnabled;
      if (this._bpmInput) this._bpmInput.value = this._song.tempoMap?.[0]?.bpm ?? 120;

      if (state.showFullRange != null) {
        this._showFullRange = state.showFullRange;
        const cb = $('#mus-show-full-range');
        if (cb) cb.checked = state.showFullRange;
        this._updateDisplayRange();
      }

      return true;
    } catch {
      return false;
    }
  }

  async loadFile(file) {
    // Simulate MIDI import
    try {
      const buffer = await readFileAsArrayBuffer(file);
      const { midi, summary } = parseMidiFile(buffer);

      if (summary.length === 0) {
        showToast('No note data found in MIDI file', 'warning');
        return;
      }

      const target = this._targetSelect?.value || 'tones';
      const maxSelectable = target === 'tones' ? 1 : 2;

      if (this._hasSongContent()) {
        const ok = await showConfirm(`Import "${file.name}" and discard the current song?`);
        if (!ok) return;
      }

      const selected = await this._showMidiTrackDialog(summary, maxSelectable);
      if (!selected || selected.length === 0) return;

      this._stop();
      this._song = midiToSong(midi, {
        trackIndices: selected,
        targetLibrary: target,
      });

      this._bpmInput.value = this._song.tempoMap[0]?.bpm || 120;
      this._scrollX = 0;
      this._scrollY = 0;
      this._selectedNotes.clear();
      this._activeTrackIdx = 0;
      
      // Auto-set display range based on imported notes
      this._autoSetDisplayRange();
      
      this._renderVoiceList();
      this._render();
      this._updateExport();
    } catch (err) {
      showToast(`Failed to load file: ${err.message}`, 'error');
      console.error(err);
    }
  }
}
