import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

// 36 U8: ON-SCREEN ACTION BUTTONS FOR TOUCH SCREENS — the leaf that owns what a phone
// player can press, where the buttons sit, and what pressing one does.
//
// W4 (touchControls.js) gave a phone a move stick and a look drag; this adds the BUTTONS
// a game needs (jump, fire, interact, …) and makes the whole overlay customisable. Same
// leaf discipline: svelte/store + safeStorage only, so the overlay, the layout editor, the
// settings section, the game shell and the module SDK can all reach it without a cycle.
//
// WHERE BUTTONS COME FROM — the game's INPUT ACTIONS, in this order:
//   1. a module DECLARES them (`api.input.actions([...], {preset})`, lifecycle-tracked —
//      the built-in games do this on their activation edge, like `api.game.setHelp`);
//   2. otherwise the SCENE implies them: a Character Controller in walk mode means a
//      jump, fly mode means up/down, and every Key Press node's key that the stick does
//      not already cover becomes a labelled key button.
// A preset picks the frame around the buttons: platformer = stick + jump, shooter =
// stick + look + fire + jump, toss/golf = the action alone (the whole screen looks).
//
// WHAT A PRESS DOES — no second input pipeline, the W4 integration rule one step on. A
// button that names `keys` dispatches the same KeyboardEvent a keyboard would, on the
// document, so PointerLockControls' jump, the input runtime (Key Press nodes, api.onInput,
// held-key re-stamps) and a module's own key listener all see it with no list of
// consumers to keep. A `pointer` action dispatches the primary press at the crosshair on
// the canvas (fire = press/hold, interact = tap). A module's own `onPress`/`onRelease`
// runs first when it gave one (Target Toss's charge-and-throw).

/* ------------------------------------------------------------------ catalog ---- */

/**
 * @typedef {object} TouchAction
 * @property {string} id
 * @property {string} label
 * @property {string} icon       a TOUCH_ICONS key ('' = the label is drawn instead)
 * @property {string[]} keys     KeyboardEvent codes dispatched while held
 * @property {'' | 'press' | 'tap'} pointer  a primary press at the crosshair
 * @property {(() => void) | null} onPress
 * @property {(() => void) | null} onRelease
 * @property {string} owner      module id, '' = core / the scene
 */

/** The built-in actions a declaration may name by id alone. */
export const BUILTIN_ACTIONS = /** @type {Record<string, {label: string, icon: string, keys?: string[], pointer?: 'press' | 'tap'}>} */ ({
	jump: { label: 'Jump', icon: 'jump', keys: ['Space'] },
	fire: { label: 'Fire', icon: 'fire', pointer: 'press' },
	interact: { label: 'Use', icon: 'interact', pointer: 'tap' },
	crouch: { label: 'Crouch', icon: 'crouch', keys: ['KeyC'] },
	sprint: { label: 'Sprint', icon: 'sprint', keys: ['ShiftLeft'] },
	reload: { label: 'Reload', icon: 'reload', keys: ['KeyR'] },
	up: { label: 'Up', icon: 'up', keys: ['KeyQ'] },
	down: { label: 'Down', icon: 'down', keys: ['KeyE'] }
});

/**
 * The frame around the buttons. `stick` = the move stick (left half), `look` = the look
 * drag (right half, or the whole screen when there is no stick), `buttons` = built-in
 * action ids added unless a declaration already covers them.
 */
export const TOUCH_PRESETS = /** @type {Record<string, {stick: boolean, look: boolean, buttons: string[]}>} */ ({
	platformer: { stick: true, look: true, buttons: ['jump'] },
	shooter: { stick: true, look: true, buttons: ['fire', 'jump'] },
	toss: { stick: false, look: true, buttons: ['fire'] },
	golf: { stick: false, look: true, buttons: ['fire'] },
	fly: { stick: true, look: true, buttons: ['up', 'down'] },
	explore: { stick: true, look: true, buttons: [] },
	custom: { stick: true, look: true, buttons: [] }
});

/** keys the move stick and look drag already stand for — never a key button of their own */
const MOVEMENT_CODES = new Set([
	'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'
]);
/** caps: a phone is small, and a scene with forty Key Press nodes is not forty buttons */
export const MAX_KEY_BUTTONS = 6;
export const MAX_BUTTONS = 8;

/** A key code as a button reads it. @param {string} code */
export function keyLabel(code) {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
	if (code === 'Space') return 'Space';
	if (/^Shift/.test(code)) return 'Shift';
	if (/^Control/.test(code)) return 'Ctrl';
	if (/^Alt/.test(code)) return 'Alt';
	if (code === 'Enter' || code === 'NumpadEnter') return 'Enter';
	return code.length > 6 ? code.slice(0, 6) : code;
}

/** @param {any} value @param {number} max */
function text(value, max) {
	return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * One declared action, checked. A bare string is a built-in id. Anything unknown with
 * nothing to do (no keys, no pointer, no handler) is dropped rather than drawn dead.
 * @param {any} raw @param {string} owner @returns {TouchAction | null}
 */
export function normalizeAction(raw, owner = '') {
	const spec = typeof raw === 'string' ? { id: raw } : raw;
	if (!spec || typeof spec !== 'object') return null;
	const id = text(spec.id, 32).replace(/[^\w:-]/g, '');
	if (!id) return null;
	const base = BUILTIN_ACTIONS[id];
	const keys = Array.isArray(spec.keys)
		? spec.keys.filter((/** @type {any} */ k) => typeof k === 'string' && /^[A-Za-z0-9]{2,24}$/.test(k)).slice(0, 3)
		: base?.keys ?? [];
	const pointer = spec.pointer === 'press' || spec.pointer === 'tap' ? spec.pointer : spec.keys || spec.onPress ? '' : base?.pointer ?? '';
	const onPress = typeof spec.onPress === 'function' ? spec.onPress : null;
	const onRelease = typeof spec.onRelease === 'function' ? spec.onRelease : null;
	if (!keys.length && !pointer && !onPress && !onRelease) return null;
	return {
		id,
		label: text(spec.label, 24) || base?.label || keyLabel(keys[0] ?? id),
		icon: typeof spec.icon === 'string' ? spec.icon : base?.icon ?? '',
		keys,
		pointer,
		onPress,
		onRelease,
		owner
	};
}

/* ------------------------------------------------------------- declarations ---- */

/**
 * @typedef {{owner: string, actions: TouchAction[], preset: string, stick?: boolean, look?: boolean, at: number}} TouchDeclaration
 */

/** every live declaration, newest last @type {import('svelte/store').Writable<TouchDeclaration[]>} */
export const touchDeclarations = writable([]);
let declareSeq = 0;

/**
 * Declare a module's touch actions (api.input.actions). Re-declaring from the same owner
 * REPLACES its set, so a game that calls it on every activation edge keeps one entry.
 * @param {string} owner
 * @param {any[]} actions built-in ids or `{id, label?, icon?, keys?, pointer?, onPress?, onRelease?}`
 * @param {{preset?: string, stick?: boolean, look?: boolean}} [opts]
 * @returns {() => void} off
 */
export function declareTouchActions(owner, actions, opts = {}) {
	const list = (Array.isArray(actions) ? actions : [])
		.map((a) => normalizeAction(a, owner))
		.filter((a) => !!a)
		.slice(0, MAX_BUTTONS);
	const preset = typeof opts?.preset === 'string' && TOUCH_PRESETS[opts.preset] ? opts.preset : '';
	/** @type {TouchDeclaration} */
	const entry = { owner, actions: /** @type {TouchAction[]} */ (list), preset, at: ++declareSeq };
	if (typeof opts?.stick === 'boolean') entry.stick = opts.stick;
	if (typeof opts?.look === 'boolean') entry.look = opts.look;
	touchDeclarations.update((all) => [...all.filter((d) => d.owner !== owner), entry]);
	return () => touchDeclarations.update((all) => all.filter((d) => d !== entry));
}

/* --------------------------------------------------------------- resolution ---- */

/**
 * @typedef {{stick: boolean, look: boolean, preset: string, actions: TouchAction[]}} TouchControlsSpec
 */

/**
 * What the overlay draws for this scene, PURE (the unit layer drives it).
 * @param {{declared?: TouchDeclaration[], walk?: boolean, fly?: boolean, keyCodes?: string[]}} input
 * @returns {TouchControlsSpec}
 */
export function resolveTouchControls({ declared = [], walk = false, fly = false, keyCodes = [] } = {}) {
	/** @type {TouchAction[]} */
	const actions = [];
	const add = (/** @type {TouchAction | null} */ a) => {
		if (a && !actions.some((x) => x.id === a.id) && actions.length < MAX_BUTTONS) actions.push(a);
	};
	const withPreset = [...declared].reverse().find((d) => d.preset);
	let preset = withPreset?.preset || (declared.length ? 'custom' : walk ? 'platformer' : fly ? 'fly' : 'explore');
	const frame = TOUCH_PRESETS[preset] ?? TOUCH_PRESETS.custom;
	let stick = frame.stick;
	let look = frame.look;
	for (const d of declared) {
		if (typeof d.stick === 'boolean') stick = d.stick;
		if (typeof d.look === 'boolean') look = d.look;
		for (const a of d.actions) add(a);
	}
	for (const id of frame.buttons) add(normalizeAction(id));
	if (!declared.length) {
		// the scene's own keys: every Key Press node the stick does not stand for
		const covered = new Set(actions.flatMap((a) => a.keys));
		let keyButtons = 0;
		for (const code of keyCodes) {
			if (keyButtons >= MAX_KEY_BUTTONS) break;
			if (typeof code !== 'string' || !code || MOVEMENT_CODES.has(code) || covered.has(code)) continue;
			covered.add(code);
			keyButtons++;
			add(normalizeAction({ id: 'key:' + code, label: keyLabel(code), icon: '', keys: [code] }));
		}
	}
	return { stick, look, preset, actions };
}

/* ------------------------------------------------------------------- prefs ---- */

/**
 * @typedef {object} TouchPrefs
 * @property {'auto' | 'always' | 'never'} visibility  auto = `(pointer: coarse)` or a touch seen
 * @property {boolean} showInEdit  draw the buttons in Edit/Interact too (never the stick)
 * @property {boolean} haptics     a short navigator.vibrate tick on press
 * @property {'game' | 'global'} scope  where "Edit layout" saves: this game, or every game
 */

const PREFS_KEY = 'touchControlsPrefs';
/** @type {TouchPrefs} */
export const DEFAULT_TOUCH_PREFS = { visibility: 'auto', showInEdit: false, haptics: true, scope: 'game' };

/** @param {any} raw @returns {TouchPrefs} */
export function coerceTouchPrefs(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	return {
		visibility: ['auto', 'always', 'never'].includes(r.visibility) ? r.visibility : DEFAULT_TOUCH_PREFS.visibility,
		showInEdit: typeof r.showInEdit === 'boolean' ? r.showInEdit : DEFAULT_TOUCH_PREFS.showInEdit,
		haptics: typeof r.haptics === 'boolean' ? r.haptics : DEFAULT_TOUCH_PREFS.haptics,
		scope: r.scope === 'global' ? 'global' : 'game'
	};
}

/** @param {string} key */
function readJson(key) {
	try {
		const raw = safeStorage.getItem(key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}
/** @param {string} key @param {any} value */
function writeJson(key, value) {
	try {
		safeStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* safeStorage already keeps it in memory for the session */
	}
}

/** LOCAL prefs (the gamepadPrefs family): a fact about this device and this hand. */
export const touchPrefs = writable(coerceTouchPrefs(readJson(PREFS_KEY)));
/** @param {Partial<TouchPrefs>} patch */
export function setTouchPrefs(patch) {
	const next = coerceTouchPrefs({ ...get(touchPrefs), ...patch });
	touchPrefs.set(next);
	writeJson(PREFS_KEY, next);
}

/** A touch has landed on this device this session — 'auto' then shows the controls even
 * where the media query says the pointer is fine (a touchscreen laptop). */
export const touchSeen = writable(false);

/**
 * Does this device want the touch overlay at all? PURE.
 * @param {TouchPrefs['visibility']} visibility @param {boolean} coarse @param {boolean} seen
 */
export function touchWanted(visibility, coarse, seen) {
	if (visibility === 'never') return false;
	if (visibility === 'always') return true;
	return coarse || seen;
}

/* ------------------------------------------------------------------ layouts ---- */

/**
 * One placed control: its CENTRE as a fraction of the viewport (so a fold/unfold keeps
 * the arrangement), its diameter in CSS px, and its opacity.
 * @typedef {{x: number, y: number, size: number, opacity: number, hidden?: boolean}} TouchItem
 * @typedef {{v: 1, items: Record<string, TouchItem>}} TouchLayout
 */

const LAYOUTS_KEY = 'touchControlsLayouts';
export const TOUCH_SIZE_RANGE = { min: 40, max: 200 };
export const TOUCH_OPACITY_RANGE = { min: 0.15, max: 1 };
export const DEFAULT_OPACITY = 0.7;
/** the stick's default diameter — twice touchControls' TOUCH_STICK_RADIUS, so W4's feel is unchanged */
export const DEFAULT_STICK_SIZE = 128;

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** @param {any} raw @returns {TouchItem | null} */
export function coerceTouchItem(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const x = Number(raw.x);
	const y = Number(raw.y);
	const size = Number(raw.size);
	if (![x, y, size].every(Number.isFinite)) return null;
	/** @type {TouchItem} */
	const item = {
		x: clamp(x, 0, 1),
		y: clamp(y, 0, 1),
		size: clamp(Math.round(size), TOUCH_SIZE_RANGE.min, TOUCH_SIZE_RANGE.max),
		opacity: clamp(Number.isFinite(Number(raw.opacity)) ? Number(raw.opacity) : DEFAULT_OPACITY, TOUCH_OPACITY_RANGE.min, TOUCH_OPACITY_RANGE.max)
	};
	if (raw.hidden === true) item.hidden = true;
	return item;
}

/** @param {any} raw @returns {TouchLayout | null} */
export function coerceTouchLayout(raw) {
	if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') return null;
	/** @type {Record<string, TouchItem>} */
	const items = {};
	for (const [id, value] of Object.entries(raw.items).slice(0, 40)) {
		const item = coerceTouchItem(value);
		if (item && /^[\w:-]{1,40}$/.test(id)) items[id] = item;
	}
	return { v: 1, items };
}

/** @typedef {{global: TouchLayout | null, games: Record<string, TouchLayout>}} TouchLayoutStore */

/** @param {any} raw @returns {TouchLayoutStore} */
function coerceLayoutStore(raw) {
	/** @type {TouchLayoutStore} */
	const out = { global: null, games: {} };
	if (!raw || typeof raw !== 'object') return out;
	out.global = coerceTouchLayout(raw.global);
	if (raw.games && typeof raw.games === 'object')
		for (const [id, layout] of Object.entries(raw.games).slice(0, 100)) {
			const l = coerceTouchLayout(layout);
			if (l) out.games[String(id).slice(0, 80)] = l;
		}
	return out;
}

/** Saved layouts, per device (safeStorage): one global, one per game id. */
export const touchLayouts = writable(coerceLayoutStore(readJson(LAYOUTS_KEY)));

/**
 * The saved layout that applies to a game, or null (= the default arrangement). A game's
 * own layout wins over the global one, whichever scope is being EDITED.
 * @param {TouchLayoutStore} store @param {string} gameId
 */
export function savedLayoutFor(store, gameId) {
	return store.games[gameId] ?? store.global ?? null;
}

/**
 * Save a layout for a game (scope 'game') or for every game (scope 'global').
 * @param {TouchLayout} layout @param {'game' | 'global'} scope @param {string} gameId
 */
export function saveTouchLayout(layout, scope, gameId) {
	const clean = coerceTouchLayout(layout);
	if (!clean) return;
	touchLayouts.update((store) => {
		const next = { global: store.global, games: { ...store.games } };
		if (scope === 'global') next.global = clean;
		else next.games[gameId] = clean;
		writeJson(LAYOUTS_KEY, next);
		return next;
	});
}

/**
 * Back to the default arrangement for a scope (a game reset also drops back to the global
 * layout when there is one). @param {'game' | 'global'} scope @param {string} gameId
 */
export function resetTouchLayout(scope, gameId) {
	touchLayouts.update((store) => {
		const next = { global: store.global, games: { ...store.games } };
		if (scope === 'global') next.global = null;
		else delete next.games[gameId];
		writeJson(LAYOUTS_KEY, next);
		return next;
	});
}

/**
 * The default arrangement for a spec at a viewport size: the stick bottom-left, the
 * primary action bottom-right (largest), the rest on an arc around it — the thumb rest
 * every mobile shooter uses. Positions come out as fractions.
 * @param {TouchControlsSpec} spec @param {number} w @param {number} h
 * @returns {TouchLayout}
 */
export function defaultTouchLayout(spec, w, h) {
	const W = Math.max(200, w);
	const H = Math.max(200, h);
	const margin = 20;
	/** @type {Record<string, TouchItem>} */
	const items = {};
	const at = (/** @type {number} */ px, /** @type {number} */ py, /** @type {number} */ size) => ({
		x: clamp(px / W, 0, 1),
		y: clamp(py / H, 0, 1),
		size,
		opacity: DEFAULT_OPACITY
	});
	const stickSize = DEFAULT_STICK_SIZE;
	items.stick = at(margin + stickSize / 2 + 8, H - margin - stickSize / 2 - 24, stickSize);
	const primary = 76;
	const secondary = 58;
	const px = W - margin - primary / 2 - 8;
	const py = H - margin - primary / 2 - 24;
	// arc slots around the primary: left, up-left, up, then a row further left
	const arc = [
		[-1, 0],
		[-0.72, -0.72],
		[0, -1],
		[-1.9, 0.05],
		[-1.6, -0.95],
		[-0.75, -1.75],
		[-2.6, -0.6]
	];
	const radius = primary / 2 + secondary / 2 + 14;
	spec.actions.forEach((a, i) => {
		if (i === 0) {
			items['btn:' + a.id] = at(px, py, primary);
			return;
		}
		const [dx, dy] = arc[(i - 1) % arc.length];
		items['btn:' + a.id] = at(px + dx * radius, py + dy * radius, secondary);
	});
	return { v: 1, items };
}

/**
 * The layout the overlay draws: the default arrangement with the saved one laid over it,
 * item by item — a control the saved layout never placed (a new action) gets its default
 * slot instead of vanishing. @param {TouchControlsSpec} spec @param {TouchLayout | null} saved
 * @param {number} w @param {number} h @returns {TouchLayout}
 */
export function effectiveTouchLayout(spec, saved, w, h) {
	const base = defaultTouchLayout(spec, w, h);
	if (!saved) return base;
	/** @type {Record<string, TouchItem>} */
	const items = {};
	for (const [id, item] of Object.entries(base.items)) items[id] = saved.items[id] ? { ...saved.items[id] } : item;
	return { v: 1, items };
}

/* ----------------------------------------------------------------- textures ---- */

/**
 * Per-action look: an image for each state (data: URLs — uploaded PNG/SVG or an Explorer
 * image, kept on this device), a tint for the built-in icon, and the icon's scale.
 * @typedef {{released?: string, pressed?: string, tint?: string, scale?: number}} TouchTexture
 */

const TEXTURES_KEY = 'touchControlsTextures';
/** a data: URL bigger than this is refused — localStorage is ~5 MB for the whole app */
export const MAX_TEXTURE_BYTES = 160 * 1024;
export const TEXTURE_SCALE_RANGE = { min: 0.5, max: 1.6 };

/** @param {any} url */
function okImageUrl(url) {
	return typeof url === 'string' && /^data:image\/(png|svg\+xml|jpeg|webp|gif)[;,]/.test(url) && url.length <= MAX_TEXTURE_BYTES * 1.4;
}

/** @param {any} raw @returns {TouchTexture | null} */
export function coerceTexture(raw) {
	if (!raw || typeof raw !== 'object') return null;
	/** @type {TouchTexture} */
	const t = {};
	if (okImageUrl(raw.released)) t.released = raw.released;
	if (okImageUrl(raw.pressed)) t.pressed = raw.pressed;
	if (typeof raw.tint === 'string' && /^#[0-9a-f]{6}$/i.test(raw.tint)) t.tint = raw.tint;
	const s = Number(raw.scale);
	if (Number.isFinite(s) && s !== 1) t.scale = clamp(s, TEXTURE_SCALE_RANGE.min, TEXTURE_SCALE_RANGE.max);
	return Object.keys(t).length ? t : null;
}

/** @param {any} raw @returns {Record<string, TouchTexture>} */
function coerceTextures(raw) {
	/** @type {Record<string, TouchTexture>} */
	const out = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [id, value] of Object.entries(raw).slice(0, 40)) {
		const t = coerceTexture(value);
		if (t && /^[\w:-]{1,40}$/.test(id)) out[id] = t;
	}
	return out;
}

/** Button looks by action id, per device. */
export const touchTextures = writable(coerceTextures(readJson(TEXTURES_KEY)));

/** Merge into one action's look (undefined / '' clears a field). @param {string} id @param {Partial<TouchTexture>} patch */
export function setTouchTexture(id, patch) {
	touchTextures.update((all) => {
		/** @type {any} */
		const merged = { ...(all[id] ?? {}), ...patch };
		for (const k of Object.keys(merged)) if (merged[k] === undefined || merged[k] === '') delete merged[k];
		const next = { ...all };
		const t = coerceTexture(merged);
		if (t) next[id] = t;
		else delete next[id];
		writeJson(TEXTURES_KEY, next);
		return next;
	});
}

/** @param {string} id */
export function clearTouchTexture(id) {
	setTouchTexture(id, { released: undefined, pressed: undefined, tint: undefined, scale: undefined });
}

/* ------------------------------------------------------------------ presses ---- */

/** marks every event this file dispatches, so the overlay never reads its own press as a
 * stick or a look gesture */
export const TOUCH_ACTION_EVENT = '__tpTouchAction';

/** what is held right now, by action id → the action (released on hide, menu, blur) */
/** @type {Map<string, TouchAction>} */
const held = new Map();
/** observable for the overlay and the suites */
export const touchHeld = writable(/** @type {string[]} */ ([]));
const publishHeld = () => touchHeld.set([...held.keys()]);

/** the suites' counters */
const debug = { presses: 0, releases: 0, keyEvents: 0, pointerEvents: 0, handlerErrors: 0, vibrates: 0 };

/** @param {'keydown' | 'keyup'} type @param {string} code */
function dispatchKey(type, code) {
	if (typeof document === 'undefined') return;
	const key = code === 'Space' ? ' ' : /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit/.test(code) ? code.slice(5) : code.replace(/(Left|Right)$/, '');
	/** @type {any} */
	const event = new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true });
	event[TOUCH_ACTION_EVENT] = true;
	document.dispatchEvent(event);
	debug.keyEvents++;
}

/** @param {Element | null} canvas @param {string[]} types @param {'mouse' | 'touch'} pointerType */
function dispatchPointer(canvas, types, pointerType) {
	if (!canvas || typeof window === 'undefined') return;
	const rect = canvas.getBoundingClientRect();
	const clientX = rect.left + rect.width / 2;
	const clientY = rect.top + rect.height / 2;
	for (const type of types) {
		const init = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, buttons: type.endsWith('down') ? 1 : 0 };
		/** @type {any} */
		const event =
			type.startsWith('pointer') && typeof PointerEvent === 'function'
				? new PointerEvent(type, { ...init, pointerType, pointerId: 7301, isPrimary: false })
				: new MouseEvent(type, init);
		event[TOUCH_ACTION_EVENT] = true;
		canvas.dispatchEvent(event);
		debug.pointerEvents++;
	}
}

/** @param {() => void} fn */
function safely(fn) {
	try {
		fn();
	} catch (error) {
		debug.handlerErrors++;
		console.log('touch action handler failed', error);
	}
}

/**
 * A button went down or up. Idempotent per edge (a second down while held does nothing),
 * which is what keeps a jittering finger from double-jumping.
 * @param {TouchAction} action @param {boolean} down
 * @param {{canvas?: Element | null, haptics?: boolean}} [ctx]
 */
export function pressTouchAction(action, down, ctx = {}) {
	if (!action) return;
	if (down) {
		if (held.has(action.id)) return;
		held.set(action.id, action);
		debug.presses++;
		if (ctx.haptics && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
			try {
				navigator.vibrate(12);
				debug.vibrates++;
			} catch {
				/* a permissions policy may forbid it — the tick is a nicety */
			}
		}
		if (action.onPress) safely(/** @type {() => void} */ (action.onPress));
		for (const code of action.keys) dispatchKey('keydown', code);
		if (action.pointer === 'press') dispatchPointer(ctx.canvas ?? null, ['pointerdown', 'mousedown'], 'mouse');
		// a TAP is the whole click at once, and as 'touch' so playInteract never starts a
		// carry from it (its own W4 rule)
		if (action.pointer === 'tap') dispatchPointer(ctx.canvas ?? null, ['pointerdown', 'pointerup', 'click'], 'touch');
	} else {
		if (!held.has(action.id)) return;
		held.delete(action.id);
		debug.releases++;
		for (const code of action.keys) dispatchKey('keyup', code);
		if (action.pointer === 'press') dispatchPointer(ctx.canvas ?? null, ['pointerup', 'mouseup', 'click'], 'mouse');
		if (action.onRelease) safely(/** @type {() => void} */ (action.onRelease));
	}
	publishHeld();
}

/**
 * Release everything held — the quietPad discipline: a button left down because play
 * ended, a menu opened or the overlay hid would hold a key forever.
 * @param {{canvas?: Element | null}} [ctx]
 */
export function releaseAllTouchActions(ctx = {}) {
	for (const action of [...held.values()]) pressTouchAction(action, false, ctx);
}

/* ------------------------------------------------------------ editor opener ---- */

/** the layout editor overlay is open (Settings ▸ Touch controls ▸ Edit layout, or the pause menu) */
export const touchLayoutEditorOpen = writable(false);
export function openTouchLayoutEditor() {
	touchLayoutEditorOpen.set(true);
}
export function closeTouchLayoutEditor() {
	touchLayoutEditorOpen.set(false);
}

/** test/debug view */
export function touchActionsDebug() {
	return {
		...debug,
		held: [...held.keys()],
		declarations: get(touchDeclarations).map((d) => ({ owner: d.owner, preset: d.preset, actions: d.actions.map((a) => a.id) })),
		prefs: get(touchPrefs),
		layouts: get(touchLayouts),
		textures: Object.keys(get(touchTextures)),
		seen: get(touchSeen),
		editorOpen: get(touchLayoutEditorOpen)
	};
}
