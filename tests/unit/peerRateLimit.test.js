// 71 TR7: the token buckets.
import { describe, it, expect } from 'vitest';
import { createRateLimiter, rateKind, RATE_PRESETS } from '../../src/lib/peerRateLimit.js';

const NORMAL = /** @type {NonNullable<typeof RATE_PRESETS.normal>} */ (RATE_PRESETS.normal);
const STRICT = /** @type {NonNullable<typeof RATE_PRESETS.strict>} */ (RATE_PRESETS.strict);

describe('peer rate limits', () => {
	it('counts discrete edits and chat, never a stream or a state reply', () => {
		for (const t of ['create', 'delete', 'clearscene', 'nodecreate']) expect(rateKind(t)).toBe('edit');
		expect(rateKind('sent')).toBe('chat');
		for (const t of ['move', 'camera', 'object', 'objectfile', 'nodes', 'hosts', 'cloud', 'getobjects', 'drawlive', 'kick', undefined]) expect(rateKind(t)).toBe(null);
	});

	it("71-int: a scene transfer's groups are full state; a grouping edit still counts", () => {
		const transfer = { type: 'group', name: 'G', uuid: 'u', groupparent: null, pos: [0, 0, 0], rot: [0, 0, 0, 'XYZ'], scale: [1, 1, 1] };
		expect(rateKind('group', transfer)).toBe(null);
		expect(rateKind('group', { type: 'group', command: '/group Selection', uuid: 'u' })).toBe('edit');
		expect(rateKind('group', { type: 'group', uuid: 'u', group: 'up' })).toBe('edit');
		expect(rateKind('group')).toBe('edit'); // no message = the old answer
		expect(rateKind('graphcreate', { type: 'graphcreate', uuid: 'u' })).toBe(null);
		// a joiner sharing 500 groups to a Strict host: all through (the bug: 120 then refused)
		const l = createRateLimiter(() => 1000);
		let refused = 0;
		for (let i = 0; i < 500; i++) if (l.take('j', 'group', 'strict', transfer) !== 'ok') refused++;
		expect(refused).toBe(0);
		// counterfactual: the same count as grouping edits runs out at the burst
		for (let i = 0; i < 500; i++) if (l.take('j', 'group', 'strict', { type: 'group', command: '/group x', uuid: 'u' }) !== 'ok') refused++;
		expect(refused).toBe(500 - STRICT.edit.burst);
	});

	it('lets a burst through, then refills at the sustained rate', () => {
		let t = 1000;
		const l = createRateLimiter(() => t);
		const { burst } = NORMAL.chat;
		for (let i = 0; i < burst; i++) expect(l.take('a', 'sent', 'normal')).toBe('ok');
		expect(l.take('a', 'sent', 'normal')).toBe('chat');
		t += 1000;
		expect(l.take('a', 'sent', 'normal')).toBe('ok');
		expect(l.take('a', 'sent', 'normal')).toBe('chat');
		t += 3600000;
		for (let i = 0; i < burst; i++) expect(l.take('a', 'sent', 'normal')).toBe('ok');
		expect(l.take('a', 'sent', 'normal')).toBe('chat');
	});

	it('keeps a bucket per peer and per kind', () => {
		const t = 0;
		const l = createRateLimiter(() => t);
		for (let i = 0; i < NORMAL.chat.burst; i++) l.take('a', 'sent', 'normal');
		expect(l.take('a', 'sent', 'normal')).toBe('chat');
		expect(l.take('a', 'create', 'normal')).toBe('ok');
		expect(l.take('b', 'sent', 'normal')).toBe('ok');
	});

	it('a big paste passes on normal and is stopped on strict; off stops nothing', () => {
		const t = 0;
		const count = (/** @type {string} */ preset) => {
			const l = createRateLimiter(() => t);
			let n = 0;
			for (let i = 0; i < 2000; i++) if (l.take('a', 'create', preset) === 'ok') n++;
			return n;
		};
		expect(count('normal')).toBe(NORMAL.edit.burst);
		expect(count('strict')).toBe(STRICT.edit.burst);
		expect(count('off')).toBe(2000);
	});

	it('an unknown preset limits nothing; the map stays bounded', () => {
		const t = 0;
		const l = createRateLimiter(() => t);
		expect(l.take('a', 'sent', 'nonsense')).toBe('ok');
		for (let i = 0; i < 2000; i++) l.take('p' + i, 'sent', 'normal');
		expect(l.take('p1999', 'sent', 'normal')).toBe('ok');
	});
});
