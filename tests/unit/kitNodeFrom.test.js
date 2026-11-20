import { describe, it, expect } from 'vitest';
import { createKit } from '../../src/lib/kit/core.js';
import pickupsSpec from '../../src/lib/kit/pickups.spec.js';
import { KIT_PIECES } from '../../src/lib/kit/index.js';

// 2.0-n3b (N3a pickup-own control, red after step 0a): `On Enter -> Collect pickup` credited the coin to the
// AUTHORITY, not to the player who walked into it — a node action carried no player, so `ctx.from` was
// whichever peer's identical request the authority applied first (its own). runNodeAction takes `from`
// (the peer whose event made the stamp) now. Counterfactual: without `from`, both rows credit 'A'.
/** @param {string} me @param {boolean} authority @param {any[]} sent */
function makeKit(me, authority, sent) {
	let t = 1000;
	return createKit(
		{ me: () => me, now: () => (t += 10), send: (m) => sent.push(m), isAuthority: () => authority },
		KIT_PIECES
	);
}

describe('2.0-n3b kit node actions act for the peer whose event fired them', () => {
	it('the authority applies a node collect for B, not for itself', () => {
		expect(pickupsSpec.piece).toBe('pickups');
		const k = makeKit('A', true, []);
		const r = k.runNodeAction('kit-pickups-collect', { pickup: 'coin-1', score: 1 }, { rid: 'node:n1:5', from: 'B' });
		expect(r).toMatchObject({ ok: true });
		expect(k.doc().slices.pickups.taken['coin-1'].by).toBe('B');
	});

	it('a non-authority asks FOR B with the shared id (one change however many peers saw it)', () => {
		const sent = /** @type {any[]} */ ([]);
		const k = makeKit('C', false, sent);
		k.runNodeAction('kit-pickups-collect', { pickup: 'coin-1' }, { rid: 'node:n1:5', from: 'B' });
		expect(sent.at(-1)).toMatchObject({ type: 'kitreq', rid: 'node:n1:5', from: 'B', op: 'collect' });
	});

	it('no `from` keeps the old rule (the asker), and an API call is never affected', () => {
		const k = makeKit('A', true, []);
		k.runNodeAction('kit-pickups-collect', { pickup: 'coin-2' }, { rid: 'node:n2:6' });
		expect(k.doc().slices.pickups.taken['coin-2'].by).toBe('A');
	});
});
