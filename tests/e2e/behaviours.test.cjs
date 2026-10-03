// 34 R3 (D1 + D2) — BEHAVIOURS IN THE APP, on real peers. The rules are proven on the headless
// logic sim (tests/unit/sim/behaviours.test.js); this suite proves what the sim cannot: a
// `behaviour` NODE's file loaded through the module loader on every peer, its handlers run once
// (the authority) over the real `bhv` wire + wireValidate, the handshake to a late joiner, the
// DERIVED LIVE NODE VIEW in the Flow dock (live values, fired glow, a knob that rewrites the source
// literal as one undo entry), the two proof ports SIDE BY SIDE with their node versions, and the
// lifecycle teardown when the node is deleted (T2).
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const WAVES = fs.readFileSync(path.join(ROOT, 'static/behaviours/waves-spawner.js'), 'utf8');
const REACH = fs.readFileSync(path.join(ROOT, 'static/behaviours/towers-reach.js'), 'utf8');
const EVIDENCE = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-34/34-behaviours';

/** a probe module: an api handle on window, and an EVENT node type a test can pulse */
const PROBE = () => {
	const s = /** @type {any} */ (window).__stores;
	s.moduleSDK.initModules([
		{
			id: 'bhvprobe',
			name: 'Behaviour probe',
			version: '1.0.0',
			register(/** @type {any} */ api) {
				/** @type {any} */ (window).__bApi = api;
				api.registerNodeGroup({ group: 'Behaviour probe', items: [{ type: 'bhvprobe', label: 'Probe pulse', defaults: {} }] });
				api.registerValueNode('bhvprobe', () => 0, { vtype: 'event' });
			}
		}
	]);
	return !!(/** @type {any} */ (window).__bApi?.kit);
};
const B_ = (/** @type {any} */ p, /** @type {Function} */ fn, /** @type {any} */ arg) => p.page.evaluate(fn, arg);
const dbg = (/** @type {any} */ p) => B_(p, () => {
	const d = /** @type {any} */ (window).__stores.behaviours.behavioursDebug();
	return { status: d.status, authority: d.authority, me: d.me, stats: d.stats };
});
const liveOf = (/** @type {any} */ p, /** @type {string} */ id) => B_(p, (i) => /** @type {any} */ (window).__stores.behaviours.behavioursDebug().live(i), id);
const robots = (/** @type {any} */ p) => B_(p, () => /** @type {any} */ (window).__stores.kit.kit.impls.spawner.count('robot'));
const codeOf = (/** @type {any} */ p, /** @type {string} */ id) =>
	B_(p, (i) => /** @type {any} */ (window).__stores.findNodeAnyGraph((/** @type {any} */ n) => n.id === i)?.node?.data?.code ?? null, id);
const killAll = (/** @type {any} */ p) =>
	B_(p, () => {
		const k = /** @type {any} */ (window).__stores.kit.kit.impls;
		for (const e of k.spawner.extra.list({ kind: 'robot', alive: true })) k.health.damage(e.id, 999);
	});

h.run(async () => {
	fs.mkdirSync(EVIDENCE, { recursive: true });
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) h.check(await B_(p, PROBE), p.id + ': probe module up');
	const palette = await B_(A, () => /** @type {any} */ (window).__stores.nodeCatalog.nodeCatalog.flatMap((/** @type {any} */ g) => g.items).some((/** @type {any} */ i) => i.type === 'behaviour'));
	h.check(palette, 'the node palette has a Behaviour node');
	await h.connect(B, A);
	const [da, db] = [await dbg(A), await dbg(B)];
	h.check(!!da.authority && da.authority === db.authority, `both peers name ONE authority for behaviours (the kit's: ${da.authority})`);
	const auth = da.authority === A.id ? A : B;
	const other = auth === A ? B : A;

	// ---- 1. a behaviour node: the file loads on BOTH peers through the module loader -----------
	const [wid] = await B_(A, (code) => /** @type {any} */ (window).__bApi.flow.addNodes({ nodes: [{ type: 'behaviour', x: 40, y: 40, data: { name: 'Waves spawner', code } }] }), WAVES);
	await h.eventually(() => Promise.all([A, B].map((p) => dbg(p))), (v) => v.every((d) => d.status[wid]?.status === 'running'), 'the Waves behaviour node RUNS on both peers (analyzed, loaded through the module loader)', 15000);
	const reg = await B_(A, (i) => /** @type {any} */ (window).__stores.behaviours.behavioursDebug().registrations(i), wid);
	h.check((reg.kit ?? 0) >= 2, 'T2: its kit listeners are tracked in its lifecycle module (' + JSON.stringify(reg) + ')');

	// the LINT gate: a file that would make peers disagree does not load anywhere
	const [bad] = await B_(A, () =>
		/** @type {any} */ (window).__bApi.flow.addNodes({ nodes: [{ type: 'behaviour', x: 40, y: 900, data: { name: 'Dice', code: 'export default behaviour({ state: {n: 0}, on: { go() { this.state.n = Math.random(); } } });' } }] })
	);
	await h.eventually(() => Promise.all([A, B].map((p) => dbg(p))), (v) => v.every((d) => d.status[bad]?.status === 'error' && /Math\.random/.test(d.status[bad].errors?.[0]?.message ?? '')), 'a behaviour using Math.random is REFUSED on both peers, with the lint\'s reason (line ' + 1 + ')', 10000);
	await h.eventually(() => B_(A, (i) => /** @type {any} */ (window).__stores.behaviours.behavioursDebug().live(i), bad), (v) => v === null, '…and nothing of it runs', 3000);
	await B_(A, (i) => {
		const s = /** @type {any} */ (window).__stores;
		s.nodesHandler.deleteFlowNodes([i], 'scene');
		let peer;
		s.peers.subscribe((/** @type {any} */ x) => (peer = x))();
		/** @type {any} */ (peer)?.send({ type: 'nodedelete', ids: [i], graphId: 'scene' });
	}, bad);

	// ---- 2. the handlers run ONCE (authority), state reaches everyone over the real wire --------
	await B_(other, () => {
		const k = /** @type {any} */ (window).__bApi.kit;
		k.round.configure(1, 0, 'lose', 1);
		k.round.start();
	});
	await h.eventually(() => Promise.all([A, B].map((p) => liveOf(p, wid))), (v) => v.every((l) => l?.state?.wave === 1 && l.state.alive === 2), 'round go -> wave 1, alive 2 on BOTH peers (the authority ran on.go, `bhv` carried the state)', 12000);
	await h.eventually(() => Promise.all([robots(A), robots(B)]), (v) => v[0] === 2 && v[1] === 2, 'two robot entities, spawned ONCE, drawn on both peers', 8000);
	const fired = await Promise.all([A, B].map((p) => liveOf(p, wid)));
	h.check(fired.every((l) => l.fired['on.go']?.n === 1), 'on.go fired once — and every peer knows (the glow rides the document)');
	const disp = await Promise.all([A, B].map((p) => dbg(p)));
	h.check((auth === A ? disp[1] : disp[0]).stats.dispatched === 0, 'the non-authority ran no handler');

	// ---- 3. the DERIVED LIVE VIEW in the Flow dock ---------------------------------------------
	// the page a person LOOKS at: a background tab's timers are throttled to 1 Hz, which no
	// 10 Hz view (or 0.9 s glow) survives
	await A.page.bringToFront();
	await A.page.setViewportSize({ width: 1500, height: 900 });
	await B_(A, (i) => {
		const s = /** @type {any} */ (window).__stores;
		s.bottomDock?.dockHeight?.set?.(560);
		s.flowGraphClose.set(false);
		s.behaviourViewOpen.set({ id: i, graphId: 'scene' });
	}, wid);
	await A.page.waitForSelector('#behaviour-view [data-bview-kind="state"]', { timeout: 10000 });
	const kinds = await A.page.$$eval('#behaviour-view [data-bview-kind]', (els) => els.map((e) => e.getAttribute('data-bview-kind')));
	const count = (/** @type {string} */ k) => kinds.filter((x) => x === k).length;
	h.check(count('event') === 2 && count('param') === 6 && count('fn') === 3 && count('state') === 2 && count('kit') === 3 && count('timer') === 1, 'the view derives events 2, params 6, functions 3, state 2, kit calls 3, a timer (' + kinds.length + ' nodes)');
	await h.eventually(() => A.page.$$eval('#behaviour-view [data-bview-kind="state"] [data-bview-value]', (els) => els.map((e) => e.textContent?.trim())), (v) => v.join(',') === '1,2', 'live values on the state nodes: wave 1, alive 2', 5000);
	const kitLabels = await A.page.$$eval('#behaviour-view [data-bview-kind="kit"] .bview-label', (els) => els.map((e) => e.textContent?.trim()));
	h.check(kitLabels.includes('Spawn entities') && kitLabels.includes('Win round'), 'kit calls are drawn as the kit\'s own nodes (T3): ' + kitLabels.join(', '));
	// the fired glow: kill the wave, the died handler fires on the authority and glows HERE. Sampled
	// IN the page every 100 ms (a 0.9 s glow is shorter than a round trip of eventually's polls)
	// the same view open on the OTHER peer too: whichever is not the authority sees the glow only
	// through the replicated document
	await B_(B, (i) => {
		const s = /** @type {any} */ (window).__stores;
		s.flowGraphClose.set(false);
		s.behaviourViewOpen.set({ id: i, graphId: 'scene' });
	}, wid);
	await B.page.waitForSelector('#behaviour-view [data-bview-kind="state"]', { timeout: 10000 });
	const SAMPLE = () =>
		new Promise((resolve) => {
			/** @type {any[]} */
			const seen = [];
			const t0 = performance.now();
			const root = /** @type {Element} */ (document.querySelector('#behaviour-view'));
			// every class/text change, as it happens (this machine renders ~4 fps: polling misses a 0.9 s glow)
			const note = () => {
				const glow = [...root.querySelectorAll('.bview-glow')].map((e) => e.getAttribute('data-bview-id'));
				const timer = root.querySelector('[data-bview-kind="timer"] [data-bview-value]')?.textContent?.trim() ?? '';
				seen.push({ t: Math.round(performance.now() - t0), glow, timer });
			};
			const obs = new MutationObserver(note);
			obs.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'], characterData: true, childList: true });
			setTimeout(() => {
				obs.disconnect();
				resolve(seen);
			}, 6000);
		});
	const sampler = B_(A, SAMPLE);
	const samplerB = B_(B, SAMPLE);
	await killAll(B);
	const samples = /** @type {any[]} */ (await sampler);
	const samplesB = /** @type {any[]} */ (await samplerB);
	const glowedB = samplesB.filter((x) => x.glow.includes('h:died') || x.glow.includes('e:died'));
	h.check(glowedB.length > 0, 'and on peer B (' + (other === B ? 'NOT the authority: the glow came with the document' : 'the authority') + '; ' + glowedB.length + ' of ' + samplesB.length + ' samples)');
	const glowed = samples.filter((x) => x.glow.includes('h:died') || x.glow.includes('e:died'));
	h.check(glowed.length > 0, 'fired glow on the died handler, seen on peer A (' + glowed.length + ' of ' + samples.length + ' samples; first at ' + (glowed[0]?.t ?? '-') + ' ms)');
	if (!glowed.length) console.log('  samples: ' + JSON.stringify(samples.filter((_, i) => i % 5 === 0)));
	h.check(samples.some((x) => /in \d/.test(x.timer)), 'the pending timer counts down live (' + (samples.find((x) => /in \d/.test(x.timer))?.timer ?? 'never') + ')');
	await h.eventually(() => Promise.all([A, B].map((p) => liveOf(p, wid))), (v) => v.every((l) => l.state.wave === 2 && l.state.alive === 3), 'wave 2 (3 robots) after the interval, on both peers', 8000);
	await A.page.waitForTimeout(400);
	const shot = path.join(EVIDENCE, 'derived-view-live.png');
	await A.page.locator('#behaviour-view').screenshot({ path: shot });
	h.check(fs.existsSync(shot), 'screenshot of the derived view with live values: ' + shot);

	// ---- 4. a KNOB writes the source literal: one AST edit, one undo entry, replicated -----------
	const knob = A.page.locator('#behaviour-view [data-bview-knob="interval"]');
	await knob.evaluate((el) => {
		const input = /** @type {HTMLInputElement} */ (el);
		input.value = '4.5';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await h.eventually(() => Promise.all([A, B].map((p) => codeOf(p, wid))), (v) => v.every((c) => c?.includes('interval: { value: 4.5, min: 0, max: 30')), 'the knob rewrote `value: 3` -> `value: 4.5` in the file, on both peers', 6000);
	const diffLines = (await codeOf(A, wid)).split('\n').filter((/** @type {string} */ l, /** @type {number} */ i) => l !== WAVES.split('\n')[i]).length;
	h.check(diffLines === 1, 'exactly ONE line of the file changed (' + diffLines + ')');
	await h.eventually(() => Promise.all([A, B].map((p) => liveOf(p, wid))), (v) => v.every((l) => l?.params.interval === 4.5 && l.state.wave === 2), 'every peer reloaded with interval 4.5 — and the game kept its state (wave 2)', 8000);
	await h.eventually(() => Promise.all([robots(A), robots(B)]), (v) => v[0] === 3 && v[1] === 3, 'the reload did NOT remove the robots in play (a source edit is not an unload)', 4000);
	await B_(A, () => /** @type {any} */ (window).__stores.history.undo());
	await h.eventually(() => Promise.all([A, B].map((p) => codeOf(p, wid))), (v) => v.every((c) => c === WAVES), 'ONE undo puts the file back exactly, on both peers', 6000);

	// ---- 6. Towers reach: the behaviour (a local veto) next to the kit node (Set grab reach) -----
	const req = (/** @type {number} */ d) => ({ point: [0, 1.6, -d], eye: [0, 1.6, 0], feetY: 0, uuid: 'x', name: 'Piece', hand: 'desktop' });
	const verdict = (/** @type {any} */ p, /** @type {number} */ d) => B_(p, (r) => /** @type {any} */ (window).__stores.kit.kitCheckGrab(r), req(d));
	const [rid] = await B_(A, (code) => /** @type {any} */ (window).__bApi.flow.addNodes({ nodes: [{ type: 'behaviour', x: 40, y: 640, data: { name: 'Towers reach', code } }] }), REACH);
	await h.eventually(() => Promise.all([A, B].map((p) => dbg(p))), (v) => v.every((d) => d.status[rid]?.status === 'running'), 'the reach behaviour runs on both peers', 12000);
	const near = await verdict(other, 1.0);
	const far = await verdict(other, 2.0);
	h.check(near.ok === true && far.ok === false && far.reason === 'Too far - climb closer', 'behaviour version: 1.0 m allowed, 2.0 m refused on the NON-authority (a local veto): ' + JSON.stringify(far));
	await B_(A, (i) => /** @type {any} */ (window).__stores.nodesHandler.setNodeData(i, { enabled: false }, 'scene'), rid);
	await h.eventually(() => verdict(other, 2.0), (v) => v.ok === true, 'Stop: the veto is gone (its listener left with the module)', 8000);
	const sid = await B_(A, () =>
		/** @type {any} */ (window).__bApi.flow.addNodes({
			nodes: [{ type: 'bhvprobe', x: 40, y: 760 }, { type: 'kit-rules-setReach', x: 260, y: 760, data: { metres: 1.3 } }],
			edges: [{ from: 0, to: 1, handle: 'trigger' }]
		})
	);
	h.check(sid.length === 2, 'node version: a pulse into "Kit: Rules ▸ Set grab reach" (1.3 m)');
	await A.page.waitForTimeout(1200);
	await B_(A, () => /** @type {any} */ (window).__bApi.fireNodeTrigger('bhvprobe'));
	await h.eventually(() => Promise.all([verdict(other, 1.0), verdict(other, 2.0)]), (v) => v[0].ok === true && v[1].ok === false, 'node version: the same verdicts (1.0 allowed, 2.0 refused) through the kit rule', 8000);

	// ---- 7. a LATE joiner: the documents in the handshake, the behaviour runs, nothing resets -----
	const C = await h.setupPage(browser, 'C');
	await B_(C, PROBE);
	await h.connect(C, A);
	await h.eventually(() => liveOf(C, wid), (l) => l?.state?.wave === 2 && l.synced, 'a LATE joiner runs the behaviour with the session\'s state (wave 2), not its initial one', 15000);
	await A.page.waitForTimeout(2500); // past the joiner grace
	const after = await Promise.all([A, B, C].map((p) => liveOf(p, wid)));
	h.check(after.every((l) => l.state.wave === 2), 'still wave 2 everywhere after the joiner grace (' + after.map((l) => l.state.wave) + ')');

	// ---- 8. delete the node: the behaviour's whole module goes (T2) -------------------------------
	await B_(A, (i) => {
		const s = /** @type {any} */ (window).__stores;
		s.behaviourViewOpen.set(null);
		s.nodesHandler?.deleteFlowNodes?.([i], 'scene');
		const peer = (() => { let v; s.peers.subscribe((/** @type {any} */ x) => (v = x))(); return /** @type {any} */ (v); })();
		peer?.send({ type: 'nodedelete', ids: [i], graphId: 'scene' });
	}, wid);
	await h.eventually(() => Promise.all([A, B, C].map((p) => dbg(p))), (v) => v.every((d) => !d.status[wid]), 'the deleted behaviour is gone on every peer', 10000);
	const left = await Promise.all([A, B].map((p) => B_(p, (i) => /** @type {any} */ (window).__stores.behaviours.behavioursDebug().registrations(i), wid)));
	h.check(left.every((r) => Object.keys(r).length === 0), 'T2: nothing of it is left in the lifecycle registry (' + JSON.stringify(left) + ')');
	await h.eventually(() => Promise.all([robots(A), robots(B)]), (v) => v[0] === 0 && v[1] === 0, 'its owned robot entities left with it', 8000);

	// ---- 9. side by side: the SAME spawner as kit nodes (after the behaviour left: `emptied` counts every kind)
	// go -> Spawn(2); emptied -> Counter; Counter + 2 -> Spawn.count; emptied -> Delay 3 s -> Spawn
	const nodeIds = await B_(A, () =>
		/** @type {any} */ (window).__bApi.flow.addNodes({
			nodes: [
				{ type: 'bhvprobe', x: 40, y: 300 },
				{ type: 'kit-spawner-emptied', x: 40, y: 380 },
				{ type: 'counter', x: 260, y: 380 },
				{ type: 'math', x: 460, y: 380, data: { op: 'add', a: 0, b: 2 } },
				{ type: 'delay', x: 260, y: 480, data: { seconds: 3 } },
				{ type: 'kit-spawner-spawn', x: 680, y: 300, data: { kind: 'bot', count: 2, hp: 3, speed: 0 } }
			],
			edges: [
				{ from: 0, to: 5, handle: 'trigger' },
				{ from: 1, to: 2, handle: 'pulse' },
				{ from: 2, to: 3, handle: 'a' },
				{ from: 3, to: 5, handle: 'count' },
				{ from: 1, to: 4, handle: 'trigger' },
				{ from: 4, to: 5, handle: 'trigger' }
			]
		})
	);
	h.check(nodeIds.length === 6, 'the node version: 6 nodes + 6 edges (and still no win rule, no hp/speed knobs, no state you can read)');
	await A.page.waitForTimeout(1500);
	const bots = (/** @type {any} */ p) => B_(p, () => /** @type {any} */ (window).__stores.kit.kit.impls.spawner.count('bot'));
	await B_(B, () => /** @type {any} */ (window).__bApi.fireNodeTrigger('bhvprobe'));
	await h.eventually(() => Promise.all([bots(A), bots(B)]), (v) => v[0] === 2 && v[1] === 2, 'node version: the pulse spawns wave 1 (2) once', 8000);
	await B_(B, () => {
		const k = /** @type {any} */ (window).__stores.kit.kit.impls;
		for (const e of k.spawner.extra.list({ kind: 'bot', alive: true })) k.health.damage(e.id, 999);
	});
	await h.eventually(() => Promise.all([bots(A), bots(B)]), (v) => v[0] === 3 && v[1] === 3, 'node version: emptied -> 3 s -> wave 2 (counter 1 + 2 = 3) — the same rule the behaviour states in one file', 12000);

	const errs = [A, B, C].flatMap((p) => h.pageErrors(p));
	h.check(errs.length === 0, 'no page errors (' + errs.slice(0, 3).join(' | ') + ')');
	await h.finish(browser);
});
