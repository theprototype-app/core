// 51-int — THE UNION of the roadmap-51 lanes, checked where they meet (none of them could alone), two peers:
//   U1 sources x edit: a prefab WITH logic scatters as its look (51-sources) and the set's "To objects" (51-edit) brings
//      the FULL prefab back with its logic — the user's 2026-10-21 rule ("Convert to object makes one real with its
//      logic"); each object stands centred on its instance with its base on the ground, on both peers; one undo.
//   U2 sources x edit: a pack-item set becomes objects carrying the pack reference (skips, never fails, when the
//      pack CDN is unreachable); U2b a Library-model set becomes objects that reach the other peer WITH their meshes.
//   U3 sources x surface x edit — DETERMINISM: a mixed, tinted, sunk, spaced, slope-masked fill on a terrain plus
//      hand edits (rotate, delete) through the Select tool, and a mixed fill on a sphere host, are the same instances
//      on both peers, a re-roll keeps the hand edits, and after a reload (autosave restore) A rebuilds them all.
//   U4 the Scatter section and the Sculpt toolbar (dark + High contrast) pass the axe gate (53 rules for new UI).
// Counterfactual: on feat/51 @1f3b9dd5 (the early union) U1's objects are the look only — no physics; v1.42.0 has no
// scatter sources at all (U1 red at its premise).
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
/** serious + critical violations under `include` @param {any} page @param {string} include */
async function axeBad(page, include) {
	const res = await new AxeBuilder({ page }).withTags(TAGS).include(include).analyze();
	return res.violations.filter((/** @type {any} */ v) => v.impact === 'serious' || v.impact === 'critical').map((/** @type {any} */ v) => `${v.id}x${v.nodes.length}`);
}

/** the drawn list of a set as plain rows (id, pose, source) @param {any} page @param {string} uuid @param {string} setId */
const rowsOf = (page, uuid, setId) =>
	page.evaluate(
		([u, s]) => /** @type {any} */ (window).__stores.terrainPaint.scatterInstancesOf(u, s).map((/** @type {any} */ i) => [i.id, +i.x.toFixed(4), +i.z.toFixed(4), +(i.y ?? 0).toFixed(4), +i.yaw.toFixed(4), +i.scale.toFixed(4), i.src ?? 0, +(i.tint ?? 0).toFixed(4)].join(' ')),
		[uuid, setId]
	);
/** @param {any} page @param {string} uuid */
const blockOf = (page, uuid) =>
	page.evaluate((u) => {
		/** @type {any} */
		let g = null;
		/** @type {any} */ (window).__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		const o = g?.getObjectByProperty('uuid', u);
		return o ? JSON.stringify(o.userData.terrainScatter ?? null) : 'missing';
	}, uuid);
/** @param {any} page */
const objectCount = (page) => page.evaluate(() => new Promise((r) => /** @type {any} */ (window).__stores.objectsGroup.subscribe((/** @type {any} */ g) => r(g.children.length))()));
/** objects whose name is `name`: their physics mode, world box bottom and centre @param {any} page @param {string} name */
const objectsNamed = (page, name) =>
	page.evaluate((n) => {
		const s = /** @type {any} */ (window).__stores;
		/** @type {any} */
		let g = null;
		s.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
		const THREE = s.THREE ?? null;
		return g.children
			.filter((/** @type {any} */ o) => o.name === n)
			.map((/** @type {any} */ o) => {
				o.updateWorldMatrix(true, true);
				let minY = Infinity;
				const c = { x: 0, z: 0, k: 0 };
				o.traverse((/** @type {any} */ m) => {
					if (!m.isMesh) return;
					m.geometry.computeBoundingBox();
					const bb = m.geometry.boundingBox;
					for (const x of [bb.min.x, bb.max.x])
						for (const y of [bb.min.y, bb.max.y])
							for (const z of [bb.min.z, bb.max.z]) {
								const e = m.matrixWorld.elements;
								const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
								minY = Math.min(minY, wy);
								c.x += e[0] * x + e[4] * y + e[8] * z + e[12];
								c.z += e[2] * x + e[6] * y + e[10] * z + e[14];
								c.k++;
							}
				});
				void THREE;
				return { uuid: o.uuid, physics: o.userData?.physics?.mode ?? null, packPath: o.userData?.packRef?.path ?? null, minY, cx: c.x / Math.max(1, c.k), cz: c.z / Math.max(1, c.k) };
			});
	}, name);

h.run(async () => {
	const browser = await h.launch();
	const storage = { 'shared:shareNewFiles': 'always' };
	const A = await h.setupPage(browser, 'A', { storage, context: { viewport: { width: 1440, height: 900 } } });
	const B = await h.setupPage(browser, 'B', { storage });
	await h.connect(B, A);

	const terrain = await A.page.evaluate(async () => {
		const s = /** @type {any} */ (window).__stores;
		s.commandsHandler.sceneCommand('/create Terrain 24 48');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		return /** @type {any} */ (group).children[/** @type {any} */ (group).children.length - 1].uuid;
	});
	await h.eventually(() => blockOf(B.page, terrain), (v) => v !== 'missing', 'premise: B has the terrain', 20000);

	// ---- U1: a logic prefab's look -> To objects = the prefab WITH its logic ----------------------------------------------
	const prefab = await A.page.evaluate(async () => {
		const s = /** @type {any} */ (window).__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		const group = /** @type {any} */ (await new Promise((r) => s.objectsGroup.subscribe(r)()));
		const box = group.children[group.children.length - 1];
		box.userData.physics = { mode: 'dynamic', mass: 2 };
		const entry = await s.prefabs.savePrefab(box.uuid, 'U51Crate');
		s.objectActions.deleteObjectsByUuid([box.uuid]);
		const source = await s.scatterSources.resolveSourceChoice('f:' + entry.id);
		return { id: entry.id, source };
	});
	h.check(prefab.source?.kind === 'library' && /look only/i.test(prefab.source?.note ?? ''), `premise: the prefab scatters as a Library look with the note (${JSON.stringify(prefab.source)?.slice(0, 160)})`);
	h.check(prefab.source?.prefab === prefab.id, 'U1: the look remembers its prefab (source.prefab)');
	await A.page.evaluate(([u, src]) => /** @type {any} */ (window).__stores.terrainPaint.addScatterSet(u, { id: 'crates', source: src, seed: 3, gen: { count: 12, scaleMin: 0.8, scaleMax: 1.3, rot: true } }), [terrain, prefab.source]);
	await h.eventually(() => rowsOf(A.page, terrain, 'crates'), (v) => v.length === 12, 'premise: A lays out 12 crates', 20000);
	const crates = await rowsOf(A.page, terrain, 'crates');
	const objs0 = await objectCount(A.page);
	await A.page.evaluate((u) => /** @type {any} */ (window).__stores.objectActions.selectObject(u, true), terrain);
	// the Inspector opens on a timer that runs late under load: wait until the row has held still before pressing it
	const btn = A.page.locator('[data-scatter-to-objects="crates"]');
	await btn.waitFor({ state: 'visible', timeout: 15000 });
	await btn.scrollIntoViewIfNeeded();
	let box0 = await btn.boundingBox();
	for (let i = 0; i < 20; i++) {
		await A.page.waitForTimeout(250);
		const box1 = await btn.boundingBox();
		if (box0 && box1 && Math.abs(box0.y - box1.y) < 0.5 && Math.abs(box0.x - box1.x) < 0.5) break;
		box0 = box1;
	}
	const tClick = Date.now();
	await btn.click();
	// the press imports the convert path on first use: on a loaded two-peer DEV server that took ~50 s (measured, the
	// dynamic imports), on a built app it is immediate — so a generous wait, and the time is printed
	await h.eventually(() => objectsNamed(A.page, 'U51Crate'), (v) => v.length === 12, 'U1: "To objects" makes 12 crates', 120000);
	console.log(`U1: the crates appeared ${Date.now() - tClick} ms after the press`);
	if ((await objectsNamed(A.page, 'U51Crate')).length !== 12)
		console.log('U1 DIAG', await A.page.evaluate(() => new Promise((r) => /** @type {any} */ (window).__stores.notifications.subscribe((/** @type {any[]} */ v) => r(JSON.stringify(v.slice(-4).map((n) => n.text))))())));
	const made = await objectsNamed(A.page, 'U51Crate');
	h.check(made.length === 12 && made.every((m) => m.physics === 'dynamic'), `U1: every crate is the FULL prefab — its physics came back (${made.map((m) => m.physics).join(',')})`);
	const ground = await A.page.evaluate(
		([u, pts]) => {
			const s = /** @type {any} */ (window).__stores;
			/** @type {any} */
			let g = null;
			s.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			const t = g.getObjectByProperty('uuid', u);
			const grid = s.terrainScatterCore.buildHeightGrid(t.geometry.attributes.position.array);
			return pts.map((/** @type {number[]} */ p) => s.terrainScatterCore.sampleHeight(grid, p[0], p[1]).y + t.position.y);
		},
		[terrain, made.map((m) => [m.cx, m.cz])]
	);
	const rows = crates.map((r) => r.split(' ').map(Number));
	const centred = made.every((m) => rows.some((r) => Math.hypot(r[1] - m.cx, r[2] - m.cz) < 0.03));
	h.check(made.length === 12 && centred, 'U1: each crate stands centred on an instance it replaced');
	const onGround = made.map((m, k) => Math.abs(m.minY - ground[k]));
	h.check(made.length === 12 && Math.max(...onGround) < 0.05, `U1: each crate's base is on the ground (max gap ${Math.max(...onGround).toFixed(3)} m)`);
	h.check((await rowsOf(A.page, terrain, 'crates')).length === 0, 'U1: the instances left the set');
	await h.eventually(() => objectsNamed(B.page, 'U51Crate'), (v) => v.length === 12 && v.every((m) => m.physics === 'dynamic'), 'U1: B has the 12 crates — same name, with their physics (COUNTERFACTUAL: B named them "U51Crate copy")', 60000);
	await A.page.evaluate(() => /** @type {any} */ (window).__stores.history.undo());
	h.check((await objectsNamed(A.page, 'U51Crate')).length === 0 && (await rowsOf(A.page, terrain, 'crates')).length === 12, 'U1: one undo — crates gone, instances back');
	await h.eventually(() => objectsNamed(B.page, 'U51Crate'), (v) => v.length === 0, 'U1: on B too', 15000);
	h.check((await objectCount(A.page)) === objs0, `U1: nothing left behind (${await objectCount(A.page)} objects, was ${objs0})`);
	await A.page.evaluate((u) => /** @type {any} */ (window).__stores.terrainPaint.writeScatter(u, (/** @type {any} */ b) => b.sets.filter((/** @type {any} */ x) => x.id !== 'crates')), terrain);

	// ---- U2: a pack-item set -> objects with the pack reference -------------------------------------------------------
	const pack = await A.page.evaluate(async () => {
		const s = /** @type {any} */ (window).__stores;
		try {
			await s.packs.loadPacks();
			const list = await Promise.race([s.scatterSources.packChoices(), new Promise((r) => setTimeout(() => r([]), 20000))]);
			const first = /** @type {any[]} */ (list)[0];
			return first ? { source: await s.scatterSources.resolveSourceChoice(first.value), name: first.name } : { none: /** @type {any[]} */ (list).length };
		} catch (e) {
			return { error: String(e) };
		}
	});
	if (!pack?.source) console.log(`SKIP U2: no pack items reachable (${JSON.stringify(pack)})`);
	else {
		await A.page.evaluate(([u, src]) => /** @type {any} */ (window).__stores.terrainPaint.addScatterSet(u, { id: 'kit', source: src, seed: 9, gen: { count: 4, scaleMin: 1, scaleMax: 1 } }), [terrain, pack.source]);
		await h.eventually(() => rowsOf(A.page, terrain, 'kit'), (v) => v.length === 4, 'premise: A lays out 4 pack items', 30000);
		const before = await objectCount(A.page);
		const kit = await A.page.evaluate((u) => /** @type {any} */ (window).__stores.scatterConvert.instancesToObjects({ scope: 'set', uuid: u, setId: 'kit' }, { confirm: false }), terrain);
		const refs = await A.page.evaluate(
			(ids) => {
				/** @type {any} */
				let g = null;
				/** @type {any} */ (window).__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
				return ids.map((/** @type {string} */ id) => g.getObjectByProperty('uuid', id)?.userData?.packRef?.path ?? null);
			},
			kit
		);
		h.check(kit.length === 4, `U2: the pack-item set became 4 objects (${kit.length}; COUNTERFACTUAL @1f3b9dd5: "not in your Library", 0)`);
		h.check(refs.every((p) => p === pack.source.path), `U2: each carries the pack reference (${refs[0]})`);
		await h.eventually(() => objectCount(B.page), (n) => n === before + 4, 'U2: B has them', 30000);
		await A.page.evaluate(() => /** @type {any} */ (window).__stores.history.undo());
		await h.eventually(() => objectCount(B.page), (n) => n === before, 'U2: one undo takes them back on B', 15000);
		await A.page.evaluate((u) => /** @type {any} */ (window).__stores.terrainPaint.writeScatter(u, (/** @type {any} */ b) => b.sets.filter((/** @type {any} */ x) => x.id !== 'kit')), terrain);
	}

	// ---- U2b: a Library-model set -> objects, on both peers (the prefab's look GLB, without its prefab id) ----------------
	const look = { kind: 'library', hash: prefab.source.hash, name: prefab.source.name };
	await A.page.evaluate(([u, src]) => /** @type {any} */ (window).__stores.terrainPaint.addScatterSet(u, { id: 'looks', source: src, seed: 5, gen: { count: 5, scaleMin: 1, scaleMax: 1 } }), [terrain, look]);
	await h.eventually(() => rowsOf(A.page, terrain, 'looks'), (v) => v.length === 5, 'premise: A lays out 5 Library models', 20000);
	const before2 = await objectCount(A.page);
	const libs = await A.page.evaluate((u) => /** @type {any} */ (window).__stores.scatterConvert.instancesToObjects({ scope: 'set', uuid: u, setId: 'looks' }, { confirm: false }), terrain);
	h.check(libs.length === 5, `U2b: the Library-model set became 5 objects (${libs.length})`);
	h.check((await objectCount(A.page)) === before2 + 5, 'U2b: ... and no template is left behind');
	/** meshes under each object, per peer @param {any} page */
	const meshCounts = (page) =>
		page.evaluate((ids) => {
			/** @type {any} */
			let g = null;
			/** @type {any} */ (window).__stores.objectsGroup.subscribe((/** @type {any} */ v) => (g = v))();
			return ids.map((/** @type {string} */ id) => {
				let n = 0;
				g.getObjectByProperty('uuid', id)?.traverse((/** @type {any} */ m) => m.isMesh && n++);
				return n;
			});
		}, libs);
	const meshesA = await meshCounts(A.page);
	await h.eventually(() => meshCounts(B.page), (v) => v.length === 5 && v.every((n, k) => n > 0 && n === meshesA[k]), `U2b: B has the 5 objects WITH their meshes (A ${meshesA.join(',')}; COUNTERFACTUAL: duplicates of a template whose meshes had not arrived)`, 60000);
	await A.page.evaluate(() => /** @type {any} */ (window).__stores.history.undo());
	await h.eventually(() => objectCount(B.page), (n) => n === before2, 'U2b: one undo takes them back on B', 30000);
	await A.page.evaluate((u) => /** @type {any} */ (window).__stores.terrainPaint.editScatterSet(u, 'looks', null), terrain);

	// ---- U3: determinism — mixed + tint + sink + spacing + slope mask + hand edits, two peers, re-roll, reload ----------
	await A.page.evaluate(
		(u) =>
			/** @type {any} */ (window).__stores.terrainPaint.addScatterSet(u, {
				id: 'mix',
				source: { kind: 'primitive', type: 'Cone' },
				sources: [
					{ source: { kind: 'primitive', type: 'Cone' }, w: 1 },
					{ source: { kind: 'primitive', type: 'Dodecahedron' }, w: 3 }
				],
				seed: 4242,
				tint: 0.4,
				sink: 0.05,
				gen: { count: 300, scaleMin: 0.5, scaleMax: 1.5, rot: true, spacing: 0.4, slope: [0, 35] }
			}),
		terrain
	);
	await h.eventually(() => rowsOf(A.page, terrain, 'mix'), (v) => v.length > 200, 'premise: A lays out the mixed fill', 20000);
	await A.page.evaluate(async (u) => {
		const s = /** @type {any} */ (window).__stores;
		s.terrainSculpt.enterSculpt(u);
		s.terrainSculpt.sculptOp.set('scatter');
		s.scatterEdit.setScatterTool('select');
		s.scatterEdit.setScatterSelection(u, new Map([['mix', new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])]]));
		s.scatterEdit.rotateSelectedInstances(45);
		s.scatterEdit.scaleSelectedInstances(1.5);
		await new Promise((r) => setTimeout(r, 300));
		s.scatterEdit.setScatterSelection(u, new Map([['mix', new Set([20, 21, 22, 23, 24])]]));
		s.scatterEdit.deleteSelectedInstances();
		await new Promise((r) => setTimeout(r, 300));
	}, terrain);
	const mixA = await rowsOf(A.page, terrain, 'mix');
	const edited = JSON.parse(await blockOf(A.page, terrain)).sets.find((/** @type {any} */ s) => s.id === 'mix');
	h.check(Object.keys(edited?.ov ?? {}).length >= 15, `premise: the edits are overrides on the seeded set (${Object.keys(edited?.ov ?? {}).length})`);
	const srcs = new Set(mixA.map((r) => r.split(' ')[6]));
	h.check(srcs.size === 2, `premise: the fill draws both models (${[...srcs].join(',')})`);
	await h.eventually(() => rowsOf(B.page, terrain, 'mix'), (v) => v.join('\n') === mixA.join('\n'), `U3: B rebuilds the SAME ${mixA.length} instances (ids, poses, models, tint) incl. A's hand edits`, 20000);

	const sphere = await A.page.evaluate(async () => {
		const s = /** @type {any} */ (window).__stores;
		s.terrainSculpt.exitSculpt();
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1200));
		const group = /** @type {any} */ (await new Promise((r) => s.objectsGroup.subscribe(r)()));
		const o = group.children[group.children.length - 1];
		o.position.set(6, 2, 6);
		s.peers && (await new Promise((r) => s.peers.subscribe(r)()))?.send?.({ type: 'move', uuid: o.uuid, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
		s.terrainPaint.addScatterSet(o.uuid, {
			id: 'moss',
			source: { kind: 'primitive', type: 'Box' },
			sources: [
				{ source: { kind: 'primitive', type: 'Box' }, w: 2 },
				{ source: { kind: 'primitive', type: 'Sphere' }, w: 1 }
			],
			seed: 99,
			tint: 0.3,
			gen: { count: 150, scaleMin: 0.05, scaleMax: 0.1, rot: true, spacing: 0.05 }
		});
		return o.uuid;
	});
	await h.eventually(() => rowsOf(A.page, sphere, 'moss'), (v) => v.length === 150, 'premise: A fills the sphere', 20000);
	const mossA = await rowsOf(A.page, sphere, 'moss');
	await h.eventually(() => rowsOf(B.page, sphere, 'moss'), (v) => v.join('\n') === mossA.join('\n'), 'U3: B draws the same mixed fill on the sphere host', 20000);

	await A.page.evaluate((u) => /** @type {any} */ (window).__stores.terrainPaint.rerollScatterSet(u, 'mix', 777), terrain);
	const rerolled = await rowsOf(A.page, terrain, 'mix');
	const ovAfter = JSON.parse(await blockOf(A.page, terrain)).sets.find((/** @type {any} */ s) => s.id === 'mix')?.ov ?? {};
	h.check(rerolled.join('\n') !== mixA.join('\n'), 'U3: Re-roll lays out a new fill');
	h.check(JSON.stringify(ovAfter) === JSON.stringify(edited.ov), `U3: ... and keeps every hand edit (the ${Object.keys(ovAfter).length} overrides unchanged)`);
	// an override pins what it edited (turn, size) on the re-rolled slot; a deleted slot stays deleted
	const afterRows = new Map(rerolled.map((r) => [r.split(' ')[0], r.split(' ').map(Number)]));
	const pinned = Object.entries(edited.ov).every(([k, o]) => {
		const row = afterRows.get('g' + k);
		const ov = /** @type {any} */ (o);
		if (ov.del) return !row;
		if (!row) return true; // a slot the new layout masks out
		return (ov.yaw === undefined || Math.abs(row[4] - ov.yaw) < 1e-3 || Math.abs(Math.abs(row[4] - ov.yaw) - 2 * Math.PI) < 1e-3) && (ov.scale === undefined || Math.abs(row[5] - ov.scale) < 1e-3);
	});
	h.check(pinned, 'U3: ... the edited slots keep their turn and size, the deleted ones stay deleted');
	await h.eventually(() => rowsOf(B.page, terrain, 'mix'), (v) => v.join('\n') === rerolled.join('\n'), 'U3: B follows the re-roll exactly', 20000);

	// ---- U4: axe on the Scatter section (dark + High contrast) and the Sculpt toolbar ----------------------------------
	await A.page.evaluate((u) => /** @type {any} */ (window).__stores.objectActions.selectObject(u, true), terrain);
	await A.page.waitForSelector('#terrain-scatter-sets', { timeout: 15000 });
	const badSection = await axeBad(A.page, '#terrain-scatter-sets');
	h.check(badSection.length === 0, `U4: the Scatter section has no serious/critical axe violation (${badSection.join(', ') || 'none'})`);
	await A.page.evaluate(() => /** @type {any} */ (window).__stores.themes.theme.set('contrast'));
	await A.page.waitForTimeout(400);
	const badContrast = await axeBad(A.page, '#terrain-scatter-sets');
	h.check(badContrast.length === 0, `U4: ... in High contrast too (${badContrast.join(', ') || 'none'})`);
	await A.page.evaluate(() => /** @type {any} */ (window).__stores.themes.theme.set('dark'));
	await A.page.evaluate((u) => {
		const s = /** @type {any} */ (window).__stores;
		s.terrainSculpt.enterSculpt(u);
		s.terrainSculpt.sculptOp.set('scatter');
		s.scatterEdit.setScatterTool('select');
	}, terrain);
	await A.page.waitForSelector('#sculpt-toolbar', { timeout: 15000 });
	const badBar = await axeBad(A.page, '#sculpt-toolbar');
	h.check(badBar.length === 0, `U4: the Sculpt toolbar's scatter tools have no serious/critical axe violation (${badBar.join(', ') || 'none'})`);
	await A.page.evaluate(() => /** @type {any} */ (window).__stores.terrainSculpt.exitSculpt());

	// ---- U3: reload — A rebuilds both fills from its autosave ----------------------------------------------------------
	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, `no page errors (${[...h.pageErrors(A), ...h.pageErrors(B)].slice(0, 2).join(' | ')})`);
	await A.page.evaluate(async () => {
		const s = /** @type {any} */ (window).__stores;
		s.autosave.saveNow();
		for (let i = 0; i < 100 && s.autosave.isSaving(); i++) await new Promise((r) => setTimeout(r, 200));
		await new Promise((r) => setTimeout(r, 500));
	});
	await h.freshReload(A);
	// the reload offers the autosave; restore it (through the modal's own action — a click on the modal timed out under load)
	const offered = await A.page
		.waitForFunction(
			() => {
				const m = /** @type {any} */ (window).__stores?.autosave;
				let v;
				m?.restoreAvailable?.subscribe((/** @type {any} */ x) => (v = x))();
				return !!v;
			},
			null,
			{ timeout: 30000, polling: 200 }
		)
		.then(() => true)
		.catch(() => false);
	h.check(offered, 'premise: the reload offers the autosave');
	await A.page.evaluate(() => /** @type {any} */ (window).__stores.autosave.restoreSnapshot());
	await h.eventually(() => rowsOf(A.page, terrain, 'mix'), (v) => v.join('\n') === rerolled.join('\n'), 'U3: after the reload A rebuilds the same terrain fill (seed + overrides)', 30000);
	await h.eventually(() => rowsOf(A.page, sphere, 'moss'), (v) => v.join('\n') === mossA.join('\n'), 'U3: ... and the same sphere fill', 30000);

	await h.finish(browser);
});
