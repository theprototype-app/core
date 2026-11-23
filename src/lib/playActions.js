// 92-input GC3 — THE PLAY ACTIONS ON A PAD, the lazy half: how each pad family prints a button, its glyph,
// the help lines. Loaded with the first pad (padActions.js) or the first glyph (InputGlyph.svelte); the device
// itself is activeDevice.js (boot). Leaves only.
//
// A pad press of a built-in action does what that action's TOUCH button does (touchActions: the same
// synthetic key, or the same press at the crosshair), so the walker's jump, Key Press nodes, Player
// code, playInteract and modules all hear it with no second input path. The pad codes are GAME codes:
// the player's pad remap (53 A6, inputRuntime.pollGamepads) has already turned the physical button
// into the code the game listens for, so remapping Jump to B is one row like any other.
import { setPadLines, setPadFamilyOf } from './activeDevice.js';

/**
 * The built-in actions on a standard-mapping pad, in the order the remap rows list them.
 * `keys` = the keyboard codes the press sends, `pointer` = a press at the crosshair (touchActions).
 * @type {{id: string, label: string, pad: string, keys?: string[], pointer?: 'press' | 'tap'}[]}
 */
export const PAD_ACTIONS = [
	{ id: 'jump', label: 'Jump', pad: 'GamepadA', keys: ['Space'] },
	{ id: 'interact', label: 'Use / click', pad: 'GamepadX', pointer: 'tap' },
	{ id: 'fire', label: 'Fire', pad: 'GamepadR2', pointer: 'press' },
	{ id: 'grab', label: 'Grab and carry', pad: 'GamepadL2', pointer: 'press' },
	{ id: 'crouch', label: 'Crouch', pad: 'GamepadB', keys: ['KeyC'] },
	{ id: 'sprint', label: 'Sprint', pad: 'GamepadL3', keys: ['ShiftLeft'] },
	{ id: 'reload', label: 'Reload', pad: 'GamepadY', keys: ['KeyR'] },
	// E rises and Q sinks — PointerLockControls' and the touch buttons' own convention
	{ id: 'up', label: 'Fly up', pad: 'GamepadR1', keys: ['KeyE'] },
	{ id: 'down', label: 'Fly down', pad: 'GamepadL1', keys: ['KeyQ'] },
	// the pause menu (or leaving Play when the scene is no game) — Escape's job on a keyboard
	{ id: 'menu', label: 'Menu', pad: 'GamepadStart', keys: ['Escape'] }
];

/**
 * Which pad family a Gamepad `id` belongs to — it decides the face-button glyphs. Pure.
 * USB vendor ids: 045e Microsoft, 054c Sony, 057e Nintendo; names as a fallback (the id string is
 * "Name (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)" on Chromium, "054c-0ce6-Name" on Firefox).
 * @param {any} id @returns {'xbox' | 'playstation' | 'nintendo' | 'generic'}
 */
export function padFamily(id) {
	const s = String(id ?? '').toLowerCase();
	if (/054c|dualsense|dualshock|playstation/.test(s)) return 'playstation';
	if (/057e|nintendo|pro controller|joy-con/.test(s)) return 'nintendo';
	if (/045e|xbox|xinput|microsoft/.test(s)) return 'xbox';
	return 'generic';
}


/**
 * The game code a HUD key hint stands for: its `code` field, else its typed key name when that names a
 * key (E -> KeyE, Space, Esc, Shift, 1 -> Digit1, A pad button by name: "Gamepad A" / "GamepadA"), else
 * null (the hint shows its text as typed, as before). Pure. @param {any} code @param {any} keyName
 * @returns {string | null}
 */
export function hintCodeOf(code, keyName) {
	const c = String(code ?? '').trim();
	if (/^(Key[A-Z]|Digit\d|Gamepad[A-Za-z0-9]+|Space|Escape|Enter|Tab|Shift(Left|Right)|Control(Left|Right)|Arrow(Up|Down|Left|Right))$/.test(c)) return c;
	const n = String(keyName ?? '').trim();
	if (/^[A-Za-z]$/.test(n)) return 'Key' + n.toUpperCase();
	if (/^\d$/.test(n)) return 'Digit' + n;
	const named = /** @type {Record<string, string>} */ ({ space: 'Space', esc: 'Escape', escape: 'Escape', enter: 'Enter', shift: 'ShiftLeft', ctrl: 'ControlLeft', tab: 'Tab' });
	if (named[n.toLowerCase()]) return named[n.toLowerCase()];
	const pad = n.replace(/\s+/g, '');
	if (/^Gamepad[A-Za-z0-9]+$/.test(pad)) return pad;
	return null;
}

/** the stick halves, for the help lines and the rows a player reads (not remappable buttons) */
export const PAD_STICKS = { move: 'left stick', look: 'right stick' };

/** game key code -> the pad button the same action sits on (Space -> GamepadA …) */
export const PAD_FOR_KEY = /** @type {Record<string, string>} */ (
	Object.fromEntries(PAD_ACTIONS.flatMap((a) => (a.keys ?? []).map((k) => [k, a.pad])))
);

/** face / shoulder / menu buttons as each family prints them (generic = the Xbox letters, the
 * standard mapping's own names). Nintendo swaps the letters: the BOTTOM button is B. */
const NAMES = /** @type {Record<string, Record<string, string>>} */ ({
	xbox: { GamepadA: 'A', GamepadB: 'B', GamepadX: 'X', GamepadY: 'Y', GamepadL1: 'LB', GamepadR1: 'RB', GamepadL2: 'LT', GamepadR2: 'RT', GamepadSelect: 'View', GamepadStart: 'Menu', GamepadL3: 'LS', GamepadR3: 'RS' },
	playstation: { GamepadA: 'Cross', GamepadB: 'Circle', GamepadX: 'Square', GamepadY: 'Triangle', GamepadL1: 'L1', GamepadR1: 'R1', GamepadL2: 'L2', GamepadR2: 'R2', GamepadSelect: 'Create', GamepadStart: 'Options', GamepadL3: 'L3', GamepadR3: 'R3' },
	nintendo: { GamepadA: 'B', GamepadB: 'A', GamepadX: 'Y', GamepadY: 'X', GamepadL1: 'L', GamepadR1: 'R', GamepadL2: 'ZL', GamepadR2: 'ZR', GamepadSelect: 'Minus', GamepadStart: 'Plus', GamepadL3: 'LS', GamepadR3: 'RS' }
});
NAMES.generic = NAMES.xbox;
const DPAD = /** @type {Record<string, string>} */ ({ GamepadUp: 'D-pad up', GamepadDown: 'D-pad down', GamepadLeft: 'D-pad left', GamepadRight: 'D-pad right' });

/**
 * A pad button as the player's own pad prints it. Pure.
 * @param {string} code a Gamepad* code @param {string} [family] @returns {string}
 */
export function padButtonName(code, family = 'generic') {
	return (NAMES[family] ?? NAMES.generic)[code] ?? DPAD[code] ?? String(code).replace(/^Gamepad/, '');
}

/**
 * The glyph a button is drawn with: a face button's SHAPE on a PlayStation pad, else its letter / name.
 * @param {string} code @param {string} [family]
 * @returns {{shape: 'cross' | 'circle' | 'square' | 'triangle' | 'face' | 'shoulder' | 'dpad' | 'stick' | 'menu', text: string, dir?: string}}
 */
export function padGlyph(code, family = 'generic') {
	const text = padButtonName(code, family);
	if (family === 'playstation') {
		const shape = /** @type {Record<string, 'cross' | 'circle' | 'square' | 'triangle'>} */ ({ GamepadA: 'cross', GamepadB: 'circle', GamepadX: 'square', GamepadY: 'triangle' })[code];
		if (shape) return { shape, text };
	}
	if (/^Gamepad[ABXY]$/.test(code)) return { shape: 'face', text };
	if (/^Gamepad[LR][12]$/.test(code)) return { shape: 'shoulder', text };
	if (/^Gamepad[LR]3$/.test(code)) return { shape: 'stick', text };
	if (DPAD[code]) return { shape: 'dpad', text, dir: code.slice(7).toLowerCase() };
	return { shape: 'menu', text };
}

/**
 * The control lines a pad player reads (the pause menu's How to play), named for their pad.
 * @param {string} [family] @returns {string[]}
 */
export function padControlLines(family = 'generic') {
	const n = (/** @type {string} */ c) => padButtonName(c, family);
	return [
		'Move: ' + PAD_STICKS.move + ' · look: ' + PAD_STICKS.look,
		'Jump: ' + n('GamepadA') + ' · use / click: ' + n('GamepadX') + ' · fire: ' + n('GamepadR2'),
		'Menu: ' + n('GamepadStart')
	];
}

// the pause menu's How to play reads the pad lines through activeDevice (gameShell stays free of this chunk)
setPadLines(padControlLines);
setPadFamilyOf(padFamily);
