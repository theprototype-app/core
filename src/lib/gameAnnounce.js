// 30b (vr-play) — `api.announce(text, {sub, ms, color})`: a BIG centred banner for a
// game's moments — "GOAL!", "Level 3", "Ring 2 reached". The user, on Towers: "When I
// reach some of the rings and go to the top, it should dynamically tell me".
//
// A LEAF holding one store; two renderers read it — HudLayer on the desktop (DOM) and the
// VR game panel's head-locked banner in a headset (DOM is invisible there). LOCAL: nothing
// is sent (a module announces on the peer that saw the moment, or broadcasts its own op).
// A new announcement REPLACES the one showing — a banner queue would still be showing
// "Ring 1" when the player reached ring 3.
import { writable, get } from 'svelte/store';

/** @typedef {{id: number, text: string, sub: string, color: string, ms: number, at: number}} Announcement */

/** the banner on screen, or null @type {import('svelte/store').Writable<Announcement | null>} */
export const gameAnnouncement = writable(null);

const DEFAULT_MS = 1800;
const MAX_MS = 15000;
let nextId = 1;
/** @type {any} */
let timer = null;

/**
 * Show a banner. Returns its id (0 for empty text). `ms` is clamped to 300..15000.
 * @param {string} text @param {{sub?: string, ms?: number, color?: string}} [options]
 * @returns {number}
 */
export function announce(text, options = {}) {
	const line = String(text ?? '').trim().slice(0, 80);
	if (!line) return 0;
	const raw = Number(options?.ms);
	const ms = Number.isFinite(raw) ? Math.min(MAX_MS, Math.max(300, raw)) : DEFAULT_MS;
	const color = typeof options?.color === 'string' && /^#?[0-9a-z(),.% -]{3,40}$/i.test(options.color) ? options.color : '#ffd76a';
	const id = nextId++;
	gameAnnouncement.set({ id, text: line, sub: String(options?.sub ?? '').slice(0, 120), color, ms, at: Date.now() });
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
