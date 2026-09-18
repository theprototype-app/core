// 24-A A2 — ON HIT, THE SDK FEED, THE HANDSHAKE AND THE INSPECTOR ROWS.
//
// The knock (A1) is a `hit` message applied on every peer; A2 turns it into a TRIGGER
// NODE stamped from that message's own `at` — one message per knock, identical stamps
// everywhere, no nodetrigger — with `who: anyone|me|others` read PER PEER against the
// hitter's id and `speed`/`byMe` as value outputs. The same feed reaches a module through
// `api.onHit`, and a running sim now rides the handshake so a late joiner arms its probes.
//
// Sections: 1 the registries agree · 2 the initiator knocks (who/minSpeed on both peers,
// the stamp is literally equal on A and B, speed/byMe, the per-player Set Variable banks
// ONCE per hit per peer) · 3 the non-initiator knocks (the mirror image) · 4 the SDK feed
// carries what the node saw · 5 the handshake tells a late joiner the sim is running ·
// 6 the Inspector's Knock rows + the `Physics:Knock` deep link · 7 the haptic seam.
//
// THE COUNTERFACTUALS (each proven red by breaking the code, restored before commit):
// fireObjectHit without its applyNodeTrigger → 2.2/2.4 red (nothing stamped);
// the `who` gate removed → 2.5/2.6/3.3 red (`me` fires on the other peer);
// the handshake `simulate` push removed → 5.2 red (remoteSimulating stays null);
// unwrapHandle without `__default` → 2.10 red (the unnamed edge reads undefined → 15).
//
// Two peers need PEER_CONFIG (the self-hosted signaling box) and GPU_ARGS (the flow tick
// and the physics step both ride the frame loop).

const h = require('./helpers.cjs');

const sp = (page, body) =>
	page.evaluate((b) => new Function('sp', b)(window.__stores.scenePhysics), body);
const bodyOf = (page, uuid) =>
	page.evaluate(
		(uuid) => window.__stores.physics.physicsDebug().find((b) => b.uuid === uuid) ?? null,
		uuid
	);
const speedOf = (b) => (b?.linvel ? Math.hypot(b.linvel.x, b.linvel.y, b.linvel.z) : 0);
/** park the ball at (0,1,0) with zero velocity (applyThrow reseats AND zeroes — initiator only) */
const park = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			window.__stores.physics.applyThrow({
				uuid,
				pos: [0, 1, 0],
				rot: [0, 0, 0],
				linvel: [0, 0, 0],
				angvel: [0, 0, 0]
			}),
		uuid
	);

/** sweep a synthetic probe along +x through y=1, z=0 at `speed` m/s — the knock-physics shape */
const sweep = (page, id, opts) =>
	page.evaluate(
		({ id, from, to, speed, dtMs, t0 }) => {
			const k = window.__stores.knock;
			k.dropProbe(id);
			const step = (speed * dtMs) / 1000;
			let hits = 0;
			let armed = true;
			let t = t0;
			for (let x = from; x <= to + 1e-9; x += step) {
				const r = k.feedProbe(id, [x, 1, 0], t);
				hits += r.hits;
				armed = armed && r.armed;
				t += dtMs;
			}
			return { hits, armed };
		},
		{ dtMs: 16, t0: 1000, from: -1.2, to: 0, ...opts, id }
	);

const node = (id, type, data, x = 0, y = 0) => ({
	id,
	type,
	position: { x, y },
	data: { type, ...data },
	class: 'w-[150px]'
});
// the CANONICAL edge id (Nodes.svelte / hudActions.makeEdge) — peer dedupe depends on it
const edge = (source, target, targetHandle) => ({
	id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''),
	source,
	target,
	...(targetHandle ? { targetHandle } : {})
});
/** write BOTH stores (the runtime reads flowGraphs, the editor flowNodes) and push to peers */
const setGraph = (page, nodes, edges) =>
	page.evaluate(
		([nodes, edges]) => {
			window.__stores.setActiveGraph(window.__stores.SCENE_GRAPH);
			window.__stores.flowGraphs.update((graphs) => ({ ...graphs, scene: { nodes, edges } }));
			window.__stores.flowNodes.set(nodes);
			window.__stores.flowEdges.set(edges);
			let peer = null;
			window.__stores.peers.subscribe((p) => (peer = p))();
			nodes.forEach((node) => peer?.send({ type: 'nodecreate', node }));
			edges.forEach((edge) => peer?.send({ type: 'edgecreate', edge }));
		},
		[nodes, edges]
	);
const holdsGraph = (page, ids) =>
	page.evaluate((ids) => {
		const have = window.__stores.allNodes().map((n) => n.id);
		return ids.every((id) => have.includes(id));
	}, ids);

/** the trigger-log entry of a node: {count, lastT} or null */
const trig = (page, id) =>
	page.evaluate((id) => {
		let map = null;
		window.__stores.flowTriggers.subscribe((v) => (map = v))();
		return map?.[id] ? { ...map[id] } : null;
	}, id);
const value = (page, id) =>
	page.evaluate((id) => {
		let values = null;
		window.__stores.flowValues.subscribe((v) => (values = v))();
		const v = values?.[id];
		return v === undefined ? null : JSON.parse(JSON.stringify(v));
	}, id);
const touches = (page) =>
	page.evaluate(() => window.__stores.peerVars.peerVarsDebug().mine.touches ?? 0);
const settle = (page, ms = 900) => page.waitForTimeout(ms);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. the registries agree ===');
	const reg = await A.page.evaluate(() => {
		const { nodeCatalog, flowSockets } = window.__stores;
		const groups = nodeCatalog.nodeCatalog ?? nodeCatalog.catalog ?? null;
		const spec = nodeCatalog.findNodeSpec('onhit');
		const group = (groups ?? []).find((g) => g.items.some((i) => i.type === 'onhit'))?.group ?? null;
		return {
			spec: spec ? { defaults: spec.defaults, params: spec.params.map((p) => p.key) } : null,
			group,
			out: flowSockets.outputType('onhit'),
			inputs: flowSockets.inputHandles('onhit'),
			toNumber: flowSockets.canConnect(flowSockets.outputType('onhit'), 'number'),
			toBoolean: flowSockets.canConnect(flowSockets.outputType('onhit'), 'boolean'),
			toEffect: flowSockets.canConnect(flowSockets.outputType('onhit'), 'effect')
		};
	});
	h.check(!!reg.spec && reg.spec.defaults.who === 'anyone' && reg.spec.params.join() === 'minSpeed,who', '1.1 the catalog has On Hit with minSpeed + who (' + JSON.stringify(reg.spec) + ')');
	h.check(reg.group === null || reg.group === 'Triggers', '1.2 ...in the Triggers group (' + reg.group + ')');
	h.check(reg.out === 'event' && reg.inputs.length === 0, '1.3 an EVENT source with no declared inputs (the palette rule: Triggers hold sources)');
	h.check(reg.toNumber && reg.toBoolean && reg.toEffect, '1.4 its handles reach number, boolean and the Object Selector (event coercion)');

	// ---------------------------------------------------------------- the scene
	await h.connect(A, B);
	const ball = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Sphere 0.3');
		let group = null;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const sphere = group.children[group.children.length - 1];
		sphere.name = 'Ball';
		sphere.position.set(0, 1, 0);
		sphere.userData.physics = { mode: 'dynamic', mass: 1 };
		window.__stores.objectsGroup.update((v) => v);
		window.__stores.objectActions.deselectObject();
		return sphere.uuid;
	});
	await h.eventually(
		() => B.page.evaluate((uuid) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			return !!group?.getObjectByProperty('uuid', uuid);
		}, ball),
		(ok) => ok,
		'(premise) B holds the ball'
	);
	// zero-g, no damping, the block ON; peer vars from a clean slate
	await sp(A.page, 'sp.setScenePhysics({ gravity: 0, damping: { linear: 0 }, knock: { enabled: true } })');
	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.peerVars.clearPeerVars?.());

	// THE GRAPH: four On Hit flavours on the ball, each counted; `me` also banks a
	// per-player variable; a Math node reads the unnamed handle (the __default read)
	const nodes = [
		node('sel', 'objectselector', { selected: ball }, 400, 0),
		node('hitAny', 'onhit', { who: 'anyone' }, 0, 0),
		node('hitMe', 'onhit', { who: 'me' }, 0, 120),
		node('hitOthers', 'onhit', { who: 'others' }, 0, 240),
		node('hitFast', 'onhit', { who: 'anyone', minSpeed: 5 }, 0, 360),
		node('cntAny', 'counter', {}, 200, 0),
		node('cntMe', 'counter', {}, 200, 120),
		node('cntOthers', 'counter', {}, 200, 240),
		node('cntFast', 'counter', {}, 200, 360),
		node('sv', 'setvariable', { name: 'touches', value: 1, op: 'add', scope: 'player' }, 200, 480),
		node('sum', 'math', { op: 'add', a: 5, b: 10 }, 200, 600)
	];
	const edges = [
		edge('hitAny', 'sel'),
		edge('hitMe', 'sel'),
		edge('hitOthers', 'sel'),
		edge('hitFast', 'sel'),
		edge('hitAny', 'cntAny', 'pulse'),
		edge('hitMe', 'cntMe', 'pulse'),
		edge('hitOthers', 'cntOthers', 'pulse'),
		edge('hitFast', 'cntFast', 'pulse'),
		edge('hitMe', 'sv', 'trigger'),
		edge('hitAny', 'sum', 'a')
	];
	await setGraph(A.page, nodes, edges);
	const ids = nodes.map((n) => n.id);
	await h.eventually(() => holdsGraph(B.page, ids), (ok) => ok, '(premise) B holds the graph');
	// the stale-stamp guard records first-seen at TICK time — settle before the first knock
	await settle(A.page, 800);

	for (const p of [A, B]) await p.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(() => bodyOf(A.page, ball), (b) => !!b && b.mode === 'dynamic', '(premise) the ball is a dynamic body on A, the initiator');
	await h.eventually(
		() => B.page.evaluate(() => {
			let v = null;
			window.__stores.physics.remoteSimulating.subscribe((x) => (v = x))();
			return v;
		}),
		(v) => v === A.id,
		'(premise) B knows A is simulating'
	);
	await settle(A.page, 400);
	await park(A.page, ball);

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. the initiator knocks: who/minSpeed on both peers, one stamp ===');
	const s1 = await sweep(A.page, 'p', { speed: 2 });
	h.check(s1.armed && s1.hits === 1, '2.1 (premise) A\'s 2 m/s sweep knocks the ball once');
	await settle(A.page, 700);
	const a2 = { any: await trig(A.page, 'hitAny'), me: await trig(A.page, 'hitMe'), others: await trig(A.page, 'hitOthers'), fast: await trig(A.page, 'hitFast'), cnt: await trig(A.page, 'cntAny') };
	h.check(!!a2.any && !!a2.me, '2.2 on A: `anyone` and `me` are stamped');
	h.check(!a2.others && !a2.fast, '2.3 on A: `others` is not (A hit it), and minSpeed 5 gates a 2 m/s hit');
	h.check(a2.cnt?.count === 1, '2.4 ...and the Counter behind `anyone` reads 1 (' + a2.cnt?.count + ')');
	const b2 = { any: await trig(B.page, 'hitAny'), me: await trig(B.page, 'hitMe'), others: await trig(B.page, 'hitOthers'), fast: await trig(B.page, 'hitFast'), cnt: await trig(B.page, 'cntAny') };
	h.check(!!b2.any && !!b2.others, '2.5 on B: `anyone` and `others` are stamped (A hit it, B is the other)');
	h.check(!b2.me && !b2.fast, '2.6 on B: `me` is NOT — who is read per peer against the hitter');
	h.check(!!a2.any && !!b2.any && a2.any.lastT === b2.any.lastT, '2.7 THE STAMP IS LITERALLY EQUAL on A and B (' + a2.any?.lastT + ' / ' + b2.any?.lastT + '): derived from the one message, no nodetrigger');
	const va = await value(A.page, 'hitAny');
	const vb = await value(B.page, 'hitAny');
	h.check(!!va?.__handles && Math.abs(va.__handles.speed - 2) < 0.25 && !!vb?.__handles && Math.abs(vb.__handles.speed - 2) < 0.25, '2.8 `speed` reads the approach speed on both (' + va?.__handles?.speed?.toFixed(2) + ' / ' + vb?.__handles?.speed?.toFixed(2) + ')');
	h.check(va?.__handles?.byMe === 1 && vb?.__handles?.byMe === 0, '2.9 `byMe` is 1 on A and 0 on B');
	const sum = await value(A.page, 'sum');
	h.check(sum === 10, '2.10 the Math node wired from the UNNAMED handle reads 0 + 10 = 10, not its 5 fallback (' + sum + '): __default resolves');
	h.check((await touches(A.page)) === 1 && (await touches(B.page)) === 0, '2.11 the per-player `touches` banked ONCE on A and not on B (the setvariable one-writer shape)');

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. the non-initiator knocks: the mirror image ===');
	await park(A.page, ball);
	await settle(A.page, 300);
	const s3 = await sweep(B.page, 'q', { speed: 6 });
	h.check(s3.armed && s3.hits === 1, '3.1 (premise) B\'s 6 m/s sweep knocks once (the hit goes to A as a message)');
	await h.eventually(() => trig(A.page, 'cntAny'), (t) => t?.count === 2, '3.2 A\'s `anyone` Counter reaches 2 once the hit lands');
	await settle(A.page, 500);
	const a3 = { me: await trig(A.page, 'cntMe'), others: await trig(A.page, 'cntOthers'), fast: await trig(A.page, 'cntFast') };
	const b3 = { me: await trig(B.page, 'cntMe'), others: await trig(B.page, 'cntOthers'), fast: await trig(B.page, 'cntFast'), any: await trig(B.page, 'cntAny') };
	h.check(a3.me?.count === 1 && a3.others?.count === 1, '3.3 on A: `me` stays at 1 (B hit it) and `others` is now 1');
	h.check(b3.me?.count === 1 && b3.others?.count === 1 && b3.any?.count === 2, '3.4 on B: `me` 1, `others` 1, `anyone` 2 — every peer counted each hit exactly once');
	h.check(a3.fast?.count === 1 && b3.fast?.count === 1, '3.5 minSpeed 5 passes a 6 m/s hit on both');
	h.check((await touches(A.page)) === 1 && (await touches(B.page)) === 1, '3.6 `touches`: one each, banked by the hitter only — no double bank (the 21-F3 counter-case)');
	const vb3 = await value(B.page, 'hitFast');
	h.check(!!vb3?.__handles && Math.abs(vb3.__handles.speed - 6) < 0.6 && vb3.__handles.byMe === 1, '3.7 B\'s `speed` reads ~6 and `byMe` 1 for its own hit (' + vb3?.__handles?.speed?.toFixed(2) + ')');
	const applied = await bodyOf(A.page, ball);
	h.check(speedOf(applied) > 1, '3.8 (premise) A applied the knock to the body (|v| ' + speedOf(applied).toFixed(2) + ')');

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. the SDK feed: api.onHit carries what the node saw ===');
	const installFeed = (peer) =>
		peer.page.evaluate(async () => {
			window.__feed = { hits: [], off: null, api: null };
			await window.__stores.moduleSDK.initModules([
				{
					id: 'hitfeed',
					name: 'Hit feed test',
					version: '1.0.0',
					description: 'proves api.onHit / api.hitLog',
					register(api) {
						window.__feed.api = api;
						window.__feed.off = api.onHit((hit) => window.__feed.hits.push(hit));
					}
				}
			]);
			return typeof window.__feed.api.onHit === 'function' && typeof window.__feed.api.hitLog === 'function';
		});
	h.check((await installFeed(A)) && (await installFeed(B)), '4.1 api.onHit and api.hitLog exist');
	await park(A.page, ball);
	await settle(A.page, 300);
	const s4 = await sweep(A.page, 'p', { speed: 3 });
	h.check(s4.hits === 1, '4.2 (premise) A knocks once more');
	await h.eventually(() => B.page.evaluate(() => window.__feed.hits.length), (n) => n === 1, '4.3 B\'s callback fired once for A\'s hit');
	const fa = await A.page.evaluate(() => window.__feed.hits[0]);
	const fb = await B.page.evaluate(() => window.__feed.hits[0]);
	h.check(fa && fa.uuid === ball && fa.local === true && fa.by === A.id && Math.abs(fa.speed - 3) < 0.3, '4.4 A\'s payload: uuid, local:true, by = A, speed ~3 (' + JSON.stringify({ local: fa?.local, by: fa?.by === A.id, speed: fa?.speed?.toFixed(2) }) + ')');
	h.check(fb && fb.uuid === ball && fb.local === false && fb.by === A.id && fb.at === fa.at, '4.5 B\'s payload: local:false, by = A, the SAME `at` (' + fb?.at + ')');
	const stampA = await trig(A.page, 'hitAny');
	h.check(!!stampA && Math.abs(stampA.lastT - ((fa.at % 86400000) / 1000)) < 1e-6, '4.6 the node\'s stamp is that `at` folded the way the tick clock folds Date.now: the module and the graph saw ONE hit');
	const logA = await A.page.evaluate((uuid) => window.__feed.api.hitLog(), ball);
	h.check(logA.last[ball]?.by === A.id && logA.recent.length >= 3, '4.7 api.hitLog(): last-per-body names A, the ring holds the session\'s hits (' + logA.recent.length + ')');
	await A.page.evaluate(() => window.__feed.off());
	await park(A.page, ball);
	await settle(A.page, 300);
	await sweep(A.page, 'p', { speed: 3 });
	await settle(A.page, 500);
	h.check((await A.page.evaluate(() => window.__feed.hits.length)) === 1, '4.8 after the unsubscribe A\'s callback stays at 1');
	h.check((await B.page.evaluate(() => window.__feed.hits.length)) === 2, '4.9 ...while B\'s (still subscribed) reads 2');

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. a late joiner learns the sim is running from the handshake ===');
	const C = await h.setupPage(browser, 'C');
	// the Connect pill lives in the editor chrome, which play mode hides
	await A.page.evaluate(() => window.__stores.isLocked.set(null));
	await h.connect(C, A);
	const cSim = await C.page.evaluate(() => {
		let v = null;
		window.__stores.physics.remoteSimulating.subscribe((x) => (v = x))();
		return v;
	});
	h.check(cSim === A.id, '5.1 (measured) C\'s remoteSimulating names A (' + cSim + ')');
	h.check(cSim === A.id, '5.2 THE FINDING CLOSED: `simulate` rode the handshake — before A2 a joiner mid-run sat with null until the sim restarted');
	await C.page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(
		() => C.page.evaluate((uuid) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			return !!group?.getObjectByProperty('uuid', uuid);
		}, ball),
		(ok) => ok,
		'(premise) C holds the ball'
	);
	await sp(A.page, 'return null');
	const s5 = await sweep(C.page, 'c', { speed: 2 });
	h.check(s5.armed, '5.3 ...so C\'s probes ARM straight away (a sim runs somewhere)');
	await A.page.evaluate(() => window.__stores.isLocked.set(true));

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. the Inspector: Knock rows and the Physics:Knock deep link ===');
	await A.page.evaluate(() => window.__stores.isLocked.set(null));
	await A.page.evaluate(() => window.__stores.openSceneSection('Physics:Knock'));
	await settle(A.page, 1200);
	const anchor = await A.page.evaluate(() => {
		const el = document.querySelector('[data-anchor="Knock"]');
		if (!el) return { found: false };
		const sticky = document.querySelector('#drawer-label')?.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		return { found: true, top: Math.round(r.top), stickyBottom: Math.round(sticky?.bottom ?? 0), text: el.textContent?.trim() };
	});
	h.check(anchor.found && anchor.text === 'Knock', '6.1 the Knock sub-heading exists inside Physics (' + JSON.stringify(anchor) + ')');
	h.check(anchor.found && anchor.top >= anchor.stickyBottom - 4 && anchor.top < 500, '6.2 the deep link lands it just under the sticky header');
	const rows = await A.page.evaluate(() => ({
		enabled: document.querySelector('#physics-knock-enabled')?.checked ?? null,
		gain: !!document.querySelector('#physics-knock-gain'),
		max: !!document.querySelector('#physics-knock-maxspeed'),
		radius: !!document.querySelector('#physics-knock-radius'),
		spin: !!document.querySelector('#physics-knock-spin')
	}));
	h.check(rows.enabled === true && rows.gain && rows.max && rows.radius && rows.spin, '6.3 with the block on, the checkbox reads on and the four rows are drawn (' + JSON.stringify(rows) + ')');
	await A.page.click('#physics-knock-enabled');
	await settle(A.page, 400);
	const offA = await sp(A.page, 'let v; sp.sceneKnock.subscribe((x) => (v = x))(); return v.enabled');
	const offRows = await A.page.evaluate(() => !!document.querySelector('#physics-knock-gain'));
	h.check(offA === false && offRows === false, '6.4 the checkbox writes knock.enabled false and the rows fold away');
	await h.eventually(
		() => sp(B.page, 'let v; sp.sceneKnock.subscribe((x) => (v = x))(); return v.enabled'),
		(v) => v === false,
		'6.5 ...and B\'s block follows (the one scenephysics singleton, no new message)'
	);
	await A.page.click('#physics-knock-enabled');
	await settle(A.page, 300);
	await A.page.evaluate(() => {
		const el = document.querySelector('#physics-knock-gain');
		if (!el) return;
		el.value = '2';
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await settle(A.page, 300);
	const gain = await sp(A.page, 'let v; sp.sceneKnock.subscribe((x) => (v = x))(); return v');
	h.check(gain.enabled === true && Math.abs(gain.gain - 2) < 1e-9, '6.6 the Gain row writes knock.gain (' + gain.gain + ')');
	await sp(A.page, 'sp.setScenePhysics({ knock: { gain: 1 } })');

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. the haptic seam: a LOCAL VR hand feels its own hit ===');
	await A.page.evaluate(() => window.__stores.isLocked.set(true));
	await A.page.evaluate(() => {
		const k = window.__stores.knock;
		window.__hap = [];
		k.stopKnock();
		k.startKnock({ haptic: (i, ms, hand) => window.__hap.push([i, ms, hand]) });
	});
	await park(A.page, ball);
	await settle(A.page, 300);
	const left = await sweep(A.page, 'left', { speed: 4 });
	const hap1 = await A.page.evaluate(() => window.__hap.slice());
	h.check(left.hits === 1 && hap1.length === 1 && hap1[0][2] === 'left' && Math.abs(hap1[0][0] - 0.6) < 1e-9 && hap1[0][1] === 30, '7.1 a left-hand knock at 4 m/s buzzes the LEFT hand at 0.2 + 4/10 = 0.6 for 30 ms (' + JSON.stringify(hap1) + ')');
	await park(A.page, ball);
	await settle(A.page, 300);
	const head = await sweep(A.page, 'head', { speed: 4 });
	h.check(head.hits === 1 && (await A.page.evaluate(() => window.__hap.length)) === 1, '7.2 the head probe (desktop) buzzes nothing');
	await park(A.page, ball);
	await settle(A.page, 300);
	await sweep(B.page, 'right', { speed: 4 });
	await h.eventually(() => trig(A.page, 'cntAny'), (t) => (t?.count ?? 0) >= 6, '(premise) B\'s hit landed on A');
	h.check((await A.page.evaluate(() => window.__hap.length)) === 1, '7.3 a PEER\'s hit never buzzes this hand — the message carries no haptic');
	await A.page.evaluate(() => {
		window.__stores.knock.stopKnock();
		window.__stores.knock.startKnock({});
	});

	await h.finish(browser);
});
