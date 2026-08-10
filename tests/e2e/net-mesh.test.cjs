// B5: mesh formation must not kill its own in-flight dials.
//
// Every `hosts` message re-enters connectToPeer for every known peer. A conn
// that hadn't fired 'open' yet was treated as broken and handed to
// restoreConnection, which CLOSES it and redials — but negotiation takes
// seconds, and the two sides fire 'open' at different times, so the closed
// conn was often one the remote had ALREADY adopted as its send channel. The
// close cascaded into a full teardown + whitelist removal on the remote, after
// which every redial was refused as a stranger: at N=5 the stress harness
// measured two peers permanently deaf to each other, at N=10 seven joins hit
// the 60s timeout. connectToPeer now leaves conns younger than the dial grace
// alone (a deferred check catches the genuinely wedged ones).
//
// Stubbed at the peer.connect level (the CLAUDE.md headless recipe) so the
// grace logic is exercised deterministically; the real-world proof is the
// net-stress harness, where N=6..10 now forms a full mesh in under a second
// per join.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const r = await A.page.evaluate(async () => {
		let pc;
		window.__stores.peers.subscribe((p) => (pc = p))();
		// signaling stub: dials return inert conn objects we control
		Object.defineProperty(pc.peer, 'open', { value: true });
		const made = [];
		pc.peer.connect = (id) => {
			const conn = { peer: id, open: false, closed: false, on() {}, send() {}, close() { this.closed = true; } };
			made.push(conn);
			return conn;
		};
		const out = {};

		// young conn: a re-entrant connectToPeer (the `hosts` path) must NOT close it
		pc.connectToPeer('aaaa1', false);
		const young = pc.connections['aaaa1'];
		pc.connectToPeer('aaaa1', false); // hosts message #1
		pc.connectToPeer('aaaa1', false); // hosts message #2
		out.youngSurvives = !young.closed && pc.connections['aaaa1'] === young;
		out.oneDial = made.length === 1;

		// ...and once it opens, the deferred stale check must leave it alone
		young.open = true;
		out.openKept = pc.connections['aaaa1'] === young;

		// stale conn: a conn that has sat un-open past the grace IS redialed
		pc.connectToPeer('bbbb2', false);
		const stale = pc.connections['bbbb2'];
		stale.__dialedAt = Date.now() - 60000;
		pc.connectToPeer('bbbb2', false);
		out.staleReplaced = stale.closed && pc.connections['bbbb2'] !== stale;

		// restoreConnection must not stack: a young restore dial in flight wins
		const restoring = pc.connections['bbbb2'];
		pc.restoreConnection('bbbb2', false, pc.peer.id, 0);
		out.restoreNotStacked = pc.connections['bbbb2'] === restoring && !restoring.closed;

		return out;
	});

	h.check(r.youngSurvives, 'a re-entrant connectToPeer leaves a young negotiating conn alone');
	h.check(r.oneDial, 'no redial happened while the conn was within the grace');
	h.check(r.openKept, 'the conn that opened stays the send channel');
	h.check(r.staleReplaced, 'a conn stale past the grace is closed and redialed');
	h.check(r.restoreNotStacked, 'parallel restoreConnection calls do not reset a fresh restore dial');

	await h.finish(browser);
});
