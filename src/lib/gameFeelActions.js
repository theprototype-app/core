// 30b (core-games): GAME FEEL AS FLOW NODES. 30b-vr-play gave MODULES the game-feel kit
// (api.playSound's procedural set, api.music, api.hapticPattern, api.effects.burst,
// api.announce), but the three core games — Towers, Stars Room, Jam Room — are authored as
// FLOW GRAPHS, and a graph had no way to reach any of it: a ring reached could not say so,
// sparkle, chime or buzz. These are the five nodes that close that gap, and this file is
// their runtime half (flowRuntime owns the stamp edge; this owns what happens on it).
//
// THE SYNC MODEL, one rule for all five: every one is LOCAL, acted on by EVERY peer from
// the REPLICATED trigger stamp — the setcamera / storevalue / hudscreen house rule. The
// trigger already travelled, so a banner, a sound, a burst and a buzz happen on each
// device from the same pulse with NO message of their own. A per-player trigger (a
// perPlayer On Click) keeps its pulse on the machine that pressed it, so only that player
// gets the feedback — which composes rather than special-cases.
//
// Haptics and music keep the core's own gate (gameFeel: Interact or Play, silent in Edit),
// because both funnel through the functions that own it (vrControls.hapticPattern,
// gameMusic.playGameMusic). A sound, a banner and a burst are not gated: a spectator in
// the editor watching a peer's round sees the ring light and hears it, like every other
// consequence of a replicated pulse.
//
// Deliberately NOT a leaf in the strict sense: it reaches effectsBurst (which imports
// moduleSDK) and vrControls through PRIMED dynamic imports, the flowRuntime rule — a static
// edge from a module flowRuntime imports into either closes a cycle into history.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalCamera, objectsGroup } from '../stores/sceneStore';
import { playGameSound, isGameSound, GAME_SOUNDS } from './gameSfx';
import { announce } from './gameAnnounce';
import { playGameMusic, stopGameMusic, gameMusicState, MUSIC_PRESET_IDS } from './gameMusic';
import { gameFeelActive } from './gameFeel';
import { HAPTIC_PATTERN_NAMES } from './hapticPatterns';

export { GAME_SOUNDS, MUSIC_PRESET_IDS, HAPTIC_PATTERN_NAMES };
export const BURST_KIND_NAMES = ['sparkle', 'confetti', 'smoke', 'sparks'];

/** the flow node types this file acts for on a trigger's stamp edge */
export const GAME_FEEL_ACTIONS = ['announce', 'gamesound', 'effectburst', 'hapticpulse'];

/** @type {any} */ let burstRef = null;
/** @type {any} */ let vrRef = null;

/** flowRuntime's init: resolve the two primed modules (see the header). */
export function primeGameFeelActions() {
	import('./effectsBurst').then((m) => (burstRef = m));
	import('./vrControls').then((m) => (vrRef = m));
}

/** what each node type did — the suites' view (no headset, no ears) */
const debug = {
	/** @type {Record<string, number>} */ fired: {},
	/** per sound name, so a suite can count coins among the clicks @type {Record<string, number>} */ sounds: {},
	/** @type {any[]} */ last: [],
	musicOwner: /** @type {string | null} */ (null),
	musicStarts: 0,
	musicStops: 0
};

/**
 * Put a wired number into a text: every `{v}` becomes the value, `decimals` places (a
 * non-number passes through as text). PURE — the hudtext format rule, so an author who
 * knows one knows the other.
 * @param {string} text @param {any} value @param {number} [decimals]
 * @returns {string}
 */
export function fillValue(text, value, decimals = 0) {
	const s = String(text ?? '');
	if (!s.includes('{v}')) return s;
	const n = Number(value);
	const d = Math.max(0, Math.min(6, Math.round(Number(decimals) || 0)));
	const shown = value === undefined || value === null || value === '' ? '' : Number.isFinite(n) ? n.toFixed(d) : String(value);
	return s.split('{v}').join(shown);
}

/** a named object's world position, or null @param {any} uuid @returns {number[] | null} */
function worldPositionOf(uuid) {
	if (typeof uuid !== 'string' || !uuid) return null;
	const object = get(objectsGroup)?.getObjectByProperty?.('uuid', uuid);
	if (!object) return null;
	object.updateWorldMatrix(true, false);
	const p = object.getWorldPosition(new THREE.Vector3());
	return [p.x, p.y, p.z];
}

/** a point `metres` in front of the viewer's eyes at eye height — where a banner-sized
 * burst belongs when nothing names a place (the confetti at a round's end) */
function inFrontOfPlayer(metres = 1.6) {
	/** @type {any} */
	const camera = get(globalCamera);
	if (!camera?.getWorldPosition) return null;
	camera.updateMatrixWorld?.(true);
	const eye = camera.getWorldPosition(new THREE.Vector3());
	const dir = camera.getWorldDirection(new THREE.Vector3());
	dir.y = Math.max(-0.2, Math.min(0.2, dir.y));
	dir.normalize();
	const p = eye.addScaledVector(dir, metres);
	return [p.x, p.y, p.z];
}

/** @param {string} type @param {any} what */
function note(type, what) {
	debug.fired[type] = (debug.fired[type] ?? 0) + 1;
	debug.last.push({ type, ...what, at: Date.now() });
	if (debug.last.length > 120) debug.last.shift();
}

/**
 * ONE stamp edge of a game-feel action node, already past flowRuntime's freshness and
 * staleness checks. `data` is the node's resolved inputs.
 * @param {string} type @param {any} data
 * @returns {boolean} whether it did something
 */
export function runGameFeelAction(type, data) {
	if (type === 'announce') {
		const text = fillValue(data.text ?? '', data.value, data.decimals);
		const sub = fillValue(data.sub ?? '', data.value, data.decimals);
		const id = announce(text, { sub, ms: Number(data.seconds ?? 1.8) * 1000, color: data.color || undefined });
		if (id) note(type, { text, sub });
		return id > 0;
	}
	if (type === 'gamesound') {
		const name = String(data.sound ?? 'click');
		if (!isGameSound(name)) return false;
		const at = worldPositionOf(data.at);
		const ok = playGameSound(name, at);
		debug.sounds[name] = (debug.sounds[name] ?? 0) + 1;
		note(type, { sound: name, spatial: !!at, played: ok });
		return ok;
	}
	if (type === 'effectburst') {
		const at = worldPositionOf(data.at);
		const lift = Number(data.lift ?? 0) || 0;
		const where = at ? [at[0], at[1] + lift, at[2]] : inFrontOfPlayer();
		if (!where || !burstRef) return false;
		const kind = BURST_KIND_NAMES.includes(data.kind) ? data.kind : 'sparkle';
		const count = Number(data.count);
		const name = burstRef.burst(where, {
			kind,
			...(typeof data.color === 'string' && data.color ? { color: data.color } : {}),
			...(Number.isFinite(count) && count > 0 ? { count } : {})
		});
		note(type, { kind, where, fired: !!name });
		return !!name;
	}
	if (type === 'hapticpulse') {
		const pattern = String(data.pattern ?? 'tap');
		const hand = data.hand === 'left' || data.hand === 'right' ? data.hand : undefined;
		// gated inside (silent in Edit, the user's rule) — the count still says we asked
		const ok = vrRef?.hapticPattern?.(pattern, hand) ?? false;
		note(type, { pattern, hand: hand ?? 'both', felt: !!ok });
		return !!ok;
	}
	return false;
}

/**
 * Which Game Music node wants to play right now — PURE (the stores stay in the caller), so
 * the rule is unit-tested: the FIRST node in graph order whose `on` is not false (unwired
 * = on) and whose `while` allows the shell's state ('round' = playing or paused), with a
 * known preset. @param {any[]} nodes @param {(node: any) => any} resolve
 * @param {string} gameStateName @returns {{id: string, preset: string, volume: number} | null}
 */
export function musicWanted(nodes, resolve, gameStateName) {
	for (const node of nodes) {
		if (node?.type !== 'gamemusic') continue;
		const data = resolve(node) ?? {};
		if (data.on === false || data.on === 0) continue;
		const during = data.while ?? 'always';
		if (during === 'round' && gameStateName !== 'playing' && gameStateName !== 'paused') continue;
		const preset = String(data.preset ?? '');
		if (!MUSIC_PRESET_IDS.includes(preset)) continue;
		const v = Number(data.volume);
		return { id: node.id, preset, volume: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7 };
	}
	return null;
}

/**
 * THE MUSIC NODE is a DECLARATION, not an action (the Character Controller's shape): a
 * Game Music node that WANTS to play — its `on` input true or unwired, and during a round
 * when `while` says so — plays its preset while this device is in Interact or Play, and
 * stops when nothing wants it. Level-triggered, so leaving and re-entering Interact brings
 * the music back with no pulse, and a late joiner hears it the moment it arrives.
 * The FIRST wanting node in graph order wins; music a MODULE started is never stopped
 * here (we stop only what we started).
 * @param {any[]} nodes every flow node @param {(node: any) => any} resolve resolved inputs
 * @param {string} gameStateName the shell's state ('menu' | 'playing' | ...)
 */
export function updateGameMusicNodes(nodes, resolve, gameStateName) {
	const want = musicWanted(nodes, resolve, gameStateName);
	const playing = get(gameMusicState);
	if (want && gameFeelActive()) {
		if (!playing || playing.preset !== want.preset || Math.abs((playing.volume ?? 1) - want.volume) > 1e-3) {
			// a preset someone else started is left alone unless we are the owner already
			if (playing && debug.musicOwner === null) return;
			if (playGameMusic(want.preset, { volume: want.volume })) {
				if (!playing || playing.preset !== want.preset) debug.musicStarts++;
				debug.musicOwner = want.id;
			}
		}
		return;
	}
	if (debug.musicOwner !== null) {
		if (playing) {
			stopGameMusic();
			debug.musicStops++;
		}
		debug.musicOwner = null;
	}
}

/** the suites' view @returns {any} */
export function gameFeelActionsDebug() {
	return { fired: { ...debug.fired }, sounds: { ...debug.sounds }, last: debug.last.map((e) => ({ ...e })), musicOwner: debug.musicOwner, musicStarts: debug.musicStarts, musicStops: debug.musicStops };
}

/** forget the counters (a suite section's clean slate) */
export function resetGameFeelActionsDebug() {
	debug.fired = {};
	debug.sounds = {};
	debug.last = [];
	debug.musicStarts = 0;
	debug.musicStops = 0;
}
