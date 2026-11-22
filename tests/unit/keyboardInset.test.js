// phone-polish item 2: what counts as the on-screen keyboard
import { describe, it, expect } from 'vitest';
import { keyboardInsets, isTextField, KB_MIN } from '../../src/lib/ui/keyboardInset.js';

describe('keyboardInsets', () => {
	it('the HONOR numbers: 587 → 251 visible with a field focused = 336 px of keyboard', () => {
		expect(keyboardInsets({ innerHeight: 587, vvHeight: 251, vvTop: 0, typing: true })).toEqual({ inset: 336, top: 0 });
	});
	it('a panned visual viewport splits into top + bottom', () => {
		expect(keyboardInsets({ innerHeight: 587, vvHeight: 251, vvTop: 100, typing: true })).toEqual({ inset: 236, top: 100 });
	});
	it('nothing without a focused text field (the URL bar, a keyboard left from elsewhere)', () => {
		expect(keyboardInsets({ innerHeight: 587, vvHeight: 251, vvTop: 0, typing: false })).toEqual({ inset: 0, top: 0 });
	});
	it('a collapsing URL bar is not a keyboard', () => {
		expect(keyboardInsets({ innerHeight: 640, vvHeight: 640 - 56, vvTop: 0, typing: true })).toEqual({ inset: 0, top: 0 });
		expect(KB_MIN).toBeGreaterThan(56);
	});
	it('a pinch zoom is not a keyboard', () => {
		expect(keyboardInsets({ innerHeight: 800, vvHeight: 400, vvTop: 0, scale: 2, typing: true })).toEqual({ inset: 0, top: 0 });
	});
});

describe('isTextField', () => {
	const el = (/** @type {string} */ tag, /** @type {string} */ type = '') => ({ tagName: tag, type, isContentEditable: false });
	it('text inputs and textareas, not buttons/checkboxes/ranges', () => {
		expect(isTextField(/** @type {any} */ (el('INPUT', 'text')))).toBe(true);
		expect(isTextField(/** @type {any} */ (el('INPUT', 'search')))).toBe(true);
		expect(isTextField(/** @type {any} */ (el('TEXTAREA')))).toBe(true);
		expect(isTextField(/** @type {any} */ (el('INPUT', 'checkbox')))).toBe(false);
		expect(isTextField(/** @type {any} */ (el('INPUT', 'range')))).toBe(false);
		expect(isTextField(/** @type {any} */ (el('BUTTON')))).toBe(false);
		expect(isTextField(null)).toBe(false);
		expect(isTextField(/** @type {any} */ ({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
	});
});
