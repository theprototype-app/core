// 30b (vr-play) C5 — GAME MUSIC: `api.music.play(preset, {volume})` / `api.music.stop()`.
// Seven procedural looping presets (gameMusicPresets.js is the tune as data), scheduled on
// the app's one AudioContext and LOCAL to this device — a peer's music is theirs.
//
// THREE RULES, each one the user's:
//  · it plays only while the player is PLAYING (Interact or Play — gameFeel.js). A call
//    from the editor is refused, and leaving the game stops it: "music stops on leaving
//    Play/Interact". Refusing in Edit is stricter than "stop on leave" and is on purpose —
//    a module that started its music from register() would otherwise score the editor.
//  · it sits UNDER the effects: one "Music" volume in Settings (persisted via safeStorage)
//    times a quiet MIX constant, into the engine's `music` bus.
//  · it is TEMPO-SYNCED to the SESSION clock: the step that plays is floor(sessionNow /
//    step length), never "steps since the button" — two peers who start one preset hear
//    the same bar at the same moment, and a restart lands back on the beat.
//
// The scheduler is the classic lookahead: a 25 ms timer schedules every step whose time
// falls inside the next LOOKAHEAD seconds on the audio clock (audioTimeFor maps a session
// stamp through the engine's filtered clock). A TIMER, not a rAF: an immersive session
// stops window rAF on the Quest, and music must not.
import { writable, get } from 'svelte/store';
import { ensureAudioContext, bus, audioTimeFor } from './audioEngine';
import { sessionNow } from './sessionClock';
import { safeStorage } from './safeStorage';
import { gameFeelOn, gameFeelActive } from './gameFeel';
import { sfxTone, sfxNoise } from './gameSfx';
import { musicPreset, stepSeconds, stepEvents, MUSIC_PRESET_IDS } from './gameMusicPresets';

export { MUSIC_PRESET_IDS };

const VOLUME_KEY = 'game:musicVolume';
/** music under effects: the slider's full scale is this loud */
const MIX = 0.55;
const LOOKAHEAD = 0.18;
const TICK_MS = 25;

/** @param {string | null} raw @param {number} fallback */
function readVolume(raw, fallback) {
	const n = raw === null ? NaN : Number(raw);
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** "Music" volume, 0..1, LOCAL per device (Settings ▸ Interface ▸ Sound). */
export const gameMusicVolume = writable(readVolume(safeStorage.getItem(VOLUME_KEY), 0.6));

/** what is playing now: `{preset, volume}` or null @type {import('svelte/store').Writable<{preset: string, volume: number} | null>} */
export const gameMusicState = writable(null);

/**
 * The running session. `gain` is PER PLAY: stopping fades and disconnects it, so any note
 * already scheduled into it goes silent with it — no voice bookkeeping needed.
 * @type {{preset: any, volume: number, gain: GainNode, timer: any, lastStep: number, scheduled: number} | null}
 */
let current = null;
const debug = { steps: 0, notes: 0, refused: 0, stops: 0 };

/** @param {number} volume the per-call volume */
function levelFor(volume) {
	return MIX * get(gameMusicVolume) * volume;
}

// Declared ABOVE the subscribes (they run synchronously at module evaluation).
gameMusicVolume.subscribe((v) => {
	safeStorage.setItem(VOLUME_KEY, String(v));
	if (current) current.gain.gain.value = levelFor(current.volume);
});
// "music stops on leaving Play/Interact" — the falling edge of the one predicate
gameFeelOn.subscribe((on) => {
	if (!on && current) stopGameMusic();
});

/** @param {number} midi */
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/**
 * Build one step's notes into `dest` at audio time `t`. Shared by the live scheduler and
 * the offline render, so what the suite measures is what a player hears.
 * @param {BaseAudioContext} ctx @param {AudioNode} dest @param {any} preset
 * @param {number} step @param {number} t @returns {number} notes built
 */
export function buildMusicStep(ctx, dest, preset, step, t) {
	const beat = 60 / preset.bpm;
	let n = 0;
	for (const event of stepEvents(preset, step)) {
		const g = preset.drumGain;
		switch (event.kind) {
			case 'kick':
				sfxTone(ctx, dest, { freq: 140, to: 44, t0: t, dur: 0.24, peak: 0.55 * g, attack: 0.002 });
				break;
			case 'snare':
				sfxNoise(ctx, dest, { t0: t, dur: 0.14, peak: 0.22 * g, filter: 'bandpass', freq: 1800, q: 0.7, attack: 0.002 });
				sfxTone(ctx, dest, { freq: 190, to: 140, t0: t, dur: 0.08, peak: 0.12 * g, attack: 0.002 });
				break;
			case 'hat':
				sfxNoise(ctx, dest, { t0: t, dur: 0.04, peak: 0.08 * g, filter: 'highpass', freq: 7000, attack: 0.001 });
				break;
			case 'bass': {
				const dur = Math.max(0.12, (event.beats ?? 0.5) * beat * 0.95);
				const v = preset.bassVoice;
				const lp = ctx.createBiquadFilter();
				lp.type = 'lowpass';
				lp.frequency.value = v.cutoff;
				lp.connect(dest);
				sfxTone(ctx, lp, { freq: hz(/** @type {number} */ (event.midi)), type: v.type, t0: t, dur, peak: v.gain, attack: 0.01 });
				break;
			}
			case 'pad': {
				const dur = (event.beats ?? 4) * beat;
				for (const m of /** @type {number[]} */ (event.midi))
					sfxTone(ctx, dest, { freq: hz(m), type: preset.pad.type, t0: t, dur, peak: preset.pad.gain, attack: Math.min(0.6, dur * 0.3) });
				break;
			}
			case 'arp':
				sfxTone(ctx, dest, { freq: hz(/** @type {number} */ (event.midi)), type: preset.arp.type, t0: t, dur: Math.max(0.1, beat * 0.45), peak: preset.arp.gain, attack: 0.004 });
				break;
		}
		n++;
	}
	return n;
}

function tick() {
	if (!current) return;
	const ctx = ensureAudioContext();
	const stepMs = stepSeconds(current.preset) * 1000;
	const now = sessionNow();
	const horizon = now + LOOKAHEAD * 1000;
	// the first tick starts at the NEXT step boundary — a step already begun would land
	// part-way through its own notes
	let step = current.lastStep < 0 ? Math.floor(now / stepMs) + 1 : current.lastStep + 1;
	// a stalled timer (a background tab) never replays the backlog: skip to now
	if (step * stepMs < now - 200) step = Math.floor(now / stepMs) + 1;
	for (; step * stepMs <= horizon; step++) {
		const at = audioTimeFor(step * stepMs);
		if (at < ctx.currentTime) continue;
		debug.notes += buildMusicStep(ctx, current.gain, current.preset, step, at);
		debug.steps++;
		current.lastStep = step;
	}
}

/**
 * Start (or switch to) a preset. Refused — false — outside Interact/Play, and for an
 * unknown preset name. The same preset already playing only takes the new volume.
 * @param {string} presetId @param {{volume?: number}} [options]
 * @returns {boolean}
 */
export function playGameMusic(presetId, options = {}) {
	const preset = musicPreset(presetId);
	if (!preset || !gameFeelActive()) {
		debug.refused++;
		return false;
	}
	const raw = Number(options?.volume);
	const volume = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
	if (current && current.preset.id === preset.id) {
		current.volume = volume;
		current.gain.gain.value = levelFor(volume);
		gameMusicState.set({ preset: preset.id, volume });
		return true;
	}
	if (current) stopGameMusic();
	/** @type {AudioContext} */
	let ctx;
	try {
		ctx = ensureAudioContext();
	} catch {
		return false;
	}
	if (ctx.state === 'suspended') ctx.resume().catch(() => {});
	const gain = ctx.createGain();
	gain.gain.value = levelFor(volume);
	gain.connect(bus('music'));
	current = { preset, volume, gain, timer: setInterval(tick, TICK_MS), lastStep: -1, scheduled: 0 };
	tick();
	gameMusicState.set({ preset: preset.id, volume });
	return true;
}

/** Stop whatever is playing (a short fade — a hard cut clicks). Safe to call anytime. */
export function stopGameMusic() {
	if (!current) return;
	const { gain, timer } = current;
	current = null;
	clearInterval(timer);
	debug.stops++;
	try {
		const ctx = ensureAudioContext();
		gain.gain.cancelScheduledValues(ctx.currentTime);
		gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
		gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
	} catch {
		/* a closed context has nothing left to fade */
	}
	setTimeout(() => {
		try {
			gain.disconnect();
		} catch {}
	}, 450);
	gameMusicState.set(null);
}

/**
 * Render `bars` bars of a preset OFFLINE and measure them (the suite's proof that every
 * preset plays a real loop).
 * @param {string} presetId @param {number} [bars] @param {number} [sampleRate]
 * @returns {Promise<{preset: string, seconds: number, rms: number, peak: number, notes: number} | null>}
 */
export async function renderGameMusic(presetId, bars = 1, sampleRate = 22050) {
	const preset = musicPreset(presetId);
	const Offline = typeof window !== 'undefined' ? /** @type {any} */ (window).OfflineAudioContext : null;
	if (!preset || !Offline) return null;
	const step = stepSeconds(preset);
	const seconds = bars * 16 * step + 1;
	const ctx = new Offline(1, Math.ceil(seconds * sampleRate), sampleRate);
	let notes = 0;
	for (let i = 0; i < bars * 16; i++) notes += buildMusicStep(ctx, ctx.destination, preset, i, i * step);
	const buffer = await ctx.startRendering();
	const data = buffer.getChannelData(0);
	let sum = 0;
	let peak = 0;
	for (let i = 0; i < data.length; i++) {
		sum += data[i] * data[i];
		peak = Math.max(peak, Math.abs(data[i]));
	}
	return { preset: preset.id, seconds, rms: Math.sqrt(sum / data.length), peak, notes };
}

/** the live gain's value, or null when nothing plays */
export function gameMusicGainValue() {
	return current ? current.gain.gain.value : null;
}

/** counts for the suites */
export function gameMusicDebug() {
	return { ...debug, playing: current?.preset.id ?? null, lastStep: current?.lastStep ?? -1 };
}
