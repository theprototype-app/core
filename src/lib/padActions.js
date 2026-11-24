// 92-input GC3 — THE PAD BRIDGE (lazy: inputRuntime loads it the first time a pad is seen). A pad press of
// a built-in play action (playActions.PAD_ACTIONS: A jump, X use, RT fire …) does what that action's TOUCH
// button does — touchActions.pressTouchAction: the same synthetic key, or the same press at the
// crosshair — so the walker, Key Press nodes, Player code, playInteract and modules hear it with no
// second input path. The codes arriving here are GAME codes (the player's pad remap already applied).
//
// Stands down: outside Play, in VR (Quest controllers keep their own mapping, vr/bindings.js), while a
// HUD menu holds the pointer (the HUD ring owns the D-pad + A there; the Menu button still works, as
// Escape does), and for any button a Gamepad Button node binds — that button is the game's own.
import { get } from 'svelte/store';
import { onInput } from './inputRuntime';
import { isLocked, isVRMode, playPointerFree, globalRenderer } from '../stores/sceneStore';
import { allNodes } from '../stores/flowStore';
import { PAD_ACTIONS } from './playActions.js'; // the lazy half: loading it registers the pad help lines
import { noteDeviceInput, activeInputNow } from './activeDevice.js';
import { normalizeAction, pressTouchAction } from './touchActions';

/** pad code -> the touch-action shape it presses (ids namespaced so a finger and a pad never share a hold) */
const BY_PAD = new Map(
	PAD_ACTIONS.map((a) => [a.pad, { meta: a, action: normalizeAction({ id: 'pad:' + a.id, label: a.label, keys: a.keys ?? [], pointer: a.pointer ?? '' }, 'pad') }])
);
/** what this bridge is holding down: pad code -> action @type {Map<string, any>} */
const held = new Map();
const debug = { presses: 0, releases: 0, skipped: 0, last: /** @type {string | null} */ (null) };

const canvas = () => /** @type {any} */ (get(globalRenderer))?.domElement ?? null;

/** does a Gamepad Button node listen for this button? (then it is the game's, not the bridge's) @param {string} code */
function boundByGame(code) {
	return allNodes().some((n) => n?.type === 'gamepadbutton' && n.data?.button === code);
}

/** @param {any} entry */
function allowed(entry) {
	if (get(isLocked) !== true || get(isVRMode)) return false;
	if (get(playPointerFree) && entry.meta.id !== 'menu') return false;
	return !boundByGame(entry.meta.pad);
}

function releaseAll() {
	for (const [code, action] of [...held]) {
		held.delete(code);
		pressTouchAction(action, false, { canvas: canvas() });
		debug.releases++;
	}
}

/** back on the keyboard / mouse or a finger (capture phase: a handler that stops the event must not hide the
 * device; synthetic events are not the player's) */
function watchDevices() {
	if (typeof window === 'undefined') return;
	window.addEventListener('keydown', (e) => e.isTrusted && noteDeviceInput('keyboard'), true);
	window.addEventListener('pointerdown', (e) => e.isTrusted && noteDeviceInput(e.pointerType === 'touch' ? 'touch' : 'keyboard'), true);
	window.addEventListener(
		'pointermove',
		(e) => {
			if (!e.isTrusted || e.pointerType === 'touch' || activeInputNow().kind === 'keyboard') return;
			if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) noteDeviceInput('keyboard');
		},
		true
	);
}

let started = false;
export function startPadActions() {
	if (started) return;
	started = true;
	watchDevices();
	onInput((kind, code) => {
		const entry = BY_PAD.get(code);
		if (!entry?.action) return;
		if (kind === 'down') {
			if (held.has(code)) return;
			if (!allowed(entry)) {
				debug.skipped++;
				return;
			}
			held.set(code, entry.action);
			debug.presses++;
			debug.last = entry.meta.id;
			pressTouchAction(entry.action, true, { canvas: canvas() });
		} else if (kind === 'up' && held.has(code)) {
			const action = held.get(code);
			held.delete(code);
			debug.releases++;
			pressTouchAction(action, false, { canvas: canvas() });
		}
	});
	// a hold never outlives Play, a menu opening or a headset going on (the quietPad discipline)
	isLocked.subscribe((v) => v !== true && releaseAll());
	playPointerFree.subscribe((v) => v && releaseAll());
	isVRMode.subscribe((v) => v && releaseAll());
}

/** suites: the device the prompts follow, through this hook (one debug row) */
export { activeInput } from './activeDevice.js';

/** suites */
export function padActionsDebug() {
	return { started, held: [...held.keys()], ...debug };
}
