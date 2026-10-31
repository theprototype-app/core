import { describe, it, expect } from 'vitest';
import { createDialBackQueue, DIAL_BACK_QUEUE_CAP } from '../../src/lib/dialBackQueue.js';

// scatter-sync: the host's room broadcasts held for a joiner whose approval dial-back has not
// opened yet, flushed in order after its handshake.

describe('dialBackQueue', () => {
	it('flushes in order, once, per peer', () => {
		const q = createDialBackQueue();
		q.hold('b', { type: 'create', uuid: '1' });
		q.hold('c', { type: 'create', uuid: 'x' });
		q.hold('b', { type: 'objectParameters', uuid: '1' });
		expect(q.size('b')).toBe(2);
		expect(q.take('b').map((p) => p.type)).toEqual(['create', 'objectParameters']);
		expect(q.take('b')).toEqual([]);
		expect(q.take('c')).toEqual([{ type: 'create', uuid: 'x' }]);
	});

	it('abandons the WHOLE queue past the cap, and holds nothing more for that peer', () => {
		const q = createDialBackQueue({ cap: 3 });
		for (let i = 0; i < 3; i++) expect(q.hold('b', { i })).toBe(true);
		expect(q.hold('b', { i: 3 })).toBe(false);
		expect(q.overflowed('b')).toBe(true);
		expect(q.hold('b', { i: 4 })).toBe(false);
		expect(q.take('b')).toEqual([]);
		// a later dial-back starts clean
		expect(q.hold('b', { i: 5 })).toBe(true);
		expect(q.take('b')).toEqual([{ i: 5 }]);
	});

	it('does not flush what outlived the ttl', () => {
		let t = 1000;
		const q = createDialBackQueue({ ttlMs: 100, now: () => t });
		q.hold('b', { n: 'old' });
		t = 1150;
		q.hold('b', { n: 'new' });
		expect(q.take('b')).toEqual([{ n: 'new' }]);
	});

	it('drop forgets a peer', () => {
		const q = createDialBackQueue();
		q.hold('b', { n: 1 });
		q.drop('b');
		expect(q.take('b')).toEqual([]);
		expect(DIAL_BACK_QUEUE_CAP).toBeGreaterThan(100);
	});
});
