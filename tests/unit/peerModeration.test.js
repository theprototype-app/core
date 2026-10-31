// Roadmap 55 A9 — who may remove a peer, and what a receiver does with a kick. Pure:
// peerModerationCore imports nothing.
import { describe, it, expect } from 'vitest';
import {
	kickAllowedFrom,
	kickDecision,
	canModerateWith,
	isKickMessage,
	createModerationState,
	REMOVED_HOLD_MS
} from '../../src/lib/peerModerationCore.js';
import { validateWireMessage } from '../../src/lib/wireValidate.js';

const HOST = 'aaaa1';
const B = 'bbbb2';
const C = 'cccc3';
const roles = (/** @type {Record<string,string>} */ m) => (/** @type {string} */ id) => m[id] ?? 'viewer';

describe('kickAllowedFrom (receive side)', () => {
	it('OSS: only the session host', () => {
		expect(kickAllowedFrom(HOST, { host: HOST })).toBe(true);
		expect(kickAllowedFrom(B, { host: HOST })).toBe(false);
		// we ARE the host (host null): nobody may remove peers from us by message
		expect(kickAllowedFrom(B, { host: null })).toBe(false);
	});
	it('cloud: an admin, or the host; an editor or viewer never', () => {
		const roleOf = roles({ [HOST]: 'admin', [B]: 'editor', x: 'admin' });
		expect(kickAllowedFrom(HOST, { host: HOST, roleOf })).toBe(true);
		expect(kickAllowedFrom('x', { host: HOST, roleOf })).toBe(true);
		expect(kickAllowedFrom(B, { host: HOST, roleOf })).toBe(false);
		expect(kickAllowedFrom(C, { host: HOST, roleOf })).toBe(false);
	});
	it('a throwing roles bridge refuses', () => {
		expect(kickAllowedFrom(B, { host: HOST, roleOf: () => { throw new Error('x'); } })).toBe(false);
	});
});

describe('kickDecision', () => {
	const ctx = { host: HOST };
	it('the host removes C: B removes C, C leaves', () => {
		expect(kickDecision({ peer: C, block: true }, HOST, B, ctx)).toBe('remove');
		expect(kickDecision({ peer: C, block: true }, HOST, C, ctx)).toBe('self');
	});
	it('an editor/guest kick is ignored by every receiver (counterfactual: same message from the host acts)', () => {
		expect(kickDecision({ peer: C }, B, C, ctx)).toBe('ignore');
		expect(kickDecision({ peer: C }, B, HOST, { host: null })).toBe('ignore');
		expect(kickDecision({ peer: C }, HOST, C, ctx)).toBe('self');
	});
	it('allow back', () => {
		expect(kickDecision({ peer: C, allow: true }, HOST, B, ctx)).toBe('allow');
		expect(kickDecision({ peer: C, allow: true }, B, HOST, { host: null })).toBe('ignore');
	});
	it('malformed or self-addressed messages do nothing', () => {
		expect(kickDecision({}, HOST, B, ctx)).toBe('ignore');
		expect(kickDecision({ peer: 7 }, HOST, B, ctx)).toBe('ignore');
		expect(kickDecision({ peer: C, block: 'yes' }, HOST, B, ctx)).toBe('ignore');
		expect(kickDecision({ peer: HOST }, HOST, B, ctx)).toBe('ignore');
	});
});

describe('canModerateWith (what the menu offers)', () => {
	it('OSS: the host with somebody connected', () => {
		expect(canModerateWith({ host: null, hasRoles: false, connected: true })).toBe(true);
		expect(canModerateWith({ host: null, hasRoles: false, connected: false })).toBe(false);
		expect(canModerateWith({ host: HOST, hasRoles: false, connected: true })).toBe(false);
	});
	it('cloud: admins', () => {
		expect(canModerateWith({ host: HOST, hasRoles: true, amAdmin: true, connected: true })).toBe(true);
		expect(canModerateWith({ host: null, hasRoles: true, amAdmin: false, connected: true })).toBe(false);
	});
});

describe('the wire shape agrees with the core', () => {
	for (const m of [{ peer: C }, { peer: C, block: true }, { peer: C, allow: true }, { peer: '' }, { peer: C, block: 1 }, {}]) {
		it(JSON.stringify(m), () => {
			expect(validateWireMessage({ type: 'kick', ...m })).toBe(isKickMessage(m));
		});
	}
});

describe('moderation state', () => {
	it('a block holds until allowed back; a removal holds briefly', () => {
		let t = 1000;
		const s = createModerationState(() => t);
		s.remove(C, { block: true, name: 'Cee', by: HOST });
		s.remove(B);
		expect(s.isBlocked(C)).toBe(true);
		expect(s.isBlocked(B)).toBe(false);
		expect(s.isHeldOut(B)).toBe(true);
		t += REMOVED_HOLD_MS + 1;
		expect(s.isHeldOut(B)).toBe(false);
		expect(s.isHeldOut(C)).toBe(true);
		expect(s.list()).toEqual([{ peerId: C, name: 'Cee', at: 1000, by: HOST }]);
		expect(s.allow(C)).toBe(true);
		expect(s.isHeldOut(C)).toBe(false);
		expect(s.allow(C)).toBe(false);
	});
	it('an approval forgets the removal hold, never a block', () => {
		const s = createModerationState(() => 0);
		s.remove(B);
		s.remove(C, { block: true });
		s.forget(B);
		s.forget(C);
		expect(s.isHeldOut(B)).toBe(false);
		expect(s.isBlocked(C)).toBe(true);
		s.reset();
		expect(s.list()).toEqual([]);
	});
});
