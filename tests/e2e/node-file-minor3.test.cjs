// 2.0-n3c step 4/5 (roadmap 2.0 N4a, formatMinor 3): what the scene file now carries — custom node
// definitions, a per-node `v`, the Convert to code marker — through a REAL reload (autosave), a .tpscene load
// into a live room, the phone node sheet, and (N3C_OLD_URL set) an OLDER build opening the newer file.
//
// The bug this reproduces first: customNodeDefs had no save path, so a scene reloaded alone kept its custom
// node instances and lost what they run (no sockets, nothing evaluated).
//
// N3C_OLD_URL=https://theprototype.app:<port>/ (a v1.67.1 tree served by the lane, see STATUS) runs §5; without
// it §5 says SKIP and the rest still runs (the battery has no old build to point at).
//
// Counterfactual (run 2026-11-20, evidence e2e-cf2-autosave-no-defs.log): autosave.js restoring no definitions ->
// "the custom node's definition comes back after a real reload" and "its instance draws its two sockets again" red
// (the v1.68.0 state of the reload path). The merge / v / data.type guards have unit counterfactuals
// (tests/unit/nodeFileMinor3.test.js).
const h = require('./helpers.cjs');
const fs = require('fs');

const OUT = '/home/deck/.code/lanes-30/after-2.0/2.0-n3c/';
fs.mkdirSync(OUT, { recursive: true });
const OLD = process.env.N3C_OLD_URL || '';

const DEF = {
	id: 'wobble-def',
	name: 'Wobble',
	params: [
		{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 },
		{ key: 'size', kind: 'range', min: 0, max: 5, step: 1 }
	],
	code: 'object.rotation.y = base.rot[1] + time * (data.speed ?? 1);\n'
};
const DOC = {
	scene: {
		nodes: [
			{ id: 'n1', type: 'number', position: { x: 0, y: 0 }, data: { type: 'number', label: 'n1', value: 3 } },
			{ id: 'n2', type: 'number', position: { x: 0, y: 120 }, data: { type: 'number', label: 'n2', value: 4 } },
			{ id: 'm', type: 'math', position: { x: 260, y: 0 }, data: { type: 'math', label: 'm', op: 'mul', a: 0, b: 0 } },
			{ id: 'cn1', type: 'customnode', position: { x: 260, y: 200 }, data: { type: 'customnode', defId: DEF.id, speed: 1, size: 2 } }
		],
		edges: [
			{ id: 'e-n1-m.a', source: 'n1', target: 'm', targetHandle: 'a' },
			{ id: 'e-n2-m.b', source: 'n2', target: 'm', targetHandle: 'b' },
			{ id: 'e-n1-cn1.speed', source: 'n1', target: 'cn1', targetHandle: 'speed' }
		]
	}
};

const graph = (page) =>
	page.evaluate(() => {
		let ns;
		window.__tp.test.v1.flowNodes.subscribe((v) => (ns = v))();
		return ns.map((n) => ({ id: n.id, type: n.type, v: n.v, data: JSON.parse(JSON.stringify(n.data ?? {})) }));
	});
const defs = (page) =>
	page.evaluate(() => {
		let d;
		window.__tp.test.v1.customNodeDefs.subscribe((v) => (d = v))();
		return d.map((x) => x.id);
	});
const value = (page, id) =>
	page.evaluate((id) => {
		let v;
		window.__tp.test.v1.flowValues.subscribe((x) => (v = x))();
		const r = v[id];
		return r && typeof r === 'object' && r.__handles ? r.__default : r;
	}, id);
const sockets = (page, id) => page.evaluate((id) => document.querySelectorAll(`.svelteFlow [data-id="${id}"] .svelte-flow__handle[data-handleid]`).length, id);
const card = (id) => `.svelteFlow .svelte-flow__node[data-id="${id}"]`;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { storage: { flowPropsOpen: 'true', flowPropsTab: 'info' } });
	const p = A.page;

	// --- 1. a scene with a custom node and a converted Math -------------------------------------
	console.log('\n=== 1. author ===');
	await p.evaluate(
		([def, doc]) => {
			const t = window.__tp.test.v1;
			t.customNodes.saveNodeDef(def);
			t.restoreGraphs(JSON.parse(JSON.stringify(doc)));
		},
		[DEF, DOC]
	);
	await p.locator('p[title="Node editor (N)"]').click();
	await p.waitForTimeout(1500);
	await h.eventually(() => sockets(p, 'cn1'), (n) => n === 2, 'the custom node draws a socket per range param (its definition is here)');
	const conv = await p.evaluate(() => window.__tp.test.v1.convertToCode.convertNode('m'));
	h.check(conv?.ok === true, 'Math converts to code');
	await h.eventually(() => value(p, 'm'), (v) => v === 12, 'the converted Math reads 12');
	const payload = await p.evaluate(() => JSON.parse(JSON.stringify(window.__tp.test.v1.sessions.buildSessionPayload('minor3'))));
	h.check(payload.formatMinor >= 3, `the file says formatMinor 3 or later (${payload.formatMinor})`);
	h.check(Array.isArray(payload.nodeDefs) && payload.nodeDefs.length === 1 && payload.nodeDefs[0].id === DEF.id && payload.nodeDefs[0].code === DEF.code, 'the .tpscene carries nodeDefs (the definition, whole)');
	const mSaved = payload.graphs.scene.nodes.find((n) => n.id === 'm');
	h.check(mSaved?.type === 'script' && mSaved.data.convertedFrom?.type === 'math' && mSaved.v === undefined, 'the converted node is saved with its marker and no v (every core definition is v 1)');
	fs.writeFileSync(OUT + 'minor3-payload.json', JSON.stringify(payload));
	// a future file: a node with v 2 and a broken v beside it
	const future = JSON.parse(JSON.stringify(payload));
	future.graphs.scene.nodes.find((n) => n.id === 'n2').v = 2;
	future.graphs.scene.nodes.find((n) => n.id === 'n1').v = 'x';
	future.nodes = future.graphs.scene.nodes;

	// --- 2. a REAL reload (autosave) brings the definition and the marker back -------------------
	console.log('\n=== 2. real reload ===');
	await p.evaluate(async () => {
		const t = window.__tp.test.v1;
		t.autosave.autosaveEnabled.set(true);
		await t.autosave.saveNow();
	});
	await p.waitForTimeout(1200);
	await h.freshReload(A);
	await h.answerRestore(A, 'restore', 30000);
	await h.eventually(() => defs(p), (d) => d.includes(DEF.id), "the custom node's definition comes back after a real reload", 30000);
	await p.evaluate(() => window.__tp.test.v1.flowGraphClose.set(false));
	await p.waitForTimeout(1500);
	await h.eventually(() => sockets(p, 'cn1'), (n) => n === 2, 'and its instance draws its two sockets again', 15000);
	const afterReload = await graph(p);
	h.check(afterReload.find((n) => n.id === 'm')?.data.convertedFrom?.type === 'math', 'the converted Math keeps its marker across the reload');
	await h.eventually(() => value(p, 'm'), (v) => v === 12, 'and still reads 12');
	h.check((await p.evaluate(() => window.__tp.test.v1.convertToCode.convertNode('m', { back: true })))?.ok === true, 'Convert back still works after the reload (the code is unchanged)');
	h.check((await graph(p)).find((n) => n.id === 'm')?.type === 'math', 'it is a Math again');
	await p.screenshot({ path: OUT + 'minor3-01-after-reload.png' });

	// --- 3. a .tpscene load into a live room: the definition reaches the peer --------------------
	console.log('\n=== 3. .tpscene load with a peer ===');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await h.eventually(() => defs(B.page), (d) => d.includes(DEF.id), 'the joiner receives the definition on the handshake (as before)', 20000);
	for (const peer of [A, B]) await peer.page.evaluate(() => window.__tp.test.v1.customNodeDefs.set([]));
	await p.evaluate(async (payload) => {
		await window.__tp.test.v1.sessions.applySession(payload, { backup: false });
	}, future);
	await h.eventually(() => defs(p), (d) => d.includes(DEF.id), 'the .tpscene load brings the definition back');
	await h.eventually(() => defs(B.page), (d) => d.includes(DEF.id), 'and replicates it to the peer in the room');
	const g3 = await graph(p);
	h.check(g3.find((n) => n.id === 'n2')?.v === 2, 'a valid per-node v is kept');
	h.check(g3.find((n) => n.id === 'n1') && g3.find((n) => n.id === 'n1').v === undefined, 'a broken v is dropped at the boundary, the node stays');
	await h.eventually(
		async () => [await p.evaluate(() => window.__tp.test.v1.nodesHandler.graphHash()), await B.page.evaluate(() => window.__tp.test.v1.nodesHandler.graphHash())],
		([a, b]) => a === b,
		'the peer agrees on the loaded graph (nodesync hash, v included)',
		20000
	);
	{
		const dump = (page) =>
			page.evaluate(() => {
				let all;
				window.__tp.test.v1.flowGraphs.subscribe((v) => (all = v))();
				const s = window.__tp.test.v1.nodesHandler.serializeNode;
				return Object.fromEntries(Object.entries(all).map(([k, g]) => [k, { nodes: g.nodes.map(s).sort((a, b) => a.id.localeCompare(b.id)), edges: g.edges.map((e) => e.id).sort() }]));
			});
		fs.writeFileSync(OUT + 'minor3-graphs-A-B.json', JSON.stringify({ A: await dump(p), B: await dump(B.page) }, null, 1));
	}
	await h.closePeer(B);

	// --- 4. the phone node sheet: the action is there, the code is read-only ---------------------
	console.log('\n=== 4. phone sheet ===');
	const P = await h.setupPage(browser, 'phone', {
		context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9, userAgent: h.N6_UA },
		storage: { 'flowPropsOpen:touch': 'true', flowPropsTab: 'info', toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const q = P.page;
	await q.evaluate((payload) => window.__tp.test.v1.restoreGraphs(JSON.parse(JSON.stringify(payload.graphs))), payload);
	await q.evaluate(() => window.__tp.test.v1.flowGraphClose.set(false));
	await q.waitForTimeout(1500);
	await q.evaluate(() => window.__tp.test.v1.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: n.id === 'm' }))));
	await q.waitForTimeout(600);
	await q.locator(card('m')).tap({ position: { x: 20, y: 10 } }).catch(() => {});
	await q.waitForTimeout(600);
	const sheet = await q.evaluate(() => {
		const btn = document.querySelector('#flow-node-convert');
		const ro = document.querySelector('#flow-node-code-ro');
		return {
			handheld: matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches,
			conversion: btn?.getAttribute('data-conversion') ?? null,
			label: btn?.textContent?.trim() ?? '',
			code: ro?.textContent ?? '',
			editable: ro ? ro.isContentEditable || ro.tagName !== 'PRE' : null
		};
	});
	h.check(sheet.handheld, 'the phone context is handheld (coarse pointer, no hover)');
	h.check(sheet.conversion === 'back' && sheet.label === 'Convert back', `the phone sheet offers Convert back (${JSON.stringify(sheet.label)})`);
	h.check(/convertedFrom: math/.test(sheet.code) && sheet.editable === false, 'the phone sheet shows the code read-only');
	h.check(!/\p{Extended_Pictographic}/u.test(sheet.label + sheet.code), 'no emoji in the sheet');
	await q.screenshot({ path: OUT + 'minor3-02-phone-sheet.png' });
	await q.locator('#flow-node-convert').tap();
	// 2.0-int: Convert to code is a lazy chunk now (off the editor boot), so the first convert on a page waits for it
	let back = null;
	for (let i = 0; i < 40 && back !== 'math'; i++) {
		await q.waitForTimeout(500);
		back = (await graph(q)).find((n) => n.id === 'm')?.type ?? null;
	}
	h.check(back === 'math', `tapping it on the phone converts back (${back})`);
	await h.closePeer(P);

	// --- 5. an older build opens the newer file --------------------------------------------------
	console.log('\n=== 5. older build ===');
	if (!OLD) console.log('SKIP: N3C_OLD_URL not set (the v1.67.1 proof runs from the lane, see STATUS)');
	else {
		const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
		await ctx.addInitScript(() => {
			localStorage.setItem('debugStores', 'true');
			localStorage.setItem('hasSeenDisclaimer', 'true');
			localStorage.setItem('hasSeenWelcome', 'true');
		});
		const o = await ctx.newPage();
		const errors = [];
		o.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
		await o.goto(OLD, { waitUntil: 'domcontentloaded', timeout: 120000 });
		await o.waitForFunction(() => !!(window.__tp?.test?.v1?.sessions || window.__stores?.sessions), null, { timeout: 120000 });
		const res = await o.evaluate(async (payload) => {
			const t = window.__tp?.test?.v1 ?? window.__stores;
			let threw = null;
			try {
				await t.sessions.applySession(payload, { backup: false });
			} catch (e) {
				threw = String(e?.message ?? e);
			}
			await new Promise((r) => setTimeout(r, 3000));
			let ns;
			t.flowNodes.subscribe((v) => (ns = v))();
			let vals;
			t.flowValues.subscribe((x) => (vals = x))();
			const m = vals?.m;
			return {
				version: t.sessions.SESSION_FORMAT_MINOR ?? null,
				app: document.querySelector('meta[name="app-version"]')?.getAttribute('content') ?? null,
				threw,
				nodes: ns.map((n) => n.id + ':' + n.type).sort(),
				m: m && typeof m === 'object' && m.__handles ? m.__default : m
			};
		}, future);
		console.log('older build:', JSON.stringify(res));
		fs.writeFileSync(OUT + 'minor3-older-build.json', JSON.stringify({ url: OLD, ...res, errors }, null, 1));
		h.check(res.version === 2, `the older build reads formatMinor 2 (${res.version}): this is a newer file to it`);
		h.check(res.threw === null, `the older build opens the formatMinor 3 file without an error (${res.threw})`);
		h.check(JSON.stringify(res.nodes) === JSON.stringify(future.graphs.scene.nodes.map((n) => n.id + ':' + n.type).sort()), 'with every node');
		h.check(res.m === 12, `and runs the converted Math as an ordinary Script node (${res.m})`);
		await o.screenshot({ path: OUT + 'minor3-03-older-build.png' });
		await ctx.close();
	}

	await h.finish(browser);
});
