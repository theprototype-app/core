// 30b (vr-play) C5 — the game MUSIC presets as DATA, plus the pure arithmetic that turns
// a preset and a step number into the notes that step plays. Imports NOTHING: the
// scheduler (gameMusic.js) is the only thing that touches WebAudio, so everything a
// listener would call "the tune" is testable with no browser.
//
// A preset is a four-bar loop in sixteenth notes: a chord PROGRESSION (scale degrees, one
// per bar), drum lanes as 16-char strings ('x' hit, '.' rest), a bass lane ('r' root,
// 'o' octave, 'f' fifth, 't' third), an optional pad (the bar's triad, held) and an
// optional ARP lane of chord-tone indices ('0'-'5' = triad tones up two octaves).
//
// Everything is keyed to a GLOBAL step count (the session clock divided by the step
// length), never to "when play was pressed" — so two peers who start the same preset hear
// the same bar at the same moment, and "tempo-synced" means synced to the session.

/** @typedef {{kind: 'kick'|'snare'|'hat'|'bass'|'pad'|'arp', midi?: number[] | number, beats?: number}} MusicEvent */

/**
 * @typedef {object} MusicPreset
 * @property {string} id @property {string} name
 * @property {number} bpm
 * @property {number} root midi note of the key's tonic (octave 4-ish)
 * @property {number[]} scale semitone offsets of the mode
 * @property {number[]} progression scale degrees (0-based), one chord per bar
 * @property {{kick?: string, snare?: string, hat?: string}} drums 16 chars each
 * @property {string} bass 16 chars: r o f t .
 * @property {{type: OscillatorType, gain: number} | null} pad
 * @property {{lane: string, type: OscillatorType, gain: number, octave: number} | null} arp
 * @property {{type: OscillatorType, gain: number, cutoff: number}} bassVoice
 * @property {number} drumGain
 */

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];

/** @type {MusicPreset[]} */
export const MUSIC_PRESETS = [
	{
		id: 'arcade',
		name: 'Arcade',
		bpm: 138,
		root: 60,
		scale: MAJOR,
		progression: [0, 5, 3, 4],
		drums: { kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.' },
		bass: 'r.r.o.r.r.r.o.f.',
		pad: null,
		arp: { lane: '0.1.2.3.2.1.0.1.', type: 'square', gain: 0.045, octave: 1 },
		bassVoice: { type: 'square', gain: 0.07, cutoff: 900 },
		drumGain: 0.8
	},
	{
		id: 'ambient',
		name: 'Ambient',
		bpm: 72,
		root: 62,
		scale: LYDIAN,
		progression: [0, 3, 5, 4],
		drums: {},
		bass: 'r...............',
		pad: { type: 'triangle', gain: 0.05 },
		arp: { lane: '0.......2.......', type: 'sine', gain: 0.04, octave: 2 },
		bassVoice: { type: 'sine', gain: 0.09, cutoff: 500 },
		drumGain: 0
	},
	{
		id: 'dungeon',
		name: 'Dungeon',
		bpm: 84,
		root: 57,
		scale: PHRYGIAN,
		progression: [0, 0, 1, 6],
		drums: { kick: 'x.......x.x.....', snare: '............x...', hat: '' },
		bass: 'r.......r...f...',
		pad: { type: 'sawtooth', gain: 0.022 },
		arp: { lane: '....2.......1...', type: 'triangle', gain: 0.035, octave: 1 },
		bassVoice: { type: 'sawtooth', gain: 0.07, cutoff: 350 },
		drumGain: 0.7
	},
	{
		id: 'stadium',
		name: 'Stadium',
		bpm: 120,
		root: 55,
		scale: MAJOR,
		progression: [0, 4, 5, 3],
		drums: { kick: 'x...x...x...x...', snare: '....x.......x.x.', hat: 'x.x.x.x.x.x.x.x.' },
		bass: 'r.r.r.r.f.f.o.o.',
		pad: { type: 'sawtooth', gain: 0.025 },
		arp: null,
		bassVoice: { type: 'sawtooth', gain: 0.07, cutoff: 700 },
		drumGain: 0.9
	},
	{
		id: 'space',
		name: 'Space',
		bpm: 100,
		root: 64,
		scale: DORIAN,
		progression: [0, 6, 5, 4],
		drums: { kick: 'x.........x.....', snare: '....x.......x...', hat: '..x...x...x...xx' },
		bass: 'r.....r.....f...',
		pad: { type: 'triangle', gain: 0.035 },
		arp: { lane: '0.2.4.2.1.3.5.3.', type: 'triangle', gain: 0.04, octave: 1 },
		bassVoice: { type: 'triangle', gain: 0.09, cutoff: 600 },
		drumGain: 0.6
	},
	{
		id: 'puzzle',
		name: 'Puzzle',
		bpm: 96,
		root: 65,
		scale: MAJOR,
		progression: [0, 3, 1, 4],
		drums: { kick: 'x.......x.......', snare: '', hat: '....x.......x...' },
		bass: 'r...f...r...t...',
		pad: null,
		arp: { lane: '0..2..1..3..2...', type: 'triangle', gain: 0.05, octave: 1 },
		bassVoice: { type: 'triangle', gain: 0.08, cutoff: 800 },
		drumGain: 0.5
	},
	{
		id: 'studio',
		name: 'Studio',
		bpm: 88,
		root: 55,
		scale: MINOR,
		progression: [0, 3, 6, 4],
		drums: { kick: 'x......x..x.....', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xx' },
		bass: 'r.....r.f.....o.',
		pad: { type: 'sine', gain: 0.045 },
		arp: null,
		bassVoice: { type: 'sine', gain: 0.1, cutoff: 500 },
		drumGain: 0.6
	}
];

/** @param {string} id @returns {MusicPreset | null} */
export function musicPreset(id) {
	return MUSIC_PRESETS.find((p) => p.id === String(id)) ?? null;
}

/** the names a module can ask for */
export const MUSIC_PRESET_IDS = MUSIC_PRESETS.map((p) => p.id);

/** seconds per sixteenth note @param {MusicPreset} preset */
export function stepSeconds(preset) {
	return 60 / preset.bpm / 4;
}

/**
 * The triad (three midi notes) on scale degree `degree`, stacked in thirds inside the
 * mode — so a minor key's iv is minor and a major key's V is major, with no chord table.
 * @param {MusicPreset} preset @param {number} degree @returns {number[]}
 */
export function triadOn(preset, degree) {
	const s = preset.scale;
	/** @param {number} i */
	const note = (i) => preset.root + s[((i % 7) + 7) % 7] + 12 * Math.floor(i / 7);
	return [note(degree), note(degree + 2), note(degree + 4)];
}

/** @param {string | undefined} lane @param {number} i */
const hitAt = (lane, i) => !!lane && lane[i] !== undefined && lane[i] !== '.';

/**
 * What global step `step` plays. Pure: same preset + same step = same events, on every
 * device. The chord changes per BAR (16 steps), cycling the progression.
 * @param {MusicPreset} preset @param {number} step @returns {MusicEvent[]}
 */
export function stepEvents(preset, step) {
	const i = ((step % 16) + 16) % 16;
	const bar = Math.floor(step / 16);
	const degree = preset.progression[((bar % preset.progression.length) + preset.progression.length) % preset.progression.length];
	const triad = triadOn(preset, degree);
	/** @type {MusicEvent[]} */
	const out = [];
	if (hitAt(preset.drums.kick, i)) out.push({ kind: 'kick' });
	if (hitAt(preset.drums.snare, i)) out.push({ kind: 'snare' });
	if (hitAt(preset.drums.hat, i)) out.push({ kind: 'hat' });
	const b = preset.bass[i];
	if (b && b !== '.') {
		const base = triad[0] - 24;
		const midi = b === 'o' ? base + 12 : b === 'f' ? base + 7 : b === 't' ? triad[1] - 24 : base;
		// a bass note lasts until the next one in its lane
		let len = 1;
		while (len < 16 && (preset.bass[(i + len) % 16] ?? '.') === '.' && i + len < 16) len++;
		out.push({ kind: 'bass', midi, beats: len / 4 });
	}
	if (preset.pad && i === 0) out.push({ kind: 'pad', midi: triad, beats: 4 });
	if (preset.arp) {
		const c = preset.arp.lane[i];
		if (c && c !== '.') {
			const k = Number(c);
			const tone = triad[k % 3] + 12 * (Math.floor(k / 3) + preset.arp.octave);
			out.push({ kind: 'arp', midi: tone, beats: 0.25 });
		}
	}
	return out;
}
