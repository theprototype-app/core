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
