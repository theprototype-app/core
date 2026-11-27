// Roadmap 104 C2 — `show`, the pure half (a LEAF: imports only the panelsCore leaf). showTool.js drives the interface.
//
// `show` acts on the screen of the person the assistant acts for, and nobody else's: it has no peer
// argument at all. Its eight safety rules (scout report row 7c) and where each one lives:
//   1 own tab only; headless agent pages do not get the tool        (personTools.js / tpAgent)
//   2 a deny-list: never sign-in, consent, Publish, Connected apps, account, payment surfaces   panelsCore BLOCKED / blockedReason()
//   3 the first use of each kind asks once (Always / This time / No), stored per device          showTool.js + SHOW_KINDS
//   4 every action leaves a line the person can act on: "Claude moved your view · Back"          showTool.js
//   5 no camera move in a headset (this release)                                                 showTool.js
//   6 reduced motion: an instant cut (flyTo's motionMs)                                           objectActions.flyTo
//   7 6 calls a minute, one camera move per 2 s, refused while the person drags or types          SHOW_PER_MINUTE / CAMERA_GAP_MS
//   8 editing text stays files {write}: show {code} only opens, goes to a line and highlights     (no text argument)

import { PANELS, panelOf, deniedPanel, normalName, blockedReason, BLOCKED } from './panelsCore.js';

/** the kinds the person is asked about, once each */
export const SHOW_KINDS = /** @type {const} */ (['panel', 'camera', 'code']);
export const SHOW_PER_MINUTE = 6;
export const CAMERA_GAP_MS = 2000;
export const FLY_MS = 600;

/** 107: the actions that ride an existing kind's first-use answer (no new question) */
export const MORE_KIND = /** @type {Record<string, string>} */ ({ reveal: 'panel', select: 'panel', flow: 'panel' });

/** what the first-use question says, per kind — 107-int: also what Settings ▸ Privacy lists (uiStateCore.GRANT_WORDS is
 * this object), so the question and the list always name the same kinds in the same words */
export const KIND_WORDS = /** @type {Record<string, string>} */ ({
	panel: 'open and close your panels and select things in them',
	camera: 'move your view',
	code: 'open code for you'
});

// 107-panels: the panels, their names and the refused surfaces live in ONE registry (panelsCore.js, also a
// leaf); these are the names show always exported, kept so every reader keeps working.
export { panelOf, deniedPanel, normalName, blockedReason };

/**
 * The panels `show` may open, close or bring forward, by id: `key` is the app's own key (panelToggles /
 * dockHost), `via` how it opens, `label` its title.
 * @type {Record<string, {key: string, label: string, via: string, readOnly?: boolean}>}
 */
export const SHOW_PANELS = Object.fromEntries(PANELS.map((p) => [p.id, { key: p.key, label: p.title, via: p.via, ...(p.readOnly ? { readOnly: true } : {}) }]));

/** surfaces `show` never opens or presses (rule 2), by their names */
export const DENIED = BLOCKED.flatMap((b) => [b.title, ...(b.aliases ?? [])].map(normalName));

/**
 * Where the camera goes to frame a box, keeping the view direction (objectActions.focusObject's
 * framing): `dir` points from the target to the camera.
 * @param {{center: number[], radius: number}} box @param {number} fovDeg @param {number[]} dir unit vector
 * @returns {{position: number[], target: number[], distance: number}}
 */
export function frameBox(box, fovDeg, dir) {
	const fov = (Math.max(10, Math.min(120, Number(fovDeg) || 50)) * Math.PI) / 180;
	const radius = Math.max(0.5, Number(box.radius) || 0.5);
	const distance = Math.max(1, Math.min(200, (radius / Math.tan(fov / 2)) * 1.2));
	const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
	const d = [dir[0] / len, dir[1] / len, dir[2] / len];
	const c = box.center;
	return { position: [c[0] + d[0] * distance, c[1] + d[1] * distance, c[2] + d[2] * distance], target: [c[0], c[1], c[2]], distance };
}

/** @param {any} v @returns {v is number[]} */
export const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * Where `find` text is in a document: the first hit's [line, col] range (1-based lines, 0-based
 * columns), or null.
 * @param {string} text @param {string} find @param {number} [fromLine]
 * @returns {{from: [number, number], to: [number, number]} | null}
 */
export function findRange(text, find, fromLine = 1) {
	const needle = String(find ?? '');
	if (!needle) return null;
	const lines = String(text ?? '').split('\n');
	const start = Math.max(1, Math.floor(fromLine) || 1);
	for (let pass = 0; pass < 2; pass++) {
		const lo = pass === 0 ? start : 1;
		const hi = pass === 0 ? lines.length : start - 1;
		for (let n = lo; n <= hi; n++) {
			const col = lines[n - 1].indexOf(needle);
			if (col >= 0 && !needle.includes('\n')) return { from: [n, col], to: [n, col + needle.length] };
		}
	}
	// a multi-line needle: search the whole text
	const at = String(text ?? '').indexOf(needle);
	if (at < 0) return null;
	const before = String(text).slice(0, at).split('\n');
	const inside = needle.split('\n');
	const fromL = before.length;
	const fromC = before[before.length - 1].length;
	const toL = fromL + inside.length - 1;
	const toC = inside.length === 1 ? fromC + needle.length : inside[inside.length - 1].length;
	return { from: [fromL, fromC], to: [toL, toC] };
}
