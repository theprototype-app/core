// phone-polish item 1: the Back stack's rules, against a fake history (no router, no DOM).
import { describe, it, expect } from 'vitest';
import { createBackStack } from '../../src/lib/backStackCore.js';

/** a history of entries; `top` is the current one. back() is async like the browser's. */
function fakeHistory() {
	/** @type {string[]} */
	const entries = ['base'];
	let idx = 0;
	/** @type {(() => void)[]} */
	const pending = [];
	const h = {
		entries,
		get top() {
			return entries[idx];
		},
		push(/** @type {string} */ tag) {
			entries.splice(idx + 1);
			entries.push(tag);
			idx = entries.length - 1;
		},
		back() {
			pending.push(() => {
				if (idx > 0) idx--;
			});
		},
		/** run one queued traversal and report it as a popstate */
		flush(/** @type {() => void} */ onPop) {
			while (pending.length) {
				pending.shift()?.();
				onPop();
			}
		},
		/** the USER presses Back */
		userBack(/** @type {() => void} */ onPop) {
			if (idx > 0) idx--;
			onPop();
		},
		get depth() {
			return idx;
		}
	};
	return h;
}

function setup() {
	const h = fakeHistory();
	/** @type {(() => void)[]} */
	const q = [];
	const bs = createBackStack({
		push() {
			h.push('back');
			return true;
		},
		back: () => h.back(),
		onTop: () => h.top === 'back',
		busy: () => h.top === 'play',
		defer: (fn) => q.push(fn)
	});
	/** run deferred syncs and queued traversals until both are quiet */
	const tick = () => {
		for (let n = 0; n < 20; n++) {
			while (q.length) q.shift()?.();
			let popped = false;
			h.flush(() => ((popped = true), bs.popstate()));
			if (!popped && !q.length) return;
		}
		throw new Error('back stack never settled');
	};
	return { h, bs, tick, userBack: () => (h.userBack(() => bs.popstate()), tick()) };
}

describe('back stack', () => {
	it('one marker while anything is open; Back closes the top surface only', () => {
		const { h, bs, tick, userBack } = setup();
		/** @type {any[]} */
		const closed = [];
		/** @type {Record<string, () => void>} */
		const rel = {};
		const open = (/** @type {string} */ id) => (rel[id] = bs.register(() => (closed.push(id), rel[id]()), id));
		open('menu');
		open('settings');
		tick();
		expect(h.entries).toEqual(['base', 'back']);
		userBack();
		expect(closed).toEqual(['settings']);
		expect(bs.state().open).toEqual(['menu']);
		expect(h.top).toBe('back'); // re-pushed for the one still open
		userBack();
		expect(closed).toEqual(['settings', 'menu']);
		expect(h.top).toBe('base');
		expect(bs.state().marker).toBe(false);
	});

	it('closing by other means spends the marker; the next Back is the user’s', () => {
		const { h, bs, tick } = setup();
		const release = bs.register(() => {}, 'chat');
		tick();
		expect(h.depth).toBe(1);
		release();
		tick();
		expect(h.depth).toBe(0);
		expect(bs.state()).toMatchObject({ marker: false, spending: false, open: [] });
	});

	it('close-then-open in one tick does not churn the history', () => {
		const { h, bs, tick } = setup();
		const relMenu = bs.register(() => {}, 'menu');
		tick();
		relMenu();
		bs.register(() => {}, 'dialog');
		tick();
		expect(h.entries).toEqual(['base', 'back']);
		expect(h.depth).toBe(1);
	});

	it('a surface that refuses to close never traps Back inside the app', () => {
		const { h, bs, tick, userBack } = setup();
		bs.register(() => {}, 'permanent'); // never releases
		tick();
		userBack();
		expect(bs.state().open).toEqual([]);
		expect(h.top).toBe('base');
		expect(h.depth).toBe(0);
	});

	it('suspended while playing: no marker, play keeps Back; it resumes after', () => {
		const { h, bs, tick } = setup();
		bs.suspend('play', true);
		const rel = bs.register(() => {}, 'chat');
		tick();
		expect(h.entries).toEqual(['base']);
		bs.suspend('play', false);
		tick();
		expect(h.top).toBe('back');
		rel();
		tick();
		expect(h.depth).toBe(0);
	});

	it('play’s marker above ours: our entry is spent only once it is the top again', () => {
		const { h, bs, tick } = setup();
		const rel = bs.register(() => {}, 'explorer');
		tick();
		bs.suspend('play', true);
		h.push('play'); // play pressed with Explorer open
		rel(); // Explorer closed during play
		tick();
		expect(h.top).toBe('play');
		// play exits by its ✕: it pops its own marker
		h.back();
		bs.suspend('play', false);
		tick();
		expect(h.depth).toBe(0); // our spent marker went too
	});

	it('does not push over play’s marker while its back() is on the way', () => {
		const { h, bs, tick } = setup();
		bs.suspend('play', true);
		h.push('play');
		bs.register(() => {}, 'menu');
		h.back(); // play's consume, not yet delivered
		bs.suspend('play', false);
		// sync runs before the traversal: busy → wait
		const before = [...h.entries];
		tick();
		expect(before).toEqual(['base', 'play']);
		expect(h.top).toBe('back');
		expect(h.depth).toBe(1);
	});

	it('Forward onto a spent marker gives it straight back', () => {
		const { h, bs, tick, userBack } = setup();
		/** @type {any[]} */
		const closed = [];
		let rel = () => {};
		rel = bs.register(() => (closed.push(1), rel()), 'menu');
		tick();
		userBack();
		expect(h.depth).toBe(0);
		// browser Forward
		h.push('back');
		bs.popstate();
		tick();
		expect(h.depth).toBe(0);
	});
});
