// 27-A (hardening audit H1, M7, M11, M12) — ONE BAD MESSAGE USED TO KILL A CONNECTION.
//
// The dispatcher had no try/catch and trusted every payload's SHAPE. Three consequences,
// all of them silent:
//   · a null / string / number fell through 440 lines of `else if` to the final branch,
//     `data.startsWith('/')`, and threw `not a function` out of `conn.on('data')` — where
//     peerjs swallowed it and nothing counted it;
//   · a malformed structural message (`hosts` that is not an array, `userdata` likewise)
//     threw INSIDE an applier, leaving state half-applied;
//   · a `move` carrying NaN applied cleanly and poisoned the object's matrix, after which
//     every consumer that measures the scene reads NaN with nothing naming the cause.
//
// And the branch that caught a raw string routed it into `sceneCommand`, where "/clear
// all" wipes the scene AND re-broadcasts — a receiver re-broadcasting, which is golden
// rule 1 inverted. Nothing sends raw strings, so it stood armed and unreachable.
//
// Driven through a STUBBED conn: `wireData` is the real dispatcher, so handing it a fake
// connection object exercises the true path with no peer and no signaling server.
//
// Run: APP_URL=https://theprototype.app:5175/ npm run e2e -- wire-hardening
const h = require('./helpers.cjs');

const errorsFor = (page) => page.evaluate(() => window.__stores.wireErrors.wireErrors());

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'wire');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.wireErrors && !!window.__stores?.wireValidate, {
		timeout: 30000
	});

	// a real object to aim `move` at
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(700);
	const uuid = await page.evaluate(() => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return group.children[group.children.length - 1].uuid;
	});
	h.check(!!uuid, `premise: there is an object to move (${uuid})`);

	// ---- feed the REAL dispatcher a hostile stream through a stubbed conn --------------
	await page.evaluate(
		({ id }) => {
			const s = window.__stores;
			s.wireErrors.clearWireErrors();
			let pc = null;
			s.peers.subscribe((v) => (pc = v))();
			/** a minimal DataConnection: wireData only needs `peer` and `on` */
			const handlers = {};
			const conn = { peer: 'badpeer1', open: true, on: (ev, fn) => (handlers[ev] = fn), send() {} };
			pc.wireData(conn);
			window.__wire = { deliver: (m) => handlers.data(m) };
			// order matters only in that the VALID move comes last: if the handler had been
			// taken down by any earlier message, that one could not land.
			window.__wire.deliver(null);
			window.__wire.deliver('/clear all');
			window.__wire.deliver(42);
			window.__wire.deliver({ type: 'zzz-not-a-real-type' });
			window.__wire.deliver({ type: 'hosts', hosts: 'not-an-array' });
			window.__wire.deliver({ type: 'userdata', userdata: 'not-an-array' });
			window.__wire.deliver({ type: 'locked', lockeditems: 'not-an-array' });
			window.__wire.deliver({ type: 'move', uuid: id, pos: [NaN, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] });
			window.__wire.deliver({ type: 'move', uuid: id, pos: [3, 4, 5], rot: [0, 0, 0], scale: [1, 1, 1] });
		},
		{ id: uuid }
	);
	await page.waitForTimeout(400);

	// ---- 1. the handler survived, and the LAST message applied -------------------------
	const moved = await page.evaluate((id) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const o = group.getObjectByProperty('uuid', id);
		return { pos: o.position.toArray(), finite: o.position.toArray().every(Number.isFinite) };
	}, uuid);
	h.check(
		moved.pos[0] === 3 && moved.pos[1] === 4 && moved.pos[2] === 5,
		`the connection survived every hostile message — the valid move still applied (${moved.pos})`
	);
	h.check(moved.finite, 'and the object never holds a non-finite coordinate');

	// ---- 2. a page error would mean it threw out of the handler ------------------------
	h.check(
		h.pageErrors(peer).length === 0,
		`nothing threw out of conn.on('data') (${JSON.stringify(h.pageErrors(peer)).slice(0, 120)})`
	);

	// ---- 3. every rejection was COUNTED, by kind ---------------------------------------
	const errs = await errorsFor(page);
	const kinds = errs.map((e) => e.type);
	const total = errs.reduce((n, e) => n + e.count, 0);
	h.check(total >= 6, `every bad message was counted, not swallowed (${total} across ${errs.length} kinds)`);
	h.check(
		kinds.filter((k) => k === 'shape').length === 1 && errs.find((e) => e.type === 'shape').count === 3,
		`null, a string and a number are all rejected on SHAPE (${JSON.stringify(errs.find((e) => e.type === 'shape'))})`
	);
	h.check(
		kinds.includes('unknown:zzz-not-a-real-type'),
		`an unknown type is counted rather than falling through (${kinds.filter((k) => k.startsWith('unknown')).join(',')})`
	);
	for (const t of ['invalid:hosts', 'invalid:userdata', 'invalid:locked'])
		h.check(kinds.includes(t), `a malformed structural message is refused before its applier: ${t}`);
	// `move-nan` is recorded by the sanitiser, which runs BELOW the dispatcher in
	// geometries.js and has no peer in scope — so it is filed under a pseudo-peer. Every
	// failure the DISPATCHER records must name the sender.
	h.check(
		errs.filter((e) => e.type !== 'move-nan').every((e) => e.peerId === 'badpeer1'),
		`every dispatcher failure is attributed to the peer that sent it (${[...new Set(errs.map((e) => e.peerId))].join(',')})`
	);

	// ---- 4. the NaN move is REFUSED, and never reaches the matrix ----------------------
	// Two defences exist for this hazard and only the first can fire: the validator
	// requires finite components, so a NaN `move` is rejected at the gate and
	// `sanitizeTransform` (geometries.js) never runs for wire traffic. Rejection is the
	// right answer for a transform — a partially repaired pose is one nobody sent, and the
	// next message in a stream corrects it — so the sanitiser stays only as the backstop
	// for callers that do not pass through the validator.
	h.check(
		kinds.includes('invalid:move'),
		`a NaN transform is refused at the gate, before any applier (${kinds.filter((k) => k.includes('move')).join(',') || 'none'})`
	);

	// ---- 5. the raw-string branch is GONE ----------------------------------------------
	// '/clear all' was delivered above. Under the old branch it would have wiped the scene
	// and re-broadcast it; the object surviving IS the assertion.
	const survived = await page.evaluate((id) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return !!group.getObjectByProperty('uuid', id);
	}, uuid);
	h.check(survived, "a peer's raw string can no longer reach sceneCommand and clear the scene");

	// ---- 6. the counters reach the diagnostics bundle ------------------------------------
	const section = await page.evaluate(() => window.__stores.diagnostics.bundle().sections.wire);
	h.check(
		!!section && section.total >= 6 && Array.isArray(section.failures),
		`the wire counters ride the diagnostics bundle (${JSON.stringify(section).slice(0, 120)})`
	);

	// ---- 7. a departed peer's rows are dropped (golden rule 3) ---------------------------
	await page.evaluate(() => window.__stores.wireErrors.dropWireErrors('badpeer1'));
	const after = await errorsFor(page);
	h.check(
		after.every((e) => e.peerId !== 'badpeer1'),
		`a departed peer's counters are dropped, and only theirs (${after.length} row(s) left: ${after.map((e) => e.peerId + '/' + e.type).join(',')})`
	);

	await h.finish(browser);
});
