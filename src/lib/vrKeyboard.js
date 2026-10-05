import { writable, get } from 'svelte/store';

// VR keyboard (116, expert call: native key-grid over an external dep). Pure
// layout + buffer semantics live here so they test headlessly; VRKeyboard.svelte
// renders named key meshes and vrControls routes ray/stick/trigger to keyPress.
// Reused by object rename (116) and chat (117) via {initial, onCommit, onCancel}.

// key rows (lowercase base; Shift upper-cases letters and swaps the digit + punctuation keys).
// 36-vr-ai (B9): the punctuation a sentence needs — a prompt to the AI assistant is a sentence, a rename
// often has a dash or an apostrophe — on the US layout's keys, so Shift gives what it gives on a desk (the
// ? key is the one exception: ? is the common case, Shift gives /). Clear empties the line.
export const KEY_ROWS = [
	['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'],
	['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', "'"],
	['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';'],
	['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', 'backspace'],
	['esc', 'clear', 'space', '?', 'enter']
];

/** @type {Record<string, string>} */
const SHIFTED = {
	'1': '!',
	'2': '@',
	'3': '#',
	'4': '$',
	'5': '%',
	'6': '^',
	'7': '&',
	'8': '*',
	'9': '(',
	'0': ')',
	'-': '_',
	"'": '"',
	';': ':',
	',': '<',
	'.': '>',
	'?': '/'
};

/** Glyph shown on a key given the current shift state @param {string} key @param {boolean} shift */
export function keyLabel(key, shift) {
	if (key === 'shift') return '⇧';
	if (key === 'backspace') return '⌫';
	if (key === 'space') return '␣';
	if (key === 'enter') return '⏎';
	if (key === 'esc') return 'esc';
	if (key === 'clear') return 'clear';
	if (key.length === 1) {
		if (shift && SHIFTED[key]) return SHIFTED[key];
		return shift ? key.toUpperCase() : key;
	}
	return key;
}

/**
 * Apply a key to the buffer. Pure — returns the next {buffer, shift, done}.
 * `done` is 'commit' on Enter, 'cancel' on Esc, else null. Shift is one-shot
 * (auto-clears after a character), like a phone keyboard.
 * @param {string} key @param {{buffer: string, shift: boolean}} state
 */
export function keyPress(key, state) {
	const buffer = state.buffer ?? '';
	const shift = !!state.shift;
	if (key === 'enter') return { buffer, shift, done: 'commit' };
	if (key === 'esc') return { buffer, shift, done: 'cancel' };
	if (key === 'shift') return { buffer, shift: !shift, done: null };
	if (key === 'backspace') return { buffer: buffer.slice(0, -1), shift, done: null };
	if (key === 'clear') return { buffer: '', shift, done: null };
	if (key === 'space') return { buffer: buffer + ' ', shift, done: null };
	// a character: shift affects only this keystroke, then clears
	const char = keyLabel(key, shift);
	return { buffer: buffer + char, shift: false, done: null };
}

/** the open keyboard target, or null @type {import('svelte/store').Writable<any>}
 * {title, buffer, shift, onCommit(text), onCancel(), onInput?(text)} */
export const vrKeyboardTarget = writable(null);

/** Open the keyboard bound to a target. `onInput` (36-vr-ai B9) hears every edit of the buffer — a search
 * that filters as you type. @param {{title?: string, initial?: string,
 * onCommit: (text: string) => void, onCancel?: () => void, onInput?: (text: string) => void}} opts */
export function openVRKeyboard(opts) {
	vrKeyboardTarget.set({
		title: opts.title ?? 'Type',
		buffer: opts.initial ?? '',
		shift: false,
		onCommit: opts.onCommit,
		onCancel: opts.onCancel ?? (() => {}),
		onInput: opts.onInput ?? null
	});
}

/** Route a key through the open target (vrControls calls this) @param {string} key */
export function pressVRKey(key) {
	const target = get(vrKeyboardTarget);
	if (!target) return;
	const next = keyPress(key, target);
	if (next.done === 'commit') {
		vrKeyboardTarget.set(null);
		target.onCommit(next.buffer);
		return;
	}
	if (next.done === 'cancel') {
		vrKeyboardTarget.set(null);
		target.onCancel();
		return;
	}
	vrKeyboardTarget.set({ ...target, buffer: next.buffer, shift: next.shift });
	if (next.buffer !== target.buffer) target.onInput?.(next.buffer);
}

export function closeVRKeyboard() {
	const target = get(vrKeyboardTarget);
	vrKeyboardTarget.set(null);
	target?.onCancel();
}
