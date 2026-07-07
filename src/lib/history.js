import { writable, derived, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';

// Transform-only undo/redo. Entries are recorded from local gizmo drags
// (Scene.svelte hooks TransformControls' dragging-changed); remote peers'
// moves are not recorded, so histories stay per-user.
// entry: { uuid, before: {pos, rot, scale}, after: {pos, rot, scale} }

const LIMIT = 50;

/** @type {import('svelte/store').Writable<any[]>} */
const undoStack = writable([]);
/** @type {import('svelte/store').Writable<any[]>} */
const redoStack = writable([]);

export const canUndo = derived(undoStack, (stack) => stack.length > 0);
export const canRedo = derived(redoStack, (stack) => stack.length > 0);

/** @param {any} entry */
export function recordTransform(entry) {
	undoStack.update((stack) => {
		const next = [...stack, entry];
		if (next.length > LIMIT) next.shift();
		return next;
	});
	redoStack.set([]);
}

/** @param {string} uuid @param {any} state */
function applyState(uuid, state) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	object.position.fromArray(state.pos);
	object.rotation.set(state.rot[0], state.rot[1], state.rot[2]);
	object.scale.fromArray(state.scale);
	objectsGroup.update((value) => value);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'move', uuid: uuid, pos: state.pos, rot: state.rot, scale: state.scale });
	return true;
}

export function undo() {
	const stack = get(undoStack);
	if (stack.length === 0) {
		showToast('Nothing to undo — only object move/rotate/scale steps are tracked (last 50)');
		return;
	}
	const entry = stack[stack.length - 1];
	undoStack.update((s) => s.slice(0, -1));
	if (applyState(entry.uuid, entry.before)) redoStack.update((s) => [...s, entry]);
}

export function redo() {
	const stack = get(redoStack);
	if (stack.length === 0) {
		showToast('Nothing to redo — only object move/rotate/scale steps are tracked (last 50)');
		return;
	}
	const entry = stack[stack.length - 1];
	redoStack.update((s) => s.slice(0, -1));
	if (applyState(entry.uuid, entry.after)) undoStack.update((s) => [...s, entry]);
}
