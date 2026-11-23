// 105-slot-shaders: a node shader per material slot. A document keyed `<uuid>/<slotId>` draws on that slot only; the
// plain `<uuid>` key draws on every slot without its own; the scene default reaches material lists. Checks: a shader
// on one slot + the pixels of two faces, the all-slots key on a two-slot box, move between the keys (one undo), remove
// slot + undo, off + shader, duplicate (two peers agree on the copy's slot ids), merge import, reload (autosave), a
// saved scene reopened, two peers, a late joiner, the older-peer note (a page dialling without `slotShaders`), the
// Shader editor chip, and a single-material object staying on today's path.
//
// Optional E2E_BASE_URL = a dev server on the release before this one: §9 joins a page there (it keeps and forwards
// the slot document, draws the slot's own material, drops the document from its own save) and opens a file saved
// by this build there. Without it §9 prints a SKIP line.
//
// Counterfactual (the base, origin/feat/105-slots @ ca56d95d): §1 is red — the slot never draws the shader
// (shaderTargetSupported refuses the list, kinds stay ["material","material"]).
const h = require('./helpers.cjs');

const BASE = process.env.E2E_BASE_URL || '';
const NAME = 'ShBox';
const RED = '#ff0000';
const GREEN = '#00ff00';

/** a graph whose colour node has its own id, so each drawn product says which document made it */
const GRAPH = (/** @type {string} */ hex, /** @type {string} */ id) => ({
	nodes: [
		{ id, type: 'color', position: { x: 60, y: 80 }, data: { value: hex } },
		{ id: 's1', type: 'surface', position: { x: 320, y: 80 }, data: {} }
	],
	edges: [{ id: 'e1', source: id, sourceHandle: 'out', target: 's1', targetHandle: 'emissive' }]
});

/** run a body on the box: (w, o, uuid) @param {any} peer @param {string} body @param {string} [name] */
const call = (peer, body, name = NAME) =>
	peer.page.evaluate(
		async ({ body, name }) => {
			const w = window.__tp.test.v1;
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			/** @type {any} */ let o = null;
			g.traverse((/** @type {any} */ n) => (o ??= n.isMesh && n.name === name ? n : null));
			// eslint-disable-next-line no-new-func
			const fn = new Function('w', 'o', 'uuid', 'return (async () => {' + body + '})()');
			const out = await fn(w, o, o?.uuid);
			await new Promise((r) => setTimeout(r, 50));
			return out === undefined ? null : JSON.parse(JSON.stringify(out));
		},
		{ body, name }
	);

/** what each slot draws and which document made it @param {any} peer @param {string} [name] */
const snap = (peer, name = NAME) =>
	call(
		peer,
		`if (!o) return null;
		const S = w.shaderGraph;
		const list = Array.isArray(o.material) ? o.material : [o.material];
		const slots = w.materialSlots.slotsOf(o);
		const keys = Object.keys(S.shaderGraphs ? (await new Promise((r) => S.shaderGraphs.subscribe(r)())) : {});
		return {
			uuid,
			array: Array.isArray(o.material),
			ids: slots.map((s) => s.id),
			kinds: slots.map((s) => s.kind),
			// the colour node id of the product drawn in each slot ('' = its own material)
			by: list.map((m) => Object.keys(m?.userData?.shaderUniforms ?? {}).map((k) => k.split('_')[1]).filter(Boolean)[0] ?? ''),
			keys: keys.filter((k) => k === uuid || k.startsWith(uuid + '/')).sort(),
			driven: S.isShaderDriven(uuid)
		};`,
		name
	);

/** settle the debounced compiles + reconciles */
const settle = (/** @type {any} */ peer, ms = 700) => peer.page.waitForTimeout(ms);

const undo = (/** @type {any} */ peer) => peer.page.evaluate(() => window.__tp.test.v1.history.undo());
const redo = (/** @type {any} */ peer) => peer.page.evaluate(() => window.__tp.test.v1.history.redo());
const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);

/** dominant-channel pixel counts of the box's picture @param {any} peer */
async function huesOf(peer) {
	await peer.page.evaluate(() => window.__tp.test.v1.pokeScene?.());
	await peer.page.waitForTimeout(900);
	const png = await h.grabFrame(peer, await h.centeredClip(peer, [0, 0.5, 0], 240));
	return peer.page.evaluate(async (b64) => {
		const img = new Image();
		img.src = 'data:image/png;base64,' + b64;
		await img.decode();
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
		x.drawImage(img, 0, 0);
		const d = x.getImageData(0, 0, c.width, c.height).data;
		let red = 0, green = 0, blue = 0;
		for (let i = 0; i < d.length; i += 4) {
			const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
			if (r > 90 && r > g * 1.8 && r > b * 1.8) red++;
			else if (g > 90 && g > r * 1.8 && g > b * 1.8) green++;
			else if (b > 90 && b > r * 1.8 && b > g * 1.8) blue++;
		}
		return { red, green, blue };
	}, png.toString('base64'));
}

/** answer the restore offer with Restore (an in-page click when Playwright's hangs on a booting page) @param {any} peer */
async function restoreHere(peer) {
	await peer.page.waitForTimeout(3000);
	try {
		await h.answerRestore(peer, 'restore', 20000);
	} catch (error) {
		console.log('restore click fallback: ' + String(error).split('\n')[0]);
		await peer.page.evaluate(() => /** @type {HTMLElement | null} */ (document.getElementById('restore-session-restore'))?.click());
	}
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	await h.answerRestore(A);

	// ---- 0. a box with two slots: slot 0 = the +x / -x faces (red), slot 1 = the other four (green) -------------
	const hooks = await A.page.evaluate(() => !!window.__tp.test.v1.materialSlots?.slotsOf && !!window.__tp.test.v1.shaderGraph);
	h.check(hooks, '0 hooks: materialSlots + shaderGraph');
	if (!hooks) return h.finish(browser);
	await A.page.evaluate(async (name) => {
		const w = window.__tp.test.v1;
		w.shaderGraph.startShaderGraphs();
		const g0 = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const before = new Set(g0.children.map((/** @type {any} */ c) => c.uuid));
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		for (let i = 0; i < 50; i++) {
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const box = g.children.find((/** @type {any} */ c) => c.isMesh && !before.has(c.uuid));
			if (box) {
				box.name = name;
				box.position.set(0, 0.5, 0);
				box.rotation.set(0.45, 0.6, 0);
				return;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
	}, NAME);
	await call(
		A,
		`const M = w.materialsHandler;
		M.addMaterialSlot(uuid);
		M.setObjectMaterials(uuid, M.materialsOf(o), [{ start: 0, count: 12, materialIndex: 0 }, { start: 12, count: 24, materialIndex: 1 }]);
		M.setObjectColor(uuid, '${RED}', true, 0);
		M.setObjectColor(uuid, '${GREEN}', true, 1);`
	);
	const s0 = await snap(A);
	h.check(!!s0 && s0.array && s0.ids.length === 2 && same(s0.kinds, ['material', 'material']), '0 a two-slot box: ' + JSON.stringify(s0));
	const [SA, SB] = s0?.ids ?? ['', ''];
	const U = s0?.uuid;
	const hue0 = await huesOf(A);
	h.check(hue0.red > 200 && hue0.green > 200 && hue0.blue < 50, '0 pixels: red faces + green faces, no blue: ' + JSON.stringify(hue0));

	// ---- 1. a shader on ONE slot: slot B draws it, slot A keeps its own material ----------------------------------
	await call(A, `w.shaderGraph.setShaderGraphFor(uuid + '/${SB}', ${JSON.stringify(GRAPH('#0000ff', 'cB'))});`);
	await h.eventually(() => snap(A), (x) => same(x?.kinds, ['material', 'shader']) && x?.by[1] === 'cB', '1a the slot key draws on slot B only', 15000);
	const hue1 = await huesOf(A);
	h.check(hue1.blue > 200 && hue1.red > 200 && hue1.green < hue0.green / 4, '1b pixels: the B faces turn blue, the A faces stay red: ' + JSON.stringify(hue1));
	const driven1 = await call(A, `return [w.shaderGraph.isShaderDriven(uuid, '${SB}'), w.shaderGraph.isShaderDriven(uuid, '${SA}')];`);
	h.check(same(driven1, [true, false]), '1c isShaderDriven per slot: ' + JSON.stringify(driven1));
	const saved1 = await call(A, `const p = w.sessions.buildSessionPayload('slot-shaders', { thumbnail: false }); return { keys: Object.keys(p.shaderGraphs ?? {}), json: JSON.stringify(p.objects).includes('shaderUniforms') };`);
	h.check(!!saved1 && saved1.keys.includes(U + '/' + SB) && !saved1.json, '1d a save carries the slot document and never the compiled product: ' + JSON.stringify(saved1));

	// ---- 2. the object key = every slot WITHOUT its own key --------------------------------------------------------
	await call(A, `w.shaderGraph.setShaderGraphFor(uuid, ${JSON.stringify(GRAPH('#ffff00', 'cO'))});`);
	await h.eventually(() => snap(A), (x) => same(x?.kinds, ['shader', 'shader']) && same(x?.by, ['cO', 'cB']), '2a the all-slots key fills slot A; slot B keeps its own', 15000);
	await call(A, `w.shaderGraph.setShaderGraphFor(uuid + '/${SB}', null);`);
	await h.eventually(() => snap(A), (x) => same(x?.by, ['cO', 'cO']), '2b deleting the slot key hands slot B to the all-slots key', 15000);
	await undo(A);
	await h.eventually(() => snap(A), (x) => same(x?.by, ['cO', 'cB']), '2c undo brings the slot key back', 15000);

	// ---- 3. move between the keys: ONE undo step ---------------------------------------------------------------------
	await call(A, `return w.shaderGraph.moveShaderGraph(uuid, uuid + '/${SA}');`);
	await h.eventually(() => snap(A), (x) => same(x?.keys, [U + '/' + SA, U + '/' + SB].sort()) && same(x?.by, ['cO', 'cB']), '3a "Only this slot" moves the all-slots document onto slot A', 15000);
	await undo(A);
	await h.eventually(() => snap(A), (x) => same(x?.keys, [U, U + '/' + SB].sort()), '3b ONE undo puts it back on the object key', 15000);
	await redo(A);
	await h.eventually(() => snap(A), (x) => same(x?.keys, [U + '/' + SA, U + '/' + SB].sort()), '3c redo', 15000);

	// ---- 4. off + shader: off wins, the shader comes back with "on" ----------------------------------------------------
	await call(A, `w.materialSlots.setSlotOff(uuid, '${SB}', true);`);
	await h.eventually(() => snap(A), (x) => x?.kinds[1] === 'off' && x?.kinds[0] === 'shader', '4a an off slot draws the default, shader or not', 10000);
	await call(A, `w.materialSlots.setSlotOff(uuid, '${SB}', false);`);
	await h.eventually(() => snap(A), (x) => same(x?.kinds, ['shader', 'shader']) && x?.by[1] === 'cB', '4b on again: the slot shader draws', 10000);

	// ---- 5. remove a slot + undo ------------------------------------------------------------------------------------------
	await call(A, `w.materialSlots.removeSlot(uuid, '${SB}');`);
	await h.eventually(() => snap(A), (x) => x?.array === false && x?.driven === true && x?.by[0] === 'cO', '5a remove B: the survivor is one material, still drawn by its slot key (A)', 15000);
	const pruned = await call(A, `const p = w.sessions.buildSessionPayload('slot-shaders', { thumbnail: false }); const all = await new Promise((r) => w.shaderGraph.shaderGraphs.subscribe(r)()); return { saved: Object.keys(p.shaderGraphs), store: Object.keys(all) };`);
	h.check(!!pruned && !pruned.saved.includes(U + '/' + SB) && pruned.saved.includes(U + '/' + SA) && pruned.store.includes(U + '/' + SB), '5b the gone slot\'s document is pruned from the save only, kept in the store: ' + JSON.stringify(pruned));
	await undo(A);
	await h.eventually(() => snap(A), (x) => x?.array === true && same(x?.kinds, ['shader', 'shader']) && same(x?.by, ['cO', 'cB']), '5c undo: slot B is back, with its shader', 20000);

	// ---- 6. a single-material object stays on today's path (object.material IS the compiled material) --------------
	const single = await A.page.evaluate(async () => {
		const w = window.__tp.test.v1;
		const g0 = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const before = new Set(g0.children.map((/** @type {any} */ c) => c.uuid));
		w.commandsHandler.sceneCommand('/create Sphere');
		/** @type {any} */ let s = null;
		for (let i = 0; i < 50 && !s; i++) {
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			s = g.children.find((/** @type {any} */ c) => c.isMesh && !before.has(c.uuid)) ?? null;
			if (!s) await new Promise((r) => setTimeout(r, 200));
		}
		s.name = 'ShSphere';
		s.position.set(3, 0.5, 0);
		const own = s.material;
		w.shaderGraph.setShaderGraphFor(s.uuid, { nodes: [{ id: 'cS', type: 'color', data: { value: '#ff8800' } }, { id: 's1', type: 'surface', data: {} }], edges: [{ id: 'e1', source: 'cS', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }] });
		await new Promise((r) => setTimeout(r, 800));
		return { array: Array.isArray(s.material), swapped: s.material !== own, driven: w.shaderGraph.isShaderDriven(s.uuid), base: w.shaderGraph.baseMaterialOf(s.uuid) === own };
	});
	h.check(same(single, { array: false, swapped: true, driven: true, base: true }), '6 a one-material sphere: object.material is the compiled material, its own is the base (unchanged path): ' + JSON.stringify(single));

	// ---- 7. two peers, then a late joiner ------------------------------------------------------------------------------
	const B = await h.setupPageQuiet(browser, 'B', [A], { context: { viewport: { width: 1000, height: 700 } } });
	await h.answerRestore(B);
	await h.connect(B, A);
	await h.eventually(() => snap(B), (x) => same(x?.ids, [SA, SB]) && same(x?.by, ['cO', 'cB']), '7a the joiner draws the same shader per slot', 40000);
	await call(A, `w.shaderGraph.setShaderGraphFor(uuid + '/${SB}', ${JSON.stringify(GRAPH('#00ffff', 'cB2'))});`);
	await h.eventually(() => snap(B), (x) => x?.by[1] === 'cB2' && x?.by[0] === 'cO', '7b a slot edit on A reaches B on that slot only', 15000);
	await call(B, `w.shaderGraph.setShaderGraphFor(uuid + '/${SB}', null);`);
	await h.eventually(() => snap(A), (x) => x?.by[1] === '' && !x?.keys.includes(U + '/' + SB), '7c B removes the slot shader: A draws the slot\'s own material', 15000);
	await undo(B);
	await h.eventually(() => snap(A), (x) => x?.by[1] === 'cB2', '7d B\'s undo replicates', 15000);

	// duplicate on A: the copy keeps its slot ids on BOTH peers, and carries both documents
	const copyName = await call(A, `const c = w.objectActions.duplicateObject(uuid, { select: false }); c.name = 'ShCopy'; await new Promise((r) => setTimeout(r, 600)); return c.name;`);
	h.check(copyName === 'ShCopy', '7e duplicate made');
	await h.eventually(() => snap(A, 'ShCopy'), (x) => same(x?.ids, [SA, SB]) && same(x?.by, ['cO', 'cB2']), '7e the copy keeps the slot ids and draws both documents (A)', 15000);
	const copyA = await snap(A, 'ShCopy');
	await call(B, `const all = await new Promise((r) => w.objectsGroup.subscribe(r)()); const c = all.getObjectByProperty('uuid', '${copyA?.uuid}'); if (c) c.name = 'ShCopy';`);
	await h.eventually(() => snap(B, 'ShCopy'), (x) => same(x?.ids, [SA, SB]) && same(x?.by, ['cO', 'cB2']), '7f ... and on B (each peer clones; the written ids agree)', 20000);

	// merge import: a fresh uuid, its slot documents re-keyed onto it
	const imported = await call(
		A,
		`const p = w.sessions.buildSessionPayload('slot-shaders-merge', { thumbnail: false });
		const i = p.objects.findIndex((x) => x?.object?.name === '${NAME}');
		const before = new Set((await new Promise((r) => w.objectsGroup.subscribe(r)())).children.map((c) => c.uuid));
		const n = w.sessions.importObjects(JSON.parse(JSON.stringify(p)), [i]);
		await new Promise((r) => setTimeout(r, 800));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const fresh = g.children.find((c) => c.isMesh && !before.has(c.uuid) && c.name === '${NAME}');
		if (fresh) fresh.name = 'ShImported';
		return { n, index: i, uuid: fresh?.uuid ?? null };`
	);
	h.check(!!imported?.uuid && imported.uuid !== U, '7g merge import made a fresh object: ' + JSON.stringify(imported));
	await h.eventually(() => snap(A, 'ShImported'), (x) => same(x?.ids, [SA, SB]) && same(x?.by, ['cO', 'cB2']) && x?.keys.length === 2, '7g ... carrying both slot documents re-keyed', 15000);

	// a late joiner gets the documents with the handshake
	const C = await h.setupPageQuiet(browser, 'C', [A, B], { context: { viewport: { width: 900, height: 640 } } });
	await h.answerRestore(C);
	await h.connect(C, A);
	await h.eventually(() => snap(C), (x) => same(x?.by, ['cO', 'cB2']), '7h a late joiner draws the shader per slot', 40000);
	await C.ctx.close();

	// ---- 8. the older-peer note: a page dialling without slotShaders ----------------------------------------------------
	const O = await h.setupPageQuiet(browser, 'O', [A, B], { context: { viewport: { width: 900, height: 640 } }, storage: { debugCapsOff: 'slotShaders' } });
	await h.answerRestore(O);
	await h.connect(O, A);
	await h.eventually(() => snap(O), (x) => x?.ids?.length === 2, '8a a peer without slotShaders joins', 40000);
	const note = await A.page.evaluate(async () => {
		document.getElementById('peers-trigger')?.click();
		for (let i = 0; i < 30; i++) {
			const el = document.getElementById('peers-older-slots');
			if (el) return el.textContent?.trim() ?? '';
			await new Promise((r) => setTimeout(r, 200));
		}
		return null;
	});
	h.check(!!note && /older version/.test(note) && /per-slot shaders/.test(note), '8b People says so: ' + JSON.stringify(note));
	await A.page.keyboard.press('Escape');
	await O.ctx.close();

	// ---- 9. reload = autosave, then a saved scene reopened ---------------------------------------------------------------
	await B.ctx.close();
	await A.page.evaluate(() => window.__tp.test.v1.autosave.saveNow());
	await h.freshReload(A);
	await restoreHere(A);
	await A.page.evaluate(() => window.__tp.test.v1.shaderGraph.startShaderGraphs());
	await h.eventually(() => snap(A), (x) => same(x?.ids, [SA, SB]) && same(x?.by, ['cO', 'cB2']), '9a reload = autosave: the shader per slot comes back', 40000);
	const file = await A.page.evaluate(() => JSON.parse(JSON.stringify(window.__tp.test.v1.sessions.buildSessionPayload('slot-shaders-file', { thumbnail: false }))));
	await A.page.evaluate((payload) => window.__tp.test.v1.sessions.applySession(payload, { backup: false, replicate: false, quiet: true }), file);
	await h.eventually(() => snap(A), (x) => same(x?.ids, [SA, SB]) && same(x?.by, ['cO', 'cB2']), '9b a saved scene reopened: the same', 30000);

	// ---- 10. the Shader editor: the chip follows the active slot, Create makes what it says -----------------------------
	const chip = await call(
		A,
		`w.objectActions.applySelectionSet([uuid]);
		(await import('/src/lib/slotDraw.js')).activeMaterialSlot.set(1);
		await w.shaderGraph.openShaderEditor();
		await new Promise((r) => setTimeout(r, 1200));
		const one = document.getElementById('shader-slot-one');
		const all = document.getElementById('shader-slot-all');
		const label = document.getElementById('shader-scope')?.textContent ?? '';
		const r1 = { one: one?.getAttribute('aria-pressed'), all: all?.getAttribute('aria-pressed'), label };
		all?.click();
		await new Promise((r) => setTimeout(r, 300));
		const label2 = document.getElementById('shader-scope')?.textContent ?? '';
		return { r1, label2, move: document.getElementById('shader-slot-move')?.textContent?.trim() ?? null };`
	);
	h.check(
		!!chip && chip.r1.one === 'true' && chip.r1.all === 'false' && /slot/.test(chip.r1.label) && /all slots/.test(chip.label2) && chip.move === null,
		'10 the chip: the active slot with its own shader is picked; All slots scopes to the object key (both exist: no move offered): ' + JSON.stringify(chip)
	);

	// ---- 11. a peer on the previous release (optional) ------------------------------------------------------------------
	if (!BASE) console.log('SKIP 11 (no E2E_BASE_URL): an older peer keeps + forwards the slot document, draws the own material, its save drops it');
	else {
		const P = await h.setupPageQuiet(browser, 'P', [A], { url: BASE, context: { viewport: { width: 900, height: 640 } } });
		await h.answerRestore(P);
		await h.connect(P, A);
		await h.eventually(() => call(P, `if (!o) return null; const all = await new Promise((r) => w.shaderGraph.shaderGraphs.subscribe(r)()); return { keys: Object.keys(all).filter((k) => k.startsWith(uuid + '/')).length, drawsOwn: !(Array.isArray(o.material) ? o.material : [o.material]).some((m) => m?.userData?.shaderUniforms && m.userData.shaderUniforms.u_cB2_value) };`), (x) => x?.keys === 1 && x?.drawsOwn === true, '11a the older peer keeps the slot document and draws the slot\'s own material', 40000);
		const theirs = await call(P, `const p = w.sessions.buildSessionPayload('older', { thumbnail: false }); return Object.keys(p.shaderGraphs ?? {}).filter((k) => k.includes('/')).length;`);
		h.check(theirs === 0, '11b ... and its own save drops it (its prune reads the key as an object id): ' + theirs);
		const opened = await P.page.evaluate(async (payload) => {
			const w = window.__tp.test.v1;
			await w.sessions.applySession(payload, { backup: false, replicate: false, quiet: true });
			await new Promise((r) => setTimeout(r, 1500));
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			/** @type {any} */ let o = null;
			g.traverse((/** @type {any} */ n) => (o ??= n.isMesh && n.name === 'ShBox' ? n : null));
			return o ? { slots: Array.isArray(o.material) ? o.material.length : 1 } : null;
		}, file);
		h.check(opened?.slots === 2, '11c a file saved by this build opens on the older release with both slots: ' + JSON.stringify(opened));
		await P.ctx.close();
	}

	await h.finish(browser);
});
