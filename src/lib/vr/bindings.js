// VR controls — THE BINDINGS MAP (36-vr, plan 55). Every VR action the app reads from a controller is a
// NAMED ACTION bound to a {hand, control}; the frame loop, locomotion, the editor stick and the grip code
// ask this file which hand and which button, never a literal `buttons[5]` or `'right'`. Defaults are the
// map phases 52-54/30b/31 settled on (menu B · mode Y · game menu X · talk/jump A · ping right stick
// press · move left stick · turn + teleport right stick · drag-the-world right grip).
//
// LOCAL ONLY (55.3): each person maps their own controllers — safeStorage `vrBindings`, never replicated.
// The menu hand is the old `vrMenuHand` store and stays its single source of truth: `menu.hand` mirrors it
// both ways, so Settings ▸ VR's menu-hand row, the radial's hand switch and every module that already
// reads `vrMenuHand` agree with the table by construction.
//
// CONFLICTS (55.2): two actions on the same hand + control conflict, except turn + teleport, which
// SHARE a stick on purpose (sideways turns, up aims). `setBinding` refuses a conflict unless the caller
// asks to SWAP (the other action takes the moved one's old place) — the desktop table offers that as a
// button, the in-VR panel as a second press.
//
// A leaf: svelte/store + safeStorage + the sceneStore menu hand. Nothing here allocates per frame.
import { writable, get } from 'svelte/store';
import { vrMenuHand } from '../../stores/sceneStore';
import { safeStorage } from '../safeStorage';

/** @typedef {'left' | 'right'} Hand */
/** @typedef {'stick' | 'trigger' | 'grip' | 'stickClick' | 'primary' | 'secondary'} Control */
/** @typedef {{hand: Hand | 'both', control: Control}} Binding */

/** xr-standard gamepad button index per control (the stick is axes 2/3, no button) */
export const CONTROL_INDEX = /** @type {const} */ ({ trigger: 0, grip: 1, stickClick: 3, primary: 4, secondary: 5 });

/** what a control is CALLED on a Quest controller, per hand */
const CONTROL_NAMES = {
	stick: { left: 'Left stick', right: 'Right stick' },
	trigger: { left: 'Left trigger', right: 'Right trigger' },
	grip: { left: 'Left grip', right: 'Right grip' },
	stickClick: { left: 'Left stick press', right: 'Right stick press' },
	primary: { left: 'X', right: 'A' },
	secondary: { left: 'Y', right: 'B' }
};

/**
 * The actions, in the order the remap table lists them. `kind` decides which controls an action may take:
 * a 'stick' action takes a stick, a 'button' action any face button / stick press, a 'grip' action only
 * moves hands. `locked` rows are shown (so the table is complete) but are the platform convention.
 * @type {{id: string, label: string, kind: 'stick' | 'button' | 'grip' | 'locked', default: Binding, doc: string}[]}
 */
export const VR_ACTIONS = [
	{ id: 'move', label: 'Move', kind: 'stick', default: { hand: 'left', control: 'stick' }, doc: 'Walk or fly; hold that hand’s grip in Edit to pan and rise' },
	{ id: 'turn', label: 'Turn', kind: 'stick', default: { hand: 'right', control: 'stick' }, doc: 'Push sideways to turn (snap or smooth, Settings ▸ Comfort)' },
	{ id: 'teleport', label: 'Teleport', kind: 'stick', default: { hand: 'right', control: 'stick' }, doc: 'Push up to aim the arc, let go to jump there' },
	{ id: 'menu', label: 'Radial menu', kind: 'button', default: { hand: 'right', control: 'secondary' }, doc: 'Opens the radial menu on that hand; the other hand points' },
	{ id: 'mode', label: 'Edit / Interact', kind: 'button', default: { hand: 'left', control: 'secondary' }, doc: 'Switches between editing and interacting' },
	{ id: 'pause', label: 'Game menu', kind: 'button', default: { hand: 'left', control: 'primary' }, doc: 'Pauses a game and shows its menu' },
	{ id: 'ptt', label: 'Talk / jump', kind: 'button', default: { hand: 'right', control: 'primary' }, doc: 'Hold to talk (push-to-talk); jumps while a game lets you' },
	{ id: 'ping', label: 'Ping', kind: 'button', default: { hand: 'right', control: 'stickClick' }, doc: 'Pings the spot that hand points at' },
	{ id: 'worldPan', label: 'Drag the world', kind: 'grip', default: { hand: 'right', control: 'grip' }, doc: 'Grip empty air with that hand and pull to move the world' },
	{ id: 'grab', label: 'Grab', kind: 'locked', default: { hand: 'both', control: 'grip' }, doc: 'Either grip holds what it touches (the Quest convention)' },
	{ id: 'select', label: 'Select / use', kind: 'locked', default: { hand: 'both', control: 'trigger' }, doc: 'Either trigger selects, presses and draws' }
];
const BY_ID = new Map(VR_ACTIONS.map((a) => [a.id, a]));
/** the controls an action of each kind may be bound to */
export const CONTROLS_FOR = {
	stick: /** @type {Control[]} */ (['stick']),
	button: /** @type {Control[]} */ (['secondary', 'primary', 'stickClick']),
	grip: /** @type {Control[]} */ (['grip']),
	locked: /** @type {Control[]} */ ([])
};
/** actions that may share one control on one hand */
const SHARED = new Set(['turn|teleport', 'teleport|turn']);

/** @returns {Record<string, Binding>} */
export function defaultBindings() {
	/** @type {Record<string, Binding>} */
	const out = {};
	for (const a of VR_ACTIONS) out[a.id] = { ...a.default };
	return out;
}

/** @param {any} v @returns {v is Hand} */
const isHand = (v) => v === 'left' || v === 'right';

/**
 * A stored map made safe: unknown actions dropped, a bad hand/control falls back to the default, locked
 * rows always default. Pure (exported for the unit test).
 * @param {any} raw @returns {Record<string, Binding>}
 */
export function normalizeBindings(raw) {
	const out = defaultBindings();
	if (!raw || typeof raw !== 'object') return out;
	for (const a of VR_ACTIONS) {
		if (a.kind === 'locked') continue;
		const b = raw[a.id];
		if (!b || typeof b !== 'object') continue;
		const hand = isHand(b.hand) ? b.hand : a.default.hand;
		const control = CONTROLS_FOR[a.kind].includes(b.control) ? b.control : a.default.control;
		out[a.id] = { hand, control };
	}
	// a stored map with a conflict (an older build, a hand-edited value) falls back to the defaults
	return bindingConflicts(out).length ? defaultBindings() : out;
}

/**
 * Every pair of actions that share a hand + control (turn/teleport excepted). Pure.
 * @param {Record<string, Binding>} map @returns {[string, string][]}
 */
export function bindingConflicts(map) {
	/** @type {[string, string][]} */
	const out = [];
	const ids = VR_ACTIONS.filter((a) => a.kind !== 'locked').map((a) => a.id);
	for (let i = 0; i < ids.length; i++)
		for (let j = i + 1; j < ids.length; j++) {
			const a = map[ids[i]];
			const b = map[ids[j]];
			if (!a || !b || a.hand !== b.hand || a.control !== b.control) continue;
			if (SHARED.has(ids[i] + '|' + ids[j])) continue;
			out.push([ids[i], ids[j]]);
		}
	return out;
}

function load() {
	let raw = null;
	try {
		raw = JSON.parse(safeStorage.getItem('vrBindings') || 'null');
	} catch {}
	const map = normalizeBindings(raw);
	// the menu hand's truth is vrMenuHand (it predates this table)
	const hand = get(vrMenuHand);
	if (isHand(hand) && map.menu.hand !== hand) return followMenuHand(map, hand);
	return map;
}

/** the live map — a store for the UI, a plain object for the frame loop */
export const vrBindings = writable(defaultBindings());
/** @type {Record<string, Binding>} */
let current = defaultBindings();
vrBindings.subscribe((v) => (current = v));

function save() {
	try {
		safeStorage.setItem('vrBindings', JSON.stringify(current));
	} catch {}
}

/**
 * The menu moved to `hand` (Settings' menu-hand row, the radial, a module setting vrMenuHand): the menu
 * binding follows, and whatever then collides with it takes the menu's old place — so the old
 * behaviour holds (menu on the left puts Edit/Interact on the right's B). Pure over the map.
 * @param {Record<string, Binding>} map @param {Hand} hand @returns {Record<string, Binding>}
 */
export function followMenuHand(map, hand) {
	const next = { ...map };
	const old = next.menu;
	if (old.hand === hand) return next;
	next.menu = { hand, control: old.control };
	for (const [a, b] of bindingConflicts(next)) {
		const other = a === 'menu' ? b : b === 'menu' ? a : null;
		if (other) next[other] = { hand: /** @type {Hand} */ (old.hand), control: old.control };
	}
	return bindingConflicts(next).length ? map : next;
}

/**
 * Bind `id` to `binding`. A conflict is refused (`{ok: false, conflict}`) unless `swap` — then the
 * conflicting action takes `id`'s previous binding. Persists; a menu move also moves vrMenuHand.
 * @param {string} id @param {{hand?: Hand, control?: Control}} binding @param {{swap?: boolean}} [opts]
 * @returns {{ok: boolean, conflict?: string, swapped?: string}} `swapped` = the moved action ids, comma-joined
 */
export function setBinding(id, binding, opts = {}) {
	const action = BY_ID.get(id);
	if (!action || action.kind === 'locked') return { ok: false };
	const prev = current[id];
	const want = {
		hand: isHand(binding.hand) ? binding.hand : /** @type {Hand} */ (prev.hand),
		control: CONTROLS_FOR[action.kind].includes(/** @type {any} */ (binding.control)) ? /** @type {Control} */ (binding.control) : prev.control
	};
	if (want.hand === prev.hand && want.control === prev.control) return { ok: true };
	const next = { ...current, [id]: want };
	const others = bindingConflicts(next)
		.filter(([a, b]) => a === id || b === id)
		.map(([a, b]) => (a === id ? b : a));
	let swapped;
	if (others.length) {
		if (!opts.swap) return { ok: false, conflict: others[0] };
		// every action in the way takes our old place (turn + teleport travel together — they share a
		// stick) — or, when our old control is not one it may hold, our old hand with its own control
		for (const other of others) {
			const otherKind = BY_ID.get(other)?.kind ?? 'button';
			next[other] = CONTROLS_FOR[otherKind].includes(prev.control)
				? { hand: /** @type {Hand} */ (prev.hand), control: prev.control }
				: { hand: /** @type {Hand} */ (prev.hand), control: next[other].control };
		}
		if (bindingConflicts(next).length) return { ok: false, conflict: others[0] };
		swapped = others.join(',');
	}
	vrBindings.set(next);
	save();
	syncMenuHandOut();
	return { ok: true, swapped };
}

/** Back to the defaults (keeps nothing); the menu hand follows. */
export function resetBindings() {
	vrBindings.set(defaultBindings());
	save();
	syncMenuHandOut();
}

/** Mirror every remappable action onto the other hand (the left-handed layout, and back). */
export function mirrorBindings() {
	/** @type {Record<string, Binding>} */
	const next = {};
	for (const a of VR_ACTIONS) {
		const b = current[a.id];
		next[a.id] = a.kind === 'locked' ? { ...b } : { hand: b.hand === 'left' ? 'right' : 'left', control: b.control };
	}
	vrBindings.set(next);
	save();
	syncMenuHandOut();
}

/** Is the current map the mirror image of the defaults? (the "Left-handed" toggle's state) */
export function isLeftHanded() {
	return VR_ACTIONS.every((a) => {
		if (a.kind === 'locked') return true;
		const b = current[a.id];
		return b.control === a.default.control && b.hand !== a.default.hand;
	});
}

/** @param {string} id @returns {Binding} */
export function bindingOf(id) {
	return current[id] ?? BY_ID.get(id)?.default ?? { hand: 'right', control: 'trigger' };
}
/** the hand an action lives on ('right' for a both-hands row) @param {string} id @returns {Hand} */
export function handOf(id) {
	const h = bindingOf(id).hand;
	return h === 'left' ? 'left' : 'right';
}
/** The button index an action reads (-1 for a stick). @param {string} id */
export function buttonIndexOf(id) {
	const c = bindingOf(id).control;
	return c === 'stick' ? -1 : CONTROL_INDEX[c];
}
/** Is the action's button down on this input source (false for the other hand)? Hot path, no allocation.
 * @param {string} id @param {any} source an XRInputSource */
export function actionPressed(id, source) {
	const b = bindingOf(id);
	if (b.hand !== 'both' && source?.handedness !== b.hand) return false;
	if (b.control === 'stick') return false;
	return !!source?.gamepad?.buttons?.[CONTROL_INDEX[b.control]]?.pressed;
}
/** The input source carrying an action (by the binding's hand), or null. @param {string} id @param {any} session */
export function sourceOf(id, session) {
	const hand = handOf(id);
	if (!session?.inputSources) return null;
	for (const s of session.inputSources) if (s.handedness === hand) return s;
	return null;
}
const _stick = { x: 0, y: 0 };
/** The action's stick {x, y} (xr-standard: up is NEGATIVE y). The returned object is REUSED — read it at
 * once. @param {string} id @param {any} session */
export function stickOf(id, session) {
	const axes = sourceOf(id, session)?.gamepad?.axes;
	_stick.x = axes?.[2] ?? 0;
	_stick.y = axes?.[3] ?? 0;
	return _stick;
}

/** 'B', 'Left stick', 'Right grip'… @param {Hand | 'both'} hand @param {Control} control */
export function controlName(hand, control) {
	if (hand === 'both') return control === 'grip' ? 'Either grip' : 'Either trigger';
	return CONTROL_NAMES[control]?.[hand] ?? control;
}
/** "B (right)", "Left stick" — what a tour or a hint shows for an action. @param {string} id */
export function bindingLabel(id) {
	const b = bindingOf(id);
	const name = controlName(b.hand, b.control);
	return b.control === 'primary' || b.control === 'secondary' ? `${name} (${b.hand})` : name;
}
/** the action's row for UIs @param {string} id */
export function actionInfo(id) {
	return BY_ID.get(id) ?? null;
}

/** keep vrMenuHand equal to the menu binding (after a set/reset/mirror) */
function syncMenuHandOut() {
	const hand = current.menu.hand;
	if (isHand(hand) && get(vrMenuHand) !== hand) {
		vrMenuHand.set(hand);
		try {
			safeStorage.setItem('vrMenuHand', hand);
		} catch {}
	}
}

// LAST (a module-level subscribe runs synchronously at evaluation — the TDZ rule): load, then follow
// every outside write of vrMenuHand (the desktop row, the radial, tests, modules).
vrBindings.set(load());
vrMenuHand.subscribe((hand) => {
	if (!isHand(hand) || current.menu.hand === hand) return;
	const next = followMenuHand(current, hand);
	if (next === current) return;
	vrBindings.set(next);
	save();
});
