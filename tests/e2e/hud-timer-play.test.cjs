// 92-correct row 1 — an autostart HUD Timer counts from Play (or the round), not while editing;
// a pause stops it; a late joiner reads the host's time.
//
// Red on v1.74.0: the timer counted from when the page first saw the node, so 6 s in the editor
// already read 114 of 120 (2.0-eval2 Q3; the round-timer eval task scored 0/10 on it).
//
// Run: APP_URL=https://localhost:5927/ npm run e2e -- hud-timer-play
const h = require('./helpers.cjs');

const HUD = () => {
	const s = /** @type {any} */ (window).__tp.test.v1;
	s.hudDocs.setHudDocFor('scene', {
		screens: [{ id: 'main', name: 'Main', elements: [{ id: 'clock', kind: 'timer', label: '', anchor: 'top-center', x: 0, y: 20, w: 120, h: 26 }] }],
		active: 'main'
	});
	s.flowNodes.set([
		{ id: 'timer', type: 'hudtimer', position: { x: 0, y: 0 }, data: { type: 'hudtimer', element: 'clock', duration: 120, format: '{v}', decimals: 1, autostart: true } }
	]);
	s.flowEdges.set([]);
};

/** the timer's number from the runtime store (the layer renders it; the store is what every peer derives) */
const clock = (/** @type {any} */ p) =>
	p.page.evaluate(() => {
		/** @type {any} */
		let v;
		/** @type {any} */ (window).__tp.test.v1.hudDocs.hudRuntime.subscribe((/** @type {any} */ x) => (v = x))();
		const n = Number(String(v?.clock?.text ?? '').replace(/[^0-9.]/g, ''));
		return Number.isFinite(n) && v?.clock ? n : null;
	});
const E = (/** @type {any} */ p, /** @type {Function} */ fn, /** @type {any} */ arg) => p.page.evaluate(fn, arg);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const playing = (/** @type {any} */ p) =>
	E(p, () => {
		/** @type {any} */
		let v;
		/** @type {any} */ (window).__tp.test.v1.isLocked.subscribe((/** @type {any} */ x) => (v = x))();
		return v === true;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!(/** @type {any} */ (window).__tp?.test.v1?.hudDocs), { timeout: 30000 });
	await E(A, HUD);

	// ---- 1. the editor: the timer waits, however long the scene sits there ----------------------
	await h.eventually(() => clock(A), (v) => v !== null, 'the timer element has a value', 10000);
	const ed0 = await clock(A);
	await sleep(6000);
	const ed1 = await clock(A);
	h.check(ed0 === 120 && ed1 === 120, `in the editor the timer shows its full time and waits (${ed0} then ${ed1} after 6 s; red on v1.74.0: ~114)`);

	// ---- 2. plain Play (no round): counts from the Play press ----------------------------------
	await E(A, () => /** @type {any} */ (window).__tp.test.v1.playMode.requestPlay({ flat: true }));
	await h.eventually(() => playing(A), (v) => v === true, 'Play started', 15000);
	await sleep(400);
	const p0 = await clock(A);
	await sleep(4000);
	const p1 = await clock(A);
	h.check(p0 !== null && p0 >= 117 && p0 <= 120, `the timer starts near 2:00 when Play starts (${p0})`);
	h.check(p0 !== null && p1 !== null && p0 - p1 >= 2.5 && p0 - p1 <= 6, `and counts down in Play (${p0} -> ${p1} over 4 s)`);

	// ---- 3. a round: counts from the round's start, a pause stops it ----------------------------
	await E(A, () => /** @type {any} */ (window).__tp.test.v1.gameState.setGameState('playing'));
	await sleep(600);
	const r0 = await clock(A);
	h.check(r0 !== null && r0 >= 118.5, `a new round starts the clock at its full time (${r0})`);
	await sleep(3000);
	await E(A, () => /** @type {any} */ (window).__tp.test.v1.gameState.setGameState('paused'));
	await sleep(500);
	const z0 = await clock(A);
	await sleep(4000);
	const z1 = await clock(A);
	h.check(z0 !== null && z0 === z1, `a pause stops it (${z0} -> ${z1} over 4 s paused)`);
	await E(A, () => /** @type {any} */ (window).__tp.test.v1.gameState.setGameState('playing'));
	await sleep(2000);
	const z2 = await clock(A);
	h.check(z0 !== null && z2 !== null && z0 - z2 >= 1 && z0 - z2 <= 3.5, `and resume carries on from where it held (${z0} -> ${z2} 2 s after resume)`);

	// ---- 4. a late joiner reads the host's time --------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!(/** @type {any} */ (window).__tp?.test.v1?.hudDocs), { timeout: 30000 });
	// the JOINER dials the host (the host is in Play, where the dial field is hidden)
	await h.connect(B, A);
	await h.eventually(() => clock(B), (v) => v !== null, 'the joiner has the timer', 30000);
	await h.eventually(
		async () => {
			const [a, b] = [await clock(A), await clock(B)];
			return a !== null && b !== null ? Math.abs(a - b) : 99;
		},
		(d) => d <= 1,
		'the late joiner reads the host clock (within 1 s)',
		20000
	);
	const [la, lb] = [await clock(A), await clock(B)];
	h.check(la !== null && lb !== null && Math.abs(la - lb) <= 1 && lb < 117, `late joiner ${lb} vs host ${la}`);

	await browser.close();
});
