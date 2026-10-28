// 55 A4 — the invite scheme's pure half. Every counterfactual the rules name lands
// refused: wrong proof, reused token, expired, revoked, a proof replayed from another
// peer id, a multi-use link past its count.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
	sha256HexSync,
	newToken,
	isToken,
	inviteKey,
	inviteId,
	inviteProof,
	dialInvite,
	makeRecord,
	inviteState,
	checkInvite,
	spendUse,
	revokeRecord,
	nameUse,
	pruneRecords,
	useLabel,
	parseHashParams,
	scrubHash,
	inviteLink,
	mcpCommand,
	chatSentence,
	INVITE_EXPIRY,
	KEEP_AFTER_MS
} from '../../src/lib/inviteCore.js';

const HOST = 'a1b2c';
const JOINER = 'e6f54';
const OTHER = '99zz9';
const T0 = 1_800_000_000_000;

describe('sha256HexSync', () => {
	it('matches node crypto on vectors incl. multi-block and UTF-8', () => {
		for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(200), 'héllo ✓ 🤖']) {
			expect(sha256HexSync(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
		}
	});
});

describe('tokens and the link', () => {
	it('mints 128-bit base64url tokens that are distinct', () => {
		const a = newToken();
		const b = newToken();
		expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(a).not.toBe(b);
		expect(isToken(a)).toBe(true);
		expect(isToken('short')).toBe(false);
		expect(isToken('has space in it aaaaaaaaa')).toBe(false);
	});

	it('parses the hash grammar shared with tools/agent', () => {
		const t = newToken();
		const p = parseHashParams('#F0FD3&agent&invite=' + t + '&x=1~srv=peer.example');
		expect(p.peerId).toBe('F0FD3');
		expect(p.agent).toBe(true);
		expect(p.invite).toBe(t);
		expect(p.params.x).toBe('1');
		expect(p.tail).toBe('~srv=peer.example');
		expect(parseHashParams('#abcde')).toMatchObject({ peerId: 'abcde', agent: false, invite: null, tail: '' });
		// a token that is not token-shaped is no token
		expect(parseHashParams('#abcde&invite=<script>').invite).toBe(null);
	});

	it('scrubs the token out of the hash', () => {
		const t = newToken();
		expect(scrubHash('#F0FD3&agent&invite=' + t)).toBe('#F0FD3');
		expect(scrubHash('#F0FD3&invite=' + t + '~srv=x', { keepTail: true })).toBe('#F0FD3~srv=x');
		expect(scrubHash('')).toBe('');
	});

	it('builds the three hand-over forms', () => {
		const t = newToken();
		const agent = inviteLink('https://theprototype.app/', HOST, t, 'agent');
		expect(agent).toBe('https://theprototype.app/#A1B2C&agent&invite=' + t);
		expect(inviteLink('https://x/', HOST, t, 'person')).toBe('https://x/#A1B2C&invite=' + t);
		expect(parseHashParams(new URL(agent).hash)).toMatchObject({ peerId: 'A1B2C', agent: true, invite: t });
		expect(mcpCommand(agent)).toBe("claude mcp add theprototype -- npx -y @theprototype/agent mcp '" + agent + "'");
		expect(chatSentence(agent, 'agent')).toContain(agent);
	});
});

describe('the record', () => {
	it('defaults: agent = edit, person = view, single use, 30 min', () => {
		const t = newToken();
		const a = makeRecord(t, { kind: 'agent' }, T0);
		expect(a).toMatchObject({ kind: 'agent', role: 'edit', maxUses: 1, expiresAt: T0 + INVITE_EXPIRY['30m'], revoked: false });
		expect(a.id).toBe(inviteId(t));
		expect(a.key).toBe(inviteKey(t));
		expect(a.key).not.toContain(t);
		const p = makeRecord(t, { kind: 'person' }, T0);
		expect(p.role).toBe('view');
		expect(makeRecord(t, { kind: 'person', role: 'edit', expiry: '24h', maxUses: 5 }, T0)).toMatchObject({
			role: 'edit',
			maxUses: 5,
			expiresAt: T0 + INVITE_EXPIRY['24h']
		});
		// out-of-menu values fall back to the defaults
		expect(makeRecord(t, { maxUses: 7, expiry: '1y', role: 'admin' }, T0)).toMatchObject({ maxUses: 1, role: 'view' });
	});
});

describe('checkInvite — the host side', () => {
	const t = newToken();
	const fresh = () => [makeRecord(t, { kind: 'agent' }, T0)];
	const meta = (joiner = JOINER, host = HOST, tok = t) => dialInvite(tok, joiner, host);

	it('a valid proof admits with the role the link carries', () => {
		const r = checkInvite(fresh(), meta(), JOINER, HOST, T0 + 1000);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.record.role).toBe('edit');
	});

	it('ids are compared case-insensitively (the app dials lower-case, links show upper)', () => {
		const r = checkInvite(fresh(), dialInvite(t, JOINER.toUpperCase(), HOST.toUpperCase()), JOINER, HOST, T0);
		expect(r.ok).toBe(true);
	});

	it('no invite on the dial = none (the plain-link path)', () => {
		expect(checkInvite(fresh(), null, JOINER, HOST, T0)).toMatchObject({ ok: false, reason: 'none' });
		expect(checkInvite(fresh(), { v: 2, i: 'x', p: 'y' }, JOINER, HOST, T0)).toMatchObject({ ok: false, reason: 'none' });
	});

	it('COUNTERFACTUAL wrong token → refused', () => {
		const wrong = newToken();
		// same id (the attacker copied the id) but a proof from another key
		const m = { v: 1, i: inviteId(t), p: inviteProof(inviteKey(wrong), JOINER, HOST) };
		expect(checkInvite(fresh(), m, JOINER, HOST, T0)).toMatchObject({ ok: false, reason: 'bad-proof' });
		expect(checkInvite(fresh(), meta(JOINER, HOST, wrong), JOINER, HOST, T0)).toMatchObject({ ok: false, reason: 'unknown' });
	});

	it('COUNTERFACTUAL proof replayed from another peer id → refused', () => {
		// a proof lifted off the signaling server, made for JOINER, dialled from OTHER
		expect(checkInvite(fresh(), meta(JOINER), OTHER, HOST, T0)).toMatchObject({ ok: false, reason: 'bad-proof' });
		// …or made for another host
		expect(checkInvite(fresh(), meta(JOINER, 'zzzzz'), JOINER, HOST, T0)).toMatchObject({ ok: false, reason: 'bad-proof' });
	});

	it('COUNTERFACTUAL expired → refused, even at the exact expiry', () => {
		const recs = fresh();
		expect(checkInvite(recs, meta(), JOINER, HOST, recs[0].expiresAt)).toMatchObject({ ok: false, reason: 'expired' });
		expect(checkInvite(recs, meta(), JOINER, HOST, recs[0].expiresAt - 1).ok).toBe(true);
	});

	it('COUNTERFACTUAL revoked → refused, even for the peer that already used it', () => {
		let rec = spendUse(fresh()[0], JOINER, { name: 'Claude', kind: 'agent' }, T0);
		rec = revokeRecord(rec, T0 + 5);
		expect(checkInvite([rec], meta(), JOINER, HOST, T0 + 10)).toMatchObject({ ok: false, reason: 'revoked' });
	});

	it('COUNTERFACTUAL reused single-use token → refused for a second peer, re-dial ok for the first', () => {
		const rec = spendUse(fresh()[0], JOINER, {}, T0);
		expect(checkInvite([rec], meta(OTHER), OTHER, HOST, T0)).toMatchObject({ ok: false, reason: 'used' });
		const again = checkInvite([rec], meta(JOINER), JOINER, HOST, T0);
		expect(again).toMatchObject({ ok: true, again: true });
	});

	it('COUNTERFACTUAL multi-use past its count → refused', () => {
		let rec = makeRecord(t, { kind: 'person', maxUses: 5 }, T0);
		const ids = ['p0001', 'p0002', 'p0003', 'p0004', 'p0005'];
		for (const id of ids) {
			const r = checkInvite([rec], dialInvite(t, id, HOST), id, HOST, T0);
			expect(r.ok).toBe(true);
			rec = spendUse(rec, id, {}, T0);
		}
		expect(inviteState(rec, T0)).toBe('used');
		expect(checkInvite([rec], dialInvite(t, 'p0006', HOST), 'p0006', HOST, T0)).toMatchObject({ ok: false, reason: 'used' });
	});

	it('a Person link with View carries view, never edit', () => {
		const rec = makeRecord(t, { kind: 'person' }, T0);
		const r = checkInvite([rec], meta(), JOINER, HOST, T0);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.record.role).toBe('view');
	});

	it('the dial never carries the token', () => {
		const m = meta();
		expect(JSON.stringify(m)).not.toContain(t);
		expect(dialInvite('not a token', JOINER, HOST)).toBe(null);
	});
});

describe('bookkeeping', () => {
	it('spends, names, labels', () => {
		const t = newToken();
		let rec = makeRecord(t, { kind: 'agent', maxUses: 5 }, T0);
		rec = spendUse(rec, 'E6F54', { name: '  Claude \n Code ', kind: 'agent' }, T0);
		expect(rec.uses[0]).toMatchObject({ peerId: 'e6f54', name: 'Claude Code', kind: 'agent' });
		expect(spendUse(rec, 'e6f54', {}, T0)).toBe(rec); // no double count
		expect(useLabel(rec.uses[0])).toBe('Claude Code (E6F54)');
		rec = spendUse(rec, 'aaaaa', {}, T0);
		expect(useLabel(rec.uses[1])).toBe('AAAAA');
		rec = nameUse(rec, 'aaaaa', 'Ada');
		expect(useLabel(rec.uses[1])).toBe('Ada (AAAAA)');
	});

	it('prunes records a day after they ended', () => {
		const a = makeRecord(newToken(), {}, T0);
		const b = revokeRecord(makeRecord(newToken(), { expiry: '24h' }, T0), T0 + 1);
		expect(pruneRecords(/** @type {any} */ ([a, b, null, { id: 1 }]), T0 + 10)).toHaveLength(2);
		expect(pruneRecords([a, b], a.expiresAt + KEEP_AFTER_MS + 1)).toHaveLength(0);
	});
});
