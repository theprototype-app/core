import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { captureStack, topCapture, pushCapture, popCapture, updateCapture, captureOwns, captureArmed, escapeTopCapture } from '../../src/lib/captureStack.js';

// 78 F5: one owner for viewport captures — the newest armed tool owns the clicks, Esc pops
// only the top, and a key that belongs elsewhere passes through.
/** @param {string} id @param {string[]} log @param {any} [extra] */
const entry = (id, log, extra = {}) => ({ id, label: id, escape: () => log.push(id), ...extra });
const esc = (target = /** @type {any} */ ({ tagName: 'CANVAS' })) => /** @type {any} */ ({ key: 'Escape', repeat: false, target });

describe('capture stack', () => {
	beforeEach(() => captureStack.set([]));

	it('push order is stack order; re-pushing moves an entry to the top; pop removes it', () => {
		const log = /** @type {string[]} */ ([]);
		pushCapture(entry('path', log));
		pushCapture(entry('measure', log));
		expect(get(topCapture)?.id).toBe('measure');
		pushCapture(entry('path', log));
		expect(get(captureStack).map((c) => c.id)).toEqual(['measure', 'path']);
		popCapture('path');
		expect(get(topCapture)?.id).toBe('measure');
		expect(captureArmed('path')).toBe(false);
	});

	it('only the TOP entry owns viewport clicks; a tool that is not on the stack keeps its old behaviour', () => {
		const log = /** @type {string[]} */ ([]);
		expect(captureOwns('measure')).toBe(true); // empty stack
		pushCapture(entry('path', log));
		pushCapture(entry('measure', log));
		expect(captureOwns('measure')).toBe(true);
		expect(captureOwns('path')).toBe(false);
		expect(captureOwns('draw')).toBe(true);
	});

	it('Esc runs the TOP entry only — the one below stays armed for the next Esc', () => {
		const log = /** @type {string[]} */ ([]);
		pushCapture(entry('path', log, { escape: () => (log.push('path'), popCapture('path')) }));
		pushCapture(entry('measure', log, { escape: () => (log.push('measure'), popCapture('measure')) }));
		expect(escapeTopCapture(esc())).toBe(true);
		expect(log).toEqual(['measure']);
		expect(get(topCapture)?.id).toBe('path');
		expect(escapeTopCapture(esc())).toBe(true);
		expect(log).toEqual(['measure', 'path']);
		expect(escapeTopCapture(esc())).toBe(false); // nothing armed: Esc is somebody else's
	});

	it('a key the top tool does not own, a text field, another key or a repeat pass through', () => {
		const log = /** @type {string[]} */ ([]);
		pushCapture(entry('measure', log, { keyOk: () => false }));
		expect(escapeTopCapture(esc())).toBe(false);
		updateCapture('measure', { keyOk: () => true });
		expect(escapeTopCapture(esc({ tagName: 'INPUT', type: 'text' }))).toBe(false);
		expect(escapeTopCapture(esc({ tagName: 'TEXTAREA' }))).toBe(false);
		expect(escapeTopCapture(/** @type {any} */ ({ key: 'Enter', target: {} }))).toBe(false);
		expect(escapeTopCapture(/** @type {any} */ ({ key: 'Escape', repeat: true, target: {} }))).toBe(false);
		// a checkbox is a control, not typing
		expect(escapeTopCapture(esc({ tagName: 'INPUT', type: 'checkbox' }))).toBe(true);
		expect(log).toEqual(['measure']);
	});

	it('updateCapture changes an entry in place and never reorders', () => {
		const log = /** @type {string[]} */ ([]);
		pushCapture(entry('draw', log));
		pushCapture(entry('path', log));
		updateCapture('draw', { label: 'Placing a spline' });
		expect(get(captureStack).map((c) => [c.id, c.label])).toEqual([
			['draw', 'Placing a spline'],
			['path', 'path']
		]);
		updateCapture('nope', { label: 'x' });
		expect(get(captureStack)).toHaveLength(2);
	});
});
