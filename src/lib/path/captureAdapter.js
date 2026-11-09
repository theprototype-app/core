import { get } from 'svelte/store';
import { pushCapture as pushStack, popCapture as popStack, captureArmed, captureStack } from '../captureStack';

// 78 F4 → F5: the Path editor's "Add points" mode on 78-wire's viewport CAPTURE STACK (captureStack.js:
// one owner for viewport clicks, Esc pops the top, one banner). The Path editor keeps its small
// {id, label, hint?, onExit} shape; this file maps it onto the stack. Only entries pushed here are
// popped here, so Esc never runs another tool's exit from the Path editor's key handler.

/** @typedef {{id: string, label: string, hint?: string, icon?: string, onExit?: () => void}} CaptureEntry */

/** exits of the entries this adapter pushed @type {Map<string, (() => void) | undefined>} */
const exits = new Map();

/** the stack, top last (the banner's store) */
export const captureTop = captureStack;

/**
 * Push a capture; returns its pop. Pushing an id already on the stack moves it to the top.
 * @param {CaptureEntry} entry @returns {() => void}
 */
export function pushCapture(entry) {
	exits.set(entry.id, entry.onExit);
	pushStack({
		id: entry.id,
		label: entry.label,
		hint: entry.hint,
		icon: entry.icon ?? 'spline',
		escape: () => popCapture(entry.id)
	});
	return () => popCapture(entry.id);
}

/** pop one capture by id (runs its onExit once) @param {string} id */
export function popCapture(id) {
	if (!exits.has(id) || !captureArmed(id)) {
		exits.delete(id);
		return false;
	}
	const onExit = exits.get(id);
	exits.delete(id);
	popStack(id);
	try {
		onExit?.();
	} catch (error) {
		console.log('capture exit failed', error);
	}
	return true;
}

/** Esc: pop the top capture when it is one of ours (true = Esc was used) */
export function popTopCapture() {
	const stack = get(captureStack);
	const top = stack[stack.length - 1];
	return top && exits.has(top.id) ? popCapture(top.id) : false;
}

/** is this capture live? @param {string} id */
export function captureActive(id) {
	return captureArmed(id);
}
