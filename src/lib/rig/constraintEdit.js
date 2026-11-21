// 102 M7 — the ONE write path for an object's `userData.constraints` (the setFluidFor shape):
// normalize, one `props` undo entry per edit (one per scrub through a gesture), the existing
// `objectParameters` message (parameter 'constraints'), a rescan, a poke. Every peer evaluates
// the stack itself from this record and the synced targets; no pose travels.

import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { recordEntry } from '../history';
import { normalizeConstraints, normalizeConstraint, makeConstraint, captureOffset, CONSTRAINT_KINDS } from './constraintCore.js';
import { nodeIn } from './constraintRuntime.js';
import { markConstraintsDirty } from './constraintHub.js'; // the hub loads + forwards to the runtime

/** @typedef {import('./constraintCore.js').Constraint} Constraint */

/** @param {string} uuid */
function objectOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid) ?? null;
}

/** The object's list (normalized copy). @param {string} uuid @returns {Constraint[]} */
export function constraintsOf(uuid) {
	return normalizeConstraints(objectOf(uuid)?.userData?.constraints);
}

/** uuid -> the list before an open gesture (one undo entry per scrub) */
/** @type {Map<string, Constraint[]>} */
const gestures = new Map();
/** @type {Map<string, number>} */
const lastSend = new Map();

/** @param {string} uuid @param {Constraint[]} list */
function send(uuid, list) {
	/** @type {any} */
	const peer = get(peers);
	peer?.send?.({ type: 'objectParameters', parameter: 'constraints', uuid, constraints: list.length ? list : null });
	lastSend.set(uuid, performance.now());
}

/**
 * Replace an object's whole list. `record: false` skips the undo entry (the applier, a scrub).
 * @param {string} uuid @param {any[]} list @param {{record?: boolean, replicate?: boolean}} [opts]
 * @returns {Constraint[] | null} the stored list, null when the object is missing
 */
export function setConstraintsFor(uuid, list, opts = {}) {
	const object = objectOf(uuid);
	if (!object) return null;
	const before = normalizeConstraints(object.userData.constraints);
	const next = normalizeConstraints(list);
	if (next.length) object.userData.constraints = next;
	else delete object.userData.constraints;
	markConstraintsDirty();
	const inGesture = gestures.has(uuid);
	if (opts.record !== false && !inGesture) recordEntry({ kind: 'props', uuid, before: { constraints: before.length ? before : null }, after: { constraints: next.length ? next : null } });
	if (opts.replicate !== false) {
		// a scrub sends at most every 100 ms; the gesture's end sends the final list
		if (!inGesture || performance.now() - (lastSend.get(uuid) ?? 0) >= 100) send(uuid, next);
	}
	pokeScene();
	return next;
}

/** Open a scrub (a weight slider drag): edits inside it are ONE undo entry. @param {string} uuid */
export function beginConstraintGesture(uuid) {
	if (!gestures.has(uuid)) gestures.set(uuid, constraintsOf(uuid));
}

/** Close a scrub: one undo entry, one final message. @param {string} uuid */
export function endConstraintGesture(uuid) {
	const before = gestures.get(uuid);
	if (!before) return;
	gestures.delete(uuid);
	const after = constraintsOf(uuid);
	if (JSON.stringify(before) === JSON.stringify(after)) return;
	recordEntry({ kind: 'props', uuid, before: { constraints: before.length ? before : null }, after: { constraints: after.length ? after : null } });
	send(uuid, after);
}

/**
 * Add one constraint (at the end of the stack). A copy constraint made in "parent" mode captures
 * its offset now, so the object stays where it is and then follows.
 * @param {string} uuid @param {string} kind @param {Partial<Constraint> & {parent?: boolean}} [fields]
 * @returns {Constraint | null}
 */
export function addConstraint(uuid, kind, fields = {}) {
	if (!CONSTRAINT_KINDS.includes(kind)) return null;
	const list = constraintsOf(uuid);
	if (list.length >= 16) return null;
	const base = /** @type {any} */ (makeConstraint(kind, new Set(list.map((c) => c.id))));
	const { parent, ...rest } = /** @type {any} */ (fields);
	let c = normalizeConstraint({ ...base, ...rest, id: base.id, kind });
	if (!c) return null;
	if (kind === 'copy' && parent && c.target) c = withOffset(uuid, c) ?? c;
	const stored = setConstraintsFor(uuid, [...list, c]);
	return stored?.find((x) => x.id === c.id) ?? null;
}

/** @param {string} uuid @param {Constraint} c @returns {Constraint | null} */
function withOffset(uuid, c) {
	const object = objectOf(uuid);
	const group = /** @type {any} */ (get(objectsGroup));
	if (!object || !c.target) return null;
	const owner = nodeIn(object, c.bone);
	const t = group?.getObjectByProperty?.('uuid', c.target.uuid);
	const tn = t ? nodeIn(t, c.target.bone ?? '') : null;
	if (!owner || !tn) return null;
	group.updateMatrixWorld(true);
	return normalizeConstraint({ ...c, offset: captureOffset(owner, tn) });
}

/** Patch one entry. @param {string} uuid @param {string} id @param {Record<string, any>} patch */
export function updateConstraint(uuid, id, patch) {
	const list = constraintsOf(uuid);
	const i = list.findIndex((c) => c.id === id);
	if (i < 0) return null;
	const next = [...list];
	next[i] = /** @type {Constraint} */ (normalizeConstraint({ ...list[i], ...patch, id, kind: list[i].kind }) ?? list[i]);
	return setConstraintsFor(uuid, next);
}

/** "Parent" with the offset taken now (or cleared: a plain copy). @param {string} uuid @param {string} id @param {boolean} on */
export function setParentOffset(uuid, id, on) {
	const c = constraintsOf(uuid).find((x) => x.id === id);
	if (!c || c.kind !== 'copy') return null;
	if (!on) return updateConstraint(uuid, id, { offset: null });
	const withO = withOffset(uuid, { ...c, offset: null });
	return withO ? updateConstraint(uuid, id, { offset: withO.offset }) : null;
}

/** @param {string} uuid @param {string} id */
export function removeConstraint(uuid, id) {
	return setConstraintsFor(
		uuid,
		constraintsOf(uuid).filter((c) => c.id !== id)
	);
}

/** Move an entry up (-1) or down (+1) the stack (the evaluation order). @param {string} uuid @param {string} id @param {number} dir */
export function moveConstraint(uuid, id, dir) {
	const list = constraintsOf(uuid);
	const i = list.findIndex((c) => c.id === id);
	const j = i + Math.sign(dir);
	if (i < 0 || j < 0 || j >= list.length) return null;
	const next = [...list];
	[next[i], next[j]] = [next[j], next[i]];
	return setConstraintsFor(uuid, next);
}

/** The receive side (objectParameters 'constraints'): normalized, never recorded, never re-sent. @param {string} uuid @param {any} list */
export function applyRemoteConstraints(uuid, list) {
	return setConstraintsFor(uuid, Array.isArray(list) ? list : [], { record: false, replicate: false });
}
