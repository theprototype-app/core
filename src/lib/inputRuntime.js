import { writable, get } from 'svelte/store';
import { anyModalOpen } from '../stores/appStore';
import { registerShortcut, unregisterShortcutGroup } from './shortcuts';

// Module SDK input layer (K-C). STORE-ONLY module (the peerApproval.js pattern):
// imports nothing from peerHandler/vrControls, so vrControls can feed it VR
// stick axes and the SDK can expose it without closing an import cycle (the
// vite-dev TDZ trap). Modules declare BINDINGS (listed in Settings ▸ Shortcuts),
// poll per-frame input (getInput) or subscribe to down/up events (onInput), and
// CLAIM input scopes so the host stops consuming the same keys/sticks:
//   'keys'       — PointerLockControls WASD + the editor fly-navigation pause
//   'locomotion' — VR left-stick locomotion pauses (modules drive instead)

/** currently held key codes (event.code, e.g. 'KeyW') */
const codes = new Set();
/** latest VR stick axes, published by vrControls each frame */
const vrAxes = { lx: 0, ly: 0, rx: 0, ry: 0 };
/** latest VR button states, published by vrControls each frame */
const vrButtons = { ltrigger: false, rtrigger: false, lsqueeze: false, rsqueeze: false };
/** @type {Set<(kind: 'down'|'up', code: string) => void>} */
const listeners = new Set();

/** active claims — stores so host consumers can subscribe reactively
 * @type {import('svelte/store').Writable<string[]>} */
export const inputClaims = writable([]);

/** Is a scope currently claimed by any module? @param {'keys'|'locomotion'} scope */
export function isClaimed(scope) {
	return get(inputClaims).includes(scope);
}

/** @param {'keys'|'locomotion'} scope */
export function claimInput(scope) {
	inputClaims.update((list) => (list.includes(scope) ? list : [...list, scope]));
}

/** @param {'keys'|'locomotion'} scope */
export function releaseInput(scope) {
	inputClaims.update((list) => list.filter((s) => s !== scope));
}

/** Release everything a module might have left claimed (module error/disable). */
export function releaseAllInput() {
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

/** Per-frame input snapshot for module frame tasks. */
export function getInput() {
	return {
		codes: new Set(codes),
		axes: { ...vrAxes },
		vrButtons: { ...vrButtons }
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
		listeners.forEach((fn) => {
			try {
				fn('down', event.code);
			} catch (error) {
				console.log('input listener failed', error);
			}
		});
	}
}

/** @param {KeyboardEvent} event */
function onKeyUp(event) {
	if (codes.delete(event.code))
		listeners.forEach((fn) => {
			try {
				fn('up', event.code);
			} catch (error) {
				console.log('input listener failed', error);
			}
		});
}

function onBlur() {
	// keys stuck down across a focus loss would run a possessed object forever
	for (const code of [...codes]) {
		codes.delete(code);
		listeners.forEach((fn) => {
			try {
				fn('up', code);
			} catch {}
		});
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
