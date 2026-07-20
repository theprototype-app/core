import { writable, get } from 'svelte/store';
import { peers } from '../stores/appStore';
import { ensureAudioContext } from './voiceChat';
import { itemByHash, itemBlob } from './explorer';
import { requestAsset, sendAsset } from './assetShare';

// Scene music (M-1): ONE shared background track per scene — a singleton synced
// latest-wins like the environment, so everyone hears the same track at the same
// phase. It is a SEPARATE `music` message, NOT piggybacked on environment: env
// state round-trips through preset export/import and music must not leak into
// saved presets. Non-spatial (a plain gain, no panner); playback phase derives
// from the synced clock (Date.now() basis, same as soundRuntime), so late joiners
// converge mid-track. A per-device local volume/mute rides on top.

const DEFAULT = { hash: null, name: '', volume: 0.8, playing: false, startedAt: 0, changedAt: 0 };

/** @type {import('svelte/store').Writable<any>} shared music state (NOT persisted) */
export const music = writable({ ...DEFAULT });

// per-device overlay (LOCAL, persisted) — your own volume trim + mute
export const musicLocalVolume = writable(
	typeof localStorage !== 'undefined' ? +(localStorage.getItem('musicLocalVolume') ?? '1') : 1
);
export const musicMuted = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('musicMuted') === 'true' : false
);

/** whether the audio context is currently blocked by the browser autoplay policy */
export const musicBlocked = writable(false);

// ---- playback runtime ------------------------------------------------------

/** @type {any} */ let ctx = null;
/** @type {any} */ let gain = null;
/** @type {any} */ let source = null;
/** @type {AudioBuffer|null} */ let buffer = null;
let bufferHash = /** @type {string|null} */ (null);
let decoding = false;
let startedKey = ''; // hash+startedAt of the currently-playing source

function audioContext() {
	try {
		if (!ctx) ctx = ensureAudioContext();
		return ctx;
	} catch {
		return null;
	}
}

function effectiveGain() {
	const shared = get(music).volume ?? 0.8;
	const local = get(musicMuted) ? 0 : get(musicLocalVolume) ?? 1;
	return shared * local;
}

/** @param {string} hash */
async function ensureBuffer(hash) {
	if (bufferHash === hash && buffer) return;
	if (decoding) return;
	const item = itemByHash(hash);
	if (!item) {
		requestAsset(hash); // pull once; the reconciler retries next tick
		return;
	}
	decoding = true;
	try {
		const blob = await itemBlob(item.id);
		const context = audioContext();
		if (blob && context) {
			buffer = await context.decodeAudioData(await blob.arrayBuffer());
			bufferHash = hash;
		}
	} catch (error) {
		console.log('music decode failed', error);
	}
	decoding = false;
}

function stopSource() {
	try {
		source?.stop();
	} catch {}
	source?.disconnect();
	source = null;
	startedKey = '';
}

/** @param {any} state */
function startSource(state) {
	const context = audioContext();
	if (!context || !buffer) return;
	stopSource();
	if (!gain) {
		gain = context.createGain();
		gain.connect(context.destination);
	}
	gain.gain.value = effectiveGain();
	const src = context.createBufferSource();
	src.buffer = buffer;
	src.loop = true;
	src.connect(gain);
	// synced phase: everyone starts inside the same loop cycle
	const offset = ((Date.now() - (state.startedAt || Date.now())) / 1000) % buffer.duration;
	src.start(0, Math.max(0, offset));
	source = src;
	startedKey = state.hash + '|' + state.startedAt;
}

/** Reconcile the audio graph to the shared+local state. Runs on a 500ms timer so
 * it also recovers when the suspended context resumes after the first gesture. */
function reconcile() {
	const state = get(music);
	const context = audioContext();
	if (context && context.state === 'suspended') {
		context.resume().catch(() => {});
		musicBlocked.set(true);
	} else {
		musicBlocked.set(false);
	}
	if (!state.hash || !state.playing) {
		if (source) stopSource();
		return;
	}
	if (bufferHash !== state.hash || !buffer) {
		ensureBuffer(state.hash);
		return;
	}
	const key = state.hash + '|' + state.startedAt;
	if (!source || startedKey !== key) {
		if (context && context.state === 'running') startSource(state);
		return;
	}
	if (gain) gain.gain.value = effectiveGain(); // volume changes without a restart
}

// ---- replication (latest-wins singleton, mirrors environment) --------------

/** Apply a change locally + replicate. @param {any} partial */
export function commitMusic(partial) {
	const state = { ...get(music), ...partial, changedAt: Date.now() };
	music.set(state);
	reconcile();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'music', ...state });
}

/** Set (or clear) the shared track by content hash; pushes the bytes to peers.
 * @param {string|null} hash @param {string} name */
export function setMusicTrack(hash, name = '') {
	commitMusic({ hash, name, playing: !!hash, startedAt: hash ? Date.now() : 0 });
	if (hash) sendAsset(hash);
}

/** Transport: play (restarts the synced phase) / stop. @param {boolean} playing */
export function setMusicPlaying(playing) {
	commitMusic({ playing, startedAt: playing ? Date.now() : get(music).startedAt });
}

/** Shared volume (0..1) — adjusts gain without restarting. @param {number} v */
export function setMusicVolume(v) {
	commitMusic({ volume: Math.max(0, Math.min(1, v)) });
}

/** Remote/handshake apply: newest change wins (env pattern). @param {any} data */
export function applyRemoteMusic(data) {
	if ((data?.changedAt ?? 0) <= (get(music).changedAt ?? 0)) return;
	music.set({
		hash: data.hash ?? null,
		name: data.name ?? '',
		volume: data.volume ?? 0.8,
		playing: !!data.playing,
		startedAt: data.startedAt ?? 0,
		changedAt: data.changedAt
	});
	reconcile();
}

/** Handshake payload (singleton: like environmentState). */
export function musicState() {
	return { type: 'music', ...get(music) };
}

let started = false;
export function startSceneMusic() {
	if (started || typeof window === 'undefined') return;
	started = true;
	musicLocalVolume.subscribe((v) => {
		try {
			localStorage.setItem('musicLocalVolume', String(v));
		} catch {}
		reconcile();
	});
	musicMuted.subscribe((v) => {
		try {
			localStorage.setItem('musicMuted', String(v));
		} catch {}
		reconcile();
	});
	setInterval(reconcile, 500);
}

/** test/debug view of the live music chain */
export function musicDebug() {
	const state = get(music);
	const offset = buffer && state.startedAt ? ((Date.now() - state.startedAt) / 1000) % buffer.duration : 0;
	return {
		hash: state.hash,
		playing: state.playing,
		startedAt: state.startedAt,
		buffered: !!buffer,
		sourceLive: !!source,
		effectiveGain: effectiveGain(),
		offset
	};
}
