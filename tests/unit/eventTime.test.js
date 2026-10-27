import { describe, it, expect } from 'vitest';
import { eventNow } from '../../src/lib/eventTime.js';

// 54 X4: a tap is timed by when its events happened, not when their handlers ran.
describe('eventNow', () => {
	it('puts an event timestamp on the Date.now() clock', () => {
		const t = eventNow({ timeStamp: 1234.5 });
		expect(t).toBeCloseTo(performance.timeOrigin + 1234.5, 3);
		expect(Math.abs(eventNow({ timeStamp: performance.now() }) - Date.now())).toBeLessThan(50);
	});
	it('a slow handler does not lengthen the interval between two events', () => {
		const down = eventNow({ timeStamp: 1000 });
		const up = eventNow({ timeStamp: 1120 });
		expect(up - down).toBeCloseTo(120, 6);
	});
	it('falls back to Date.now() without a timestamp', () => {
		for (const e of [null, undefined, {}, { timeStamp: 0 }]) {
			expect(Math.abs(eventNow(e) - Date.now())).toBeLessThan(50);
		}
	});
});
