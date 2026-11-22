// 73 AI9 — WHERE YOUR OWN GLSL RUNS (owner option A, 2026-11-02). A leaf: svelte/store + safeStorage.
//
//   - YOUR code (written on this device, in the shader editor's Your GLSL) runs in your scenes, behind the
//     usual guard (shaderCodeGuard: block list, worker probe, first-frame box, context loss).
//   - An EXPORTED GAME runs its author's code the same way: the person opened that game.
//   - Code that reached you from SOMEONE ELSE (a joined room, a community template, a scene file made
//     elsewhere) must first PASS the worker's first-frame test. When the worker cannot test it (no WebGL2 in
//     workers, a worker that never started) it stays off here with a notice, where your own code would go on
//     to the first-frame box. "Run it anyway" is the person's own choice and marks the hash as trusted.
//   - On QUEST, custom shaders are OFF by default (one GPU hang there can take the whole browser down, the
//     tab and the headset session with it) until "Turn on custom shaders" (Settings ▸ VR ▸ Display). Not
//     even the worker test runs while it is off: the test is itself a GPU draw.
//
// Verdicts are this device's, like the guard's: nothing here touches the document or the wire.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

const MINE_KEY = 'shaderCodeMine';
const QUEST_KEY = 'customShadersQuest';
/** the newest hashes kept; an older one only loses the shortcut, never its document */
const MINE_CAP = 200;

/** @param {string} ua */
export function isQuestUserAgent(ua) {
	return /OculusBrowser|Quest/i.test(String(ua ?? ''));
}

/** Test seam: null = read the user agent. @type {boolean | null} */
let questOverride = null;

/** Is this the Quest browser? */
export function onQuest() {
	if (questOverride !== null) return questOverride;
	return typeof navigator !== 'undefined' && isQuestUserAgent(navigator.userAgent);
}

/** "Turn on custom shaders" on Quest (default off). Elsewhere it changes nothing. */
export const customShadersOnQuest = writable(safeStorage.getItem(QUEST_KEY) === '1');

/** @param {boolean} on */
export function setCustomShadersOnQuest(on) {
	customShadersOnQuest.set(!!on);
	if (on) safeStorage.setItem(QUEST_KEY, '1');
	else safeStorage.removeItem(QUEST_KEY);
}

/** @returns {string[]} */
function readMine() {
	try {
		const v = JSON.parse(safeStorage.getItem(MINE_KEY) ?? '[]');
		return Array.isArray(v) ? v.filter((h) => typeof h === 'string') : [];
	} catch {
		return [];
	}
}

/** hashes written (or chosen to run) on this device */
export const shaderCodeMine = writable(/** @type {string[]} */ (readMine()));

/** This device wrote it, or the person chose to run it. @param {string} hash */
export function markShaderCodeMine(hash) {
	if (!hash) return;
	shaderCodeMine.update((list) => {
		const next = [...list.filter((h) => h !== hash), hash].slice(-MINE_CAP);
		safeStorage.setItem(MINE_KEY, JSON.stringify(next));
		return next;
	});
}

/** @param {string} hash */
export function isShaderCodeMine(hash) {
	return get(shaderCodeMine).includes(hash);
}

export const QUEST_OFF_REASON = 'Custom shaders are off on Quest, because one stuck shader can close the whole browser. Turn them on in Settings ▸ VR ▸ Display.';
export const FOREIGN_UNTESTED_REASON = 'This shader came from someone else and this device could not test it first, so it stays off here.';

/**
 * Before anything (the worker test included): is custom GLSL allowed on this device at all?
 * @returns {{kind: 'quest', reason: string} | null}
 */
export function deviceRefusal() {
	if (onQuest() && !get(customShadersOnQuest)) return { kind: 'quest', reason: QUEST_OFF_REASON };
	return null;
}

/**
 * After the worker test: code from someone else runs only on a PASSED test ('ok'). Your own code and an
 * exported game's go on with 'unavailable' too (the first-frame box still holds).
 * @param {string} hash @param {string} status the probe's status @param {boolean} exported this page is an exported game
 * @returns {{kind: 'foreign', reason: string} | null}
 */
export function reachRefusal(hash, status, exported) {
	if (status === 'ok' || exported || isShaderCodeMine(hash)) return null;
	return { kind: 'foreign', reason: FOREIGN_UNTESTED_REASON };
}

/**
 * 73 AI9 export rule: switch OFF (in place, on the export's own payload copy) every document's GLSL that is
 * not this device's own. The hash/uses helpers are passed in so this stays a leaf.
 * @param {Record<string, any> | undefined} graphs @param {(code: any) => string} hashOf @param {(doc: any) => boolean} uses
 * @returns {number} how many were switched off
 */
export function foreignShaderCodeOff(graphs, hashOf, uses) {
	let off = 0;
	for (const [key, doc] of Object.entries(graphs ?? {})) {
		if (!doc || !uses(doc) || isShaderCodeMine(hashOf(doc.code))) continue;
		/** @type {any} */ (graphs)[key] = { ...doc, code: { ...doc.code, use: false } };
		off++;
	}
	return off;
}

/** hash -> why it is held on this device (the pane's button depends on the kind) @type {import('svelte/store').Writable<Record<string, {kind: 'quest'|'foreign', reason: string}>>} */
export const shaderCodeHeld = writable({});

/** @param {string} hash @param {{kind: 'quest'|'foreign', reason: string}} why */
export function holdShaderCode(hash, why) {
	shaderCodeHeld.update((all) => (all[hash]?.kind === why.kind ? all : { ...all, [hash]: why }));
}

/** @param {string} hash */
export function releaseHeldShaderCode(hash) {
	shaderCodeHeld.update((all) => {
		if (!all[hash]) return all;
		const next = { ...all };
		delete next[hash];
		return next;
	});
}

/** Test seams. */
export const shaderCodeReachForTest = {
	setQuest: (/** @type {boolean | null} */ on) => void (questOverride = on),
	forgetMine: () => {
		shaderCodeMine.set([]);
		safeStorage.removeItem(MINE_KEY);
	},
	held: () => get(shaderCodeHeld)
};
