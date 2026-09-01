import { writable, get } from 'svelte/store';
import { anyModalOpen, showToast } from '../stores/appStore';
import { GAMEPAD_BUTTONS, applyDeadzone, gamepadPrefsNow } from './gamepadPrefs';
import { registerShortcut, unregisterShortcutGroup } from './shortcuts';

// Module SDK input layer (K-C). STORE-ONLY module (the peerApproval.js pattern):
// imports nothing from peerHandler/vrControls, so vrControls can feed it VR
// stick axes and the SDK can expose it without closing an import cycle (the
// vite-dev TDZ trap). Modules declare BINDINGS (listed in Settings ▸ Shortcuts),
// poll per-frame input (getInput) or subscribe to down/up events (onInput), and
// CLAIM input scopes so the host stops consuming the same keys/sticks:
//   'keys'       — PointerLockControls WASD + the editor fly-navigation pause
//   'locomotion' — VR left-stick locomotion pauses (modules drive instead)
//
// 21-E5: GAMEPADS publish here too — `pollGamepads()` is driven from flowRuntime's
// per-frame tick (see the seam note on that function), and pad button edges travel the
// SAME positional listener channel as key codes. The three axis channels stay
// DISTINCT: `codes`/`vrAxes` (VR sticks, pushed by vrControls) and `padAxes` are
// separate reads, because a headset and a pad can legitimately both be in play.

/** currently held key codes (event.code, e.g. 'KeyW') */
const codes = new Set();
/** latest VR stick axes, published by vrControls each frame */
const vrAxes = { lx: 0, ly: 0, rx: 0, ry: 0 };
/** latest VR button states, published by vrControls each frame */
const vrButtons = { ltrigger: false, rtrigger: false, lsqueeze: false, rsqueeze: false };
// 21-E5: the gamepad's own channels. `padCodes` is DELIBERATELY not `codes`: that set
// holds KeyboardEvent codes, and a Key Press node matching on it must never be firable
// by a pad (nor a Gamepad Button node by the keyboard).
/** pressed pad buttons, by GAMEPAD_BUTTONS code @type {Set<string>} */
const padCodes = new Set();
/** latest pad stick axes, deadzone already applied */
const padAxes = { lx: 0, ly: 0, rx: 0, ry: 0 };
/** which pad we are reading (`pad.id`), or null — drives connect/disconnect toasts */
/** @type {string | null} */
let padId = null;

/** @type {Set<(kind: 'down'|'up', code: string) => void>} */
const listeners = new Set();

/** Dispatch one edge to every subscriber. ONE copy of the try/catch, and the ONE
 * place that documents the contract: listeners are called POSITIONALLY, fn(kind, code)
 * — reading these off an event OBJECT is what silently broke Key Press until 21-E1.8.
 * @param {'down'|'up'} kind @param {string} code */
function emit(kind, code) {
	listeners.forEach((fn) => {
		try {
			fn(kind, code);
		} catch (error) {
			console.log('input listener failed', error);
		}
	});
}

/** active claims — stores so host consumers can subscribe reactively
 * @type {import('svelte/store').Writable<string[]>} */
export const inputClaims = writable([]);

/** Is a scope currently claimed by any module? @param {'keys'|'locomotion'} scope */
export function isClaimed(scope) {
	return get(inputClaims).includes(scope);
}

/** @param {'keys'|'locomotion'} scope */
// 21-E3: REFCOUNTED. The claim set used to be a plain membership list, so two
// claimers of the same scope (a HUD menu + a module possess) dropped each other:
// the first release removed the scope for both. editorNavigation refused to claim
// at all for exactly this reason. Counts fix it with the SDK signatures and the
// `includes('keys')` consumer contract byte-identical: the store gains the scope
// on 0 -> 1 and loses it on 1 -> 0.
/** @type {Map<string, number>} */
const claimCounts = new Map();

/** @param {string} scope */
export function claimInput(scope) {
	const next = (claimCounts.get(scope) ?? 0) + 1;
	claimCounts.set(scope, next);
	if (next === 1) inputClaims.update((list) => (list.includes(scope) ? list : [...list, scope]));
}

/** @param {'keys'|'locomotion'} scope */
/** @param {string} scope */
export function releaseInput(scope) {
	const next = Math.max(0, (claimCounts.get(scope) ?? 0) - 1);
	if (next === 0) claimCounts.delete(scope);
	else claimCounts.set(scope, next);
	if (next === 0) inputClaims.update((list) => list.filter((s) => s !== scope));
}

/** Release everything a module might have left claimed (module error/disable). */
export function releaseAllInput() {
	// the module-error path. KNOWN WART, carried from the pre-refcount code: this
	// drops every claimer including a live one that was not the failing module.
	claimCounts.clear();
	inputClaims.set([]);
}

/**
 * Declare a module's key bindings: display-only entries in the shortcuts
 * registry so they appear in Settings ▸ Shortcuts under the module's group.
 * @param {string} moduleId
 * @param {{id?: string, label: string, keys: string}[]} bindings
 */
export function registerBindings(moduleId, bindings) {
	for (const binding of bindings ?? []) {
		registerShortcut({
			keys: binding.keys,
			group: 'Module: ' + moduleId,
			label: binding.label
			// no action — modules poll getInput()/subscribe onInput; listing here
			// is for discoverability (the V push-to-talk precedent)
		});
	}
}

/** A2: drop a module's declared bindings (teardown for the dev-mode reload).
 * @param {string} moduleId */
export function unregisterBindings(moduleId) {
	unregisterShortcutGroup('Module: ' + moduleId);
}

/** Per-frame input snapshot for module frame tasks. 21-E5 adds the pad channels
 * ADDITIVELY — `axes` keeps meaning the VR sticks, so every existing module reads
 * byte-identically. */
export function getInput() {
	return {
		codes: new Set(codes),
		axes: { ...vrAxes },
		vrButtons: { ...vrButtons },
		pad: { ...padAxes },
		padButtons: new Set(padCodes)
	};
}

/** Subscribe to key down/up events. Returns an unsubscribe.
 * @param {(kind: 'down'|'up', code: string) => void} fn */
export function onInput(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** vrControls publishes the acting hand's stick axes each frame (the safe
 * import direction — vrControls -> inputRuntime).
 * @param {'left'|'right'} hand @param {number} x @param {number} y */
export function setVRAxes(hand, x, y) {
	if (hand === 'left') {
		vrAxes.lx = x;
		vrAxes.ly = y;
	} else {
		vrAxes.rx = x;
		vrAxes.ry = y;
	}
}

/** @param {'left'|'right'} hand @param {boolean} trigger @param {boolean} squeeze */
export function setVRButtons(hand, trigger, squeeze) {
	if (hand === 'left') {
		vrButtons.ltrigger = trigger;
		vrButtons.lsqueeze = squeeze;
	} else {
		vrButtons.rtrigger = trigger;
		vrButtons.rsqueeze = squeeze;
	}
}

// --- 21-E5: the gamepad poll ------------------------------------------------
// There is no event for a stick, so a pad has to be POLLED, and `navigator.getGamepads()`
// hands back a fresh SNAPSHOT array rather than live objects — the values in it are only
// as current as the last call.
//
// THE SEAM: this is called from flowRuntime's `runTick`, not from a loop of its own.
// Three reasons, in order. (1) A second requestAnimationFrame is a SECOND CALLBACK
// QUEUE, and whichever ran first would decide whether the flow graph saw this frame's
// press or last frame's — the same one-frame-behind trap the note markers hit against
// threlte's scheduler. (2) That tick is the only per-frame loop that ALSO runs in a
// headset (Scene.svelte pumps it through `pumpFlowTick` while presenting), so a pad
// keeps working in VR for free. (3) runTick is already inputRuntime's per-frame
// consumer — it reads `getInput().codes` there for the held-key re-stamp — so the data
// is produced exactly where it is used, and inputRuntime keeps its store-only,
// event-driven shape with no lifecycle of its own to start or stop.

/** MULTIPLE PADS: pad 0 wins, deliberately. The first CONNECTED entry drives
 * everything — there is one camera and one HUD ring, so a second pad steering them
 * would be a fight, not a feature; splitting pads across peers is what the session is
 * for. (Local co-op would need per-pad routing all the way down and is not in scope.)
 * @returns {any} */
function activePad() {
	if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
	const pads = navigator.getGamepads() ?? [];
	for (const pad of pads) if (pad && pad.connected !== false) return pad;
	return null;
}

/** Release anything held and zero the sticks. The onBlur discipline: a stick left at
 * full deflection because the pad went away (or the feature was switched off) would
 * drive the camera forever, and a button left down would hold a node's level high. */
function quietPad() {
	for (const code of [...padCodes]) {
		padCodes.delete(code);
		emit('up', code);
	}
	padAxes.lx = 0;
	padAxes.ly = 0;
	padAxes.rx = 0;
	padAxes.ry = 0;
}

/** A pad's `id` is "Name (STANDARD GAMEPAD Vendor: 045e Product: 02ea)" — the tail is
 * noise in a toast. Kept as its own function because writing this regex through a shell
 * heredoc ate both backslashes and left `/s*(.*)s*$/`, which matched the WHOLE name and
 * announced "Gamepad connected: " with nothing after it (the suite caught it).
 * @param {string} id */
function shortPadName(id) {
	return id.replace(/\s*\([^)]*\)\s*$/, '') || id;
}

/** Poll the pad and publish its edges + axes. Called once per frame. */
export function pollGamepads() {
	const prefs = gamepadPrefsNow();
	const pad = activePad();
	// PRESENCE is tracked whatever the gates say, so switching the feature on later does
	// not announce a pad that has been plugged in the whole time. The toast comes from the
	// poll rather than from `gamepadconnected` because the poll is the single seam that
	// owns this device (a stub replacing getGamepads then drives the toast too) — and on
	// several engines that event is only delivered after the first input anyway, which is
	// exactly the moment the poll notices.
	const id = pad ? String(pad.id ?? 'gamepad') : null;
	if (id !== padId) {
		padId = id;
		if (prefs.enabled)
			showToast(id ? 'Gamepad connected: ' + shortPadName(id) : 'Gamepad disconnected');
	}
	// ONE place quiets the pad, covering all three reasons it can go silent — unplugged,
	// switched off, an app dialog opened (the keyboard handler's 15-B6 discipline). The
	// first draft ALSO called quietPad on the disconnect branch above; breaking that line
	// to prove the release check could fail is what showed it was dead code, since a
	// vanished pad reaches this gate on the very same frame. Two callers would have meant
	// two places to keep in step for no observable difference.
	if (!pad || !prefs.enabled || get(anyModalOpen)) {
		if (padCodes.size || padAxes.lx || padAxes.ly || padAxes.rx || padAxes.ry) quietPad();
		return;
	}
	const buttons = pad.buttons ?? [];
	for (let i = 0; i < GAMEPAD_BUTTONS.length; i++) {
		const code = GAMEPAD_BUTTONS[i];
		const button = buttons[i];
		// a trigger is an ANALOG button on most pads: `pressed` is the engine's own verdict,
		// `value` the fallback for a pad that reports the axis and never sets the flag
		const down = !!(
			button &&
			(button.pressed || (typeof button.value === 'number' && button.value > 0.5))
		);
		if (down === padCodes.has(code)) continue;
		if (down) padCodes.add(code);
		else padCodes.delete(code);
		emit(down ? 'down' : 'up', code);
	}
	const axes = pad.axes ?? [];
	const dz = prefs.deadzone;
	padAxes.lx = applyDeadzone(Number(axes[0] ?? 0), dz);
	padAxes.ly = applyDeadzone(Number(axes[1] ?? 0), dz);
	padAxes.rx = applyDeadzone(Number(axes[2] ?? 0), dz);
	padAxes.ry = applyDeadzone(Number(axes[3] ?? 0), dz);
}

/** The deadzoned stick snapshot — {lx, ly, rx, ry}, each -1..1. */
export function getGamepadAxes() {
	return { ...padAxes };
}

/** Currently held pad buttons, by code. */
export function getGamepadButtons() {
	return new Set(padCodes);
}

/** Is a pad present? (`pad.id` when one is, for the Settings readout.) */
export function gamepadName() {
	return padId;
}

/** @param {KeyboardEvent} event */
function onKeyDown(event) {
	/** @type {any} */
	const target = event.target;
	// never steal keys from text entry (same guard as shortcuts.js)
	if (
		target &&
		(target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.tagName === 'SELECT' ||
			target.isContentEditable)
	)
		return;
	// 15-B6: module bindings stay quiet behind an open (non-modal) app modal
	if (get(anyModalOpen)) return;
	if (!codes.has(event.code)) {
		codes.add(event.code);
		emit('down', event.code);
	}
}

/** @param {KeyboardEvent} event */
function onKeyUp(event) {
	if (codes.delete(event.code)) emit('up', event.code);
}

function onBlur() {
	// keys stuck down across a focus loss would run a possessed object forever
	for (const code of [...codes]) {
		codes.delete(code);
		emit('up', code);
	}
}

let started = false;
export function startInputRuntime() {
	if (started || typeof window === 'undefined') return;
	started = true;
	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);
	window.addEventListener('blur', onBlur);
}
