import { writable, get } from 'svelte/store';

// 21-E5: THE GAMEPAD LEAF — the standard-mapping table plus this device's preferences.
//
// A deliberate LEAF (svelte/store and nothing else), because three modules that must
// never import each other all need the same two facts: inputRuntime polls the pad,
// nodeCatalog names its buttons in a picker, and PointerLockControls/HudLayer read the
// prefs. inputRuntime already sits on the history-cycle family's edge (it imports
// shortcuts, which reaches history), so nodeCatalog reaching the button list THROUGH
// inputRuntime would have closed a fresh cycle for the sake of one array.
//
// The prefs are LOCAL — the viewPrefs/gridSettings/cameraClip family: never replicated,
// never serialized into a snapshot. Which stick I hold in which hand, how far my sticks
// drift at rest and how fast I like to turn are facts about MY hardware and my taste, so
// a peer has no business receiving them. (A game that needs a SHARED axis routes it
// through the E6 controller/possess authority, which is authoritative by design —
// golden rule 8: never stream local state.)
//
// THE MAPPING OVERRIDE RULE, stated once here because every consumer needs to know it:
// what these prefs configure is the DEFAULT mapping — the NO-NODES case, so that a pad
// works in a scene nobody authored for a pad. E6's controller nodes override it per
// game; when a game binds its own sticks, the default mapping is what it replaces.

/**
 * The standard mapping's button INDEX -> our code name. Index-ordered, so the poll can
 * walk it directly (`navigator.getGamepads()` reports `buttons[i]` in this order for any
 * pad whose `mapping` is 'standard').
 *
 * Codes are namespaced `Gamepad*` on purpose: they travel the SAME positional listener
 * channel as keyboard codes — `fn('down'|'up', code)` — so the HUD ring, the flow runtime
 * and any module subscribe ONCE and get both devices. No `KeyboardEvent.code` can ever
 * read 'GamepadA', so a Key Press node can never be fired by a pad and vice versa.
 * @type {string[]}
 */
export const GAMEPAD_BUTTONS = [
	'GamepadA',
	'GamepadB',
	'GamepadX',
	'GamepadY',
	'GamepadL1',
	'GamepadR1',
	'GamepadL2',
	'GamepadR2',
	'GamepadSelect',
	'GamepadStart',
	'GamepadL3',
	'GamepadR3',
	'GamepadUp',
	'GamepadDown',
	'GamepadLeft',
	'GamepadRight'
];

/** The four stick axes the app reads, in `pad.axes` index order. @type {string[]} */
export const GAMEPAD_AXES = ['lx', 'ly', 'rx', 'ry'];

const KEY = 'gamepadPrefs';

export const DEFAULT_GAMEPAD_PREFS = {
	/** master switch — off means no edges published, no default mapping, no pad ring */
	enabled: true,
	/** invert the LOOK stick's vertical axis (the flight-stick taste) */
	invertY: false,
	/** stick drift ignored at rest; the remaining range is RESCALED, so there is no jump */
	deadzone: 0.15,
	/** look rate multiplier */
	lookSensitivity: 1,
	/** swap the roles: the RIGHT stick moves and the LEFT stick looks */
	swapSticks: false
};

/** @type {{min: number, max: number}} */
export const DEADZONE_RANGE = { min: 0.05, max: 0.4 };
/** @type {{min: number, max: number}} */
export const SENSITIVITY_RANGE = { min: 0.5, max: 3 };

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

/**
 * Fold an unknown payload onto the defaults. Runs at every store boundary (the
 * normalizeScenePost rule), so a hand-edited localStorage entry or an older payload
 * missing a key cannot put an out-of-range number in front of the camera maths.
 * @param {any} raw
 * @returns {typeof DEFAULT_GAMEPAD_PREFS}
 */
export function normalizeGamepadPrefs(raw) {
	const value = raw && typeof raw === 'object' ? raw : {};
	const deadzone = Number(value.deadzone);
	const sensitivity = Number(value.lookSensitivity);
	return {
		enabled: value.enabled !== false,
		invertY: !!value.invertY,
		deadzone: Number.isFinite(deadzone)
			? clamp(deadzone, DEADZONE_RANGE.min, DEADZONE_RANGE.max)
			: DEFAULT_GAMEPAD_PREFS.deadzone,
		lookSensitivity: Number.isFinite(sensitivity)
			? clamp(sensitivity, SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max)
			: DEFAULT_GAMEPAD_PREFS.lookSensitivity,
		swapSticks: !!value.swapSticks
	};
}

function load() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
		return normalizeGamepadPrefs(raw ? JSON.parse(raw) : {});
	} catch {
		return { ...DEFAULT_GAMEPAD_PREFS };
	}
}

/** @type {import('svelte/store').Writable<typeof DEFAULT_GAMEPAD_PREFS>} */
export const gamepadPrefs = writable(load());

gamepadPrefs.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(value));
});

/** @param {Partial<typeof DEFAULT_GAMEPAD_PREFS>} patch */
export function setGamepadPrefs(patch) {
	gamepadPrefs.update((value) => normalizeGamepadPrefs({ ...value, ...patch }));
}

export function resetGamepadPrefs() {
	gamepadPrefs.set({ ...DEFAULT_GAMEPAD_PREFS });
}

/** The prefs without a subscription — for the per-frame poll. */
export function gamepadPrefsNow() {
	return get(gamepadPrefs);
}

/**
 * A stick reading with the dead centre removed AND the remaining range RESCALED back to
 * 0..1, so crossing the threshold does not jump: at deadzone 0.15 a raw 0.15 reads 0 and
 * a raw 1 still reads 1. A plain gate would step from 0 to 0.15 the moment the stick
 * moves, which reads as a twitchy pad rather than a dead centre.
 * @param {number} value raw axis, -1..1
 * @param {number} deadzone
 */
export function applyDeadzone(value, deadzone) {
	const raw = Number.isFinite(value) ? value : 0;
	const dz = clamp(Number.isFinite(deadzone) ? deadzone : 0, 0, 0.95);
	const size = Math.abs(raw);
	if (size <= dz) return 0;
	const scaled = (size - dz) / (1 - dz);
	return raw < 0 ? -scaled : scaled;
}
