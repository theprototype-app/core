// 65 M2 + M6 — TWO PEERS: the background document and the smoke look entry are SCENE DATA (they ride the
// existing shader-graph and scene-look sync), while the pointer that moves a background and the smoke a
// pointer stirs are each viewer's own.
//   1. A applies a background preset: B receives the same document (preset, layer) and draws it
//   2. A switches it to Off and back: B follows; A removes it: B's goes too
//   3. a late JOINER (C dials after the background exists) receives it in the handshake
//   4. A adds the smoke entry: B composites it; A's pointer strokes add dye on A only
//   5. the pointer is local: A's pointer moves A's background pointer, not B's
// Run: APP_URL=https://localhost:5461/ node tests/e2e/visuals-two-peer.test.cjs
const h = require('./helpers.cjs');

const bg = (p) => p.page.evaluate(() => window.__stores.backgroundLayer.backgroundLayerDebug());
const fl = (p) => p.page.evaluate(() => window.__stores.fluidLayer.fluidLayerDebug());
const dye = (p) => p.page.evaluate(() => window.__stores.fluidLayer.readFluidDyeForTest());

async function rectOf(p) {
	return p.page.evaluate(() => {
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const b = r.domElement.getBoundingClientRect();
		return { x: b.x, y: b.y, w: b.width, h: b.height };
	});
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const opts = { context: { viewport: { width: 1100, height: 720 } } };
	const A = await h.setupPage(browser, 'A', opts);
	const B = await h.setupPageQuiet(browser, 'B', [A], opts);
	for (const p of [A, B]) {
		await h.answerRestore(p).catch(() => {});
		await p.page.evaluate(() => window.__stores.qualityGovernor.setAutoQuality(false));
	}
	await h.connect(B, A);

	console.log('\n=== 1. the background replicates ===');
	const r = await A.page.evaluate(() => window.__stores.backgroundPresets.applyBackgroundPreset('soft-gradient'));
	h.check(r.ok, '1.0 A applies the built-in preset');
	await h.eventually(() => bg(B), (s) => s.preset === 'soft-gradient' && s.draw === 'screen', 'B has it', 15000).catch(() => {});
	let b = await bg(B);
	h.check(b.preset === 'soft-gradient' && b.draw === 'screen' && b.compiled, '1.1 B receives the document and draws it: ' + JSON.stringify({ preset: b.preset, draw: b.draw, compiled: b.compiled }));

	console.log('\n=== 2. edits and removal follow ===');
	await A.page.evaluate(() => window.__stores.backgroundLayer.setBackgroundLayer({ mode: 'off' }));
	await h.eventually(() => bg(B), (s) => s.layer?.mode === 'off', 'B off', 10000).catch(() => {});
	b = await bg(B);
	h.check(b.layer?.mode === 'off' && b.draw === 'none', '2.1 Off on A: B keeps the document and stops drawing: ' + JSON.stringify({ mode: b.layer?.mode, draw: b.draw }));
	await A.page.evaluate(() => window.__stores.backgroundLayer.setBackgroundLayer({ mode: 'screen' }));
	await h.eventually(() => bg(B), (s) => s.draw === 'screen', 'B on', 10000).catch(() => {});
	h.check((await bg(B)).draw === 'screen', '2.2 back on: B draws again');

	console.log('\n=== 3. a late joiner ===');
	const C = await h.setupPageQuiet(browser, 'C', [A, B], opts);
	await h.answerRestore(C).catch(() => {});
	await h.connect(C, A);
	await h.eventually(() => bg(C), (s) => s.preset === 'soft-gradient' && s.draw === 'screen', 'C has it', 20000).catch(() => {});
	const c = await bg(C);
	h.check(c.preset === 'soft-gradient' && c.draw === 'screen', '3.1 C, dialing after the background exists, receives it: ' + JSON.stringify({ preset: c.preset, draw: c.draw }));
	await C.ctx.close().catch(() => {});

	console.log('\n=== 4. the smoke entry is shared, the smoke is not ===');
	await A.page.evaluate(() => {
		const sp = window.__stores.scenePost;
		sp.setScenePostEnabled(true);
		const id = sp.addPostEffect('fluid');
		sp.setPostEffectParams(id, { auto: false, fade: 0.2 });
	});
	await h.eventually(() => fl(B), (s) => s.presenter === 'post', 'B smoke', 15000).catch(() => {});
	h.check((await fl(B)).presenter === 'post', '4.1 B receives the look entry and composites the smoke');
	await A.page.waitForTimeout(600);
	const a0 = await dye(A);
	const b0 = await dye(B);
	const ra = await rectOf(A);
	await A.page.mouse.move(ra.x + ra.w * 0.2, ra.y + ra.h * 0.5);
	for (let i = 1; i <= 30; i++) {
		await A.page.mouse.move(ra.x + ra.w * (0.2 + 0.6 * (i / 30)), ra.y + ra.h * (0.5 + 0.1 * Math.sin(i / 4)));
		await A.page.waitForTimeout(16);
	}
	await A.page.waitForTimeout(200);
	const a1 = await dye(A);
	const b1 = await dye(B);
	h.check(a1.total > a0.total + 5, '4.2 A\'s pointer stirs A\'s smoke (' + a0.total.toFixed(1) + ' -> ' + a1.total.toFixed(1) + ')');
	h.check(b1.total <= b0.total + 1, '4.3 ...and none of it reaches B (' + b0.total.toFixed(1) + ' -> ' + b1.total.toFixed(1) + ')');

	console.log('\n=== 5. the background pointer is local ===');
	const pB0 = (await bg(B)).pointer;
	await A.page.mouse.move(ra.x + ra.w * 0.9, ra.y + ra.h * 0.1);
	await A.page.waitForTimeout(800);
	const pA = (await bg(A)).pointer;
	const pB1 = (await bg(B)).pointer;
	h.check(pA.x > 0.7, '5.1 A\'s pointer moves A\'s background pointer (x ' + pA.x.toFixed(3) + ')');
	h.check(Math.abs(pB1.x - pB0.x) < 1e-6 && Math.abs(pB1.y - pB0.y) < 1e-6, '5.2 ...B\'s does not move (' + JSON.stringify([pB0.x, pB1.x]) + ')');

	await A.page.evaluate(() => window.__stores.backgroundLayer.removeBackground());
	await h.eventually(() => bg(B), (s) => !s.preset && s.draw === 'none', 'B removed', 10000).catch(() => {});
	b = await bg(B);
	h.check(b.preset === null && b.draw === 'none', '5.3 A removes the background: B\'s is gone too: ' + JSON.stringify({ preset: b.preset, draw: b.draw }));
	await h.finish(browser);
});
