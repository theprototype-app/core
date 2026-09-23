// 30 P4 — GAMES REMEMBER THINGS ON THIS DEVICE (roadmap 30 fork 7).
//
// Two surfaces, one leaf (gameStorage.js):
//   · `api.storage` for modules — JSON under `tp:mod:<moduleId>:<key>` through safeStorage,
//     256 KB per module (over it: `false` and ONE toast), LOCAL, surviving a reload.
//   · the Store Value / Stored Value flow nodes — `tp:scene:<scene name|untitled>:<key>`,
//     acting on the trigger's stamp edge, sending NOTHING.
//
// Modules are driven INLINE through `moduleSDK.initModules` (the post-backends precedent: the
// real makeApi path, no zip). The key format is asserted byte for byte against raw
// localStorage, because a module that must also run on an older core (untangle's fallback)
// writes the very same key itself.
const h = require('./helpers.cjs');

/** register two inline modules that park their api.storage on window @param {any} page */
const registerModules = (page) =>
	page.evaluate(async () => {
		const sdk = window.__stores.moduleSDK;
		/** @param {string} id */
		const make = (id) => ({
			id,
			name: 'Storage test ' + id,
			version: '1.0.0',
			description: 'inline',
			register(api) {
				window['__' + id] = api.storage;
			}
		});
		await sdk.initModules([make('stA'), make('stB')]);
		return !!window.__stA && !!window.__stB;
	});

/** @param {any} page */
const toastsMatching = (page, re) =>
	page.evaluate((src) => {
		let list = [];
		window.__stores.toastStore.subscribe((v) => (list = v ?? []))();
		const r = new RegExp(src);
		return list.filter((t) => r.test(String(t?.message ?? t?.text ?? t ?? ''))).length;
	}, re.source);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ===================================================================== 1. the api
	h.check(await registerModules(page), 'two inline modules received api.storage');
	const basics = await page.evaluate(() => {
		const a = window.__stA;
		const out = {};
		out.setN = a.set('score', 42);
		out.setO = a.set('progress', { mode2d: { unlocked: 3, solved: [1, 2] } });
		out.setT = a.set('name', 'Ada');
		out.getN = a.get('score');
		out.getO = a.get('progress');
		out.getT = a.get('name');
		out.missing = a.get('nothing', 'fallback');
		out.keys = a.keys();
		out.raw = localStorage.getItem('tp:mod:stA:progress');
		a.remove('name');
		out.afterRemove = a.keys();
		out.bytes = a.bytes();
		return out;
	});
	h.check(basics.setN && basics.setO && basics.setT, 'set returns true for JSON values');
	h.check(basics.getN === 42 && basics.getT === 'Ada', `get round-trips a number and text (${basics.getN}, ${basics.getT})`);
	h.check(JSON.stringify(basics.getO) === '{"mode2d":{"unlocked":3,"solved":[1,2]}}', 'and an object');
	h.check(basics.missing === 'fallback', 'a missing key hands back the fallback');
	h.check(JSON.stringify(basics.keys) === '["name","progress","score"]', `keys() lists this module's keys, sorted (${basics.keys})`);
	h.check(
		basics.raw === '{"mode2d":{"unlocked":3,"solved":[1,2]}}',
		`THE KEY CONTRACT: localStorage["tp:mod:stA:progress"] holds the JSON (${basics.raw})`
	);
	h.check(JSON.stringify(basics.afterRemove) === '["progress","score"]', 'remove() drops one key');
	h.check(basics.bytes > 0, `bytes() measures what the module spends (${basics.bytes})`);

	// ===================================================================== 2. two modules never meet
	const apart = await page.evaluate(() => {
		const a = window.__stA;
		const b = window.__stB;
		b.set('score', 7);
		const view = { a: a.get('score'), b: b.get('score'), bKeys: b.keys() };
		b.clear();
		view.afterClear = { a: a.get('score'), bKeys: b.keys() };
		return view;
	});
	h.check(apart.a === 42 && apart.b === 7, `the same key in two modules holds two values (${apart.a}, ${apart.b})`);
	h.check(JSON.stringify(apart.bKeys) === '["score"]', "a module's keys() never lists another module's");
	h.check(apart.afterClear.a === 42 && apart.afterClear.bKeys.length === 0, "clear() empties this module and leaves the other alone");

	// ===================================================================== 3. the cap
	const cap = await page.evaluate(() => {
		const a = window.__stA;
		const big = 'x'.repeat(300 * 1024);
		const first = a.set('huge', big);
		const second = a.set('huge2', big);
		return { first, second, has: a.get('huge', null) !== null, cap: window.__stores.gameStorage.MODULE_STORAGE_CAP };
	});
	h.check(cap.first === false && cap.second === false, 'a write over 256 KB returns false');
	h.check(!cap.has, 'and writes nothing');
	h.check(cap.cap === 262144, `the cap is 256 KB (${cap.cap})`);
	await page.waitForTimeout(300);
	const capToasts = await toastsMatching(page, /storage limit/);
	h.check(capToasts === 1, `ONE toast per module per session, not one per write (${capToasts})`);

	// ===================================================================== 4. a failing localStorage
	const failing = await page.evaluate(() => {
		const a = window.__stA;
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function () {
			throw new DOMException('quota', 'QuotaExceededError');
		};
		let threw = false;
		let ok = false;
		let back = null;
		try {
			ok = a.set('offline', { still: 'here' });
			back = a.get('offline');
		} catch {
			threw = true;
		}
		Storage.prototype.setItem = original;
		return { threw, ok, back, raw: localStorage.getItem('tp:mod:stA:offline') };
	});
	h.check(!failing.threw, 'a throwing localStorage never throws out of api.storage');
	h.check(failing.ok && failing.back?.still === 'here', 'the value applies for the session (memory fallback)');
	h.check(failing.raw === null, 'and truly never reached localStorage');
	h.check(h.pageErrors(A).length === 0, `no page error (${h.pageErrors(A).length})`);

	// ===================================================================== 5. the flow nodes
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const built = await page.evaluate(async () => {
		const s = window.__stores;
		s.levels.currentLevel.set({ hash: '', name: 'Arcade', unsaved: true });
		const nodes = [
			{ id: 'svKey', type: 'keypress', position: { x: 0, y: 0 }, data: { type: 'keypress', code: 'KeyK', edge: 'down' }, class: 'w-[150px]' },
			{ id: 'svCount', type: 'counter', position: { x: 0, y: 200 }, data: { type: 'counter', op: 'up', step: 1 }, class: 'w-[150px]' },
			{ id: 'svStore', type: 'storevalue', position: { x: 300, y: 0 }, data: { type: 'storevalue', key: 'best', mode: 'max', value: 0 }, class: 'w-[150px]' },
			{ id: 'svRead', type: 'storedvalue', position: { x: 600, y: 0 }, data: { type: 'storedvalue', key: 'best', output: 'number', fallback: -1 }, class: 'w-[150px]' }
		];
		const edges = [
			{ id: 'e-svKey-svCount.pulse', source: 'svKey', target: 'svCount', targetHandle: 'pulse' },
			{ id: 'e-svKey-svStore.trigger', source: 'svKey', target: 'svStore', targetHandle: 'trigger' },
			{ id: 'e-svCount-svStore.value', source: 'svCount', target: 'svStore', targetHandle: 'value' }
		];
		s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges } }));
		s.flowNodes.set(nodes);
		s.flowEdges.set(edges);
		await new Promise((r) => setTimeout(r, 800)); // past the nodes' first-seen (actionSeenAt)
		return true;
	});
	h.check(built, 'a Counter -> Store Value (max) graph');
	// count the wire while the node writes: Store Value must send NOTHING of its own
	await page.evaluate(() => {
		let peer;
		window.__stores.peers.subscribe((v) => (peer = v))();
		window.__sentTypes = [];
		const send = peer.send.bind(peer);
		peer.send = (msg) => {
			window.__sentTypes.push(msg?.type);
			return send(msg);
		};
	});
	for (let i = 0; i < 3; i++) {
		// a LOCAL pulse (this player's own key press): the counter and the store both act
		await page.evaluate(() => window.__stores.flowRuntime.applyNodeTrigger('svKey', (Date.now() % 86400000) / 1000, false));
		await page.waitForTimeout(700);
	}
	const flow = await page.evaluate(() => ({
		raw: localStorage.getItem('tp:scene:Arcade:best'),
		sent: window.__sentTypes
	}));
	h.check(flow.raw === '3', `three presses keep the best (3) under tp:scene:Arcade:best (${flow.raw})`);
	h.check(!flow.sent.some((t) => /stor/i.test(String(t))), `Store Value put nothing on the wire (${JSON.stringify([...new Set(flow.sent)])})`);
	// a LOWER value must not overwrite the max
	await page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphs.update((g) => ({
			...g,
			scene: { ...g.scene, nodes: g.scene.nodes.map((n) => (n.id === 'svCount' ? { ...n, data: { ...n.data, step: -5 } } : n)) }
		}));
	});
	await page.evaluate(() => window.__stores.flowRuntime.applyNodeTrigger('svKey', (Date.now() % 86400000) / 1000, false));
	await page.waitForTimeout(700);
	h.check((await page.evaluate(() => localStorage.getItem('tp:scene:Arcade:best'))) === '3', 'max mode never lowers the best');
	const readNow = await page.evaluate(() => {
		let v = {};
		window.__stores.flowValues.subscribe((x) => (v = x))();
		return v.svRead;
	});
	h.check(readNow === 3, `Stored Value reads it back (${readNow})`);
	const onB = await B.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tp:scene:')));
	h.check(onB.length === 0, `the second peer received NOTHING (${JSON.stringify(onB)})`);

	// ===================================================================== 6. a reload keeps both halves
	await h.freshReload(A);
	await page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	await registerModules(page);
	const after = await page.evaluate(async () => {
		const s = window.__stores;
		s.levels.currentLevel.set({ hash: '', name: 'Arcade', unsaved: true });
		const nodes = [
			{ id: 'svRead2', type: 'storedvalue', position: { x: 0, y: 0 }, data: { type: 'storedvalue', key: 'best', output: 'number', fallback: -1 }, class: 'w-[150px]' },
			{ id: 'svText', type: 'storedvalue', position: { x: 0, y: 200 }, data: { type: 'storedvalue', key: 'best', output: 'text', fallback: '' }, class: 'w-[150px]' }
		];
		s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges: [] } }));
		s.flowNodes.set(nodes);
		s.flowEdges.set([]);
		await new Promise((r) => setTimeout(r, 900));
		let v = {};
		s.flowValues.subscribe((x) => (v = x))();
		return { score: window.__stA.get('score'), num: v.svRead2, text: v.svText };
	});
	h.check(after.score === 42, `a module's value survives a reload (${after.score})`);
	h.check(after.num === 3, `Stored Value reads the saved best after a reload (${after.num})`);
	h.check(after.text === '3', `and as text (${JSON.stringify(after.text)})`);
	const otherScene = await page.evaluate(async () => {
		const s = window.__stores;
		s.levels.currentLevel.set({ hash: '', name: 'Other game', unsaved: true });
		await new Promise((r) => setTimeout(r, 500));
		let v = {};
		s.flowValues.subscribe((x) => (v = x))();
		return v.svRead2;
	});
	h.check(otherScene === -1, `another scene's namespace does not see it (fallback ${otherScene})`);

	// ===================================================================== 7. "Save best score" on a HUD button
	const bind = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudDocs.setHudDocFor('scene', {
			active: 'main',
			screens: [{ id: 'main', name: 'Main', elements: [{ id: 'saveBtn', kind: 'button', text: 'Save', anchor: 'center', x: 0, y: 0, w: 120, h: 40 }] }]
		});
		await new Promise((r) => setTimeout(r, 300));
		const offered = s.hudActions.actionsForKind('button').some((a) => a.key === 'savebest');
		const res = s.hudActions.addBinding('saveBtn', 'savebest');
		await new Promise((r) => setTimeout(r, 900)); // past the fresh nodes' first-seen
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const nodes = g.scene.nodes;
		const edges = g.scene.edges;
		const store = nodes.find((n) => n.type === 'storevalue');
		const src = nodes.find((n) => n.type === 'getvariable');
		const press = nodes.find((n) => n.type === 'hudbutton');
		return {
			offered,
			ok: res.ok,
			store: store?.data ?? null,
			src: src?.data?.name ?? null,
			trig: edges.some((e) => e.source === press?.id && e.target === store?.id && e.targetHandle === 'trigger'),
			val: edges.some((e) => e.source === src?.id && e.target === store?.id && e.targetHandle === 'value'),
			labels: s.hudActions.bindingsFor('saveBtn').map((b) => b.label)
		};
	});
	h.check(bind.offered, 'a HUD button is offered "Save best score"');
	h.check(bind.ok && bind.store?.key === 'best' && bind.store?.mode === 'max', `which builds a Store Value (best, max) (${JSON.stringify(bind.store)})`);
	h.check(bind.src === 'score' && bind.val, 'fed by the score variable on its value socket');
	h.check(bind.trig, 'and pressed by the button on its trigger socket');
	h.check(bind.labels.some((l) => /Save .best. on this device/.test(l)), `the Actions pane says what it does (${JSON.stringify(bind.labels)})`);
	await page.evaluate(() => {
		window.__stores.gameState.setGameVar('score', 12);
		window.__stores.flowRuntime.fireHudButton('saveBtn');
	});
	await h.eventually(
		() => page.evaluate(() => localStorage.getItem('tp:scene:Other game:best')),
		(v) => v === '12',
		'pressing it saves the score as this device\'s best',
		4000
	);

	await h.finish(browser);
});
