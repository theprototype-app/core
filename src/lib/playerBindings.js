// 53 (A6) — WHAT A PLAYER CAN REMAP: the game's own key and pad bindings, read off the scene.
// The walker's keys (W A S D, Space — PointerLockControls, every game played on a keyboard), every
// Key Press node's key and every Gamepad Button node's button, one row per code (two nodes on one
// key are one binding: they always fire together). A node's optional `action` text ("Jump",
// "Open the door") is what the row says; without one it says which key it is.
//
// Module bindings are display-only strings in Settings ▸ Shortcuts (inputRuntime.registerBindings)
// with no codes to remap, so they are not listed — a module that reads keys through
// api.onInput / api.input still hears the remapped codes.
//
// A LEAF: the flow store + the pure core.
import { allNodes } from '../stores/flowStore';
import { codeLabel } from './playerAccessCore';
import { PAD_ACTIONS } from './playActions.js'; // 92-input GC3 (a leaf)

/** @typedef {{code: string, label: string}} PlayerBinding */

/** the walker's keys, in the order a player expects them */
export const WALKER_KEYS = [
	{ code: 'KeyW', label: 'Move forward' },
	{ code: 'KeyS', label: 'Move back' },
	{ code: 'KeyA', label: 'Move left' },
	{ code: 'KeyD', label: 'Move right' },
	{ code: 'Space', label: 'Jump' }
];

/**
 * Rows for a list of {code, action} pairs, merged per code. Pure (exported for the suites).
 * @param {{code: string, action?: string}[]} pairs @param {PlayerBinding[]} [base]
 * @returns {PlayerBinding[]}
 */
export function mergeBindings(pairs, base = []) {
	/** @type {Map<string, string[]>} */
	const labels = new Map(base.map((b) => [b.code, [b.label]]));
	for (const { code, action } of pairs) {
		if (!code) continue;
		const list = labels.get(code) ?? [];
		const text = String(action ?? '').trim().slice(0, 40);
		if (text && !list.includes(text)) list.push(text);
		labels.set(code, list);
	}
	return [...labels.entries()].map(([code, list]) => ({ code, label: list.length ? list.join(' · ') : 'Key ' + codeLabel(code) }));
}

/** The game's keyboard bindings. @returns {PlayerBinding[]} */
export function gameKeyBindings() {
	const pairs = allNodes()
		.filter((n) => n?.type === 'keypress' && typeof n.data?.code === 'string')
		.map((n) => ({ code: String(n.data.code), action: n.data?.action }));
	return mergeBindings(pairs, WALKER_KEYS);
}

/** The game's gamepad bindings (Gamepad Button nodes). @returns {PlayerBinding[]} */
export function gamePadBindings() {
	const pairs = allNodes()
		.filter((n) => n?.type === 'gamepadbutton' && typeof n.data?.button === 'string')
		.map((n) => ({ code: String(n.data.button), action: n.data?.action }));
	// 92-input GC3: the built-in pad actions are bindings too (Jump on A …); a Gamepad Button node on the same
	// button shares the row (the bridge stands down for it, so the row says what the game made of it)
	const base = PAD_ACTIONS.map((a) => ({ code: a.pad, label: a.label }));
	const nodeCodes = new Set(pairs.map((p) => p.code));
	const merged = mergeBindings(pairs, base.filter((b) => !nodeCodes.has(b.code)));
	return merged.map((b) => (b.label.startsWith('Key ') ? { ...b, label: 'Button ' + codeLabel(b.code) } : b));
}
