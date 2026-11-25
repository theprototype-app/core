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
// 53 (A6): the Game Sound node's caption line
import { captionSound } from './captions';
import { playGameMusic, stopGameMusic, gameMusicState, MUSIC_PRESET_IDS } from './gameMusic';
import { gameFeelActive, gameFeelOn } from './gameFeel';
import { HAPTIC_PATTERN_NAMES } from './hapticPatterns';

export { GAME_SOUNDS, MUSIC_PRESET_IDS, HAPTIC_PATTERN_NAMES };
export const BURST_KIND_NAMES = ['sparkle', 'confetti', 'smoke', 'sparks'];

/** the flow node types this file acts for on a trigger's stamp edge */
export const GAME_FEEL_ACTIONS = ['announce', 'gamesound', 'effectburst', 'hapticpulse'];

/** @type {any} */ let burstRef = null;
/** @type {any} */ let vrRef = null;

/** 103 (H6): the vibration output layer — LAZY (not in the boot bundle): fetched the first time this
 * device enters Interact / Play, or on the first buzz asked for before that @type {any} */
let hapticRef = null;
/** @type {Promise<any> | null} */
let hapticLoad = null;
const loadHaptics = () => (hapticLoad ??= import('./hapticOutput').then((m) => (hapticRef = m)));

/** 103 (H6): the output layer itself, loaded on demand (the suites' handle) @returns {Promise<any>} */
export const hapticOutputModule = () => loadHaptics();

/** flowRuntime's init: resolve the two primed modules (see the header). */
export function primeGameFeelActions() {
	import('./effectsBurst').then((m) => (burstRef = m));
	import('./vrControls').then((m) => (vrRef = m));
	gameFeelOn.subscribe((on) => {
		if (on) loadHaptics();
	});
}

/**
 * 103 (H6): buzz THIS device (the caller already decided it is the right one). A pattern name or a
 * custom {strength, ms}; `scale` sizes a pattern. false outside Interact / Play.
 * @param {string | {strength?: number, ms?: number}} spec @param {{hand?: 'left' | 'right', scale?: number}} [opts]
 * @returns {boolean}
 */
export function vibrateHere(spec, opts = {}) {
	if (!gameFeelActive()) return false;
	if (hapticRef) return hapticRef.playHaptic(spec, opts);
	loadHaptics().then((m) => m.playHaptic(spec, opts));
	return true;
}

/**
 * 103 (H6): the Vibrate node's stamp edge, past flowRuntime's `who` gate. PURE over its data apart
 * from the buzz itself. @param {any} data @returns {boolean}
 */
export function runVibrate(data) {
	const n = Number(data?.strength);
	const strength = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
	const hand = data?.hand === 'left' || data?.hand === 'right' ? data.hand : undefined;
	const pattern = String(data?.pattern ?? 'bump');
	const ok = pattern === 'custom' ? vibrateHere({ strength, ms: Number(data?.ms ?? 120) }, { hand }) : vibrateHere(pattern, { hand, scale: strength });
	note('vibrate', { pattern, strength, hand: hand ?? 'both', felt: !!ok });
	return ok;
}

/**
 * 103 (H6): the DEFAULT feel that goes with a game-feel effect (#580's Camera Shake, Screen Flash,
 * Hit Pause) — played where the effect plays, unless the node's `vibrate` is off. PURE mapping:
 * a shake rumbles for its length at its strength, a hit pause is a `hit`, a flash a light `tap`.
 * @param {string} type @param {any} data
 * @returns {{spec: string | {strength: number, ms: number}, scale?: number} | null}
 */
export function feelVibration(type, data) {
	if (data?.vibrate === false) return null;
	const num = (/** @type {any} */ v, /** @type {number} */ d) => (Number.isFinite(Number(v)) ? Number(v) : d);
	if (type === 'camerashake') {
		const s = Math.min(1, Math.max(0, num(data?.strength, 0.15)));
		return { spec: { strength: Math.round(Math.min(1, 0.35 + 1.3 * s) * 1000) / 1000, ms: Math.min(1000, Math.max(40, num(data?.seconds, 0.35) * 1000)) } };
	}
	if (type === 'hitpause') return { spec: 'hit', scale: Math.min(1, 0.5 + num(data?.ms, 80) / 400) };
	if (type === 'screenflash') return { spec: 'tap', scale: 1 + Math.min(1, Math.max(0, num(data?.strength, 0.6))) };
	return null;
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

/** a named object's world position, or null. 31: a PLACE ([x, y, z] in the objects group's
 * frame — the clap's point) is carried into world space the same way.
 * @param {any} uuid @returns {number[] | null} */
function worldPositionOf(uuid) {
	if (Array.isArray(uuid) && uuid.length >= 3 && uuid.slice(0, 3).every((v) => Number.isFinite(Number(v)))) {
		const group = get(objectsGroup);
		const p = new THREE.Vector3(Number(uuid[0]), Number(uuid[1]), Number(uuid[2]));
		if (group) {
			group.updateWorldMatrix(true, false);
			group.localToWorld(p);
		}
		return [p.x, p.y, p.z];
	}
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
 * staleness checks. `data` is the node's resolved inputs; `node` (78 F14) names the console
 * line's source.
 * @param {string} type @param {any} data @param {any} [node]
 * @returns {boolean} whether it did something
 */
export function runGameFeelAction(type, data, node) {
	if (type === 'announce') {
		const text = fillValue(data.text ?? '', data.value, data.decimals);
		const sub = fillValue(data.sub ?? '', data.value, data.decimals);
		const label = typeof node?.data?.label === 'string' && node.data.label.trim() ? node.data.label.trim() : 'Announce';
		const source = node?.id ? { kind: 'node', nodeId: node.id, label, graph: node.__graph ?? 'scene' } : undefined;
		const id = announce(text, { sub, ms: Number(data.seconds ?? 1.8) * 1000, color: data.color || undefined, source });
		if (id) note(type, { text, sub });
		return id > 0;
	}
	if (type === 'gamesound') {
		const name = String(data.sound ?? 'click');
		if (!isGameSound(name)) return false;
		const at = worldPositionOf(data.at);
		// 53 (A6): captioned whether or not this player has the sound on (a deaf player may mute it)
		captionSound(data.caption, { source: 'gamesound', sound: name });
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
			// 33 (L4): only the track a node started (owner '' = core)
			stopGameMusic('');
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
