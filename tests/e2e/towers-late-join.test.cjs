// fix-batch-4 G18 — A PLAYER WHO JOINS TOWERS MID-ROUND SEES THE LIVE ROUND, not "ROUND OVER ... 0 m".
// device-lab-3 (2026-11-08) read "ROUND OVER Your best tower: 0 m Back to menu" on both joiners of a
// running Towers round. Two peers: A loads the REAL .tpscene (TOWERS_TPSCENE, or the sibling scenes
// checkout), plays and starts level 1; B joins while the round runs and presses Play. B must read the
// round A is in: game state 'playing' on the same round, the in-round HUD screen (not 'over'), a
// running clock and the height readout — and A's round must be untouched by B's arrival.
// Skip-never-fail without a Towers scene (authored content, not core code).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) =>
	fs.existsSync(p)
);
const TPSCENE = process.env.TOWERS_TPSCENE || (SCENES_REPO && path.join(SCENES_REPO, 'games/towers/scene.tpscene'));

h.run(async () => {
	if (!TPSCENE || !fs.existsSync(TPSCENE)) {
		console.log('SKIP: no games/towers/scene.tpscene (set TOWERS_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const bytes = Array.from(fs.readFileSync(TPSCENE));
	await A.page.evaluate(async (arr) => {
		const s = window.__tp?.test.v1;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await A.page.waitForTimeout(1500);
	const modern = await A.page.evaluate(() => {
		/** @type {any} */ let g;
		window.__tp.test.v1.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		return !!g.getObjectByName('Towers game');
	});
	if (!modern) {
		console.log('SKIP: this Towers scene predates 31 (no "Towers game" marker) — a stale scenes checkout; set TOWERS_TPSCENE');
		await h.finish(browser);
		return;
	}

	const snap = (/** @type {any} */ p) =>
		p.page.evaluate(() => {
			const s = window.__tp?.test.v1;
			/** @type {any} */ let gs;
			s.gameState.gameState.subscribe((/** @type {any} */ v) => (gs = v))();
			return { state: gs?.state ?? null, round: gs?.round ?? null, screen: s.hudDocs.visibleScreen('scene')?.id ?? null, level: window.__towers?.vars?.().twLevel ?? null };
		});
	const hud = async (/** @type {any} */ p) => ((await p.page.locator('#hud-layer').textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');

	// ---- A plays level 1
	await A.page.evaluate(() => window.__towers?.resetProgress?.());
	await A.page.evaluate(() => window.__tp.test.v1.isLocked.set(true));
	await h.eventually(() => snap(A), (s) => s.state === 'menu' && s.screen === 'menu', 'A: the game opens on the level select', 15000);
	await A.page.locator('#hud-layer button', { hasText: '1 · Stack' }).first().click();
	await h.eventually(() => snap(A), (s) => s.state === 'playing' && s.level === 1, 'A: level 1 starts', 10000);
	await A.page.waitForTimeout(3000);
	const before = await snap(A);

	// ---- B joins the running round, then presses Play
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	// A stays in play (leaving would end a round nobody else plays), so its approval goes through the same
	// call the card's button makes rather than a click on a card the play screen covers
	await B.page.waitForFunction(() => {
		/** @type {any} */ let p;
		window.__tp.test.v1.peers.subscribe((/** @type {any} */ v) => (p = v))();
		return !!p?.peer?.open;
	}, null, { timeout: 60000 });
	await B.page.evaluate((/** @type {string} */ id) => window.__tp.test.v1.peerApproval.requestConnect(id), A.id);
	const openTo = (/** @type {any} */ p, /** @type {string} */ id) =>
		p.page.evaluate((/** @type {string} */ pid) => {
			/** @type {any} */ let pc;
			window.__tp.test.v1.peers.subscribe((/** @type {any} */ v) => (pc = v))();
			return !!pc.connections?.[pid]?.open && !!pc.openedPeers?.has(pid);
		}, id);
	// approve once the request is in (the card's own call), again only if nothing opened after 20 s
	for (let tries = 0; tries < 3 && !((await openTo(A, B.id)) && (await openTo(B, A.id))); tries++) {
		await A.page.waitForTimeout(3000);
		await A.page.evaluate((/** @type {string} */ id) => window.__tp.test.v1.peerApproval.approvePeer(id), B.id).catch(() => {});
		for (const until = Date.now() + 20000; Date.now() < until; await A.page.waitForTimeout(500)) if ((await openTo(A, B.id)) && (await openTo(B, A.id))) break;
	}
	h.check((await openTo(A, B.id)) && (await openTo(B, A.id)), 'premise: B joined A while A plays');
	await h.eventually(() => B.page.evaluate(() => !!window.__towers), (v) => v, 'B: the towers module runs on the joiner', 30000);
	await B.page.waitForTimeout(1500);
	const atJoin = { snap: await snap(B), hud: await hud(B) };
	console.log(`  B at join: ${JSON.stringify(atJoin.snap)} hud="${atJoin.hud.slice(0, 160)}"`);
	await B.page.evaluate(() => window.__tp.test.v1.isLocked.set(true));
	await B.page.waitForTimeout(2500);
	const bPlay = await snap(B);
	const bHud = await hud(B);
	console.log(`  B in play: ${JSON.stringify(bPlay)} hud="${bHud.slice(0, 200)}"`);
	h.check(bPlay.state === 'playing' && bPlay.round === before.round, `B reads A's live round: playing, round ${before.round} (${bPlay.state}, round ${bPlay.round})`);
	h.check(bPlay.screen !== 'over' && !/round over/i.test(bHud), `B is not shown the round-over card (screen ${bPlay.screen})`);
	h.check(bPlay.level === 1, `B reads the level A is playing (twLevel ${bPlay.level})`);
	const clock = (/** @type {string} */ t) => (t.match(/\d+:\d\d/) ?? [''])[0];
	await h.eventually(() => hud(B), (t) => /Level 1 · Stack/.test(t) && !!clock(t), `B's HUD shows the level and a clock (${clock(bHud) || 'none'})`, 8000);
	const c1 = clock(await hud(B));
	await B.page.waitForTimeout(2200);
	const c2 = clock(await hud(B));
	h.check(!!c1 && !!c2 && c1 !== c2, `B's round clock runs (${c1} -> ${c2})`);
	const cA = clock(await hud(A));
	const secs = (/** @type {string} */ c) => (c ? Number(c.split(':')[0]) * 60 + Number(c.split(':')[1]) : NaN);
	h.check(Math.abs(secs(cA) - secs(c2)) <= 2, `B's clock agrees with A's within 2 s (A ${cA}, B ${c2})`);
	h.check(/m\b/.test(bHud) || /Goal/.test(bHud), `B's HUD carries the height readout (${(bHud.match(/[^|]{0,30}\bm\b/) ?? [''])[0]})`);
	const after = await snap(A);
	h.check(after.state === 'playing' && after.round === before.round, `A's round is untouched by the late join (${after.state}, round ${after.round})`);
	await h.finish(browser);
});
