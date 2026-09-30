// 30b (vr-play) C5 — THE GAME SOUND SET. Twenty procedural WebAudio effects a game can
// name (`api.playSound('coin')`), with NO asset files: every sound is oscillators, a
// shared noise buffer, filters and envelopes, built fresh per play on the app's one
// AudioContext (audioEngine — a second context would have its own listener and clock).
//
// Why procedural and not samples: a module is a self-contained zip, the sound set must be
// the same on every peer with nothing to fetch, and "the user asked for sounds in every
// game" is not worth a megabyte of wav per build. The ping chimes (pingAudio.js) set the
// precedent; this is the same idea grown to a game's vocabulary.
//
// ROUTING: every game sound goes through ONE gain (the "Game sounds" volume in Settings,
// persisted LOCALLY through safeStorage) into the engine's `sfx` bus, so the mixer and the
// limiter see it like any other effect. A `position` spatialises it through a PannerNode
// (the engine keeps the listener on the camera/headset whatever spatialVoice says).
//
// CAPPED: a sweep across a keyboard or a round of explosions must not stack hundreds of
// live voices — past MAX_LIVE the oldest-ending ones are simply not started (a dropped
// sound is inaudible under that many; a stalled audio thread is not).
//
// A LEAF: svelte/store + audioEngine + safeStorage. `renderGameSound` renders one into an
// OfflineAudioContext and MEASURES it — the suite's proof that every name makes a sound.
import { writable, get } from 'svelte/store';
import { ensureAudioContext, bus } from './audioEngine';
import { safeStorage } from './safeStorage';

/** The names a game can play. Anything else is a quiet no-op (never an error). */
export const GAME_SOUNDS = [
	'click',
	'pop',
	'whoosh',
	'success',
	'fail',
	'hit',
	'kick',
	'shoot',
	'laser',
	'explosion',
	'coin',
	'levelup',
	'goal',
	'whistle',
	'cheer',
	'step',
	'ring',
	'sparkle',
	'hurt',
	'portal'
];
const SOUND_SET = new Set(GAME_SOUNDS);

/** @param {string} name */
export function isGameSound(name) {
	return SOUND_SET.has(String(name));
}

const VOLUME_KEY = 'game:soundVolume';
const MAX_LIVE = 24;

/** @param {string | null} raw @param {number} fallback */
function readVolume(raw, fallback) {
	const n = raw === null ? NaN : Number(raw);
	// Number.isFinite, never `|| fallback`: a slider dragged to ZERO is a real volume
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** "Game sounds" volume, 0..1, LOCAL per device (Settings ▸ Interface ▸ Sound). */
export const gameSoundVolume = writable(readVolume(safeStorage.getItem(VOLUME_KEY), 0.8));

/** @type {GainNode | null} */
let gameGain = null;

// Declared ABOVE the subscribe (the module-level subscribe runs synchronously — TDZ rule).
gameSoundVolume.subscribe((v) => {
	safeStorage.setItem(VOLUME_KEY, String(v));
	if (gameGain) gameGain.gain.value = v;
});

/** the game-sound gain on the sfx bus, built once @returns {GainNode} */
function gameOut() {
	const ctx = ensureAudioContext();
	if (!gameGain) {
		gameGain = ctx.createGain();
		gameGain.gain.value = get(gameSoundVolume);
		gameGain.connect(bus('sfx'));
	}
	return gameGain;
}

/* ------------------------------------------------------------------ the synth ---- */

/** @type {WeakMap<BaseAudioContext, AudioBuffer>} one second of white noise per context */
const noiseBuffers = new WeakMap();

/** @param {BaseAudioContext} ctx @returns {AudioBuffer} */
function noiseBuffer(ctx) {
	let buffer = noiseBuffers.get(ctx);
	if (buffer) return buffer;
	buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
	const data = buffer.getChannelData(0);
	// a fixed LCG, so the same sound renders the same bytes on every device
	let seed = 0x2f6b1d;
	for (let i = 0; i < data.length; i++) {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		data[i] = (seed / 0xffffffff) * 2 - 1;
	}
	noiseBuffers.set(ctx, buffer);
	return buffer;
}

/** exponential ramps cannot reach zero */
const FLOOR = 0.0001;

/**
 * One enveloped oscillator, optionally gliding.
 * @param {BaseAudioContext} ctx @param {AudioNode} dest
 * @param {{freq: number, to?: number, type?: OscillatorType, t0: number, dur: number,
 *   peak?: number, attack?: number, vibrato?: {rate: number, depth: number}}} o
 */
function tone(ctx, dest, o) {
	const { freq, to, type = 'sine', t0, dur, peak = 0.25, attack = 0.008, vibrato } = o;
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = type;
	osc.frequency.setValueAtTime(freq, t0);
	if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
	if (vibrato) {
		const lfo = ctx.createOscillator();
		const depth = ctx.createGain();
		lfo.frequency.value = vibrato.rate;
		depth.gain.value = vibrato.depth;
		lfo.connect(depth).connect(osc.frequency);
		lfo.start(t0);
		lfo.stop(t0 + dur + 0.05);
	}
	gain.gain.setValueAtTime(FLOOR, t0);
	gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
	gain.gain.exponentialRampToValueAtTime(FLOOR, t0 + dur);
	osc.connect(gain).connect(dest);
	osc.start(t0);
	osc.stop(t0 + dur + 0.05);
}

/**
 * A filtered noise burst, optionally sweeping its filter.
 * @param {BaseAudioContext} ctx @param {AudioNode} dest
 * @param {{t0: number, dur: number, peak?: number, attack?: number,
 *   filter?: BiquadFilterType, freq?: number, to?: number, q?: number, flutter?: number}} o
 */
function noise(ctx, dest, o) {
	const { t0, dur, peak = 0.3, attack = 0.005, filter = 'lowpass', freq = 2000, to, q = 0.8, flutter } = o;
	const src = ctx.createBufferSource();
	src.buffer = noiseBuffer(ctx);
	src.loop = true;
	const biquad = ctx.createBiquadFilter();
	biquad.type = filter;
	biquad.Q.value = q;
	biquad.frequency.setValueAtTime(freq, t0);
	if (to) biquad.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
	const gain = ctx.createGain();
	gain.gain.setValueAtTime(FLOOR, t0);
	gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
	gain.gain.exponentialRampToValueAtTime(FLOOR, t0 + dur);
	src.connect(biquad).connect(gain);
	if (flutter) {
		// a crowd is not one steady hiss: an amplitude wobble makes it read as voices
		const wobble = ctx.createGain();
		wobble.gain.value = 0.6;
		const lfo = ctx.createOscillator();
		const depth = ctx.createGain();
		lfo.frequency.value = flutter;
		depth.gain.value = 0.4;
		lfo.connect(depth).connect(wobble.gain);
		lfo.start(t0);
		lfo.stop(t0 + dur + 0.05);
		gain.connect(wobble).connect(dest);
	} else gain.connect(dest);
	src.start(t0, (t0 * 7.13) % 0.5);
	src.stop(t0 + dur + 0.05);
}

/** equal-tempered frequency of a midi note @param {number} midi */
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/**
 * Build one sound into `dest` starting at `t0`. Returns its length in seconds, or -1 for
 * a name that is not in the set. Pure WebAudio graph building — the live player and the
 * offline measurement share it, so what the suite measures is what a player hears.
 * @param {BaseAudioContext} ctx @param {AudioNode} dest @param {string} name @param {number} t0
 * @returns {number}
 */
export function buildGameSound(ctx, dest, name, t0) {
	switch (name) {
		case 'click':
			tone(ctx, dest, { freq: 1900, type: 'square', t0, dur: 0.035, peak: 0.12, attack: 0.002 });
			noise(ctx, dest, { t0, dur: 0.03, peak: 0.12, filter: 'highpass', freq: 3000 });
			return 0.05;
		case 'pop':
			tone(ctx, dest, { freq: 380, to: 1100, t0, dur: 0.09, peak: 0.3, attack: 0.004 });
			return 0.1;
		case 'whoosh':
			noise(ctx, dest, { t0, dur: 0.45, peak: 0.35, attack: 0.12, filter: 'bandpass', freq: 300, to: 2600, q: 1.4 });
			return 0.5;
		case 'success':
			[72, 76, 79, 84].forEach((m, i) =>
				tone(ctx, dest, { freq: hz(m), type: 'triangle', t0: t0 + i * 0.08, dur: i === 3 ? 0.5 : 0.18, peak: 0.28 })
			);
			return 0.8;
		case 'fail':
			tone(ctx, dest, { freq: 330, type: 'square', t0, dur: 0.22, peak: 0.12 });
			tone(ctx, dest, { freq: 247, type: 'square', t0: t0 + 0.2, dur: 0.22, peak: 0.12 });
			tone(ctx, dest, { freq: 196, to: 150, type: 'sawtooth', t0: t0 + 0.4, dur: 0.45, peak: 0.12 });
			return 0.9;
		case 'hit':
			tone(ctx, dest, { freq: 160, to: 55, t0, dur: 0.18, peak: 0.5, attack: 0.002 });
			noise(ctx, dest, { t0, dur: 0.12, peak: 0.4, freq: 1400, to: 300, attack: 0.002 });
			return 0.22;
		case 'kick':
			tone(ctx, dest, { freq: 150, to: 42, t0, dur: 0.3, peak: 0.7, attack: 0.002 });
			noise(ctx, dest, { t0, dur: 0.02, peak: 0.15, filter: 'highpass', freq: 2000, attack: 0.001 });
			return 0.32;
		case 'shoot':
			tone(ctx, dest, { freq: 900, to: 140, type: 'square', t0, dur: 0.16, peak: 0.16, attack: 0.002 });
			noise(ctx, dest, { t0, dur: 0.1, peak: 0.3, freq: 3000, to: 500, attack: 0.001 });
			return 0.2;
		case 'laser':
			tone(ctx, dest, { freq: 1500, to: 280, type: 'sawtooth', t0, dur: 0.26, peak: 0.14, attack: 0.003 });
			tone(ctx, dest, { freq: 3000, to: 560, type: 'sine', t0, dur: 0.2, peak: 0.08, attack: 0.003 });
			return 0.3;
		case 'explosion':
			noise(ctx, dest, { t0, dur: 1.3, peak: 0.7, freq: 2200, to: 120, attack: 0.004, q: 0.5 });
			tone(ctx, dest, { freq: 90, to: 28, t0, dur: 0.9, peak: 0.6, attack: 0.004 });
			return 1.35;
		case 'coin':
			tone(ctx, dest, { freq: hz(83), type: 'square', t0, dur: 0.08, peak: 0.13, attack: 0.002 });
			tone(ctx, dest, { freq: hz(88), type: 'square', t0: t0 + 0.07, dur: 0.35, peak: 0.13, attack: 0.002 });
			return 0.45;
		case 'levelup':
			[60, 64, 67, 72, 76, 79, 84, 88].forEach((m, i) =>
				tone(ctx, dest, { freq: hz(m), type: 'triangle', t0: t0 + i * 0.055, dur: i === 7 ? 0.6 : 0.12, peak: 0.24 })
			);
			return 1.05;
		case 'goal':
			// a bright major stab that swells, with a rising run on top — a stadium moment
			[60, 64, 67, 72].forEach((m) =>
				tone(ctx, dest, { freq: hz(m), type: 'sawtooth', t0, dur: 1.1, peak: 0.07, attack: 0.05 })
			);
			[79, 84, 88, 91].forEach((m, i) =>
				tone(ctx, dest, { freq: hz(m), type: 'triangle', t0: t0 + 0.05 + i * 0.07, dur: 0.4, peak: 0.16 })
			);
			noise(ctx, dest, { t0: t0 + 0.1, dur: 1.4, peak: 0.12, attack: 0.3, filter: 'bandpass', freq: 1600, q: 0.7, flutter: 9 });
			return 1.5;
		case 'whistle':
			// a referee's pea whistle: a high tone with a fast trill
			tone(ctx, dest, { freq: 2900, type: 'sine', t0, dur: 0.55, peak: 0.2, attack: 0.02, vibrato: { rate: 32, depth: 160 } });
			return 0.6;
		case 'cheer':
			noise(ctx, dest, { t0, dur: 1.8, peak: 0.3, attack: 0.35, filter: 'bandpass', freq: 1200, to: 1700, q: 0.6, flutter: 7 });
			noise(ctx, dest, { t0: t0 + 0.1, dur: 1.6, peak: 0.14, attack: 0.4, filter: 'bandpass', freq: 2600, q: 1.2, flutter: 11 });
			return 1.9;
		case 'step':
			noise(ctx, dest, { t0, dur: 0.08, peak: 0.3, freq: 500, to: 180, attack: 0.002 });
			return 0.1;
		case 'ring':
			tone(ctx, dest, { freq: 1320, t0, dur: 1.0, peak: 0.2, attack: 0.003 });
			tone(ctx, dest, { freq: 1320 * 2.76, t0, dur: 0.5, peak: 0.07, attack: 0.003 });
			tone(ctx, dest, { freq: 1320 * 5.4, t0, dur: 0.25, peak: 0.04, attack: 0.003 });
			return 1.05;
		case 'sparkle': {
			// seven high pings on a fixed pattern (deterministic — no Math.random)
			const notes = [96, 100, 103, 98, 105, 101, 108];
			notes.forEach((m, i) => tone(ctx, dest, { freq: hz(m), t0: t0 + i * 0.045, dur: 0.22, peak: 0.1, attack: 0.002 }));
			return 0.55;
		}
		case 'hurt':
			tone(ctx, dest, { freq: 320, to: 110, type: 'sawtooth', t0, dur: 0.32, peak: 0.2, attack: 0.004 });
			noise(ctx, dest, { t0, dur: 0.15, peak: 0.2, freq: 900, attack: 0.002 });
			return 0.36;
		case 'portal':
			tone(ctx, dest, { freq: 180, to: 1300, t0, dur: 0.9, peak: 0.18, attack: 0.3, vibrato: { rate: 9, depth: 40 } });
			tone(ctx, dest, { freq: 270, to: 1950, type: 'triangle', t0: t0 + 0.05, dur: 0.85, peak: 0.08, attack: 0.3 });
			noise(ctx, dest, { t0, dur: 0.9, peak: 0.08, attack: 0.4, filter: 'bandpass', freq: 800, to: 4000, q: 2 });
			return 0.95;
		default:
			return -1;
	}
}

/* ------------------------------------------------------------------ the player --- */

/** end times (context seconds) of the sounds still ringing @type {number[]} */
const live = [];
const debug = { played: 0, dropped: 0, unknown: 0, last: '' };

/**
 * Play a game sound, LOCAL to this device. Returns true when a sound started; false for
 * an unknown name, a missing audio context, or the voice cap.
 * @param {string} name @param {number[] | null} [position] world-space, spatialised
 * @returns {boolean}
 */
export function playGameSound(name, position = null) {
	if (!isGameSound(name)) {
		debug.unknown++;
		return false;
	}
	/** @type {AudioContext} */
	let ctx;
	try {
		ctx = ensureAudioContext();
	} catch {
		return false;
	}
	if (ctx.state === 'suspended') ctx.resume().catch(() => {});
	const now = ctx.currentTime;
	while (live.length && live[0] <= now) live.shift();
	if (live.length >= MAX_LIVE) {
		debug.dropped++;
		return false;
	}
	/** @type {AudioNode} */
	let dest = gameOut();
	if (Array.isArray(position) && position.length >= 3 && position.every((n) => Number.isFinite(n))) {
		const panner = ctx.createPanner();
		panner.panningModel = 'HRTF';
		panner.distanceModel = 'inverse';
		panner.refDistance = 2;
		if (panner.positionX) {
			panner.positionX.value = position[0];
			panner.positionY.value = position[1];
			panner.positionZ.value = position[2];
		} else panner.setPosition(position[0], position[1], position[2]);
		panner.connect(dest);
		dest = panner;
	}
	const length = buildGameSound(ctx, dest, name, now + 0.005);
	live.push(now + length);
	live.sort((a, b) => a - b);
	debug.played++;
	debug.last = name;
	return true;
}

/**
 * Render one sound OFFLINE and measure it (the suite's "does every name make a sound").
 * @param {string} name @param {number} [sampleRate]
 * @returns {Promise<{name: string, seconds: number, rms: number, peak: number} | null>}
 */
export async function renderGameSound(name, sampleRate = 22050) {
	const Offline = typeof window !== 'undefined' ? /** @type {any} */ (window).OfflineAudioContext : null;
	if (!Offline) return null;
	const probe = new Offline(1, 64, sampleRate);
	const seconds = buildGameSound(probe, probe.destination, name, 0);
	if (seconds < 0) return { name, seconds: -1, rms: 0, peak: 0 };
	const ctx = new Offline(1, Math.ceil((seconds + 0.1) * sampleRate), sampleRate);
	buildGameSound(ctx, ctx.destination, name, 0);
	const buffer = await ctx.startRendering();
	const data = buffer.getChannelData(0);
	let sum = 0;
	let peak = 0;
	for (let i = 0; i < data.length; i++) {
		sum += data[i] * data[i];
		peak = Math.max(peak, Math.abs(data[i]));
	}
	return { name, seconds, rms: Math.sqrt(sum / data.length), peak };
}

/** the live gain's value (null before the first sound) — the volume's measurable end */
export function gameSoundGainValue() {
	return gameGain ? gameGain.gain.value : null;
}

/** counts for the suites @returns {{played: number, dropped: number, unknown: number, last: string, live: number}} */
export function gameSfxDebug() {
	return { ...debug, live: live.length };
}

// the two building blocks, shared with the music scheduler (gameMusic.js) so a game's
// music and its effects are made of the same parts
export { tone as sfxTone, noise as sfxNoise };
