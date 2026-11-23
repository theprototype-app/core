// fix-late-joiners — THE WIRE BOTH WAYS, AND THE FILE BOTH WAYS (a save/sync lane's proof).
//
// The branch next to the newest release (LJ_OTHER_URL, default the lane's snapshot port 7205, serving
// LJ_OTHER_DIR = build-base, the release build; started here when nothing answers):
//   1. a RELEASE host, a BRANCH late joiner: every object arrives (the branch reads the release's glTF objects);
//   2. a BRANCH host, a RELEASE late joiner: every object arrives (the release reads the branch's recipe objects
//      and ignores the additive `visible` field); names and hidden templates are right on the release too;
//   3. a scene SAVED on the release opens on the branch unchanged (objects, names, visibility, the graph);
//   4. a scene SAVED on the branch opens on the release unchanged.
// Run (built): npm run build; LANE_DEV_CMD='node scripts/serve-build.cjs --port $PORT' e2e-slot --dev <lane> 7204 -- env APP_URL=https://theprototype.app:7204/ node tests/e2e/late-joiner-compat.test.cjs
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const h = require('./helpers.cjs');

const OTHER_URL = process.env.LJ_OTHER_URL || 'https://theprototype.app:7205/';
const OTHER_DIR = process.env.LJ_OTHER_DIR || 'build-base';
const ROOT = path.resolve(__dirname, '..', '..');

const up = (url) =>
	new Promise((resolve) => {
		const req = https.get(url, { rejectUnauthorized: false, timeout: 3000 }, (res) => (res.resume(), resolve(res.statusCode === 200)));
		req.on('error', () => resolve(false));
		req.on('timeout', () => (req.destroy(), resolve(false)));
	});

/** the scene, built in a page: 40 meshes (spaced names), a group, three hidden templates, one /create box */
const build = async (page) =>
	page.evaluate(async () => {
		const s = /** @type {any} */ (window).__tp.test.v1;
		const THREE = await s.THREE;
		const ch = await s.commandsHandler;
		let g;
		/** @type {any} */ (window).__stores.objectsGroup.subscribe((v) => (g = v))();
		ch.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		g.children[g.children.length - 1].name = 'Made Box 1';
		for (let i = 0; i < 40; i++) {
			const m = new THREE.Mesh(i % 2 ? new THREE.SphereGeometry(0.3, 12, 8) : new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 40, 0.6, 0.5) }));
			m.name = 'Crate ' + i;
			m.position.set((i % 8) - 4, 0.3, Math.floor(i / 8) - 2);
			g.add(m);
		}
		const shelf = new THREE.Group();
		shelf.name = 'Shelf one';
		for (let k = 0; k < 3; k++) {
			const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0x3366cc }));
			m.name = 'Shelf box ' + k;
			m.position.set(k - 1, 0.2, 0);
			shelf.add(m);
		}
		shelf.position.set(0, 0, 5);
		g.add(shelf);
		for (const name of ['Coin template', 'Gate zone']) {
			const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffcc00 }));
			m.name = name;
			m.visible = false;
			m.position.set(6, 1, 0);
			g.add(m);
		}
		const orig = new THREE.Group();
		orig.name = 'Enemy original';
		const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.6, 0.6), new THREE.MeshStandardMaterial({ color: 0xaa2222 }));
		body.name = 'Enemy body';
		body.visible = false;
		orig.add(body);
		g.add(orig);
		const st = /** @type {any} */ (window).__stores;
		const graph = { nodes: [{ id: 'cx-sel', type: 'objectselector', position: { x: 0, y: 0 }, data: {} }], edges: [] };
		st.flowGraphs.update((all) => ({ ...all, scene: graph }));
		st.flowNodes.set(graph.nodes);
		s.commandsHandler.pokeScene?.();
		return true;
	});

const objects = (page) =>
	page.evaluate(() => {
		let g;
		/** @type {any} */ (window).__stores.objectsGroup.subscribe((v) => (g = v))();
		const out = [];
		g.traverse((o) => { if (o !== g) out.push({ uuid: o.uuid, name: o.name, visible: o.visible }); });
		let graphs;
		/** @type {any} */ (window).__stores.flowGraphs.subscribe((v) => (graphs = v))();
		return { list: out, nodes: (graphs.scene?.nodes ?? []).length };
	});

/** compare B's objects with A's: every uuid there; `strict` = names and visibility too */
const compare = async (A, B, label, strict) => {
	const a = await objects(A.page);
	await h.eventually(() => objects(B.page).then((b) => b.list.length), (n) => n >= a.list.length, `${label}: B holds as many objects as A (${a.list.length})`, 60000);
	await B.page.waitForTimeout(1200);
	const b = await objects(B.page);
	const by = new Map(b.list.map((o) => [o.uuid, o]));
	const missing = a.list.filter((o) => !by.has(o.uuid));
	h.check(!missing.length, `${label}: every object arrived (${missing.length} missing${missing.length ? ': ' + missing.slice(0, 4).map((o) => o.name).join(', ') : ''})`);
	if (strict) {
		const renamed = a.list.filter((o) => by.has(o.uuid) && by.get(o.uuid).name !== o.name);
		const shown = a.list.filter((o) => by.has(o.uuid) && by.get(o.uuid).visible !== o.visible);
		h.check(!renamed.length, `${label}: names as written (${renamed.length} differ${renamed.length ? ': ' + renamed.slice(0, 3).map((o) => `${o.name} -> ${by.get(o.uuid).name}`).join(', ') : ''})`);
		h.check(!shown.length, `${label}: hidden stays hidden, shown stays shown (${shown.length} differ${shown.length ? ': ' + shown.slice(0, 3).map((o) => o.name).join(', ') : ''})`);
	}
	return { a, b };
};

h.run(async () => {
	let server = null;
	if (!(await up(OTHER_URL))) {
		const port = new URL(OTHER_URL).port;
		server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve-build.cjs'), '--port', port, '--dir', OTHER_DIR], { cwd: ROOT, stdio: 'ignore' });
		process.on('exit', () => server?.kill());
		for (let i = 0; i < 60 && !(await up(OTHER_URL)); i++) await new Promise((r) => setTimeout(r, 500));
		h.check(await up(OTHER_URL), `premise: the release build answers on ${OTHER_URL} (${OTHER_DIR})`);
	}
	const browser = await h.launch();
	const rel = { url: OTHER_URL };

	console.log('\n=== 1. a release host, a branch late joiner ===');
	{
		const A = await h.setupPage(browser, 'A-release', rel);
		await build(A.page);
		const B = await h.setupPageQuiet(browser, 'B-branch', [A]);
		await h.connect(B, A);
		// the release SENDS glTF, which has no visibility: a release host's hidden templates still reach a joiner
		// shown (that half is fixed on the sending side, so it needs a branch host) — compare presence only
		await compare(A, B, '1 release -> branch', false);
		await A.page.context().close();
		await B.page.context().close();
	}

	console.log('\n=== 2. a branch host, a release late joiner ===');
	{
		const A = await h.setupPage(browser, 'A-branch');
		await build(A.page);
		const B = await h.setupPageQuiet(browser, 'B-release', [A], rel);
		await h.connect(B, A);
		await compare(A, B, '2 branch -> release', true);
		await A.page.context().close();
		await B.page.context().close();
	}

	const saveOn = (page) =>
		page.evaluate(async () => {
			const s = /** @type {any} */ (window).__tp.test.v1.sessions;
			const bytes = await s.exportSessionZip(s.buildSessionPayload('compat'));
			let bin = '';
			for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			return btoa(bin);
		});
	const openOn = (page, b64) =>
		page.evaluate(async (data) => {
			const s = /** @type {any} */ (window).__tp.test.v1.sessions;
			const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
			const payload = await s.importSessionZip(bytes.buffer);
			await s.applySession(payload, { backup: false, quiet: true });
			return true;
		}, b64);

	for (const [n, from, to] of [
		['3', rel, {}],
		['4', {}, rel]
	]) {
		const label = `${n} saved on the ${from.url ? 'release' : 'branch'}, opened on the ${to.url ? 'release' : 'branch'}`;
		console.log(`\n=== ${label} ===`);
		const S = await h.setupPage(browser, 'S' + n, from);
		await build(S.page);
		const before = await objects(S.page);
		const b64 = await saveOn(S.page);
		const O = await h.setupPage(browser, 'O' + n, to);
		await openOn(O.page, b64);
		await O.page.waitForTimeout(1500);
		const after = await objects(O.page);
		const by = new Map(after.list.map((o) => [o.uuid, o]));
		const missing = before.list.filter((o) => !by.has(o.uuid));
		const differ = before.list.filter((o) => by.has(o.uuid) && (by.get(o.uuid).name !== o.name || by.get(o.uuid).visible !== o.visible));
		h.check(!missing.length && !differ.length, `${label}: every object, name and visibility as saved (${missing.length} missing, ${differ.length} differ${differ.length ? ': ' + differ.slice(0, 3).map((o) => o.name + '/' + by.get(o.uuid).name).join(', ') : ''})`);
		h.check(after.nodes === before.nodes, `${label}: the scene graph too (${after.nodes} of ${before.nodes} nodes)`);
		await S.page.context().close();
		await O.page.context().close();
	}
	await h.finish(browser);
	server?.kill();
});
