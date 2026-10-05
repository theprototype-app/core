// 36 U11: WHICH PANEL OWNS THE KEYBOARD. A zero-import leaf (shortcuts, editorNavigation
// and the vitest layer all read it, and shortcuts sits inside history's import family).
//
// The registry used to be ONE window listener for the whole app, so a bare letter meant
// the same thing wherever the user was looking: `C` toggled chat while you typed a node
// name into the Flow pane's canvas, Delete deleted 3D objects only because the node
// editor happened to be CLOSED (and did nothing at all while it was open), and A strafed
// the camera while you meant "frame all" in the graph. A key now fires in the scope that
// has focus — decided by where the last pointer press (or keyboard focus) landed:
//
//   text      an <input>/<textarea>/<select>/contentEditable — the registry never acts
//   code      inside a CodeMirror editor (.cm-editor) — CodeMirror's own keymap acts
//   nodes     inside a [data-key-scope="nodes"] host (the node editor pane)
//   uv / animation / shader / hud   the other editors that mark their pane
//   objects   the Object list ([data-key-scope="objects"]): the scene's own outliner, so
//             the SELECTION rows that name `alsoScopes: ['objects']` (Delete, F, Ctrl+D,
//             Ctrl+A) still act there — nothing else of the viewport does
//   panel     every other panel and tool window (36 F2): Explorer, Inspector, the Flow
//             chrome and a behaviour's Graph view, the Code workspace, the HUD editor's
//             side panes, previews, chat… Only GLOBAL rows act; WASD never flies. A
//             floating window gets it from dragWindow, a docked branch marks its root
//   vr        an immersive session is running (registered by the VR side via a probe)
//   viewport  the 3D canvas and the overlays drawn on it
//
// A host marked `data-key-scope="keep"` (the toolbars, a viewport session's floating
// toolbar) never MOVES the keyboard: pressing the Move button and then F still focuses
// the object from the viewport, and pressing it from the Explorer leaves the Explorer
// in charge. The 1.23 rule — "everything that is not a marked editor is the viewport" —
// is what let W fly the camera while you were in the Explorer (user, 2026-10-05).
//
// A row's `scope` says where it lives; absent (or 'global') = every non-text scope. In
// its own scope a scoped row WINS over a global row with the same combo — Blender's rule
// that a more specific keymap shadows the window keymap.

/** @typedef {'global'|'viewport'|'objects'|'panel'|'nodes'|'code'|'text'|'vr'|'uv'|'animation'|'shader'|'hud'} KeyScope */

/** Display order + human names (the `?` sheet and Settings ▸ Shortcuts group by these). */
export const SCOPE_LABELS = /** @type {Record<string, string>} */ ({
	global: 'Everywhere',
	viewport: '3D viewport',
	mesh: 'Edit Mesh session',
	nodes: 'Node editor',
	code: 'Code editor',
	vr: 'VR',
	uv: 'UV editor',
	animation: 'Animation timeline',
	shader: 'Shader editor',
	hud: 'HUD editor',
	objects: 'Object list',
	panel: 'Panels and tool windows',
	text: 'Text fields'
});

/** @param {string|null|undefined} scope */
export function scopeLabel(scope) {
	return SCOPE_LABELS[scope || 'global'] ?? String(scope);
}

/** @param {any} el */
export function isTextEntry(el) {
	if (!el) return false;
	const tag = el.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

/** <input> types you TYPE into (their own Ctrl+Z is the browser's text undo) */
const TYPING_INPUTS = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

/**
 * Is `el` a field you type into — as opposed to a form CONTROL (slider, checkbox, radio, colour,
 * button, select) that only keeps its own bare keys (arrows, space, letters to pick an option)?
 * @param {any} el
 */
export function isTypingField(el) {
	if (!el) return false;
	if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
	if (el.tagName !== 'INPUT') return false;
	return TYPING_INPUTS.has(String(el.type ?? el.getAttribute?.('type') ?? '').toLowerCase());
}

/**
 * The scope an element belongs to (text entry excluded — that is decided per EVENT,
 * because focus inside a field is a property of the key press, not of the pane).
 * @param {any} el @returns {string}
 */
export function hostScopeOf(el) {
	if (!el || typeof el.closest !== 'function') return 'viewport';
	if (el.closest('.cm-editor')) return 'code';
	const host = el.closest('[data-key-scope]');
	const scope = host && host.getAttribute('data-key-scope');
	// a `keep` host (a toolbar) belongs to nobody: movesScope never lets it take the keys,
	// and a text field inside one is plain text
	return scope && scope !== 'keep' ? scope : 'viewport';
}

let pointerScope = 'viewport';
/** the pane element that holds the keyboard (null = the viewport / unknown) @type {any} */
let pointerHost = null;
/** @type {(() => boolean) | null} */
let vrProbe = null;

/** The scope the last pointer press / focus landed in (not counting text fields). */
export function lastScope() {
	return pointerScope;
}

/** @type {Set<(scope: string) => void>} */
const listeners = new Set();

/** Be told when the focused pane changes (a pane draws its "has the keyboard" ring).
 * @param {(scope: string) => void} fn @returns {() => void} off */
export function onScopeChange(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * Set it directly (tests, and a pane that takes focus programmatically).
 * @param {string} scope @param {any} [host] the pane element, so a CLOSED pane gives the keys back
 */
export function setLastScope(scope, host = null) {
	// 36 S12: the pane that holds the keyboard says so — `data-has-keys` on its host, read by
	// the shared ring (ui.utilities.css); moving between two panels moves the ring
	if (host !== pointerHost) {
		try {
			pointerHost?.removeAttribute?.('data-has-keys');
			host?.setAttribute?.('data-has-keys', '');
		} catch {
			/* a detached host keeps nothing */
		}
	}
	pointerHost = host;
	const next = scope || 'viewport';
	if (next === pointerScope) return;
	pointerScope = next;
	for (const fn of listeners) {
		try {
			fn(next);
		} catch {
			/* a listener never breaks focus tracking */
		}
	}
}

/** The VR side says whether an immersive session is live (no import of vr code here).
 * @param {(() => boolean) | null} probe */
export function setVrScopeProbe(probe) {
	vrProbe = probe;
}

/** Is a pane element still on screen? @param {any} el */
function paneShowing(el) {
	if (!el.isConnected) return false;
	try {
		return typeof el.getClientRects !== 'function' || el.getClientRects().length > 0;
	} catch {
		return true;
	}
}

/**
 * The scope a key event belongs to.
 * @param {{target?: any} | null | undefined} event
 * @returns {string}
 */
export function scopeOfEvent(event) {
	const target = event?.target;
	// 36 S8: a focused form CONTROL keeps its bare keys, but a Ctrl/Cmd combo (undo, redo, save)
	// is the pane's — clicking a checkbox in the Inspector used to leave Ctrl+Z dead
	const control = isTextEntry(target) && !isTypingField(target) && !!(/** @type {any} */ (event)?.ctrlKey || /** @type {any} */ (event)?.metaKey);
	if (isTextEntry(target) && !control) return hostScopeOf(target) === 'code' ? 'code' : 'text';
	if (target && typeof target.closest === 'function' && target.closest('.cm-editor')) return 'code';
	try {
		if (vrProbe && vrProbe()) return 'vr';
	} catch {
		/* a probe that throws is not in VR */
	}
	// the pane that had the keyboard was CLOSED (unmounted, or hidden by its dock/tab
	// group): its keys must not outlive it — the viewport takes them back
	if (pointerHost && !paneShowing(pointerHost)) {
		setLastScope('viewport');
		return 'viewport';
	}
	return pointerScope;
}

/**
 * Does a row of scope `rowScope` hear a key pressed in `focused`?
 * Text and code never reach registry actions: those panes own every key.
 * @param {string|null|undefined} rowScope @param {string} focused
 */
export function scopeHears(rowScope, focused) {
	if (focused === 'text' || focused === 'code') return false;
	return chainOf(focused).includes(rowScope || 'global');
}

/**
 * For the window listeners outside the registry (fly keys, mesh-edit session keys,
 * draw/sculpt/spline/measure sessions): may a press drive the 3D viewport? True in the
 * viewport and in VR; false in a text field, a code editor, or another editor's pane.
 * @param {{target?: any} | null | undefined} event
 */
export function viewportHasKeys(event) {
	const scope = scopeOfEvent(event);
	return scope === 'viewport' || scope === 'vr';
}

/**
 * Pick the row that answers a combo in a scope: the focused scope's own row first, a
 * global row otherwise. `rows` are already filtered to the pressed combo.
 * @template {{scope?: string}} T
 * @param {T[]} rows @param {string} focused @returns {T | null}
 */
export function pickForScope(rows, focused) {
	if (focused === 'text' || focused === 'code') return null;
	for (const scope of chainOf(focused)) {
		const row = rows.find((r) => rowIn(r, scope));
		if (row) return row;
	}
	return null;
}

/**
 * Is a row bound in `scope`? Its own scope, or one it lends itself to (`alsoScopes`: the
 * viewport's selection rows also answer in the Object list).
 * @param {{scope?: string, alsoScopes?: string[]}} row @param {string} scope
 */
export function rowIn(row, scope) {
	return (row.scope || 'global') === scope || !!row.alsoScopes?.includes(scope);
}

/**
 * The scopes a press in `focused` is offered to, most specific first. VR falls back to
 * the viewport's rows: a keyboard used while a headset is on (the emulator, a desk
 * keyboard) keeps meaning what it meant on the desktop.
 * @param {string} focused @returns {string[]}
 */
export function chainOf(focused) {
	if (focused === 'vr') return ['vr', 'viewport', 'global'];
	if (focused === 'global') return ['global'];
	return [focused, 'global'];
}

/**
 * Does a press / focus on this element move the keyboard to another pane? Not when it is a
 * TEXT FIELD (the field decides per event, and leaving it for the same pane must still mean
 * that pane — the node editor's search menu focuses its own filter input) and not inside a
 * TRANSIENT overlay (a context menu, a dialog, a listbox): those are portaled to <body>,
 * so they would read as the viewport, and closing one must hand the keys back to the pane
 * that opened it.
 * @param {any} el
 */
export function movesScope(el) {
	if (!el || typeof el.closest !== 'function') return true;
	// 36 S8: a TYPING field only — a checkbox or slider in the Inspector is a press in the Inspector
	if (isTextEntry(el) && isTypingField(el) && !el.closest('.cm-editor')) return false;
	if (el.closest('[role="menu"], [role="dialog"], [role="listbox"], dialog, [data-key-scope-transient]')) return false;
	// 36 F2: a toolbar is not a place — the keys stay with whoever had them
	if (el.closest('[data-key-scope]')?.getAttribute('data-key-scope') === 'keep') return false;
	return true;
}

let started = false;

/** Track where presses land. Capture phase, so a pane that stops propagation still
 * moves the focus — the scope is about WHERE the user is, not who handled the press. */
export function startKeyScope() {
	if (started || typeof window === 'undefined') return;
	started = true;
	/** @param {Event} event */
	const note = (event) => {
		const target = /** @type {any} */ (event.target);
		if (!movesScope(target)) return;
		const host = typeof target?.closest === 'function' ? target.closest('[data-key-scope]') : null;
		setLastScope(hostScopeOf(target), host);
	};
	window.addEventListener('pointerdown', note, true);
	window.addEventListener('focusin', note, true);
}
