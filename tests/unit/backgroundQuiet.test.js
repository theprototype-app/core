// A phone backgrounding the tab: two pieces of noise the owner saw on 1.57.0 (OPPO Find N6,
// Android Chrome) — a "Something went wrong: ResizeObserver loop…" toast, and the 3D-view
// overlay + error report for a WebGL context the browser handed straight back on return.
import { describe, it, expect, beforeEach } from 'vitest';
import { toastsUncaught } from '$lib/diagnostics.js';
import { ignoredMessage } from '$lib/errorReportCore.js';
import {
	CONTEXT_LOSS_GRACE_MS as G,
	lossInit,
	lossStep,
	lossDeadline,
	startContextLossGate,
	resetContextLossGateForTest
} from '$lib/contextLoss.js';

describe('the error toast skips what error reports skip', () => {
	const noise = [
		'ResizeObserver loop completed with undelivered notifications.',
		'ResizeObserver loop limit exceeded',
		'Script error.',
		'The play() request was interrupted by a call to pause().',
		'The operation was aborted.',
		'AbortError: signal is aborted without reason'
	];
	it.each(noise)('no toast for %s', (m) => {
		expect(ignoredMessage(m)).toBe(true);
		expect(toastsUncaught(m)).toBe(false);
	});
	it('a real error still toasts', () => {
		expect(toastsUncaught("Cannot read properties of undefined (reading 'position')")).toBe(true);
	});
	it('one list: every message agrees between the two', () => {
		for (const m of [...noise, 'x is not defined', 'boom', '']) expect(toastsUncaught(m)).toBe(!ignoredMessage(m));
	});
});

/** run a script of [event, at] through the rule */
const run = (/** @type {boolean} */ visible, /** @type {[any, number][]} */ steps) => {
	let s = lossInit(0, visible);
	for (const [e, t] of steps) s = lossStep(s, e, t);
	return s;
};

describe('a lost 3D view is quiet when it comes back', () => {
	it('lost while hidden, restored right after the page shows: quiet', () => {
		const s = run(true, [['hidden', 1000], ['lost', 1100], ['tick', 30000], ['visible', 60000], ['restored', 60500]]);
		expect(s.loud).toBe(false);
		expect(s.lost).toBe(false);
	});
	it('lost while hidden, nothing pending until the page shows', () => {
		const s = run(true, [['hidden', 1000], ['lost', 1100]]);
		expect(lossDeadline(s)).toBe(null);
		expect(lossStep(s, 'tick', 999999).loud).toBe(false);
	});
	it('lost while hidden, still lost GRACE after the page shows: loud', () => {
		const s = run(true, [['hidden', 1000], ['lost', 1100], ['visible', 60000]]);
		expect(lossDeadline(s)).toBe(60000 + G);
		expect(lossStep(s, 'tick', 60000 + G - 1).loud).toBe(false);
		expect(lossStep(s, 'tick', 60000 + G).loud).toBe(true);
	});
	it('lost while visible, restored inside GRACE: quiet', () => {
		const s = run(true, [['lost', 5000], ['tick', 5000 + G - 1], ['restored', 5000 + G - 1]]);
		expect(s.loud).toBe(false);
	});
	it('lost while visible and held: loud at GRACE, and the restore clears it', () => {
		let s = run(true, [['lost', 5000], ['tick', 5000 + G]]);
		expect(s.loud).toBe(true);
		s = lossStep(s, 'restored', 9000);
		expect(s.loud).toBe(false);
	});
	it('hiding stops the clock, and showing again restarts it from zero', () => {
		const s = run(true, [['lost', 5000], ['hidden', 6000], ['tick', 20000], ['visible', 30000], ['tick', 30000 + G - 1]]);
		expect(s.loud).toBe(false);
		expect(lossStep(s, 'tick', 30000 + G).loud).toBe(true);
	});
	it('a second lost event does not restart a running clock', () => {
		const s = run(true, [['lost', 5000], ['lost', 7000]]);
		expect(lossDeadline(s)).toBe(5000 + G);
	});
});

describe('the gate drives the loud store', () => {
	beforeEach(() => resetContextLossGateForTest());
	const fakeDoc = () => {
		/** @type {Record<string, () => void>} */
		const on = {};
		return {
			visibilityState: 'visible',
			addEventListener: (/** @type {string} */ t, /** @type {() => void} */ f) => (on[t] = f),
			fire(/** @type {'visible' | 'hidden'} */ v) {
				this.visibilityState = v;
				on.visibilitychange?.();
			}
		};
	};
	const stores = () => {
		/** @type {(v: boolean) => void} */
		let sub = () => {};
		const shown = { v: false, set(/** @type {boolean} */ x) { this.v = x; } };
		return { lost: { subscribe: (/** @type {any} */ f) => ((sub = f), f(false), () => {}), set: (/** @type {boolean} */ v) => sub(v) }, shown };
	};
	it('hide, lose, show, restore: the loud store never rises', () => {
		let t = 0;
		const doc = fakeDoc();
		const { lost, shown } = stores();
		/** @type {boolean[]} */
		const seen = [];
		const watch = { set: (/** @type {boolean} */ v) => (shown.set(v), seen.push(v)) };
		startContextLossGate(lost, watch, { doc: /** @type {any} */ (doc), now: () => t });
		t = 100; doc.fire('hidden');
		t = 200; lost.set(true);
		t = 9000; doc.fire('visible');
		t = 9500; lost.set(false);
		expect(seen.every((v) => v === false)).toBe(true);
	});
});
