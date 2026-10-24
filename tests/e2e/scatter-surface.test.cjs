// 51-surface — E2 scatter on ANY mesh + E3 fill mode and masks, two peers.
// E2: the "Add scatter" row sits in the Inspector right after the Water section (Add bubble / pour
//     emitter) on a plain mesh; it adds a FILL that lives in the object's own frame — move, turn
//     and scale the object and the instances follow, on both peers; the brush paints ON the mesh's
//     surface (a scatter-only session that never touches the geometry); one undo per stroke.
// E3: count vs density, minimum spacing (no two closer), slope and height masks, the painted
//     terrain layer mask; the same seed gives the same instances on both peers and after a
//     re-apply (a reload's path).
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOTS_DIR || '';

/** every drawn instance of one host, in WORLD space (holder matrixWorld x instance matrix), with the
 * local position and up axis too @param {any} page @param {string} uuid */
const drawn = (page, uuid) =>
	page.evaluate((u) => {
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		const holder = scene?.children.find((c) => c.name === 'terrain-scatter' && c.userData.terrainScatterOf === u);
		if (!holder) return [];
		holder.updateMatrixWorld(true);
		const THREE = window.__stores.THREE ?? null;
		const out = [];
		for (const mesh of holder.children) {
			const ids = mesh.userData.instanceIds ?? [];
			const e = new Array(16);
			for (let i = 0; i < mesh.count; i++) {
				const m = mesh.instanceMatrix.array.slice(i * 16, i * 16 + 16);
				const w = holder.matrixWorld.elements;
				// world = holder.matrixWorld * local (column-major)
				for (let r = 0; r < 4; r++)
					for (let c = 0; c < 4; c++) {
						let s = 0;
						for (let k = 0; k < 4; k++) s += w[k * 4 + r] * m[c * 4 + k];
						e[c * 4 + r] = s;
					}
				const up = [m[4], m[5], m[6]];
				const len = Math.hypot(up[0], up[1], up[2]) || 1;
				out.push({ id: ids[i], set: mesh.userData.scatterSet, local: [m[12], m[13], m[14]], up: up.map((v) => v / len), world: [e[12], e[13], e[14]] });
			}
			void THREE;
		}
		out.sort((a, b) => String(a.set + a.id).localeCompare(String(b.set + b.id)));
		return out;
	}, uuid);
/** @param {any} page @param {string} uuid */
const blockOf = (page, uuid) =>
	page.evaluate(
		(u) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', u);
					resolve(o ? JSON.stringify(o.userData.terrainScatter ?? null) : 'missing');
				})();
			}),
		uuid
	);
/** @param {any} a @param {any} b */
const samePlaces = (a, b, eps = 1e-4) =>
	a.length === b.length && a.every((p, i) => p.id === b[i].id && p.world.every((v, k) => Math.abs(v - b[i].world[k]) < eps));
/** @param {any} page */
const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
/** @param {any} page @param {string} uuid @param {string} setId @param {any} patch */
const editSet = (page, uuid, setId, patch) =>
	page.evaluate(([u, id, p]) => window.__stores.terrainPaint.editScatterSet(u, id, p), [uuid, setId, patch]);
/** the one set on a host @param {any} page @param {string} uuid */
const firstSet = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.getObjectByProperty('uuid', u)?.userData?.terrainScatter?.sets?.[0] ?? null;
	}, uuid);
/** move / turn / scale the host the replicated way @param {any} page @param {string} uuid */
const moveHost = (page, uuid, pos, rot, scale) =>
	page.evaluate(
		([u, p, r, s]) => {
			let g, peer;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			window.__stores.peers.subscribe((v) => (peer = v))();
			const o = g.getObjectByProperty('uuid', u);
			o.position.set(p[0], p[1], p[2]);
			o.rotation.set(r[0], r[1], r[2]);
			o.scale.set(s[0], s[1], s[2]);
			o.updateMatrixWorld(true);
			peer?.send({ type: 'move', uuid: u, pos: p, rot: r, scale: s });
		},
		[uuid, pos, rot, scale]
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- a plain mesh host: a sphere -------------------------------------------------------
	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 300));
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const o = group.children[group.children.length - 1];
		// park it where nothing else is, at rest (a /create stamps a dynamic body; no sim runs here)
		return o.uuid;
	});
	await h.eventually(() => blockOf(B.page, uuid), (v) => v !== 'missing', 'B has the sphere', 20000);
	await moveHost(A.page, uuid, [0, 1, 0], [0, 0, 0], [1, 1, 1]);
	const geoBefore = await A.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const geo = g.getObjectByProperty('uuid', u).geometry;
		window.__scatterGeoRef = geo.attributes.position;
		return { indexed: !!geo.index, verts: geo.attributes.position.count };
	}, uuid);

	// ---- E2: the "Add scatter" row, right after the Water section -------------------------------
	await A.page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), uuid);
	const add = A.page.locator('#scatter-add');
	await add.waitFor({ state: 'attached', timeout: 15000 });
	if (!(await add.isVisible().catch(() => false))) {
		const head = A.page.locator('button', { hasText: /^Scatter$/ }).first();
		if (await head.isVisible().catch(() => false)) await head.click();
	}
	const order = await A.page.evaluate(() => {
		const pour = document.querySelector('#pour-add');
		const bubbles = document.querySelector('#bubbles-add');
		const scatter = document.querySelector('#scatter-add');
		const after = (a, b) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
		// nothing but section chrome between the Water section's last row and the Scatter section
		return { pour: after(pour, scatter), bubbles: after(bubbles, scatter), label: scatter?.textContent?.trim() };
	});
	h.check(order.pour && order.bubbles, 'the Add scatter row comes after Add bubble emitter / Add pour emitter');
	h.check(order.label === 'Add scatter', `the row reads "Add scatter" (${order.label})`);
	await add.scrollIntoViewIfNeeded();
	const undo0 = await undoDepth(A.page);
	await add.click();
	await h.eventually(() => firstSet(A.page, uuid), (s) => !!s?.gen, 'Add scatter makes a FILL set on the sphere', 8000);
	const set = await firstSet(A.page, uuid);
	h.check(set.host === 'mesh' && set.gen.count === 200 && set.seed > 0, `the set lives on the mesh (host ${set.host}, count ${set.gen.count}, seeded)`);
	h.check((await undoDepth(A.page)) === undo0 + 1, 'adding the scatter = ONE undo entry');
	let aDrawn = await drawn(A.page, uuid);
	h.check(aDrawn.length === 200, `A draws 200 instances (${aDrawn.length})`);
	const onSurface = aDrawn.every((p) => Math.abs(Math.hypot(...p.local) - 1) < 0.03);
	h.check(onSurface, 'every instance sits ON the sphere surface (local |p| = radius)');
	h.check(
		aDrawn.every((p) => p.up[0] * p.local[0] + p.up[1] * p.local[1] + p.up[2] * p.local[2] > 0.95),
		'aligned to the surface: each instance stands on its normal'
	);
	const shown = await A.page.locator('[data-scatter-count]').first().getAttribute('data-scatter-count');
	h.check(shown === '200', `the Inspector shows the drawn count (${shown})`);
	if (SHOTS) await A.page.screenshot({ path: SHOTS + '/01-add-scatter-sphere.png' });

	// ---- replication + determinism -----------------------------------------------------------------
	const aBlock = await blockOf(A.page, uuid);
	h.check(aBlock.length < 400, `the wire carries params + seed, not instances (${aBlock.length} chars)`);
	await h.eventually(() => blockOf(B.page, uuid), (v) => v === aBlock, 'the block is equal on B', 15000);
	await h.eventually(() => drawn(B.page, uuid), (d) => samePlaces(d, aDrawn), 'B draws the SAME 200 instances (same seed, same places)', 15000);
	const reapplied = await A.page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const block = JSON.parse(JSON.stringify(g.getObjectByProperty('uuid', u).userData.terrainScatter));
		window.__stores.terrainSurface.applyTerrainScatter(u, null);
		window.__stores.terrainSurface.applyTerrainScatter(u, block);
		return true;
	}, uuid);
	h.check(reapplied && samePlaces(await drawn(A.page, uuid), aDrawn), 'a re-applied block (the reload path) lays out identically');

	// ---- relative to the host: move / turn / scale, on both peers ------------------------------------
	await moveHost(A.page, uuid, [3, 2, -1], [0, Math.PI / 2, 0], [2, 2, 2]);
	await A.page.waitForTimeout(200);
	const moved = await drawn(A.page, uuid);
	const expectWorld = (p) => [3 + 2 * p.local[2], 2 + 2 * p.local[1], -1 - 2 * p.local[0]]; // Ry(90°)·2·local + pos
	h.check(
		moved.length === 200 && moved.every((p) => expectWorld(p).every((v, k) => Math.abs(v - p.world[k]) < 1e-3)),
		'A: the instances follow the host (moved, turned 90°, scaled 2x)'
	);
	h.check(moved.every((p, i) => p.local.every((v, k) => Math.abs(v - aDrawn[i].local[k]) < 1e-6)), 'their LOCAL layout did not change (no reshuffle)');
	await h.eventually(() => drawn(B.page, uuid), (d) => samePlaces(d, moved, 2e-3), 'B: the instances followed the move too', 15000);

	// ---- E3 fill: density, spacing, masks ------------------------------------------------------------
	await editSet(A.page, uuid, set.id, { gen: { ...set.gen, count: undefined, density: 4 } });
	const dens = await drawn(A.page, uuid);
	// sphere area ~ 4π (~12.3 m² for the 32x16 chord sphere): 4 / m² (the format's cap) ~ 49 attempts,
	// all placed (no mask, no spacing)
	h.check(dens.length >= 45 && dens.length <= 51, `DENSITY 4/m² over the whole surface (${dens.length})`);
	await editSet(A.page, uuid, set.id, { gen: { ...set.gen, count: 150, spacing: 0.2 } });
	const spaced = await drawn(A.page, uuid);
	let minD = Infinity;
	for (let i = 0; i < spaced.length; i++)
		for (let j = i + 1; j < spaced.length; j++)
			minD = Math.min(minD, Math.hypot(...spaced[i].local.map((v, k) => v - spaced[j].local[k])));
	h.check(spaced.length === 150, `COUNT with spacing still places the count (${spaced.length})`);
	h.check(minD >= 0.2 - 1e-3, `minimum spacing: no two instances closer than 0.2 m (min ${minD.toFixed(3)})`);
	// past saturation (0.25 m packs ~120-140 on this sphere) COUNT places what fits, never overlaps
	await editSet(A.page, uuid, set.id, { gen: { ...set.gen, count: 400, spacing: 0.25 } });
	const full = await drawn(A.page, uuid);
	h.check(full.length > 80 && full.length < 400, `past saturation COUNT places what fits and stops (${full.length} of 400)`);
	await editSet(A.page, uuid, set.id, { gen: { ...set.gen, count: 120, slope: [0, 40] } });
	const top = await drawn(A.page, uuid);
	h.check(top.length === 120 && top.every((p) => p.local[1] > Math.cos((42 * Math.PI) / 180) * 0.97), `SLOPE 0..40°: only the cap of the sphere (${top.length})`);
	await editSet(A.page, uuid, set.id, { gen: { ...set.gen, count: 120, height: [-0.3, 0.3] } });
	const band = await drawn(A.page, uuid);
	h.check(band.length === 120 && band.every((p) => Math.abs(p.local[1]) <= 0.3 + 1e-3), `HEIGHT -0.3..0.3 (local): a band round the middle (${band.length})`);
	const bandBlock = await blockOf(A.page, uuid);
	await h.eventually(() => blockOf(B.page, uuid), (v) => v === bandBlock, 'the mask edits replicate', 15000);
	await h.eventually(() => drawn(B.page, uuid), (d) => d.length === 120 && d.every((p, i) => p.id === band[i].id), 'B draws the same masked fill', 15000);

	// the Fill rows in the Inspector: Density switch through the real Segmented control
	await A.page.locator('[id$="-mode-density"]').first().click();
	await h.eventually(() => firstSet(A.page, uuid), (s) => s?.gen?.density != null && s.gen.count == null, 'the Fill row switches the set to DENSITY', 8000);
	await A.page.locator('[id$="-mode-count"]').first().click();
	await h.eventually(() => firstSet(A.page, uuid), (s) => s?.gen?.count != null, '...and back to COUNT', 8000);
	if (SHOTS)
		for (const t of ['dark', 'light']) {
			await A.page.evaluate((th) => window.__stores.themes.theme.set(th), t);
			await A.page.waitForTimeout(400);
			await A.page.locator('[data-scatter-fill]').first().scrollIntoViewIfNeeded();
			await A.page.screenshot({ path: `${SHOTS}/02-fill-rows-${t}.png` });
		}
	await A.page.evaluate(() => window.__stores.themes.theme.set('dark'));

	// ---- the brush ON the mesh: a scatter-only session, geometry untouched --------------------------
	await moveHost(A.page, uuid, [0, 1, 0], [0, 0, 0], [1, 1, 1]);
	const paint = await A.page.evaluate(async (u) => {
		const s = window.__stores;
		const ts = s.terrainSculpt;
		const ok = ts.enterSculpt(u, { scatter: true });
		let only, op, mode;
		ts.sculptScatterOnly.subscribe((v) => (only = v))();
		ts.sculptOp.subscribe((v) => (op = v))();
		ts.sculptMode.subscribe((v) => (mode = v))();
		ts.sculptRadius.set(0.6);
		s.terrainPaint.scatterSource.set({ kind: 'primitive', type: 'Box' });
		s.terrainPaint.scatterDensity.set(4);
		s.terrainPaint.scatterErase.set(false);
		ts.beginStroke(u);
		// along the equator (local), +x side: points ON the sphere
		for (let i = 0; i < 8; i++) {
			const a = (i / 8) * 0.8;
			ts.strokeMove(u, Math.cos(a), Math.sin(a), 0.05, 0);
		}
		ts.endStroke();
		await new Promise((r) => setTimeout(r, 100));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		const sets = o.userData.terrainScatter.sets;
		return { ok, only, op, mode, sets: sets.length, painted: sets.find((x) => x.source.type === 'Box') ?? null, sameGeo: o.geometry.attributes.position === window.__scatterGeoRef, indexed: !!o.geometry.index };
	}, uuid);
	h.check(paint.ok && paint.only && paint.op === 'scatter' && paint.mode === 'mesh', 'Paint scatter… opens a scatter-only session on the mesh');
	h.check(paint.sameGeo && paint.indexed === geoBefore.indexed, 'the mesh geometry is untouched (no soup conversion, nothing sent)');
	h.check(!!paint.painted && paint.painted.host === 'mesh' && paint.painted.count > 4 && Array.isArray(paint.painted.box), `a stroke paints 16-byte records on the surface (${paint.painted?.count})`);
	const boxes = (await drawn(A.page, uuid)).filter((p) => p.set === paint.painted?.id);
	h.check(boxes.length === paint.painted?.count && boxes.every((p) => Math.abs(Math.hypot(...p.local) - 1) < 0.03 && p.local[0] > 0.3), 'painted instances sit ON the sphere where the brush went');
	const pBlock = await blockOf(A.page, uuid);
	await h.eventually(() => blockOf(B.page, uuid), (v) => v === pBlock, 'the stroke replicates', 15000);
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => firstSet(A.page, uuid).then(() => blockOf(A.page, uuid)), (v) => !v.includes('"Box"'), 'ONE undo removes the stroke', 8000);
	await h.eventually(() => blockOf(B.page, uuid), (v) => !v.includes('"Box"'), '...on B too', 15000);
	await A.page.evaluate(() => window.__stores.terrainSculpt.exitSculpt());

	// ---- a terrain fill on a painted layer ------------------------------------------------------------
	const terrain = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Terrain 20 20');
		await new Promise((r) => setTimeout(r, 300));
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const t = group.children[group.children.length - 1];
		// layer 3 on the +x half
		const res = 64;
		const bytes = new Uint8Array(res * res * 4);
		for (let z = 0; z < res; z++) for (let x = 0; x < res; x++) bytes[(z * res + x) * 4 + (x >= res / 2 ? 2 : 0)] = 255;
		s.terrainSurface.applyTerrainSplat(t.uuid, bytes, res);
		const id = s.terrainPaint.addScatterSet(t.uuid, { source: { kind: 'primitive', type: 'Cone' }, gen: { count: 120, scaleMin: 1, scaleMax: 1, rot: true, layer: { i: 2, min: 0.9 } } });
		return { uuid: t.uuid, id };
	});
	const onLayer = await drawn(A.page, terrain.uuid);
	h.check(onLayer.length === 120 && onLayer.every((p) => p.local[0] > -0.2), `LAYER mask: the fill sits on painted layer 3 only (${onLayer.length})`);
	const tSet = await firstSet(A.page, terrain.uuid);
	h.check(!tSet.host && tSet.gen.layer?.i === 2, 'a terrain set carries no host field (byte-identical shape) and keeps its mask');

	// ---- a GROUP host (a placed model is one): the fill covers its children, in its frame ------------
	const grp = await A.page.evaluate(async () => {
		const w = window.__stores;
		for (let i = 0; i < 2; i++) w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 300));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const kids = g.children.slice(-2);
		let peer;
		w.peers.subscribe((v) => (peer = v))();
		// placed the replicated way, or B builds the group around boxes still at the origin
		kids.forEach((o, i) => {
			o.position.set(8 + i * 3, 0.5, 8);
			o.updateMatrixWorld(true);
			peer?.send({ type: 'move', uuid: o.uuid, pos: o.position.toArray(), rot: [0, 0, 0], scale: [1, 1, 1] });
		});
		await new Promise((r) => setTimeout(r, 800));
		w.objectActions.applySelectionSet(kids.map((o) => o.uuid));
		const uuid = w.objectActions.groupSelection();
		await new Promise((r) => setTimeout(r, 300));
		const host = w.terrainPaint.isMeshHost(g.getObjectByProperty('uuid', uuid));
		const id = w.terrainPaint.addScatterSet(uuid, { source: { kind: 'primitive', type: 'Sphere' }, gen: { count: 60, scaleMin: 0.2, scaleMax: 0.2, rot: true, slope: [0, 10] } });
		return { uuid, id, host };
	});
	h.check(grp.host && !!grp.id, 'a group of meshes takes scatter (isMeshHost + a set added)');
	const gDrawn = await drawn(A.page, grp.uuid);
	// slope 0..10 = the two box TOPS (y = 1 in world); world x near 8 or 11
	h.check(
		gDrawn.length === 60 && gDrawn.every((p) => Math.abs(p.world[1] - 1) < 0.02 && (Math.abs(p.world[0] - 8) <= 0.51 || Math.abs(p.world[0] - 11) <= 0.51)),
		`the fill lies on both children's top faces (${gDrawn.length})`
	);
	await h.eventually(() => drawn(B.page, grp.uuid), (d) => samePlaces(d, gDrawn, 2e-3), 'B draws the group fill identically', 15000);
	{
		const bd = await drawn(B.page, grp.uuid);
		if (!samePlaces(bd, gDrawn, 2e-3))
			console.log('  group diag: A', gDrawn.length, JSON.stringify(gDrawn.slice(0, 3)), '\n  B', bd.length, JSON.stringify(bd.slice(0, 3)), '\n  blocks equal:', (await blockOf(A.page, grp.uuid)) === (await blockOf(B.page, grp.uuid)));
	}

	await h.finish(browser);
});
