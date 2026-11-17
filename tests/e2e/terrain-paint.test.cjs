// 47 T1 + T2 — terrain PAINT (4-layer splat) and SCATTER (instances), two peers.
// Paint: layer 3 (index 2) laid down in ONE stroke shows on the canvas (pixel check on BOTH
// peers), the splat BYTES are equal on the second peer, one undo removes it everywhere, a
// save/load round-trip keeps it, and an old scene (a terrain with no splat) loads unchanged.
// Scatter: a stroke fills the brush up to density × area (never past it), replicates and
// saves; erase removes; one undo per stroke.
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOTS_DIR || '';

/** @param {any} page @param {string} uuid */
const digest = (page, uuid) => page.evaluate((u) => window.__tp.test.v1.terrainPaint.splatDigest(u), uuid);
/** @param {any} page @param {string} uuid */
const scatterOf = (page, uuid) =>
	page.evaluate(
		(u) =>
			new Promise((resolve) => {
				window.__tp.test.v1.objectsGroup.subscribe((g) => {
					const o = g?.getObjectByProperty('uuid', u);
					resolve(o ? JSON.stringify(o.userData.terrainScatter ?? null) : 'missing');
				})();
			}),
		uuid
	);
/** @param {any} page */
const stats = (page) => page.evaluate(() => window.__tp.test.v1.terrainSurface.terrainSurfaceStats());

/** @param {any} page @param {number[]} pos @param {number[]} target */
async function look(page, pos, target) {
	await page.evaluate(
		([p, t]) => {
			let cam, orbit;
			window.__tp.test.v1.editorCam.subscribe((v) => (cam = v))();
			window.__tp.test.v1.orbitControls.subscribe((v) => (orbit = v))();
			cam.position.set(p[0], p[1], p[2]);
			orbit?.target?.set(t[0], t[1], t[2]);
			orbit?.update?.();
			cam.lookAt(t[0], t[1], t[2]);
		},
		[pos, target]
	);
}

/** Share of MAGENTA pixels (r and b well above g) in a small square around the terrain centre.
 * @param {any} peer */
let shotN = 0;
async function magentaShare(peer) {
	await peer.page.waitForTimeout(400); // a couple of frames: the upload + recompile land
	const clip = await h.centeredClip(peer, [0, 0, 0], 60);
	const png = await h.grabFrame(peer, clip);
	if (SHOTS) await peer.page.screenshot({ path: `${SHOTS}/dbg-${++shotN}-${peer.name ?? ''}.png` });
	return peer.page.evaluate(async (b64) => {
		const img = new Image();
		await new Promise((res, rej) => {
			img.onload = res;
			img.onerror = rej;
			img.src = 'data:image/png;base64,' + b64;
		});
		const c = document.createElement('canvas');
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
		ctx.drawImage(img, 0, 0);
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		let hit = 0;
		for (let i = 0; i < d.length; i += 4) if (d[i] - d[i + 1] > 50 && d[i + 2] - d[i + 1] > 50) hit++;
		return hit / (d.length / 4);
	}, png.toString('base64'));
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const uuid = await A.page.evaluate(async () => {
		window.__tp.test.v1.commandsHandler.sceneCommand('/create Terrain 24 48');
		const group = await new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe(r)());
		return group.children[group.children.length - 1].uuid;
	});
	await h.eventually(() => scatterOf(B.page, uuid), (v) => v !== 'missing', 'B has the terrain', 20000);
	if ((await scatterOf(B.page, uuid)) === 'missing')
		console.log(
			'  B scene:',
			await B.page.evaluate(() => new Promise((r) => window.__tp.test.v1.objectsGroup.subscribe((g) => r(g?.children.map((c) => c.name + ':' + c.uuid.slice(0, 6))))()))
		);
	// opposite sides: each peer's AVATAR stands at its camera, so two cameras on one spot put
	// A's view inside B's avatar
	await look(A.page, [6, 16, 8], [0, 0, 0]);
	await look(B.page, [-6, 16, -8], [0, 0, 0]);

	// ---- T1 PAINT -------------------------------------------------------------------------
	h.check((await digest(A.page, uuid)) === null, 'a fresh terrain carries no splat');
	const before = await magentaShare(A);
	h.check(before < 0.05, `no magenta before painting (${before.toFixed(3)})`);

	const entered = await A.page.evaluate((u) => {
		const s = window.__tp?.test.v1;
		const ok = s.terrainSculpt.enterSculpt(u);
		s.terrainSculpt.sculptOp.set('paint');
		s.terrainSculpt.sculptRadius.set(4);
		s.terrainSculpt.sculptStrength.set(1);
		s.terrainPaint.paintLayer.set(2);
		// layer 3 = magenta, so the pixel check cannot mistake it for anything else in the scene
		const layers = s.terrainPaint.layersOf(u);
		layers[2] = { ...layers[2], color: '#ff00ff' };
		s.terrainPaint.setTerrainLayers(u, layers);
		return ok;
	}, uuid);
	h.check(entered === true, 'A enters the sculpt session (paint brush armed)');
	const bRefused = await B.page.evaluate((u) => window.__tp.test.v1.terrainSculpt.enterSculpt(u), uuid);
	h.check(bRefused === false, 'B cannot paint the terrain A holds (selection = lock)');

	const undoBefore = await A.page.evaluate(() => new Promise((r) => window.__tp.test.v1.history.undoStack.subscribe((s) => r(s.length))()));
	// ONE stroke: begin, many moves (throttled previews stream), end
	await A.page.evaluate(async (u) => {
		const ts = window.__tp.test.v1.terrainSculpt;
		ts.beginStroke(u);
		for (let i = 0; i < 25; i++) {
			ts.strokeMove(u, 0, 0, 0.05);
			await new Promise((r) => setTimeout(r, 20));
		}
		ts.endStroke();
	}, uuid);
	const undoAfter = await A.page.evaluate(() => new Promise((r) => window.__tp.test.v1.history.undoStack.subscribe((s) => r(s.length))()));
	h.check(undoAfter === undoBefore + 1, `one stroke = ONE undo entry (${undoBefore} -> ${undoAfter})`);

	const cover = await A.page.evaluate((u) => {
		const s = window.__tp?.test.v1;
		const b64 = s.terrainPaint.splatDigest(u);
		const bytes = s.terrainPaintCore.base64ToBytes(b64);
		return s.terrainPaintCore.layerCoverage(bytes, 2);
	}, uuid);
	h.check(cover > 0.03 && cover < 0.3, `layer 3 covers the brush, not the tile (${(cover * 100).toFixed(1)} %)`);

	const aDigest = await digest(A.page, uuid);
	await h.eventually(() => digest(B.page, uuid), (d) => d === aDigest, 'the splat bytes are EQUAL on B', 15000);
	const layersB = await B.page.evaluate((u) => window.__tp.test.v1.terrainPaint.layersOf(u)[2].color, uuid);
	h.check(layersB === '#ff00ff', 'the layer colour replicated to B');

	const aMag = await magentaShare(A);
	h.check(aMag > 0.5, `A's canvas shows layer 3 at the brush (${aMag.toFixed(2)} magenta)`);
	const bMag = await magentaShare(B);
	h.check(bMag > 0.5, `B's canvas shows it too (${bMag.toFixed(2)} magenta)`);
	if (SHOTS) await A.page.screenshot({ path: SHOTS + '/01-paint-layer3.png' });

	// ---- undo / redo --------------------------------------------------------------------------
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(() => digest(A.page, uuid), (d) => d === null, 'one undo removes the stroke on A (back to unpainted)');
	await h.eventually(() => digest(B.page, uuid), (d) => d === null, '...and on B', 10000);
	const undoneMag = await magentaShare(B);
	h.check(undoneMag < 0.05, `B's canvas is back to the material (${undoneMag.toFixed(3)})`);
	await A.page.evaluate(() => window.__tp.test.v1.history.redo());
	await h.eventually(() => digest(B.page, uuid), (d) => d === aDigest, 'redo brings the same bytes back on B', 10000);

	// ---- T2 SCATTER ----------------------------------------------------------------------------
	const sc = await A.page.evaluate(async (u) => {
		const s = window.__tp?.test.v1;
		s.terrainSculpt.sculptOp.set('scatter');
		s.terrainSculpt.sculptRadius.set(3);
		s.terrainPaint.scatterSource.set({ kind: 'primitive', type: 'Cone' });
		s.terrainPaint.scatterDensity.set(0.5);
		s.terrainPaint.scatterScaleMin.set(0.8);
		s.terrainPaint.scatterScaleMax.set(1.2);
		s.terrainPaint.scatterErase.set(false);
		const ts = s.terrainSculpt;
		ts.beginStroke(u);
		for (let i = 0; i < 10; i++) ts.strokeMove(u, 4, 4, 0.05);
		ts.endStroke();
		await new Promise((r) => setTimeout(r, 100));
		return s.terrainSurface.terrainSurfaceStats();
	}, uuid);
	const target = Math.floor(0.5 * Math.PI * 9);
	h.check(sc.instances > target * 0.5 && sc.instances <= target, `a stroke scatters up to density × area (${sc.instances} of ≤ ${target})`);
	h.check(sc.instancedMeshes === 1, `drawn as ONE InstancedMesh (${sc.instancedMeshes})`);
	const aScatter = await scatterOf(A.page, uuid);
	await h.eventually(() => scatterOf(B.page, uuid), (v) => v === aScatter, 'the scatter block is equal on B', 15000);
	await h.eventually(() => stats(B.page), (s) => s.instances === sc.instances, `B draws the same ${sc.instances} instances`, 10000);
	// the instances sit ON the terrain (scene root, not children of the document)
	const placed = await A.page.evaluate((u) => {
		let scene, group;
		window.__tp.test.v1.globalScene.subscribe((v) => (scene = v))();
		window.__tp.test.v1.objectsGroup.subscribe((v) => (group = v))();
		const terrain = group.getObjectByProperty('uuid', u);
		const inTree = terrain.children.some((c) => c.isInstancedMesh);
		const holder = scene.children.find((c) => c.name === 'terrain-scatter');
		return { inTree, holder: !!holder, inDoc: !!group.getObjectByName('terrain-scatter') };
	}, uuid);
	h.check(!placed.inTree && !placed.inDoc && placed.holder, 'scatter lives at the scene root, never in the replicated document');

	if (SHOTS)
		for (const t of ['dark', 'light']) {
			await A.page.evaluate((th) => window.__tp.test.v1.themes.theme.set(th), t);
			await A.page.waitForTimeout(500);
			await A.page.screenshot({ path: `${SHOTS}/02-scatter-toolbox-${t}.png` });
		}
	await A.page.evaluate(() => window.__tp.test.v1.themes.theme.set('dark'));

	// painting the same patch again never exceeds the density
	const again = await A.page.evaluate(async (u) => {
		const ts = window.__tp.test.v1.terrainSculpt;
		ts.beginStroke(u);
		for (let i = 0; i < 10; i++) ts.strokeMove(u, 4, 4, 0.05);
		ts.endStroke();
		await new Promise((r) => setTimeout(r, 100));
		return window.__tp.test.v1.terrainSurface.terrainSurfaceStats().instances;
	}, uuid);
	h.check(again <= target, `a second pass over the same patch respects the density (${again} ≤ ${target})`);

	// erase: removes inside the brush only
	const erased = await A.page.evaluate(async (u) => {
		const s = window.__tp?.test.v1;
		s.terrainPaint.scatterErase.set(true);
		s.terrainSculpt.sculptRadius.set(1.5);
		const ts = s.terrainSculpt;
		ts.beginStroke(u);
		ts.strokeMove(u, 4, 4, 0.05);
		ts.endStroke();
		await new Promise((r) => setTimeout(r, 100));
		return s.terrainSurface.terrainSurfaceStats().instances;
	}, uuid);
	h.check(erased < again && erased > 0, `erase removes the instances under the brush only (${again} -> ${erased})`);
	await h.eventually(() => stats(B.page), (s) => s.instances === erased, 'the erase replicated to B', 10000);
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(() => stats(B.page), (s) => s.instances === again, 'one undo restores the erased instances on B', 10000);

	// ---- save / load round-trip ----------------------------------------------------------------
	await A.page.evaluate(() => window.__tp.test.v1.terrainSculpt.exitSculpt());
	const savedDigest = await digest(A.page, uuid);
	const savedScatter = await scatterOf(A.page, uuid);
	const zip = await A.page.evaluate(async () => {
		const s = window.__tp.test.v1.sessions;
		const payload = s.buildSessionPayload('Painted terrain');
		window.__savedMinor = payload.formatMinor;
		const out = await s.exportSessionZip(payload);
		return Array.from(new Uint8Array(out instanceof Blob ? await out.arrayBuffer() : out));
	});
	// (48 S2 bumped the minor to 2 for sequences: a terrain save says AT LEAST 1, the revision that carries splats)
	h.check((await A.page.evaluate(() => window.__savedMinor)) >= 1, 'the saved scene says formatMinor >= 1');
	await A.page.evaluate(() => window.__tp.test.v1.commandsHandler.sceneCommand('/clear all'));
	await A.page.waitForTimeout(800);
	await A.page.evaluate(async (arr) => {
		const s = window.__tp.test.v1.sessions;
		const payload = await s.readSessionZip(new Uint8Array(arr).buffer);
		await s.applySession(payload, { backup: false });
	}, zip);
	await h.eventually(() => digest(A.page, uuid), (d) => d === savedDigest, 'the splat survives a save/load round-trip', 15000);
	h.check((await scatterOf(A.page, uuid)) === savedScatter, 'the scatter survives it too');
	await h.eventually(() => stats(A.page), (s) => s.instances === again && s.painted === 1, 'after the load the terrain is painted and its instances drawn', 10000);
	await look(A.page, [6, 16, 8], [0, 0, 0]);
	const loadedMag = await magentaShare(A);
	h.check(loadedMag > 0.5, `the loaded terrain shows its paint (${loadedMag.toFixed(2)} magenta)`);

	// ---- an OLD scene (a terrain with no splat / scatter, no formatMinor) loads unchanged -----
	const old = await A.page.evaluate(async () => {
		const s = window.__tp?.test.v1;
		s.commandsHandler.sceneCommand('/clear all');
		await new Promise((r) => setTimeout(r, 500));
		s.commandsHandler.sceneCommand('/create Terrain 24 48');
		await new Promise((r) => setTimeout(r, 500));
		const payload = s.sessions.buildSessionPayload('Old terrain');
		delete payload.formatMinor; // as a 1.36 build wrote it
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const t = group.children[group.children.length - 1];
		const sum = Array.from(t.geometry.attributes.position.array).reduce((a, b) => a + b, 0);
		const zip = await s.sessions.exportSessionZip(payload);
		const arr = new Uint8Array(zip instanceof Blob ? await zip.arrayBuffer() : zip);
		s.commandsHandler.sceneCommand('/clear all');
		await new Promise((r) => setTimeout(r, 500));
		const back = await s.sessions.readSessionZip(arr.buffer);
		await s.sessions.applySession(back, { backup: false });
		await new Promise((r) => setTimeout(r, 1500));
		const g2 = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const t2 = g2.getObjectByProperty('uuid', t.uuid);
		const m = t2?.material;
		return {
			found: !!t2,
			sum2: t2 ? Array.from(t2.geometry.attributes.position.array).reduce((a, b) => a + b, 0) : null,
			sum,
			splat: t2?.userData?.terrainSplat ?? null,
			scatter: t2?.userData?.terrainScatter ?? null,
			patched: !!m && Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile'),
			stats: s.terrainSurface.terrainSurfaceStats()
		};
	});
	h.check(old.found && old.sum2 === old.sum, 'an old terrain loads with the same geometry');
	h.check(old.splat === null && old.scatter === null && !old.patched, 'an old terrain loads unpainted: no splat, no scatter, its material untouched');
	h.check(old.stats.painted === 0 && old.stats.instances === 0, 'nothing painted or scattered is drawn for it');

	await h.finish(browser);
});
