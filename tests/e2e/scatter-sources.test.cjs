// 51-sources — THE SCATTER SET FORMAT, E1 SOURCES AND DEVICE THINNING, two peers: A a desktop, B an
// emulated OPPO Find N6 (folded, touch, mobile viewport — "Auto" thins as a phone there).
//  §1 a seeded set travels as params + seed (a few hundred bytes) and B rebuilds the SAME instances
//  §2 thinning: the desktop draws every instance; the N6 draws fewer, the FAR ones, inside its budget,
//     every instance within NEAR_KEEP of its camera still drawn, the edge fading; "All" draws everything
//  §3 colliders are identical: a ball dropped on a rock the N6 does NOT draw rests on it there, and at
//     the same height on the desktop (counterfactual: the collider count = every instance, not the drawn)
//  §4 hand edits + re-roll: a moved slot stays where it was put on both peers, the rest re-roll
//  §5 a mixed set through the real "Add a model to the mix" select; weights replicate
//  §6 tint + sink replicate and land in the drawn pose / colours; one undo per change
//  §7 a prefab with logic scatters as its LOOK only (a Library GLB + the note); B pulls the bytes
//  §8 "Use selected object" → the brush source + the look-only note; the object menu offers it
//  §9 a 1.38 block loads byte-identical
//  §10 a pack item as a source (skips, never fails, when the pack CDN is unreachable)
const h = require('./helpers.cjs');

const N6_FOLDED = { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true };

/** every instance a terrain's set draws (ids + rounded poses) @param {any} page */
const instancesOf = (page, uuid, setId) =>
	page.evaluate(([u, s]) => window.__stores.terrainPaint.scatterInstancesOf(u, s).map((i) => [i.id, +i.x.toFixed(3), +i.z.toFixed(3), +i.yaw.toFixed(3), +i.scale.toFixed(3), i.src]), [uuid, setId]);

/** the drawn scatter of a terrain: per set, the instance ids in draw order, per source geometry type */
const drawnOf = (page, uuid) =>
	page.evaluate((u) => {
		let scene = null;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		/** @type {Record<string, {ids: string[], meshes: number, types: string[], colors: boolean}>} */
		const out = {};
		for (const holder of scene?.children ?? []) {
			if (holder.userData?.terrainScatterOf !== u) continue;
			for (const m of holder.children) {
				const set = m.userData.scatterSet;
				const e = (out[set] ??= { ids: [], meshes: 0, types: [], colors: false });
				e.meshes++;
				e.ids.push(...(m.userData.instanceIds ?? []).slice(0, m.count));
				e.types.push(m.geometry.type);
				if (m.instanceColor) e.colors = true;
			}
		}
		return out;
	}, uuid);

const blockOf = (page, uuid) =>
	page.evaluate((u) => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const o = g?.getObjectByProperty('uuid', u);
		return o ? (o.userData.terrainScatter ?? null) : 'missing';
	}, uuid);

const stats = (page) =>
	page.evaluate(async () => {
		window.__stores.scatterThin.thinNow();
		await new Promise((r) => setTimeout(r, 600));
		return window.__stores.scatterThin.scatterThinStats();
	});

const posOf = (page, uuid) =>
	page.evaluate((u) => {
		let g = null;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g?.getObjectByProperty('uuid', u)?.position.toArray() ?? null;
	}, uuid);

/** run a sim on `peer` until the ball rests; returns its height + the scatter collider debug */
async function drop(peer, ball, at) {
	await peer.page.evaluate(
		([u, p]) => {
			let g = null;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', u);
			o.position.set(p[0], p[1], p[2]);
			o.rotation.set(0, 0, 0);
			o.userData.physics = { mode: 'dynamic', mass: 1 };
			window.__stores.objectsGroup.update((v) => v);
			window.__stores.objectActions.deselectObject();
		},
		[ball, at]
	);
	await peer.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
	const started = await peer.page.evaluate(async () => {
		const ph = window.__stores.physics;
		await ph.toggleSimulation();
		let sim = null;
		let remote = null;
		ph.simulating.subscribe((v) => (sim = v))();
		ph.remoteSimulating?.subscribe?.((v) => (remote = v))();
		return { sim, remote };
	});
	console.log(`  ${peer.id} toggleSimulation -> ${JSON.stringify(started)}`);
	// rapier loads lazily on each page: wait for the run to really start (and its scatter colliders)
	await h.eventually(
		() => peer.page.evaluate(() => (window.__stores.physics.physicsWorldDebug()?.scatter ?? []).length),
		(n) => n > 0,
		peer.id + ' started a simulation with the scatter colliders',
		30000
	);
	await peer.page.waitForTimeout(800);
	let last = null;
	let still = 0;
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline && still < 3) {
		await peer.page.waitForTimeout(500);
		const y = (await posOf(peer.page, ball))?.[1] ?? null;
		still = last !== null && y !== null && Math.abs(y - last) < 0.004 ? still + 1 : 0;
		last = y;
	}
	const dbg = await peer.page.evaluate(() => window.__stores.physics.physicsWorldDebug().scatter);
	await peer.page.evaluate(() => window.__stores.physics.stopSimulation());
	await peer.page.waitForTimeout(500);
	return { y: last, dbg, rested: still >= 3 };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(3000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B', { context: N6_FOLDED });
	// A dials: the N6 layout keeps the dial box behind the phone bar
	await h.connect(A, B);

	// ---- §1 a seeded set: params + seed travel, B rebuilds the same instances ----------------
	const terrain = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Terrain 200 48');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const t = group.children[group.children.length - 1];
		t.userData.physics = { collider: 'trimesh' };
		s.objectsGroup.update((v) => v);
		s.objectActions.deselectObject();
		return t.uuid;
	});
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => v !== 'missing', 'B has the terrain', 20000);
	/** what A sends for the set */
	const sent = [];
	await A.page.evaluate(() => {
		window.__sent51 = [];
		window.__stores.peers.subscribe((p) => {
			const orig = p.send.bind(p);
			p.send = (m) => {
				if (m?.parameter === 'terrainScatter') window.__sent51.push(JSON.stringify(m).length);
				return orig(m);
			};
		})();
	});
	const setId = await A.page.evaluate(
		(u) =>
			window.__stores.terrainPaint.addScatterSet(u, {
				id: 'rocks',
				source: { kind: 'primitive', type: 'Sphere' },
				seed: 777,
				gen: { count: 6000, scaleMin: 1, scaleMax: 1, rot: true },
				collider: 'box'
			}),
		terrain
	);
	sent.push(...(await A.page.evaluate(() => window.__sent51)));
	h.check(setId === 'rocks', `addScatterSet made the set (${setId})`);
	h.check(sent.length === 1 && sent[0] < 600, `ONE message, params + seed only (${sent.join(',')} bytes for 6000 instances)`);
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => v?.sets?.[0]?.seed === 777, 'B has the set', 15000);
	const onA = await instancesOf(A.page, terrain, 'rocks');
	const onB = await instancesOf(B.page, terrain, 'rocks');
	h.check(onA.length === 6000, `A generates 6000 instances (${onA.length})`);
	h.check(JSON.stringify(onA) === JSON.stringify(onB), `B rebuilds the SAME instances from the seed (ids + poses, ${onB.length})`);
	h.check(onA[0][0] === 'g0' && onA[5999][0] === 'g5999', `ids are the slots (${onA[0][0]} … ${onA[5999][0]})`);

	// ---- §2 thinning: desktop draws all, the N6 the near ones ---------------------------------
	const sA = await stats(A.page);
	const sB = await stats(B.page);
	h.check(sA.profile === 'desktop' && sA.drawn === sA.instances, `desktop: profile ${sA.profile}, draws all (${sA.drawn}/${sA.instances})`);
	const dA = await drawnOf(A.page, terrain);
	h.check(dA.rocks?.ids.length === 6000, `desktop meshes draw every instance (${dA.rocks?.ids.length})`);
	h.check(sB.profile === 'phone', `the N6 (Auto) thins as a phone (${sB.profile})`);
	h.check(sB.drawn < sB.instances && sB.drawn > 100, `the N6 draws fewer (${sB.drawn} of ${sB.instances})`);
	h.check(sB.drawnTris <= sB.budget, `…inside its budget (${sB.drawnTris} of ${sB.budget} triangles; all ${sB.total})`);
	const near = await B.page.evaluate(
		([u, s]) => {
			let cam = null;
			window.__stores.globalCamera.subscribe((v) => (cam = v))();
			const e0 = cam.matrixWorld.elements;
			const p = { x: e0[12], y: e0[13], z: e0[14] };
			let scene = null;
			window.__stores.globalScene.subscribe((v) => (scene = v))();
			const drawn = new Set();
			let fading = 0;
			for (const holder of scene.children)
				if (holder.userData?.terrainScatterOf === u)
					for (const m of holder.children) {
						const ids = m.userData.instanceIds.slice(0, m.count);
						ids.forEach((id) => drawn.add(id));
						const e = m.instanceMatrix.array;
						for (let i = 0; i < m.count; i++) if (Math.hypot(e[i * 16], e[i * 16 + 1], e[i * 16 + 2]) < 0.98) fading++;
					}
			const all = window.__stores.terrainPaint.scatterInstancesOf(u, s);
			const nearIds = all.filter((i) => Math.hypot(i.x - p.x, p.y, i.z - p.z) < 30).map((i) => i.id);
			const far = all.map((i) => [i.id, Math.hypot(i.x - p.x, p.y, i.z - p.z)]).sort((a, b) => b[1] - a[1]);
			return { near: nearIds.length, missing: nearIds.filter((id) => !drawn.has(id)).length, fading, farthestDrawn: drawn.has(far[0][0]), farId: far[0][0] };
		},
		[terrain, 'rocks']
	);
	h.check(near.near > 0 && near.missing === 0, `every instance within 30 m of the N6 camera is drawn (${near.near}, missing ${near.missing})`);
	h.check(!near.farthestDrawn, `the farthest instance (${near.farId}) is not drawn on the N6`);
	h.check(near.fading > 0, `the edge fades (${near.fading} instances drawn shrunk)`);
	await B.page.evaluate(() => window.__stores.scatterThin.scatterDetail.set('off'));
	const sOff = await stats(B.page);
	h.check(sOff.drawn === sOff.instances && sOff.profile === null, `"All" on the N6 draws every instance (${sOff.drawn})`);
	await B.page.evaluate(() => window.__stores.scatterThin.scatterDetail.set('auto'));
	const sBack = await stats(B.page);
	h.check(sBack.drawn === sB.drawn, `back to Auto thins again (${sBack.drawn})`);
	const meter = await B.page.evaluate(() => window.__stores.budgetMeter.sampleBudget()?.totals?.triangles ?? null);
	h.check(meter !== null && meter >= sB.total, `the budget meter still counts every instance (${meter} ≥ ${sB.total})`);

	// ---- §3 colliders identical: a ball on a rock the N6 does not draw -------------------------
	const far = await B.page.evaluate(([u, id]) => window.__stores.terrainPaint.scatterInstancesOf(u, 'rocks').find((i) => i.id === id), [terrain, near.farId]);
	const ball = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1200));
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const b = group.children[group.children.length - 1];
		b.scale.set(0.4, 0.4, 0.4);
		s.objectsGroup.update((v) => v);
		return b.uuid;
	});
	await h.eventuallyAfter(A, B, () => posOf(B.page, ball), (v) => !!v, 'B has the ball', 15000);
	// A made (and so selected) the ball: a peer's selection is a LOCK, and a locked object is
	// left out of the simulation — let it go and wait for B to see it unlocked
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await h.eventually(
		() => B.page.evaluate((u) => {
			let l = [];
			window.__stores.lockedObjects.subscribe((v) => (l = v))();
			return !l.some((e) => e[1] === u);
		}, ball),
		(v) => v === true,
		'B sees the ball unlocked',
		10000
	);
	const over = [far.x, 4, far.z];
	const onPhone = await drop(B, ball, over);
	h.check(onPhone.dbg?.[0]?.colliders === 6000, `the N6's run builds a collider for EVERY instance, drawn or not (${JSON.stringify(onPhone.dbg)})`);
	h.check(onPhone.rested && onPhone.y > 0.9 && onPhone.y < 3.5, `N6: the ball rests ON the undrawn far rock (y ${onPhone.y?.toFixed(2)}; the ground would be ~0.2)`);
	await A.page.waitForTimeout(1500);
	const onDesk = await drop(A, ball, over);
	h.check(onDesk.dbg?.[0]?.colliders === 6000, `the desktop's run builds the same colliders (${JSON.stringify(onDesk.dbg)})`);
	h.check(onDesk.rested && Math.abs(onDesk.y - onPhone.y) < 0.05, `desktop: the same hit, the same height (${onDesk.y?.toFixed(3)} vs ${onPhone.y?.toFixed(3)})`);

	// ---- §4 hand edits + re-roll keep the edits --------------------------------------------------
	await A.page.evaluate((u) => window.__stores.terrainPaint.editScatterInstances(u, 'rocks', { g5: { x: 1.5, z: -2.5, yaw: 0.5 }, g6: { del: true } }), terrain);
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => !!v?.sets?.[0]?.ov?.['5'], 'B has the edits', 10000);
	const before = await instancesOf(B.page, terrain, 'rocks');
	await A.page.evaluate((u) => window.__stores.terrainPaint.rerollScatterSet(u, 'rocks', 4242), terrain);
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => v?.sets?.[0]?.seed === 4242, 'B has the re-roll', 10000);
	const after = await instancesOf(B.page, terrain, 'rocks');
	const g5 = after.find((i) => i[0] === 'g5');
	h.check(g5 && g5[1] === 1.5 && g5[2] === -2.5 && g5[3] === 0.5, `the moved slot stays where it was put after the re-roll (${JSON.stringify(g5)})`);
	h.check(!after.some((i) => i[0] === 'g6') && after.length === 5999, `the deleted slot stays deleted (${after.length})`);
	h.check(after.find((i) => i[0] === 'g7')?.[1] !== before.find((i) => i[0] === 'g7')?.[1], 'the unedited slots re-rolled');
	h.check(JSON.stringify(after) === JSON.stringify(await instancesOf(A.page, terrain, 'rocks')), 'A and B agree after edits + re-roll');
	// one undo puts the seed back
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => v?.sets?.[0]?.seed === 777, 'one undo restores the seed on B', 10000);

	// ---- §5 a mixed set through the real select ------------------------------------------------
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), terrain);
	const add = A.page.locator('[id="terrain-scatter-add-rocks"]');
	if (!(await add.isVisible().catch(() => false))) {
		const head = A.page.locator('button', { hasText: /^Scatter$/ }).first();
		if (await head.isVisible().catch(() => false)) await head.click({ timeout: h.PATIENT_CLICK_MS });
	}
	await add.scrollIntoViewIfNeeded({ timeout: h.PATIENT_CLICK_MS });
	await add.click({ timeout: h.PATIENT_CLICK_MS });
	await A.page.locator('.ts-list [role="option"]', { hasText: /^\s*Cone\s*$/ }).click({ timeout: h.PATIENT_CLICK_MS });
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => v?.sets?.[0]?.sources?.length === 2, 'B has the mix', 10000);
	const mixB = await blockOf(B.page, terrain);
	h.check(mixB.sets[0].sources[1].source.type === 'Cone', `the select added a Cone to the mix (${JSON.stringify(mixB.sets[0].sources.map((e) => e.source.type))})`);
	h.check(await A.page.locator('[data-scatter-sources="rocks"] [data-scatter-source]').count() === 2, 'Properties lists both models');
	await A.page.evaluate((u) => window.__stores.terrainPaint.setScatterSourceWeight(u, 'rocks', 1, 3), terrain);
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => v?.sets?.[0]?.sources?.[1]?.w === 3, 'the weight replicates', 10000);
	const mixed = await instancesOf(B.page, terrain, 'rocks');
	const cones = mixed.filter((i) => i[5] === 1).length;
	h.check(Math.abs(cones / mixed.length - 0.75) < 0.03, `weights 1:3 → ${(100 * cones / mixed.length).toFixed(1)} % cones`);
	const dMix = await drawnOf(A.page, terrain);
	h.check(dMix.rocks.types.includes('ConeGeometry') && dMix.rocks.types.includes('SphereGeometry'), `both models drawn (${[...new Set(dMix.rocks.types)].join(', ')})`);

	// ---- §6 tint + sink -----------------------------------------------------------------------
	await A.page.evaluate((u) => window.__stores.terrainPaint.editScatterSet(u, 'rocks', { tint: 0.6, sink: 0.3 }), terrain);
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => v?.sets?.[0]?.tint === 0.6 && v?.sets?.[0]?.sink === 0.3, 'tint + sink replicate', 10000);
	const pose = await A.page.evaluate((u) => {
		let scene = null;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		for (const holder of scene.children)
			if (holder.userData?.terrainScatterOf === u)
				for (const m of holder.children) {
					const i = m.userData.instanceIds.indexOf('g0');
					if (i < 0) continue;
					return { y: m.instanceMatrix.array[i * 16 + 13], colors: !!m.instanceColor, c: m.instanceColor ? Array.from(m.instanceColor.array.slice(i * 3, i * 3 + 3)) : null };
				}
		return null;
	}, terrain);
	h.check(pose && Math.abs(pose.y + 0.3) < 0.02, `g0 sits 0.3 m into the flat ground (y ${pose?.y?.toFixed(3)})`);
	h.check(pose?.colors && pose.c.some((v) => Math.abs(v - 1) > 0.01), `tinted instance colour (${pose?.c?.map((v) => v.toFixed(2))})`);
	h.check((await drawnOf(B.page, terrain)).rocks?.colors, 'B draws the tint too');
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventuallyAfter(A, B, () => blockOf(B.page, terrain), (v) => !v?.sets?.[0]?.tint && !v?.sets?.[0]?.sink, 'one undo clears tint + sink on B', 10000);

	// ---- §7 a prefab with logic scatters as its look only --------------------------------------
	const prefab = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		box.userData.physics = { mode: 'dynamic', mass: 2 };
		const entry = await s.prefabs.savePrefab(box.uuid, 'Crate');
		const source = await s.scatterSources.resolveSourceChoice('f:' + entry.id);
		return { id: entry.id, source };
	});
	h.check(prefab.source?.kind === 'library' && /look only/i.test(prefab.source?.note ?? ''), `the prefab became a Library look with a note (${JSON.stringify(prefab.source)})`);
	await A.page.evaluate(([u, src]) => window.__stores.terrainPaint.addScatterSet(u, { id: 'crates', source: src, seed: 3, gen: { count: 40, scaleMin: 1, scaleMax: 1 } }), [terrain, prefab.source]);
	await h.eventually(() => drawnOf(A.page, terrain), (v) => v.crates?.ids.length === 40, 'A draws the crates', 90000); // scatter-sync: the look loads + lays out locally; a slow runner needed > 20 s
	await h.eventuallyAfter(A, B, () => drawnOf(B.page, terrain), (v) => (v.crates?.ids.length ?? 0) > 0, 'B pulled the look and draws the crates', 30000);
	const glb = await A.page.evaluate((hash) => {
		let items = [];
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return items.find((i) => i.hash === hash)?.name ?? null;
	}, prefab.source.hash);
	h.check(/scatter look\)\.glb$/.test(glb ?? ''), `the look is a Library GLB (${glb})`);
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), terrain);
	await A.page.waitForTimeout(400);
	h.check(/look only/i.test((await A.page.locator('[data-scatter-sources="crates"] [data-scatter-note]').first().innerText().catch(() => '')) ?? ''), 'the source row shows the look-only note');

	// ---- §8 "Use selected object" ----------------------------------------------------------------
	const used = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create cone');
		await new Promise((r) => setTimeout(r, 1200));
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const cone = group.children[group.children.length - 1];
		cone.userData.physics = { mode: 'dynamic', mass: 1 };
		s.objectActions.selectObject(cone.uuid, true);
		// every label, submenus included (51-int moved the row under Physics & effects ▸)
		const flat = (/** @type {any[]} */ items) => items.flatMap((i) => [i?.label, ...flat(i?.children ?? [])]);
		const menu = s.objectMenu?.buildObjectMenuItems ? JSON.stringify(flat(s.objectMenu.buildObjectMenuItems(cone.uuid))) : null;
		const src = await s.scatterSources.useAsScatterSource();
		let brush = null;
		s.terrainPaint.scatterSource.subscribe((v) => (brush = v))();
		return { src, brush, menu };
	});
	h.check(used.brush?.kind === 'library' && used.brush?.hash === used.src?.hash, `the brush source is the selected object's look (${used.brush?.name})`);
	h.check(/logic is not scattered/.test(used.brush?.note ?? ''), `an object with physics says so (${used.brush?.note})`);
	if (used.menu) h.check(used.menu.includes('Use as scatter source'), 'the object menu offers "Use as scatter source"');

	// ---- §9 a 1.38 block loads byte-identical ----------------------------------------------------
	const legacy = await A.page.evaluate((u) => {
		const s = window.__stores;
		const core = s.terrainScatterCore;
		const B0 = { minX: -100, minZ: -100, sizeX: 200, sizeZ: 200 };
		const data = s.terrainPaintCore.bytesToBase64(core.encodeInstances([{ x: 1, z: 2, yaw: 0.5, scale: 1.2 }, { x: -3, z: 4, yaw: 1, scale: 0.8 }], B0));
		const block = { v: 1, sets: [{ id: 'p:Cone', source: { kind: 'primitive', type: 'Cone' }, align: true, data, count: 2, collider: 'box' }] };
		s.terrainSurface.applyTerrainScatter(u, block);
		let g = null;
		s.objectsGroup.subscribe((v) => (g = v))();
		return { sent: JSON.stringify(block), stored: JSON.stringify(g.getObjectByProperty('uuid', u).userData.terrainScatter) };
	}, terrain);
	h.check(legacy.stored === legacy.sent, `a 1.38 block is stored byte-identical (${legacy.stored.length} bytes)`);

	// ---- §10 a pack item ---------------------------------------------------------------------------
	const pack = await A.page.evaluate(async () => {
		const s = window.__stores;
		try {
			await s.packs.loadPacks();
			const list = await Promise.race([s.scatterSources.packChoices(), new Promise((r) => setTimeout(() => r([]), 20000))]);
			const pick = list.find((c) => /rock/i.test(c.name)) ?? list[0];
			return pick ? { pick, source: await s.scatterSources.resolveSourceChoice(pick.value) } : null;
		} catch (e) {
			return { error: String(e) };
		}
	});
	if (!pack?.source) console.log(`SKIP §10: no pack items reachable (${JSON.stringify(pack)})`);
	else {
		h.check(pack.source.kind === 'pack' && !!pack.source.path, `a pack item resolves to its path (${pack.source.path})`);
		await A.page.evaluate(([u, src]) => window.__stores.terrainPaint.addScatterSet(u, { id: 'kit', source: src, seed: 9, gen: { count: 30, scaleMin: 1, scaleMax: 1 } }), [terrain, pack.source]);
		await h.eventuallyAfter(A, B, () => drawnOf(B.page, terrain), (v) => (v.kit?.ids.length ?? 0) > 0, 'B fetches the pack item and draws it', 40000);
		const kitBlock = await blockOf(B.page, terrain);
		const kitSet = kitBlock.sets.find((s) => s.id === 'kit');
		h.check(!!kitSet && !kitSet.data && JSON.stringify(kitSet).length < 400, `only the path + params travel (${JSON.stringify(kitSet)?.length} bytes)`);
	}

	await h.finish(browser);
});
