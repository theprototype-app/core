// 107-look-fixes — two real peers (A hosts, B is a guest), the look tools through the in-app assistant's executor:
//   a. a slot made from faces gets its OWN texture: the Inspector's Tiling on it moves only it, and both peers agree
//   b. set_uv writes the material's stored tiling too, so the Inspector reads the new numbers (both peers)
//   c. set_uv on an object whose material is shared whole with a duplicate: by default it gets its own copy first and
//      only it is retiled (the answer says so, both peers keep the duplicate); shared: true retiles both and names it
//   d. edit_shader on the scene default shader from the GUEST's assistant asks the host first: the card shows on A,
//      Deny leaves the graph unchanged everywhere, Allow applies it as ONE undo step on the asker
// Run: APP_URL='https://localhost:7250/' npm run e2e -- look-slots-peers-107
const h = require('./helpers.cjs');

/** @param {any} peer @param {string} name @param {any} args */
const tool = (peer, name, args) => peer.page.evaluate(([n, a]) => window.__tp.test.v1.aiTools.executeAiTool(n, a), [name, args]);
/** per slot: tiling of its map, the stored texTransform, whether the map object is shared with another slot */
const slotsOf = (peer, id) =>
	peer.page.evaluate((id) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', id);
		if (!o) return null;
		const ms = Array.isArray(o.material) ? o.material : [o.material];
		return ms.map((m) => ({
			rep: m.map ? [m.map.repeat.x, m.map.repeat.y] : null,
			tt: m.userData?.texTransform?.repeat ?? null,
			shared: !!m.map && ms.some((n) => n !== m && n.map === m.map),
			hasMap: !!m.map
		}));
	}, id);
const sceneShader = (peer) => peer.page.evaluate(() => JSON.parse(JSON.stringify(window.__tp.test.v1.shaderGraph.shaderGraphOf('scene')?.nodes?.find((n) => n.id === 'g')?.data ?? null)));
const undoDepth = (peer) => peer.page.evaluate(() => { let n = 0; window.__tp.test.v1.history.undoStack.subscribe((s) => (n = s.length))(); return n; });
const short = (x) => JSON.stringify(x).slice(0, 500);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPageQuiet(browser, 'B', [A]);
	await h.connect(B, A); // B dials A: A hosts
	const hostless = await B.page.evaluate(() => { let v; window.__tp.test.v1.sessionHost?.subscribe?.((x) => (v = x))(); return v ?? null; });
	console.log('   B sees host: ' + hostless);

	// ---- a ----------------------------------------------------------------------------------------------------
	console.log('\n=== a. a faces slot has its own texture, on both peers ===');
	const img = await tool(A, 'add_image', { name: 'peer107', canvas: { width: 32, height: 32, background: '#446688', ops: [{ op: 'checker', cols: 4, rows: 4, colors: ['#ffffff', '#000000'] }] } });
	const made = await tool(A, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'PeerTiles', position: [0, 1, 0] }] });
	const box = made?.created?.[0]?.uuid;
	await tool(A, 'set_material', { objects: [box], maps: { albedo: img.hash } });
	await tool(A, 'set_uv', { objects: [box], tiling: 3 });
	const top = await tool(A, 'set_material', { objects: [box], faces: { normal: 'up' }, color: '#ffcc00' });
	h.check(top?.updated?.[0]?.newSlot?.from === 0, 'a. faces makes a slot from slot 0: ' + short(top?.updated?.[0]?.newSlot));
	await h.eventually(() => slotsOf(B, box), (s) => s?.length === 2 && s[1].hasMap && s[1].rep?.[0] === 3, 'a. B has the two slots, the new one tiled 3', 30000);
	await A.page.evaluate((id) => window.__tp.test.v1.materialMaps.setTexTransform(id, { repeat: [8, 8], offset: [0, 0], rotation: 0 }, 1), box);
	await h.eventually(() => slotsOf(A, box), (s) => s?.[1]?.rep?.[0] === 8, 'a. A: Inspector tiling on slot 1 lands', 15000);
	const onA = await slotsOf(A, box);
	h.check(onA[0].rep?.[0] === 3 && !onA[0].shared && !onA[1].shared, 'a. A: slot 0 stays 3, no texture object shared: ' + short(onA));
	await h.eventually(() => slotsOf(B, box), (s) => s?.[1]?.rep?.[0] === 8 && s[0].rep?.[0] === 3, 'a. B agrees: slot 1 at 8, slot 0 at 3', 30000);
	// the reverse: Inspector tiling on slot 0 leaves slot 1
	await A.page.evaluate((id) => window.__tp.test.v1.materialMaps.setTexTransform(id, { repeat: [2, 2], offset: [0, 0], rotation: 0 }, 0), box);
	await h.eventually(() => slotsOf(A, box), (s) => s?.[0]?.rep?.[0] === 2 && s[1].rep?.[0] === 8, 'a. A: Inspector tiling slot 0 leaves slot 1 at 8', 15000);
	await h.eventually(() => slotsOf(B, box), (s) => s?.[0]?.rep?.[0] === 2 && s[1].rep?.[0] === 8, 'a. B agrees', 30000);

	// ---- b ----------------------------------------------------------------------------------------------------
	console.log('\n=== b. set_uv writes the stored tiling the Inspector reads ===');
	const tiled = await tool(A, 'set_uv', { objects: [box], slot: 0, tiling: [6, 4] });
	h.check(JSON.stringify(tiled?.updated?.[0]?.slots?.map((s) => s.tiling)) === '[[6,4],[8,8]]', 'b. the answer has both slots: ' + short(tiled?.updated?.[0]?.slots));
	const readA = await A.page.evaluate((id) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const m = g.getObjectByProperty('uuid', id).material[0];
		return window.__tp.test.v1.materialMapTextures.texTransformOf(m).repeat;
	}, box);
	h.check(JSON.stringify(readA) === '[6,4]', 'b. A: the Inspector reads 6 x 4 (texTransformOf): ' + short(readA));
	await h.eventually(() => slotsOf(B, box), (s) => JSON.stringify(s?.[0]?.tt) === '[6,4]' && s[0].rep?.[0] === 6 && s[1].rep?.[0] === 8, 'b. B: slot 0 stored + live tiling 6 x 4, slot 1 still 8', 30000);

	// ---- c ----------------------------------------------------------------------------------------------------
	console.log('\n=== c. a material shared whole with a duplicate ===');
	const crate = (await tool(A, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Crate107', position: [3, 1, 0] }] }))?.created?.[0]?.uuid;
	await tool(A, 'set_material', { objects: [crate], maps: { albedo: img.hash } });
	await A.page.evaluate(() => window.__tp.test.v1.materialSharing.shareDuplicatedMaterials.set(true));
	const meshes = () => A.page.evaluate(() => { let g; window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))(); const out = []; g.traverse((n) => n.isMesh && out.push(n.uuid)); return out; });
	const beforeDup = await meshes();
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.duplicateObject(u), crate);
	await h.eventually(meshes, (m) => m.length === beforeDup.length + 1, 'c. the duplicate is there', 10000);
	const copy = (await meshes()).find((u) => !beforeDup.includes(u));
	h.check(await A.page.evaluate((u) => window.__tp.test.v1.materialSharing.isSharedMaterial(u), crate), 'c. the two share one material');
	const own = await tool(A, 'set_uv', { objects: [crate], tiling: 5 });
	const row = own?.updated?.[0];
	h.check(row?.madeUnique === true && row.sharedWith?.length === 1 && /own copy/.test(row.note ?? ''), 'c. default: made unique, and the answer says so: ' + short(row));
	h.check((await slotsOf(A, copy))?.[0]?.rep?.[0] === 1 && (await slotsOf(A, crate))?.[0]?.rep?.[0] === 5, 'c. A: the duplicate is NOT retiled');
	await h.eventually(() => Promise.all([slotsOf(B, crate), slotsOf(B, copy)]), ([c, d]) => c?.[0]?.rep?.[0] === 5 && d?.[0]?.rep?.[0] === 1, 'c. B agrees: the crate at 5, the duplicate at 1', 30000);
	// shared: true on a fresh pair
	const beforeDup2 = await meshes();
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.duplicateObject(u), copy);
	await h.eventually(meshes, (m) => m.length === beforeDup2.length + 1, 'c. a second duplicate', 10000);
	const copy2 = (await meshes()).find((u) => !beforeDup2.includes(u));
	const both = await tool(A, 'set_uv', { objects: [copy], tiling: 7, shared: true });
	h.check(both?.updated?.[0]?.alsoRetiled?.length === 1 && !both.updated[0].madeUnique, 'c. shared: true retiles both and names the other: ' + short(both?.updated?.[0]));
	await h.eventually(() => Promise.all([slotsOf(A, copy), slotsOf(A, copy2)]), ([c, d]) => c?.[0]?.rep?.[0] === 7 && d?.[0]?.rep?.[0] === 7, 'c. A: both at 7', 15000);
	await h.eventually(() => Promise.all([slotsOf(B, copy), slotsOf(B, copy2)]), ([c, d]) => c?.[0]?.rep?.[0] === 7 && d?.[0]?.rep?.[0] === 7, 'c. B: both at 7', 30000);

	// ---- d ----------------------------------------------------------------------------------------------------
	console.log('\n=== d. edit_shader on the scene shader asks the host ===');
	const made0 = await tool(A, 'create_shader', { scene: true, text: 'g = color {value: "#ff0000"}\nout = surface\ng -> out.emissive' });
	h.check(made0?.created?.[0]?.scene === true, 'd. the host made a scene default shader: ' + short(made0));
	await h.eventually(() => sceneShader(B), (d) => d?.value === '#ff0000', 'd. B has it', 30000);
	const edit = { shader: 'scene', params: [{ node: 'g', param: 'value', value: '#00ff00' }] };
	const asked = await tool(B, 'edit_shader', edit);
	h.check(asked?.needsConfirm === true && !!asked.confirmId, 'd. the guest\'s edit asks first: ' + short(asked));
	const card = A.page.locator('.tp-toast').filter({ hasText: /whole scene/ }).last();
	await card.waitFor({ timeout: 30000 });
	h.check(/default shader/.test(await card.innerText()), 'd. the card on the host says what: ' + (await card.innerText()).replace(/\s+/g, ' ').slice(0, 160));
	await card.getByRole('button', { name: 'Deny', exact: true }).click({ timeout: 30000 });
	const denied = await tool(B, 'edit_shader', { ...edit, confirmId: asked.confirmId, wait: 30 });
	h.check(denied?.denied === true, 'd. Deny comes back: ' + short(denied));
	await A.page.waitForTimeout(1500);
	h.check((await sceneShader(A))?.value === '#ff0000' && (await sceneShader(B))?.value === '#ff0000', 'd. Deny: the graph is unchanged on both');
	const asked2 = await tool(B, 'edit_shader', edit);
	const card2 = A.page.locator('.tp-toast').filter({ hasText: /whole scene/ }).last();
	await card2.waitFor({ timeout: 30000 });
	const depth = await undoDepth(B);
	await card2.getByRole('button', { name: 'Allow', exact: true }).click({ timeout: 30000 });
	const applied = await tool(B, 'edit_shader', { ...edit, confirmId: asked2.confirmId, wait: 30 });
	h.check(applied?.updated?.[0]?.ok === true && applied.status === 'allowed', 'd. Allow applies it: ' + short(applied));
	await h.eventually(() => sceneShader(A), (d) => d?.value === '#00ff00', 'd. A has the edit', 30000);
	h.check((await undoDepth(B)) === depth + 1, 'd. as ONE undo step on the asker (' + depth + ' -> ' + (await undoDepth(B)) + ')');
	await B.page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(() => sceneShader(A), (d) => d?.value === '#ff0000', 'd. that one undo takes it back on the host too', 30000);

	await browser.close();
});
