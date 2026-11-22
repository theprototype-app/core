import { describe, it, expect } from 'vitest';
import { JOIN_ASK_WAIT_MS, JOIN_DIAL_GIVE_UP_MS, joinSettled, nextJoinState } from '../../src/lib/connector/joinWatch.js';

const base = { requested: false, linkOpen: false, joined: false, startedAt: 0, now: 1000 };
const start = (/** @type {any} */ state) => /** @type {any} */ ( ({ session: 'ZZZ99', state, note: '', at: 0 }));

describe('mcp-fix: what became of a join', () => {
	it('a dial nobody answers stays dialing, and never claims a host was reached', () => {
		const s = nextJoinState(start('dialing'), { ...base, requested: true });
		expect(s.state).toBe('dialing');
		expect(s.note).not.toMatch(/Approve/);
	});
	it('a dial nothing answers gives up, while one the host answered goes on waiting for Approve', () => {
		const late = { ...base, requested: true, now: JOIN_DIAL_GIVE_UP_MS + 1 };
		expect(nextJoinState(start('dialing'), late).state).toBe('failed');
		expect(nextJoinState(start('dialing'), { ...late, now: JOIN_DIAL_GIVE_UP_MS - 1 }).state).toBe('dialing');
		expect(nextJoinState(start('waiting'), { ...late, linkOpen: true }).state).toBe('waiting');
	});
	it('the request ending with no link means no such session', () => {
		const s = nextJoinState(start('dialing'), base);
		expect(s.state).toBe('failed');
		expect(s.note).toMatch(/No session ZZZ99 is online/);
		expect(joinSettled(s.state)).toBe(true);
	});
	it('only an answered link means the host has to press Approve', () => {
		expect(nextJoinState(start('dialing'), { ...base, requested: true, linkOpen: true }).note).toMatch(/press Approve/);
	});
	it('a request ending after the host answered is the host not letting us in', () => {
		expect(nextJoinState(start('waiting'), base).note).toMatch(/did not let this tab in/);
	});
	it('joined wins, and a settled join stays settled', () => {
		const s = nextJoinState(start('waiting'), { ...base, requested: true, linkOpen: true, joined: true });
		expect(s.state).toBe('joined');
		expect(nextJoinState(s, base)).toBe(s);
	});
	it('an open question waits for the person, then gives up', () => {
		expect(nextJoinState(start('asking'), base).state).toBe('asking');
		expect(nextJoinState(start('asking'), { ...base, now: JOIN_ASK_WAIT_MS + 1 }).state).toBe('failed');
		expect(nextJoinState(start('asking'), { ...base, requested: true }).state).toBe('dialing');
	});
	it('an unchanged state keeps its first timestamp', () => {
		const s = { ...start('dialing'), note: 'x', at: 5 };
		expect(nextJoinState(s, { ...base, requested: true })).toBe(s);
	});
});
