// 55 (1.48.1): THE AGENT TOOL CONTRACT, end to end — orchestrator 41's research rounds 1-6 (agent-research r*.mjs)
// turned into checks, plus what 1.48.0/1.48.1 changed because of them. One host (A) and one agent page (B, the
// window.tpAgent API); every call goes through tpAgent.exec exactly as an MCP client's would, and what it claims is
// read back on the HOST, where it has to be true. Rows are independent: a red names its contract point.
const h = require('./helpers.cjs');

/** poll `fn` until `pred` holds or the time is up; returns the last value */
async function poll(fn, pred, timeout = 15000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (pred(last)) return last;
		await new Promise((r) => setTimeout(r, 400));
	}
	return last;
}
const short = (/** @type {any} */ v) => JSON.stringify(v ?? null).slice(0, 220);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B', { storage: { agentApi: '1' } });
	await B.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(B, A);
	const st = await poll(() => B.page.evaluate(() => window.tpAgent.status()), (s) => s?.joined && s.loading === false, 60000);
	h.check(st?.joined === true && st.loading === false, 'premise: the agent joined and the host\'s scene landed');

	/** one agent call @param {string} tool @param {any} args */
	const exec = (tool, args) => B.page.evaluate(([t, a]) => window.tpAgent.exec(t, a), [tool, args]);
	/** one host object, as the host has it @param {string} uuid */
	const onHost = (uuid) =>
		A.page.evaluate((u) => {
			/** @type {any} */ let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			const o = g?.getObjectByProperty('uuid', u);
			if (!o) return null;
			o.updateWorldMatrix(true, false);
			const w = o.getWorldPosition(o.position.clone());
			const m = Array.isArray(o.material) ? null : o.material;
			return {
				name: o.name,
				type: o.type,
				parent: o.parent?.uuid ?? null,
				local: o.position.toArray(),
				world: w.toArray(),
				intensity: o.intensity,
				color: o.color?.getHexString?.() ?? m?.color?.getHexString?.(),
				mat: m && { type: m.type, rough: m.roughness, metal: m.metalness, emissive: m.emissive?.getHexString?.(), ei: m.emissiveIntensity, opacity: m.opacity, transparent: m.transparent, clearcoat: m.clearcoat }
			};
		}, uuid);
	const near = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 0.01);

	// ---- R6.1 scale: 300 objects in one call, then the narrowed list_scene (1.48.1), then one delete
	const many = Array.from({ length: 300 }, (_, i) => ({ kind: 'primitive', primitive: 'Box', name: 'Bulk ' + i, params: [0.15, 0.15, 0.15], position: [-12 + (i % 20) * 0.3, 0.08, 6 + Math.floor(i / 20) * 0.3], physics: 'static' }));
	const big = await exec('create_objects', { objects: many });
	h.check(big?.created?.length === 300 && big.created.every((/** @type {any} */ c) => c.uuid), '300 objects in one create_objects call');
	const brief = await exec('list_scene', { brief: true, name: 'Bulk *' });
	h.check(brief?.matched === 300 && brief.objects?.length === 200 && brief.truncated === 100, 'list_scene {brief, name glob}: 300 matched, 200 listed, the rest counted: ' + short({ m: brief?.matched, n: brief?.objects?.length, t: brief?.truncated }));
	h.check(Object.keys(brief?.objects?.[0] ?? {}).sort().join() === 'name,parentUuid,type,uuid', 'brief rows carry uuid, name, type, parentUuid only');
	const ones = await exec('list_scene', { brief: true, name: 'bulk 1*' });
	h.check(ones?.matched === 111, 'a glob is case-insensitive and anchored ("bulk 1*" = Bulk 1, 10-19, 100-199): ' + ones?.matched);
	const nearby = await exec('list_scene', { brief: true, near: { position: [-12, 0.08, 6], radius: 0.2 } });
	h.check(nearby?.matched === 1 && nearby.objects?.[0]?.name === 'Bulk 0', 'list_scene {near}: the one object within the radius: ' + short(nearby?.objects));
	const del = await exec('delete_objects', { uuids: big.created.map((/** @type {any} */ c) => c.uuid) });
	h.check(del?.deleted === 300, '300 deleted in one call');

	// ---- R6.4 materials: each applied key is TRUE on the host; a key that cannot apply is an error, never ok
	const ball = (await exec('create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'Mat test', position: [-6, 0.5, -6], color: '#ff4060', physics: 'static' }] }))?.created?.[0]?.uuid;
	h.check(!!ball, 'premise: a sphere to paint');
	/** @type {[string, any, (r: any, o: any) => boolean][]} */
	const mats = [
		['roughness/metalness', { materialParams: { roughness: 0.1, metalness: 1 } }, (r, o) => r.ok && Math.abs(o.mat.rough - 0.1) < 1e-6 && o.mat.metal === 1],
		['emissive', { materialParams: { emissive: '#ff2200', emissiveIntensity: 3 } }, (r, o) => r.ok && o.mat.emissive === 'ff2200' && o.mat.ei === 3],
		['transparent', { materialParams: { transparent: true, opacity: 0.4 } }, (r, o) => r.ok && o.mat.transparent === true && Math.abs(o.mat.opacity - 0.4) < 1e-6],
		['physical + clearcoat', { materialType: 'MeshPhysicalMaterial', materialParams: { clearcoat: 1 } }, (r, o) => r.ok && o.mat.type === 'MeshPhysicalMaterial' && o.mat.clearcoat === 1],
		['a texture URL is refused', { materialParams: { map: 'https://example.com/x.png' } }, (r) => r.ok === false && /map/.test((r.errors || []).join())],
		['an unknown key is refused', { materialParams: { wobble: 5 } }, (r) => r.ok === false && /wobble/.test((r.errors || []).join())],
		['an 8-digit hex is refused', { color: '#40ff4060' }, (r) => r.ok === false && /colour|color/.test((r.errors || []).join())]
	];
	for (const [label, upd, ok] of mats) {
		const res = await exec('update_objects', { updates: [{ uuid: ball, ...upd }] });
		const row = res?.updated?.[0] ?? {};
		const host = await poll(() => onHost(ball), (o) => !!o && ok(row, o), 8000);
		h.check(!!host && ok(row, host), 'material: ' + label + ' — ' + short(row) + ' host ' + short(host?.mat));
	}

	// ---- R6.5 errors come back as errors (top level when nothing applied)
	const badUuid = await exec('update_objects', { updates: [{ uuid: 'nope', position: [0, 0, 0] }] });
	h.check(/no object/.test(badUuid?.updated?.[0]?.error ?? ''), 'an unknown uuid is an error on its row: ' + short(badUuid));
	const banana = await exec('create_objects', { objects: [{ kind: 'primitive', primitive: 'Banana', name: 'x' }] });
	h.check(typeof banana?.error === 'string', 'an unknown primitive: a top-level error (nothing was created): ' + short(banana));
	const negative = await exec('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Neg box', params: [-1, 0, 'a'] }] });
	h.check(/params\[0\]/.test(negative?.error ?? ''), 'a negative size is refused with the bad index: ' + short(negative));
	const unknownTool = await exec('make_coffee', {});
	h.check(typeof unknownTool?.error === 'string', 'an unknown tool is an error: ' + short(unknownTool));

	// ---- R6.6 a group keeps the name it was given
	const parts = (await exec('create_objects', { objects: [0, 1].map((i) => ({ kind: 'primitive', primitive: 'Box', name: 'G part ' + i, position: [-8 + i, 0.15, -8], physics: 'static' })) }))?.created ?? [];
	const grouped = await exec('group_objects', { name: 'G group', memberUuids: parts.map((/** @type {any} */ p) => p.uuid) });
	h.check(grouped?.name === 'G group' && grouped.members?.length === 2, 'group_objects keeps the name as given and nests both: ' + short(grouped));

	// ---- round 4: a light takes its fields
	const lamp = (await exec('create_objects', { objects: [{ kind: 'light', light: 'point', name: 'Lamp', position: [0, 3, 0], color: '#ffaa00', intensity: 5 }] }))?.created?.[0]?.uuid;
	const lampHost = await poll(() => onHost(lamp), (o) => o?.intensity === 5, 8000);
	h.check(lampHost?.intensity === 5 && lampHost.color === 'ffaa00', 'a light is created with its colour and intensity: ' + short(lampHost));

	// ---- 1.48.1 (a): with parentUuid, a position is LOCAL to the group
	const holder = (await exec('create_objects', { objects: [{ kind: 'group', name: 'Holder', position: [5, 0, 0] }] }))?.created?.[0]?.uuid;
	const kid = (await exec('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Kid', parentUuid: holder, position: [1, 0, 0], physics: 'static' }] }))?.created?.[0]?.uuid;
	const kidHost = await poll(() => onHost(kid), (o) => o?.parent === holder, 8000);
	h.check(kidHost?.parent === holder && near(kidHost.local, [1, 0, 0]) && near(kidHost.world, [6, 0, 0]), 'parentUuid: position [1,0,0] is local — world x 6 under a group at x 5: ' + short(kidHost));
	await exec('update_objects', { updates: [{ uuid: kid, position: [2, 0, 0] }] });
	const moved = await poll(() => onHost(kid), (o) => near(o?.local, [2, 0, 0]), 8000);
	h.check(near(moved?.world, [7, 0, 0]), 'update_objects position on a nested object is local too: ' + short(moved?.world));

	// ---- 1.48.1 (c): list_scene shows a primitive's shape
	const slab = (await exec('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Slab', params: [2, 1, 0.25], position: [0, 0.5, 4], physics: 'static' }] }))?.created?.[0]?.uuid;
	const scene = await exec('list_scene', { name: 'Slab' });
	const slabRow = scene?.objects?.find((/** @type {any} */ o) => o.uuid === slab);
	h.check(slabRow?.geometry?.type === 'Box' && slabRow.geometry.width === 2 && slabRow.geometry.depth === 0.25, 'list_scene carries the primitive\'s sizes: ' + short(slabRow?.geometry));

	// ---- 1.48.1 (b): a locked object's skip names the object and who holds it
	await A.page.evaluate((u) => window.__stores.objectActions.applySelectionSet([u]), slab);
	await poll(() => B.page.evaluate(() => new Promise((r) => window.__stores.lockedObjects.subscribe((l) => r(l))())), (l) => (l || []).some((/** @type {any} */ x) => x[1] === slab), 10000);
	const skipped = await exec('update_objects', { updates: [{ uuid: slab, position: [0, 0.5, 5] }] });
	const why = String(skipped?.updated?.[0]?.skipped ?? '');
	h.check(why.includes('"Slab"') && why.includes(A.id), 'a lock skip names the object and the peer holding it: ' + why);
	await A.page.evaluate(() => window.__stores.objectActions.applySelectionSet([]));

	// ---- 1.48.0: behaviours explain themselves; a wire must name a real socket
	const bhv = await exec('create_behaviour', {
		name: 'Conf',
		source: "export default behaviour({ name: 'Conf', state: { n: 0 }, inputs: ['hit'], outputs: ['n', 'done'], on: { hit() { this.state.n += 1; if (this.state.n > 2) this.emit('done'); } } });"
	});
	const made = bhv?.created?.[0];
	h.check(!!made?.id && (made.inputs || []).some((/** @type {any} */ i) => (i.name ?? i) === 'hit'), 'create_behaviour returns its node id and sockets: ' + short(bhv));
	const hook = await exec('create_behaviour', { name: 'Ticker', source: "export default behaviour({ name: 'Ticker', state: {}, onTick() {} });" });
	h.check(typeof hook?.error === 'string' && /onTick/.test(JSON.stringify(hook.issues)) && /per-frame/.test(JSON.stringify(hook.issues)), 'a per-frame hook is refused, saying there is none: ' + short(hook));
	const wire = await exec('create_flow_nodes', { graph: 'scene', nodes: [{ ref: 'c', type: 'onclick' }], edges: [{ from: 'c', to: made?.id, toHandle: 'nope' }] });
	const wireText = JSON.stringify(wire);
	h.check(/nope/.test(wireText) && /hit/.test(wireText), 'a toHandle the node does not declare is an error naming the real inputs: ' + short(wire));

	await h.finish(browser);
});
