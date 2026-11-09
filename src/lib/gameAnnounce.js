// 30b (vr-play) — `api.announce(text, {sub, ms, color})`: a BIG centred banner for a
// game's moments — "GOAL!", "Level 3", "Ring 2 reached". The user, on Towers: "When I
// reach some of the rings and go to the top, it should dynamically tell me".
//
// A LEAF holding one store; two renderers read it — HudLayer on the desktop (DOM) and the
// VR game panel's head-locked banner in a headset (DOM is invisible there). LOCAL: nothing
// is sent (a module announces on the peer that saw the moment, or broadcasts its own op).
// A new announcement REPLACES the one showing — a banner queue would still be showing
// "Ring 1" when the player reached ring 3.
//
// 78 F14 — EDIT IS NOT THE GAME. The banner draws only while somebody is PLAYING (Play, an AR
// table playing, a headset); in Edit it flashed full-screen over the floating windows the author
// was building with. Every announcement is also WRITTEN DOWN (`announceLog`, newest last, with its
// time and its source — the node that announced, or a module) and logged to diagnostics, so the
// Debugger panel's Console and the agent's logs/status read it whatever mode it fired in. The
// store above still holds the latest announcement in every mode: the RENDERERS decide.
import { writable, get } from 'svelte/store';
import { isLocked, isVRMode } from '../stores/sceneStore';
import { log } from './diagnostics';

/** @typedef {{id: number, text: string, sub: string, color: string, ms: number, at: number}} Announcement */
/** where an announcement came from: a flow node (its id, label and graph) or a module
 * @typedef {{kind: 'node', nodeId: string, label: string, graph: string} | {kind: 'module', label: string}} AnnounceSource */
/** one console line @typedef {{id: number, at: number, text: string, sub: string, source: AnnounceSource | null, shown: 'banner' | 'console'}} AnnounceLine */

/** how many lines the console keeps */
export const ANNOUNCE_LOG_CAP = 50;
/** the console: what was announced, oldest first (LOCAL) @type {import('svelte/store').Writable<AnnounceLine[]>} */
export const announceLog = writable(/** @type {AnnounceLine[]} */ ([]));
/** lines nobody has looked at yet (the Debugger button's dot); the panel zeroes it */
export const announceUnread = writable(0);

/** @param {any} source @returns {AnnounceSource | null} */
function cleanSource(source) {
	if (!source || typeof source !== 'object') return null;
	if (source.kind === 'module') return { kind: 'module', label: String(source.label ?? 'a module').slice(0, 60) };
	if (typeof source.nodeId === 'string' && source.nodeId)
		return { kind: 'node', nodeId: source.nodeId, label: String(source.label ?? '').slice(0, 60), graph: String(source.graph ?? 'scene') };
	return null;
}

/** the banner on screen, or null @type {import('svelte/store').Writable<Announcement | null>} */
export const gameAnnouncement = writable(null);

const DEFAULT_MS = 1800;
const MAX_MS = 15000;
let nextId = 1;
/** @type {any} */
let timer = null;

/**
 * Show a banner. Returns its id (0 for empty text). `ms` is clamped to 300..15000. `source`
 * (78 F14) names who announced, for the console line.
 * @param {string} text @param {{sub?: string, ms?: number, color?: string, source?: any}} [options]
 * @returns {number}
 */
export function announce(text, options = {}) {
	const line = String(text ?? '').trim().slice(0, 80);
	if (!line) return 0;
	const raw = Number(options?.ms);
	const ms = Number.isFinite(raw) ? Math.min(MAX_MS, Math.max(300, raw)) : DEFAULT_MS;
	const color = typeof options?.color === 'string' && /^#?[0-9a-z(),.% -]{3,40}$/i.test(options.color) ? options.color : '#ffd76a';
	const id = nextId++;
	const sub = String(options?.sub ?? '').slice(0, 120);
	const at = Date.now();
	gameAnnouncement.set({ id, text: line, sub, color, ms, at });
	// 78 F14: written down in every mode; `shown` says whether a banner drew it
	const source = cleanSource(options?.source);
	/** @type {'banner' | 'console'} */
	const shown = get(isLocked) === true || get(isVRMode) === true ? 'banner' : 'console';
	announceLog.update((rows) => [...rows, { id, at, text: line, sub, source, shown }].slice(-ANNOUNCE_LOG_CAP));
	if (shown === 'console') announceUnread.update((n) => n + 1);
	const from = source ? (source.kind === 'node' ? 'node ' + (source.label || source.nodeId) : source.label) : '';
	log('info', 'announce', line + (sub ? ' / ' + sub : ''), { from, shown });
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		if (get(gameAnnouncement)?.id === id) gameAnnouncement.set(null);
	}, ms);
	return id;
}

/** Take the banner down now (a scene clear, leaving the game). */
export function clearAnnouncement() {
	if (timer) clearTimeout(timer);
	timer = null;
	gameAnnouncement.set(null);
}

/** Empty the console (the Debugger's Clear). */
export function clearAnnounceLog() {
	announceLog.set([]);
	announceUnread.set(0);
}
