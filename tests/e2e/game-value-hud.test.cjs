// 102b-hud — Game values in the HUD without code, the HUD / logic paper cuts and the game feel nodes,
// on two connected peers through the real runtime:
//   1. Game Value: a shared variable and a published value written as words into HUD Text on both
//      peers (fraction, clock), and a value handle into HUD Bar;
//   2. a level grid answered by ONE HUD Button node (screen mode): the pressed button's value reaches
//      both peers through Set Variable op text; the button's click sound plays for the presser only;
//   3. Show / Hide Element hides one element (the DOM slot is hidden, the others stay);
//   4. Screen Flash / Hit Pause: who: me acts only where the press was made, everyone on both.
// Run: APP_URL=https://localhost:7094/ npm run e2e -- game-value-hud
const h = require('./helpers.cjs');

const HUD = () => {
	window.__tp.test.v1.hudDocs.setHudDocFor('scene', {
		screens: [
			{
				id: 'main',
				name: 'Main',
				elements: [
					{ id: 'coins', kind: 'text', label: '', anchor: 'top-left', x: 20, y: 20, w: 200, h: 26 },
					{ id: 'clock', kind: 'text', label: '', anchor: 'top-center', x: 0, y: 20, w: 120, h: 26 },
					{ id: 'lives', kind: 'bar', label: '', anchor: 'bottom-center', x: 0, y: 40, w: 220, h: 16 },
					{ id: 'tip', kind: 'text', label: 'Pick a level', anchor: 'middle-left', x: 20, y: 0, w: 200, h: 26 },
					{ id: 'picked', kind: 'text', label: '', anchor: 'middle-right', x: 20, y: 0, w: 200, h: 26 },
					{ id: 'lv1', kind: 'button', label: 'Level 1', value: '1', sound: 'click', anchor: 'center', x: -70, y: 80, w: 120, h: 34 },
					{ id: 'lv2', kind: 'button', label: 'Level 2', value: '2', sound: 'click', anchor: 'center', x: 70, y: 80, w: 120, h: 34 }
				]
			}
		],
		active: 'main'
	});
};

const GRAPH = () => {
	const s = window.__tp.test.v1;
	const N = (id, type, data, x = 0, y = 0) => ({ id, type, position: { x, y }, data: { type, ...data } });
	s.flowNodes.set([
		// 1. words from values
		N('gvCoins', 'gamevalue', { read: 'variable', name: 'coins', format: 'fraction', max: 10, prefix: 'Coins ' }),
		N('txCoins', 'hudtext', { element: 'coins', format: '', decimals: 0, value: 0 }, 250),
		N('gvClock', 'gamevalue', { read: 'published', name: 'runTime', format: 'time', decimals: 1, empty: 'not yet' }, 0, 120),
		N('txClock', 'hudtext', { element: 'clock', format: '', decimals: 0, value: 0 }, 250, 120),
		N('gvLives', 'gamevalue', { read: 'variable', name: 'lives' }, 0, 240),
		N('barLives', 'hudbar', { element: 'lives', min: 0, max: 3, value: 0, format: '' }, 250, 240),
		// 2. one node for the level grid -> a text variable -> a HUD Text
		N('grid', 'hudbutton', { element: '', screen: 'main' }, 0, 360),
		N('setPick', 'setvariable', { name: 'level', op: 'text', scope: 'shared', value: 0 }, 250, 360),
		N('gvPick', 'gamevalue', { read: 'variable', name: 'level', format: 'text', prefix: 'Level ', empty: 'none' }, 500, 360),
		N('txPick', 'hudtext', { element: 'picked', format: '', decimals: 0, value: 0 }, 750, 360),
		// 3. the press hides the tip
		N('hideTip', 'hudvisible', { element: 'tip', action: 'hide' }, 250, 480),
		// 4. feel: me and everyone
		N('flashMe', 'screenflash', { color: '#ff3040', strength: 0.5, seconds: 0.2, who: 'me' }, 250, 600),
		N('pauseAll', 'hitpause', { ms: 60, who: 'everyone' }, 250, 720)
	]);
	const E = (source, target, sourceHandle, targetHandle) => ({ id: `e-${source}-${sourceHandle ?? ''}-${target}-${targetHandle ?? ''}`, source, target, sourceHandle: sourceHandle ?? null, targetHandle: targetHandle ?? null });
	s.flowEdges.set([
		E('gvCoins', 'txCoins', null, 'format'),
		E('gvClock', 'txClock', null, 'format'),
		E('gvLives', 'barLives', 'value', 'value'),
		E('grid', 'setPick', null, 'trigger'),
		E('grid', 'setPick', 'value', 'value'),
		E('gvPick', 'txPick', null, 'format'),
		E('grid', 'hideTip', null, 'trigger'),
		E('grid', 'flashMe', null, 'trigger'),
		E('grid', 'pauseAll', null, 'trigger')
	]);
};

const pushGraph = async (from, to, expectIds) => {
	await from.page.evaluate((peerId) => window.__tp.test.v1.nodesHandler.sendNodes(peerId), to.id);
	for (let i = 0; i < 40; i++) {
		const ids = await to.page.evaluate(() => {
			let nodes;
			window.__tp.test.v1.flowNodes.subscribe((v) => (nodes = v))();
			return nodes.map((n) => n.id);
		});
		if (expectIds.every((id) => ids.includes(id))) return true;
		await to.page.waitForTimeout(250);
	}
	return false;
};
const elText = (peer, id) => peer.page.evaluate((elId) => document.querySelector(`[data-hud-id="${elId}"] .hud-el`)?.textContent?.trim() ?? null, id);
const hidden = (peer, id) => peer.page.evaluate((elId) => !!document.querySelector(`[data-hud-id="${elId}"]`)?.classList.contains('hud-hidden'), id);
const fx = (peer) => peer.page.evaluate(() => window.__tp.test.v1.gameKit.gameFeelFx.gameFeelFxDebug());
const sfx = (peer) => peer.page.evaluate(() => { const d = window.__tp.test.v1.gameKit.gameSfx.gameSfxDebug(); return d.played + d.muted + d.dropped; });

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__tp?.test.v1?.hudDocs && !!window.__tp?.test.v1?.gameKit, null, { timeout: 60000 });
	await h.connect(A, B);
	await A.page.evaluate(HUD);
	await A.page.evaluate(GRAPH);
	h.check(await pushGraph(A, B, ['gvCoins', 'grid', 'pauseAll']), 'B has the graph');
	await A.page.waitForTimeout(1200);

	console.log('\n=== 1. Game Value -> HUD Text / Bar ===');
	await A.page.evaluate(() => {
		const s = window.__tp.test.v1;
		s.gameState.setGameVar('coins', 7);
		s.gameState.setGameVar('lives', 2);
	});
	for (const [p, n] of [[A, 'A'], [B, 'B']])
		await h.eventually(() => elText(p, 'coins'), (t) => t === 'Coins 7 / 10', `${n}: a shared variable written as "Coins 7 / 10"`, 6000);
	// a PUBLISHED value is per peer: A publishes, B has none and shows the "when empty" text
	await A.page.evaluate(() => window.__tp.test.v1.gameKit.gameValues.setGameValue('runTime', 64.24, {}, 'suite'));
	await h.eventually(() => elText(A, 'clock'), (t) => t === '1:04.2', 'A: a published run time as a clock (1:04.2)', 4000);
	await h.eventually(() => elText(B, 'clock'), (t) => t === 'not yet', 'B: nothing published there -> the when-empty words', 4000);
	const bar = await A.page.evaluate(() => {
		let v;
		window.__tp.test.v1.hudDocs.hudRuntime.subscribe((x) => (v = x))();
		return v.lives;
	});
	h.check(bar?.value === 2 && bar?.max === 3, 'the value handle drives HUD Bar (2 of 3)', JSON.stringify(bar));

	console.log('\n=== 2. one HUD Button node for a level grid; the click sound ===');
	h.check((await elText(A, 'picked')) === 'none', 'nothing picked yet');
	const sA0 = await sfx(A);
	const sB0 = await sfx(B);
	await A.page.evaluate(() => window.__tp.test.v1.objectActions.setEditorMode('interact'));
	await B.page.evaluate(() => window.__tp.test.v1.objectActions.setEditorMode('interact'));
	await A.page.waitForTimeout(400);
	const fxA0 = await fx(A);
	const fxB0 = await fx(B);
	const fired = await A.page.evaluate(() => window.__tp.test.v1.flowRuntime.fireHudButton('lv2'));
	h.check(fired === 1, 'pressing Level 2 fires the one screen-mode node', String(fired));
	for (const [p, n] of [[A, 'A'], [B, 'B']])
		await h.eventually(() => elText(p, 'picked'), (t) => t === 'Level 2', `${n}: the pressed button's value reached Set Variable (text) -> "Level 2"`, 6000);
	h.check((await sfx(A)) > sA0, 'the button sound played for the presser (A)');
	h.check((await sfx(B)) === sB0, 'and not on the other peer (B)');
	await A.page.evaluate(() => window.__tp.test.v1.flowRuntime.fireHudButton('lv1'));
	await h.eventually(() => elText(B, 'picked'), (t) => t === 'Level 1', 'a second press of another button: B reads Level 1', 6000);

	console.log('\n=== 3. Show / Hide Element ===');
	for (const [p, n] of [[A, 'A'], [B, 'B']]) {
		await h.eventually(() => hidden(p, 'tip'), (v) => v === true, `${n}: the tip is hidden by the press`, 4000);
		h.check((await hidden(p, 'coins')) === false, `${n}: the other elements stay`);
	}

	console.log('\n=== 4. Screen Flash (me) and Hit Pause (everyone) ===');
	await h.eventually(() => fx(A), (d) => d.flashes >= fxA0.flashes + 1 && d.pauses >= fxA0.pauses + 1, 'A (the presser): flashed and paused', 4000);
	await h.eventually(() => fx(B), (d) => d.pauses >= fxB0.pauses + 1, 'B: paused (who: everyone)', 4000);
	const fxB = await fx(B);
	h.check(fxB.flashes === fxB0.flashes, 'B: no flash (who: me is the presser only)', JSON.stringify(fxB));
	const overlay = await A.page.evaluate(() => {
		const el = document.getElementById('tp-screen-flash');
		return el ? { pe: getComputedStyle(el).pointerEvents, bg: el.style.background } : null;
	});
	h.check(!!overlay && overlay.pe === 'none', 'the flash overlay takes no pointer', JSON.stringify(overlay));

	console.log('\n=== 5. reduced motion turns the flash down ===');
	await A.page.evaluate(() => {
		const s = window.__tp.test.v1;
		s.gameKit.gameFeelFx.resetGameFeelFx();
	});
	const strengths = await A.page.evaluate(async () => {
		const k = window.__tp.test.v1.gameKit.gameFeelFx;
		const m = await import('/src/lib/motion.js').catch(() => null);
		const out = {};
		k.screenFlash({ strength: 0.9 });
		out.full = k.gameFeelFxDebug().lastFlash.strength;
		if (m) {
			m.motionPref.set('reduce');
			k.screenFlash({ strength: 0.9 });
			out.reduced = k.gameFeelFxDebug().lastFlash.strength;
			m.motionPref.set('system');
		}
		return out;
	});
	if (strengths.reduced !== undefined) h.check(Math.abs(strengths.reduced - 0.3) < 1e-6 && strengths.full === 0.9, 'reduced motion: the flash at a third', JSON.stringify(strengths));
	else console.log('  (motion module not reachable on a built app: covered by tests/unit/gameFeelFx)');

	console.log('\n=== 6. a scene saved by this build (for the older-release check) ===');
	await A.page.evaluate(() => window.__tp.test.v1.objectActions.setEditorMode('edit'));
	const bytes = await A.page.evaluate(async () => {
		const s = window.__tp.test.v1;
		const zip = await s.sessions.exportSessionZip(s.sessions.buildSessionPayload('game-value-hud'), { assets: true, packs: false, flow: true });
		return Array.from(zip);
	});
	const out = require('path').resolve(__dirname, '../../test-results/102b-hud');
	require('fs').mkdirSync(out, { recursive: true });
	require('fs').writeFileSync(out + '/lane-saved.tpscene', Buffer.from(bytes));
	h.check(bytes.length > 1000, 'saved the scene to test-results/102b-hud/lane-saved.tpscene', String(bytes.length));

	console.log('\n=== 7. B reloads and rejoins: the graph, the variables and the words come back ===');
	await h.freshReload(B);
	// a reload is a new Peer: answer the restore offer, read the new id, join again
	await h.answerRestore(B).catch(() => {});
	B.id = await B.page.evaluate(() => new Promise((r) => window.__tp.test.v1.peers.subscribe((p) => r(p?.peer?.id))()));
	await h.connect(A, B);
	await h.eventually(
		() => B.page.evaluate(() => { let n; window.__tp.test.v1.flowNodes.subscribe((v) => (n = v))(); return n.some((x) => x.id === 'gvCoins'); }),
		(v) => v === true,
		'B after reload: the graph is back (late-joiner sync)',
		60000
	);
	await h.eventually(() => elText(B, 'coins'), (t) => t === 'Coins 7 / 10', 'B after reload: "Coins 7 / 10" from the replicated variable', 20000);
	await h.eventually(() => elText(B, 'picked'), (t) => t === 'Level 1', 'B after reload: the text variable reads "Level 1"', 20000);

	await h.finish(browser);
});
