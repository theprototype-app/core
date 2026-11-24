// @ts-nocheck — plain fixtures
// A returning link proves itself (rejoinProof + rejoinLinks): the exchange both ways, the quiet link,
// the secrets' lifetimes, and that no secret reaches the diagnostics bundle.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const mem = new Map();
globalThis.sessionStorage = {
	getItem: (k) => (mem.has(k) ? mem.get(k) : null),
	setItem: (k, v) => mem.set(k, String(v)),
	removeItem: (k) => mem.delete(k)
};

/** @type {any} */ let P;
/** @type {any} */ let L;
/** @type {any} */ let R;
/** @type {any} */ let D;
beforeAll(async () => {
	P = await import('../../src/lib/rejoinProof.js');
	L = await import('../../src/lib/rejoinLinks.js');
	R = await import('../../src/lib/rejoin.js');
	D = await import('../../src/lib/diagnostics.js');
});
beforeEach(() => mem.clear());

const settle = () => new Promise((r) => setTimeout(r, 20));

/** Two ends of one link: what one side sends arrives at the other through its gate. */
function link(aId, bId) {
	const ends = {};
	const mk = (me, other) => ({
		peer: other,
		open: true,
		sent: [],
		send(m) {
			this.sent.push(m);
			queueMicrotask(() => ends[other].deliver(m));
		}
	});
	ends[aId] = { conn: mk(aId, bId), deliver: () => {} };
	ends[bId] = { conn: mk(bId, aId), deliver: () => {} };
	return ends;
}

/** A side: its controller, what reached its dispatcher, and its link's receive head. */
function side(id, ends, { accept = () => true } = {}) {
	const s = { id, applied: [], rj: null, conn: ends[id].conn };
	s.rj = L.createRelinks({ myId: () => id, acceptSecretFrom: accept, send: (conn, m) => conn.send(m) });
	ends[id].deliver = (m) => {
		if (s.rj.gate(s.conn, m, () => s.applied.push(m))) return;
		s.applied.push(m);
	};
	return s;
}

describe('the proof itself', () => {
	it('answers verify for the right roles, ids and nonce, and nothing else', async () => {
		const secret = P.mintSecret();
		const nonce = P.mintNonce();
		const m = await P.answerFor(secret, 'guest', 'b0b0b', 'a1a1a', nonce);
		expect(await P.verifyAnswer(secret, 'guest', 'b0b0b', 'a1a1a', nonce, m)).toBe(true);
		expect(await P.verifyAnswer(secret, 'host', 'b0b0b', 'a1a1a', nonce, m)).toBe(false); // a reflection
		expect(await P.verifyAnswer(secret, 'guest', 'c0c0c', 'a1a1a', nonce, m)).toBe(false); // another id
		expect(await P.verifyAnswer(secret, 'guest', 'b0b0b', 'a1a1a', P.mintNonce(), m)).toBe(false); // a replay
		expect(await P.verifyAnswer(P.mintSecret(), 'guest', 'b0b0b', 'a1a1a', nonce, m)).toBe(false);
		expect(await P.verifyAnswer(secret, 'guest', 'b0b0b', 'a1a1a', nonce, 'nope')).toBe(false);
		expect(await P.answerFor(secret, 'guest', 'b0b0b', 'a1a1a', 'short')).toBe(null);
	});

	it('mints secrets and nonces of the declared size, fresh each time', () => {
		const a = P.mintSecret();
		expect(P.isSecret(a)).toBe(true);
		expect(P.fromB64(a).length).toBe(P.SECRET_BYTES);
		expect(P.fromB64(P.mintNonce()).length).toBe(P.NONCE_BYTES);
		expect(P.mintSecret()).not.toBe(a);
		expect(P.isSecret('x'.repeat(44))).toBe(false);
		expect(P.isSecret(42)).toBe(false);
	});
});

describe('a returning link', () => {
	it('proves both ways, then runs what the open would do and replays what waited, in order', async () => {
		const ends = link('a1a1a', 'b0b0b');
		const host = side('a1a1a', ends);
		const guest = side('b0b0b', ends);
		const secret = P.mintSecret();
		const seen = [];
		host.rj.begin('b0b0b', 'host', secret, { onOk: () => seen.push('host ok'), onFail: (r) => seen.push('host fail ' + r) });
		guest.rj.begin('a1a1a', 'guest', secret, { onOk: () => seen.push('guest ok'), onFail: (r) => seen.push('guest fail ' + r) });
		expect(guest.rj.claiming('a1a1a')).toBe(true);
		expect(host.rj.claiming('b0b0b')).toBe(false);
		// content from the host before the guest has checked it waits
		host.rj.opened(host.conn, () => seen.push('host open'));
		guest.rj.opened(guest.conn, () => seen.push('guest open'));
		ends['b0b0b'].deliver({ type: 'objects', n: 1 });
		ends['b0b0b'].deliver({ type: 'objects', n: 2 });
		expect(guest.applied).toEqual([]);
		await settle();
		expect(seen).toContain('host ok');
		expect(seen).toContain('guest ok');
		expect(seen.indexOf('guest ok')).toBeLessThan(seen.indexOf('guest open'));
		expect(guest.applied.map((m) => m.n)).toEqual([1, 2]);
		expect(host.rj.pending('b0b0b')).toBe(false);
		// only the exchange crossed: one challenge and one answer each way
		expect(host.conn.sent.map((m) => m.type).sort()).toEqual(['rjc', 'rjp']);
		expect(guest.conn.sent.map((m) => m.type).sort()).toEqual(['rjc', 'rjp']);
	});

	it('a side without the secret is refused, and what it sent is dropped, never applied', async () => {
		const ends = link('a1a1a', 'b0b0b');
		const guest = side('b0b0b', ends);
		const other = side('a1a1a', ends);
		const seen = [];
		guest.rj.begin('a1a1a', 'guest', P.mintSecret(), { onOk: () => seen.push('ok'), onFail: (r) => seen.push('fail ' + r) });
		other.rj.begin('b0b0b', 'host', P.mintSecret(), { onOk: () => {}, onFail: () => {} });
		guest.rj.opened(guest.conn, () => seen.push('open'));
		other.rj.opened(other.conn, () => {});
		ends['b0b0b'].deliver({ type: 'objects' });
		await settle();
		expect(seen).toEqual(['fail proof']);
		expect(guest.applied).toEqual([]);
		// the guest sent nothing but its challenge: no answer to a host that did not prove itself
		expect(guest.conn.sent.map((m) => m.type)).toEqual(['rjc']);
	});

	it('an id with no record of us gets no answer (not an oracle), and its exchange is never applied', async () => {
		const ends = link('a1a1a', 'b0b0b');
		const host = side('a1a1a', ends);
		ends['a1a1a'].deliver({ type: 'rjc', n: P.mintNonce() });
		await settle();
		expect(host.conn.sent).toEqual([]);
		expect(host.applied).toEqual([]);
	});

	it('a captured answer does not prove a later link', async () => {
		const secret = P.mintSecret();
		const first = link('a1a1a', 'b0b0b');
		const h1 = side('a1a1a', first);
		const g1 = side('b0b0b', first);
		h1.rj.begin('b0b0b', 'host', secret, { onOk: () => {}, onFail: () => {} });
		g1.rj.begin('a1a1a', 'guest', secret, { onOk: () => {}, onFail: () => {} });
		h1.rj.opened(h1.conn, () => {});
		g1.rj.opened(g1.conn, () => {});
		await settle();
		const captured = g1.conn.sent.find((m) => m.type === 'rjp');
		expect(captured).toBeTruthy();
		// a new link: the replayer sends the old answer to the host's fresh challenge
		const second = link('a1a1a', 'b0b0b');
		const h2 = side('a1a1a', second);
		const seen = [];
		h2.rj.begin('b0b0b', 'host', secret, { onOk: () => seen.push('ok'), onFail: (r) => seen.push('fail ' + r) });
		h2.rj.opened(h2.conn, () => {});
		second['a1a1a'].deliver({ type: 'rjc', n: P.mintNonce() });
		second['a1a1a'].deliver(captured);
		await settle();
		expect(seen).toEqual(['fail proof']);
	});

	it('reflecting our own challenge and answer back does not prove anything', async () => {
		const secret = P.mintSecret();
		const ends = link('a1a1a', 'b0b0b');
		const guest = side('b0b0b', ends);
		const seen = [];
		guest.rj.begin('a1a1a', 'guest', secret, { onOk: () => seen.push('ok'), onFail: (r) => seen.push('fail ' + r) });
		guest.rj.opened(guest.conn, () => {});
		const myChallenge = guest.conn.sent.find((m) => m.type === 'rjc');
		ends['b0b0b'].deliver({ type: 'rjc', n: myChallenge.n }); // ask us to answer our own nonce
		await settle();
		// the guest answers nobody before the host has proved itself: there is no answer of ours to reflect
		expect(guest.conn.sent.map((m) => m.type)).toEqual(['rjc']);
		// a guest-role answer to our own nonce (what a reflection would hand back) is not the host's
		ends['b0b0b'].deliver({ type: 'rjp', m: await P.answerFor(secret, 'guest', 'b0b0b', 'a1a1a', myChallenge.n) });
		await settle();
		expect(seen).toEqual(['fail proof']);
		expect(guest.conn.sent.map((m) => m.type)).toEqual(['rjc']);
	});

	it('a returning guest answers only after the host proved itself, whichever comes first', async () => {
		for (const hostAsksFirst of [true, false]) {
			const secret = P.mintSecret();
			const ends = link('a1a1a', 'b0b0b');
			const guest = side('b0b0b', ends);
			const seen = [];
			guest.rj.begin('a1a1a', 'guest', secret, { onOk: () => seen.push('ok'), onFail: (r) => seen.push('fail ' + r) });
			guest.rj.opened(guest.conn, () => {});
			const mine = guest.conn.sent.find((m) => m.type === 'rjc').n;
			const hostNonce = P.mintNonce();
			const hostAnswer = { type: 'rjp', m: await P.answerFor(secret, 'host', 'a1a1a', 'b0b0b', mine) };
			if (hostAsksFirst) {
				ends['b0b0b'].deliver({ type: 'rjc', n: hostNonce });
				await settle();
				expect(guest.conn.sent.map((m) => m.type)).toEqual(['rjc']); // held: the host has not proved itself
				ends['b0b0b'].deliver(hostAnswer);
			} else {
				ends['b0b0b'].deliver(hostAnswer);
				await settle();
				expect(seen).toEqual([]); // proved, but not checked until we answered its challenge
				ends['b0b0b'].deliver({ type: 'rjc', n: hostNonce });
			}
			await settle();
			expect(seen).toEqual(['ok']);
			const sent = guest.conn.sent.map((m) => m.type);
			expect(sent).toEqual(['rjc', 'rjp']);
			expect(await P.verifyAnswer(secret, 'guest', 'b0b0b', 'a1a1a', hostNonce, guest.conn.sent[1].m)).toBe(true);
		}
	});

	it('times out, closes and floods fail; a cancel keeps the secret and runs nothing', async () => {
		const timers = [];
		const rj = L.createRelinks({ myId: () => 'b0b0b', acceptSecretFrom: () => true, send: () => {}, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} });
		const seen = [];
		rj.begin('a1a1a', 'guest', P.mintSecret(), { onOk: () => seen.push('ok'), onFail: (r) => seen.push(r) });
		timers.at(-1)();
		// nothing ever opened: the far side was not reached, which is not a failed check
		expect(seen).toEqual(['unreached']);
		const conn = { peer: 'a1a1a', send() {} };
		rj.begin('a1a1a', 'guest', P.mintSecret(), { onOk: () => {}, onFail: (r) => seen.push(r) });
		rj.opened(conn, () => {});
		timers.at(-1)();
		// opened, but not a word of the exchange came back: a page too busy to answer, not a failed check
		expect(seen.at(-1)).toBe('silent');
		rj.begin('a1a1a', 'guest', P.mintSecret(), { onOk: () => {}, onFail: (r) => seen.push(r) });
		rj.opened(conn, () => {});
		rj.gate(conn, { type: 'rjc', n: P.mintNonce() }, () => {});
		timers.at(-1)();
		expect(seen.at(-1)).toBe('timeout');
		// the host proved itself, but its own challenge never came: we sent nothing, so that is 'unasked', not a failed check
		{
			const secret = P.mintSecret();
			const sent = [];
			const g = L.createRelinks({ myId: () => 'b0b0b', acceptSecretFrom: () => true, send: (c, m) => sent.push(m), setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} });
			g.begin('a1a1a', 'guest', secret, { onOk: () => seen.push('ok'), onFail: (r) => seen.push(r) });
			g.opened(conn, () => {});
			const m = await P.answerFor(secret, 'host', 'a1a1a', 'b0b0b', sent[0].n);
			g.gate(conn, { type: 'rjp', m }, () => {});
			await settle();
			timers.at(-1)();
			expect(seen.at(-1)).toBe('unasked');
			expect(sent.map((x) => x.type)).toEqual(['rjc']);
		}
		rj.begin('a1a1a', 'guest', P.mintSecret(), { onOk: () => {}, onFail: (r) => seen.push(r) });
		rj.opened(conn, () => {});
		rj.closed(conn);
		expect(seen.at(-1)).toBe('closed');
		rj.begin('a1a1a', 'guest', P.mintSecret(), { onOk: () => {}, onFail: (r) => seen.push(r) });
		for (let i = 0; i <= 1000; i++) rj.gate(conn, { type: 'move' }, () => {});
		expect(seen.at(-1)).toBe('flood');
		rj.setHostSecret('a1a1a', P.mintSecret());
		rj.begin('a1a1a', 'guest', rj.hostSecret('a1a1a'), { onOk: () => seen.push('late ok'), onFail: () => seen.push('late fail') });
		rj.cancel('a1a1a');
		expect(rj.pending('a1a1a')).toBe(false);
		expect(rj.hostSecret('a1a1a')).not.toBe(null);
		expect(seen).not.toContain('late fail');
	});

	it('a dial is given the time asked for; once open the exchange keeps what is left, never less than its own limit', () => {
		const armed = [];
		let t = 1000;
		const rj = L.createRelinks({ myId: () => 'b0b0b', acceptSecretFrom: () => true, now: () => t, send: () => {}, setTimer: (fn, ms) => (armed.push(ms), armed.length), clearTimer: () => {} });
		rj.begin('a1a1a', 'guest', P.mintSecret(), { onOk: () => {}, onFail: () => {} }, 95000);
		t += 5000;
		rj.opened({ peer: 'a1a1a', send() {} }, () => {});
		rj.begin('c2c2c', 'host', P.mintSecret(), { onOk: () => {}, onFail: () => {} });
		t += L.RELINK_MS - 1000;
		rj.opened({ peer: 'c2c2c', send() {} }, () => {});
		expect(armed).toEqual([95000, 90000, L.RELINK_MS, P.PROOF_MS]);
	});

	it('a newer returning dial replaces the one the host still checks; a guest\'s own dial is never replaced', () => {
		const rj = L.createRelinks({ myId: () => 'b0b0b', acceptSecretFrom: () => true, send: () => {}, setTimer: () => 0, clearTimer: () => {} });
		const seen = [];
		rj.begin('a1a1a', 'host', P.mintSecret(), { onOk: () => seen.push('ok'), onFail: (r) => seen.push(r) });
		rj.supersede('a1a1a');
		expect(seen).toEqual(['replaced']);
		expect(rj.pending('a1a1a')).toBe(false);
		rj.begin('c2c2c', 'guest', P.mintSecret(), { onOk: () => seen.push('ok'), onFail: (r) => seen.push(r) });
		rj.supersede('c2c2c');
		expect(rj.pending('c2c2c')).toBe(true);
		expect(seen).toEqual(['replaced']);
	});
});

describe('the secrets', () => {
	it('a guest takes a secret only from its host, and holds it back while the link proves itself', async () => {
		let host = 'a1a1a';
		const rj = L.createRelinks({ myId: () => 'b0b0b', acceptSecretFrom: (p) => p === host, send: () => {} });
		const s = P.mintSecret();
		const fromHost = { peer: 'a1a1a' };
		const fromOther = { peer: 'c0c0c' };
		expect(rj.gate(fromOther, { type: 'rjs', s }, () => {})).toBe(true);
		expect(rj.hostSecret('c0c0c')).toBe(null);
		expect(rj.gate(fromHost, { type: 'rjs', s: 'junk' }, () => {})).toBe(true);
		expect(rj.hostSecret('a1a1a')).toBe(null);
		rj.gate(fromHost, { type: 'rjs', s }, () => {});
		expect(rj.hostSecret('a1a1a')).toBe(s);
		rj.forget('a1a1a');
		expect(rj.hostSecret('a1a1a')).toBe(null);
		host = 'z';
		rj.gate(fromHost, { type: 'rjs', s }, () => {});
		expect(rj.hostSecret('a1a1a')).toBe(null);
	});

	it('the host parks a reloading guest\'s secret for the window, hands it out once, and rotates on the next greeting', () => {
		let t = 1000;
		const rj = L.createRelinks({ myId: () => 'a1a1a', acceptSecretFrom: () => false, now: () => t });
		const sent = [];
		rj.issue('b0b0b', { send: (m) => sent.push(m) }, 'edit');
		const first = sent[0].s;
		expect(P.isSecret(first)).toBe(true);
		expect(rj.hostRecord(['b0b0b', 'c0c0c'])).toEqual({ b0b0b: { s: first, role: 'edit' } });
		rj.unloaded('b0b0b');
		expect(rj.hasIssued('b0b0b')).toBe(false);
		expect(rj.takeReturning('b0b0b')).toEqual({ s: first, role: 'edit' });
		expect(rj.takeReturning('b0b0b')).toBe(null); // once
		rj.issue('b0b0b', { send: (m) => sent.push(m) });
		expect(sent[1].s).not.toBe(first);
		rj.unloaded('b0b0b');
		t += R.REJOIN_WINDOW_MS + 1;
		expect(rj.takeReturning('b0b0b')).toBe(null); // the window ended
		rj.restoreReturning({ c0c0c: { s: P.mintSecret() }, d0d0d: { s: 'bad' } }, t);
		expect(rj.hasReturning()).toBe(true);
		expect(rj.holders()).toEqual(['c0c0c']);
		rj.reset();
		expect(rj.hasReturning()).toBe(false);
	});

	it('never reaches the diagnostics bundle', () => {
		D.startDiagnostics?.();
		const rj = L.createRelinks({ myId: () => 'a1a1a', acceptSecretFrom: () => true });
		const sent = [];
		rj.issue('b0b0b', { send: (m) => sent.push(m) });
		const s = sent[0].s;
		rj.setHostSecret('c0c0c', P.mintSecret());
		const theirs = rj.hostSecret('c0c0c');
		// even a careless line that quotes one is redacted on the way out
		D.log('info', 'net', 'probe ' + s);
		const text = D.bundleText();
		expect(text.includes(s)).toBe(false);
		expect(text.includes(theirs)).toBe(false);
		expect(text).toContain('[redacted]');
		rj.dispose();
	});
});

describe('the records', () => {
	it('a guest record carries its host\'s secret when it has one', () => {
		const s = P.mintSecret();
		R.rememberRejoin('b0b0b', 'a1a1a', 1000, s);
		expect(R.peekRejoin(1500)).toEqual({ id: 'b0b0b', host: 'a1a1a', at: 1000, s });
		R.rememberRejoin('b0b0b', 'a1a1a', 1000, 'not-a-secret');
		expect(R.peekRejoin(1500)).toEqual({ id: 'b0b0b', host: 'a1a1a', at: 1000 });
	});

	it('a host record keeps its id and its guests\' secrets for the window, read once, junk dropped', () => {
		const s = P.mintSecret();
		R.rememberHostRejoin('a1a1a', { b0b0b: { s, role: 'view' }, '<x>': { s }, c0c0c: { s: 'bad' } }, 1000);
		expect(R.takeHostRejoin(1500)).toEqual({ id: 'a1a1a', at: 1000, guests: { b0b0b: { s, role: 'view' } } });
		expect(R.takeHostRejoin(1500)).toBe(null);
		R.rememberHostRejoin('a1a1a', { b0b0b: { s } }, 1000);
		expect(R.takeHostRejoin(1001 + R.REJOIN_WINDOW_MS)).toBe(null);
		R.rememberHostRejoin('a1a1a', {}, 1000); // no guest holds one: nothing is kept
		expect(mem.has(R.HOST_REJOIN_KEY)).toBe(false);
		mem.set(R.HOST_REJOIN_KEY, '{nope');
		expect(R.takeHostRejoin()).toBe(null);
		R.rememberRejoin('b0b0b', 'a1a1a', 1000, s);
		R.rememberHostRejoin('a1a1a', { b0b0b: { s } }, 1000);
		R.forgetRejoinRecords();
		expect(mem.size).toBe(0);
	});
});

describe('a dial that cannot prove it', () => {
	it('does not use up the real guest\'s way back, and never extends its window', () => {
		let t = 1000;
		const rj = L.createRelinks({ myId: () => 'a1a1a', acceptSecretFrom: () => false, now: () => t });
		const sent = [];
		rj.issue('b0b0b', { send: (m) => sent.push(m) });
		rj.unloaded('b0b0b');
		const s = sent[0].s;
		t += 1000;
		expect(rj.takeReturning('b0b0b')).toEqual({ s });
		rj.putBack('b0b0b'); // the other page failed
		expect(rj.takeReturning('b0b0b')).toEqual({ s }); // the real guest still can
		rj.putBack('b0b0b', false); // and proved it: spent
		expect(rj.takeReturning('b0b0b')).toBe(null);
		rj.issue('c0c0c', { send: (m) => sent.push(m) });
		rj.unloaded('c0c0c');
		rj.takeReturning('c0c0c');
		t = 2000 + R.REJOIN_WINDOW_MS + 1; // c0c0c said goodbye at 2000
		rj.putBack('c0c0c');
		expect(rj.takeReturning('c0c0c')).toBe(null); // the window counts from the first goodbye
	});
});
