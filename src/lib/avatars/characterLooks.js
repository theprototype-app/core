// 41 G9: the customise panel's PRESETS, its "Custom" entry and "Surprise me". A LEAF (imports
// the two leaves it reads), so the unit suite covers it with no browser.
//
// A LOOK is the part of an avatar config a preset decides — the body, its head, the hat and the
// two colours. The name label and the ping are the person's own preferences, not part of a
// character, so picking a preset never touches them.
//
// The rules (the user's words: "clicking on predefined characters should show its default
// parameters and if I customized something add option 'custom' and select it"):
//   · a preset IS its defaults: picking one writes every look key;
//   · touching any look parameter afterwards makes the draft a CUSTOM look (kept, selectable,
//     and re-picking a preset resets);
//   · "Surprise me" deals a NEW random look on every press, never the one it dealt last.

import { AVATAR_DEFAULTS } from '../avatarModel';
import { CHARACTERS, HEAD_OPTIONS } from './catalog';

/** the config keys a look owns (everything else in the config is the person's own pref) */
export const LOOK_KEYS = /** @type {const} */ (['character', 'head', 'shape', 'face', 'hat', 'outfit', 'body']);

export const HAT_VALUES = ['none', 'cap', 'tophat', 'crown'];
const SHAPES = HEAD_OPTIONS.filter((o) => o.value !== 'character').map((o) => o.value);

/**
 * The preset list, in picker order: Auto (picked from your id, the default a new user has),
 * every rigged character, then the classic floating head.
 * @returns {{id: string, name: string}[]}
 */
export function presetList() {
	return [{ id: 'auto', name: 'Auto' }, ...CHARACTERS.map((c) => ({ id: c.id, name: c.name })), { id: 'classic', name: 'Classic head' }];
}

/**
 * A preset's defaults: the character with its own head, no hat, its own outfit colours, the
 * default body colour (and, for the classic head, the default sphere).
 * @param {string} id @returns {Record<string, string>}
 */
export function presetLook(id) {
	return {
		character: id,
		head: AVATAR_DEFAULTS.head,
		shape: AVATAR_DEFAULTS.shape,
		face: AVATAR_DEFAULTS.face,
		hat: AVATAR_DEFAULTS.hat,
		outfit: AVATAR_DEFAULTS.outfit,
		body: AVATAR_DEFAULTS.body
	};
}

/** @param {any} config @returns {Record<string, any>} the look keys of a config */
export function lookOf(config) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const k of LOOK_KEYS) out[k] = config?.[k] ?? /** @type {any} */ (AVATAR_DEFAULTS)[k];
	return out;
}

/** colours compare case-insensitively (a colour input reports lower-case hex) @param {any} v */
const norm = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

/** @param {any} a @param {any} b two configs (or looks) show the same character */
export function sameLook(a, b) {
	const la = lookOf(a);
	const lb = lookOf(b);
	return LOOK_KEYS.every((k) => norm(la[k]) === norm(lb[k]));
}

/**
 * Which preset a config IS, or null when it is a custom look (the panel's selected entry).
 * @param {any} config @returns {string | null}
 */
export function presetOf(config) {
	const id = config?.character;
	if (!presetList().some((p) => p.id === id)) return null;
	return sameLook(config, presetLook(id)) ? id : null;
}

/** a stable string for a look (the "never the same twice" comparison, and the e2e's) @param {any} config */
export function lookSignature(config) {
	const l = lookOf(config);
	return LOOK_KEYS.map((k) => `${k}=${norm(l[k])}`).join('|');
}

/** @param {number} h 0..360 @param {number} s 0..1 @param {number} l 0..1 → '#rrggbb' */
function hslHex(h, s, l) {
	const a = s * Math.min(l, 1 - l);
	const f = (/** @type {number} */ n) => {
		const k = (n + h / 30) % 12;
		const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return Math.round(c * 255)
			.toString(16)
			.padStart(2, '0');
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

/** a colour worth wearing: any hue, never washed out or muddy @param {() => number} rand */
function randomColour(rand) {
	return hslHex(rand() * 360, 0.45 + rand() * 0.4, 0.42 + rand() * 0.2);
}

/** @template T @param {T[]} list @param {() => number} rand @returns {T} */
const pick = (list, rand) => list[Math.floor(rand() * list.length) % list.length];

/**
 * A random look — the body, its head, the hat and both colours — that is NOT `previous`.
 * The classic floating head is one of the bodies (about one press in ten).
 * @param {any} [previous] the look on screen now @param {() => number} [rand]
 * @returns {Record<string, string>}
 */
export function randomLook(previous, rand = Math.random) {
	const before = previous ? lookSignature(previous) : '';
	for (let attempt = 0; attempt < 32; attempt++) {
		const classic = rand() < 0.1;
		const character = classic ? 'classic' : pick(CHARACTERS, rand).id;
		const look = {
			character,
			// a rigged body keeps its own head about half the time; the classic head is a shape
			head: classic || rand() < 0.5 ? 'character' : pick(SHAPES, rand),
			shape: classic ? pick(SHAPES, rand) : AVATAR_DEFAULTS.shape,
			face: 'label',
			hat: pick(HAT_VALUES, rand),
			outfit: classic || rand() < 0.2 ? '' : randomColour(rand),
			body: randomColour(rand)
		};
		if (lookSignature(look) !== before) return look;
	}
	// 32 identical deals in a row only happens with a broken generator: nudge the colour
	const prev = lookOf(previous);
	return { ...prev, body: norm(prev.body) === '#000000' ? '#ffffff' : '#000000' };
}
