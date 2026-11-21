// 102 — GAUSSIAN SPLATS: a captured scene (.ply / .spz / .splat) as an object in the shared scene.
//
// A splat object is a CARRIER mesh holding `userData.splat` (an invisible box over the scan: the hit
// proxy); Spark draws the splats at the scene root, glued to it every frame. The bytes are a Library
// file by content hash: the record replicates, the bytes ride the asset share. Fixtures are made
// HERE, procedurally (a coloured shell of splats) — no scan data in the repo.
//
//   §0 feature unused = zero change: a scene with no splat loads no Spark chunk and no runtime
//   §1 drop a .splat on A's viewport: one carrier, the record (count, bounds), the
//      runtime draws it (ready, visible, every splat); B receives the carrier AND pulls the bytes
//   §2 the frame shows it: opacity 0 vs 1 changes the pixels where the scan is
//   §3 opacity + crop box on A replicate to B; the proxy box follows the crop; undo reverts both peers
//   §4 the .ply gate: a mesh .ply is refused (no Library item); a small 3DGS .ply is stored as it is
//   §5 Photo parity + Cinematic: the carrier is left out of a Photo (counted), Spark meshes are
//      helpers; Cinematic mode hides the splat meshes and the chip names "Gaussian splats"
//   §6 save + reload: an autosave restores the carrier and the runtime draws it again from the Library;
//      a lane-saved .tpscene bundles the bytes (scene asset group "splats")
//   §7 mesh edit refuses a splat; the Inspector shows the Splat section, no Material / Physics
//   (reduce to fit, the 26 MB .ply, is its own suite: splats-reduce — one page, inside the runner's cap)
//
// Counterfactual: v1.70.0 has no splat kind — the import toasts "Unsupported", §1 onward is red.
// Run: e2e-slot --dev <lane> 7076 -- env APP_URL=https://theprototype.app:7076/ npm run e2e -- splats
const h = require('./helpers.cjs');

const OUT = process.env.E2E_OUT ?? 'test-results/102-splats';

const { splatFile, gaussianPly, MESH_PLY, dbg, carriers, items, toasts, pick, entry, near, until } = require('./splatFixtures.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	/** @type {string[]} */
	const sparkRequests = [];
	A.page.on('request', (/** @type {any} */ r) => {
		if (/spark/i.test(r.url())) sparkRequests.push(r.url());
	});
	A.page.on('console', (/** @type {any} */ m) => {
		if (m.type() === 'error' || m.type() === 'warning') console.log(`  [A ${m.type()}] ${m.text().slice(0, 300)}`);
	});
	A.page.on('pageerror', (/** @type {any} */ e) => console.log(`  [A pageerror] ${String(e?.message ?? e).slice(0, 300)}`));
	for (const P of [A, B]) P.page.on('crash', () => console.log(`  [${P === A ? 'A' : 'B'}] PAGE CRASHED`));
	for (const P of [A, B])
		P.page.on('console', (/** @type {any} */ m) => {
			const t = m.text();
			if (/splat|spark/i.test(t)) console.log(`  [${P === A ? 'A' : 'B'} console] ${t.slice(0, 300)}`);
		});
	await h.connect(B, A);

	// ---- §0 feature unused -------------------------------------------------------------------
	await A.page.waitForTimeout(1500);
	const d0 = await dbg(A.page);
	h.check(!d0.runtimeLoaded && !d0.sparkLoaded, '§0 no splat in the scene: the splat runtime and Spark are not loaded');
	h.check(sparkRequests.length === 0, `§0 ...and no Spark chunk was requested (${sparkRequests.length})`);
	h.check((await carriers(A.page)).length === 0, '§0 no carrier objects');

	// ---- §1 import a .splat ------------------------------------------------------------------
	const N = 2000;
	await pick(A.page, 'shell.splat', splatFile(N));
	// the first splat loads Spark (a cold dev server transforms it on demand): a generous wait
	await h.eventually(() => carriers(A.page), (c) => c.length === 1, '§1 premise: A has one splat carrier after the drop', 90000);
	const [cA] = await carriers(A.page);
	if (!cA) {
		console.log(`  toasts ${JSON.stringify(await toasts(A.page))}\n  items ${JSON.stringify(await items(A.page))}\n  debug ${JSON.stringify(await dbg(A.page))}`);
		throw new Error('no carrier after the drop');
	}
	console.log(`  record ${JSON.stringify({ ...cA.splat, bounds: cA.splat.bounds.map((v) => +v.toFixed(3)) })} pos ${cA.pos.map((v) => +v.toFixed(3))}`);
	h.check(cA.splat.count === N && cA.splat.file === 'shell.splat' && /^[0-9a-f]{64}$/.test(cA.splat.hash), `§1 the record: ${N} splats, the file, its content hash`);
	const b = cA.splat.bounds;
	h.check(near(b[0], -0.5) && near(b[3], 0.5) && near(b[1], 0) && near(b[4], 1) && near(b[2], -0.5) && near(b[5], 0.5), `§1 bounds hug the shell (${b.map((v) => v.toFixed(2)).join(' ')})`);
	h.check(near(cA.pos[1] + b[1], 0, 0.02), `§1 placed with its bottom on the ground (y ${(cA.pos[1] + b[1]).toFixed(3)})`);
	const eA = await until(() => entry(A.page, cA.uuid), (e) => !!e && e.state === 'ready' && e.visible, '§1 A draws it (runtime ready, visible)', 30000);
	h.check(!!eA && eA.numSplats === N, `§1 ...every splat (${eA?.numSplats})`);
	h.check((await items(A.page)).some((it) => it.kind === 'splat' && it.hash === cA.splat.hash), '§1 the file is in A\'s Library as a splat item');
	const eB = await until(() => entry(B.page, cA.uuid), (e) => !!e && e.state === 'ready' && e.visible, '§1 B received the carrier, pulled the bytes and draws it', 45000);
	h.check(!!eB && eB.numSplats === N, `§1 ...B draws every splat too (${eB?.numSplats})`);

	// ---- §2 the frame shows it ---------------------------------------------------------------
	// aim at the scan (it landed where the drop ray met the ground), through the orbit controls so they hold it
	await A.page.evaluate((p) => {
		const v1 = window.__tp.test.v1;
		let cam, oc;
		v1.globalCamera.subscribe((c) => (cam = c))();
		v1.orbitControls?.subscribe?.((c) => (oc = c))?.();
		v1.selectedObjects.set([]);
		v1.selectedObject.set(null);
		cam.position.set(p[0], p[1] + 0.6, p[2] + 2.2);
		if (oc?.target) {
			oc.target.set(p[0], p[1] + 0.5, p[2]);
			oc.update?.();
		} else cam.lookAt(p[0], p[1] + 0.5, p[2]);
	}, [cA.pos[0], cA.pos[1] + cA.splat.bounds[1], cA.pos[2]]);
	await A.page.waitForTimeout(600);
	const shotOn = await h.grabFrame(A);
	await A.page.evaluate((u) => window.__tp.test.v1.splatEdit.setSplatFor(u, { opacity: 0 }), cA.uuid);
	await h.eventually(() => entry(A.page, cA.uuid), (e) => !!e && !e.visible, '§2 premise: opacity 0 hides the splat mesh', 5000);
	await A.page.waitForTimeout(400);
	const shotOff = await h.grabFrame(A);
	const delta = await h.frameDelta(A.page, shotOn, shotOff);
	console.log(`  frame delta on vs off: ${JSON.stringify(delta)}`);
	h.check(delta.fraction > 0.02, `§2 the splats change the frame (${(delta.fraction * 100).toFixed(1)} % of pixels)`);
	await A.page.evaluate((u) => window.__tp.test.v1.splatEdit.setSplatFor(u, { opacity: 1 }), cA.uuid);

	// ---- §3 opacity + crop replicate, undo ---------------------------------------------------
	await A.page.evaluate((u) => window.__tp.test.v1.splatEdit.setSplatFor(u, { opacity: 0.5 }), cA.uuid);
	await A.page.evaluate((u) => window.__tp.test.v1.splatEdit.setSplatFor(u, { crop: [-0.5, 0, -0.5, 0.5, 0.5, 0.5] }), cA.uuid);
	const recB = await until(
		async () => (await carriers(B.page)).find((c) => c.uuid === cA.uuid),
		(c) => !!c && c.splat.opacity === 0.5 && Array.isArray(c.splat.crop) && Math.abs(c.box[4] - 0.5) < 1e-3,
		'§3 B has the opacity and the crop box (the runtime rebuilds the proxy box on its next frame)',
		10000
	);
	h.check(!!recB && near(recB.box[4], 0.5, 1e-3) && near(recB.box[1], 0, 1e-3), `§3 B's proxy box follows the crop (y ${recB?.box[1]}..${recB?.box[4]})`);
	const cropB = await until(() => entry(B.page, cA.uuid), (e) => !!e && e.crop !== '', '§3 B applied the crop edit to the splats', 5000);
	h.check(!!cropB, '§3 ...as a Spark edit');
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	const undone = await until(
		async () => (await carriers(B.page)).find((c) => c.uuid === cA.uuid),
		(c) => !!c && c.splat.crop === null,
		'§3 undo on A removes the crop on B',
		10000
	);
	h.check(!!undone && undone.splat.opacity === 0.5, '§3 ...one step: the opacity stays');

	// ---- §4 the .ply gate --------------------------------------------------------------------
	// look away from the scan: on a software-GL slot a screen full of splats makes every frame (and every
	// timer and import behind it) crawl — measured 2.2 s for the gate to read a 200-byte file
	await A.page.evaluate(() => {
		const v1 = window.__tp.test.v1;
		let cam, oc;
		v1.globalCamera.subscribe((c) => (cam = c))();
		v1.orbitControls?.subscribe?.((c) => (oc = c))?.();
		cam.position.set(0, 3, 0);
		if (oc?.target) {
			oc.target.set(0, 30, 0.01);
			oc.update?.();
		} else cam.lookAt(0, 30, 0.01);
	});
	await A.page.screenshot({ path: `${OUT}/splats-before-s4.png` }).catch(() => {});
	console.log(
		'  open dialogs: ' +
			JSON.stringify(
				await A.page.evaluate(() =>
					[...document.querySelectorAll('[role="dialog"],[role="alertdialog"],.modal,[aria-modal="true"]')]
						.filter((e) => e.getBoundingClientRect().width > 0)
						.map((e) => (e.id || e.className || e.tagName) + ': ' + (e.textContent ?? '').trim().slice(0, 160))
				)
			)
	);
	console.log(`  toasts now ${JSON.stringify(await toasts(A.page))}`);
	const before = (await items(A.page)).length;
	await pick(A.page, 'triangle.ply', MESH_PLY);
	await h.eventually(() => toasts(A.page), (t) => t.some((x) => /triangle\.ply is a mesh, not a Gaussian splat/.test(x)), '§4 a mesh .ply is refused with the way out', 30000);
	h.check((await items(A.page)).length === before, '§4 ...and nothing entered the Library');
	await pick(A.page, 'small.ply', gaussianPly(500, 1));
	await h.eventually(() => carriers(A.page), (c) => c.some((x) => x.splat.file === 'small.ply'), '§4 a small 3DGS .ply imports as it is', 60000);
	const small = (await carriers(A.page)).find((x) => x.splat.file === 'small.ply');
	h.check(small?.splat.count === 500 && small?.splat.sh === 1, `§4 ...500 splats, one colour band (${small?.splat.count}, sh ${small?.splat.sh})`);
	// ---- §5 Photo parity + Cinematic ---------------------------------------------------------
	const photo = await A.page.evaluate(async () => {
		const { meshKind, parityNotes } = await import('/src/lib/photo/photoCore.js');
		let g, scene;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		window.__tp.test.v1.globalScene.subscribe((v) => (scene = v))();
		const kinds = [];
		scene.traverse((o) => {
			if (o.userData?.splat || o.userData?.splatVisual) kinds.push(meshKind(o));
		});
		return { kinds, notes: parityNotes({ 'skip-splat': kinds.filter((k) => k === 'skip-splat').length }) };
	});
	h.check(photo.kinds.filter((k) => k === 'skip-splat').length === 2 && photo.kinds.every((k) => k === 'skip-splat' || k === 'skip-helper'), `§5 Photo: both carriers counted, Spark meshes are helpers (${photo.kinds.join(' ')})`);
	h.check(/Gaussian splats/.test(photo.notes[0]?.note ?? ''), '§5 ...and the parity note names them');
	await A.page.evaluate(() => window.__tp.test.v1.cinematicState.cinematicState.update((s) => ({ ...s, mode: 'on' })));
	await h.eventually(() => dbg(A.page), (d) => d.entries.every((e) => !e.visible), '§5 Cinematic on: every splat mesh stands down', 5000);
	await A.page.evaluate(() => window.__tp.test.v1.cinematicState.cinematicState.update((s) => ({ ...s, mode: 'off' })));
	await h.eventually(() => dbg(A.page), (d) => d.entries.filter((e) => e.state === 'ready').every((e) => e.visible), '§5 Cinematic off: they draw again', 5000);

	// ---- §6 save + reload --------------------------------------------------------------------
	const zipHasSplat = await A.page.evaluate(async (hash) => {
		const s = window.__tp.test.v1.sessions;
		const payload = s.buildSessionPayload('splat save');
		const assets = await import('/src/lib/sceneAssets.js');
		let list = [];
		assets.refreshSceneAssets();
		await new Promise((r) => setTimeout(r, 500));
		assets.sceneAssets.subscribe((v) => (list = v))();
		return { listed: list.some((e) => e.group === 'splats' && e.hash === hash), objects: JSON.stringify(payload.objects ?? '').includes(hash) };
	}, cA.splat.hash);
	h.check(zipHasSplat.listed, '§6 the scan is a scene asset (Scene ▸ splats), so a .tpscene bundles its bytes');
	h.check(zipHasSplat.objects, '§6 the saved objects carry the record');
	await A.page.evaluate(async () => {
		window.__tp.test.v1.autosave.autosaveEnabled.set(true);
		await window.__tp.test.v1.autosave.saveNow();
	});
	await h.freshReload(A);
	try {
		await h.answerRestore(A, 'restore', 30000);
	} catch (error) {
		// measured: the restore had already landed (the carrier back and selected, no modal left) when the
		// helper's click timed out — the checks below decide whether the scene came back
		await A.page.screenshot({ path: `${OUT}/splats-restore-fail.png` }).catch(() => {});
		console.log(`  answerRestore: ${String(/** @type {any} */ (error)?.message ?? error).split('\n')[0]}`);
	}
	const back = await until(() => carriers(A.page), (c) => c.length === 2, '§6 the reload restores both splat objects', 30000);
	h.check(!!back && back.find((c) => c.uuid === cA.uuid)?.splat.opacity === 0.5, '§6 ...with their records');
	const eR = await until(() => entry(A.page, cA.uuid), (e) => !!e && e.state === 'ready' && e.visible, '§6 the runtime draws it again from the Library', 30000);
	h.check(eR?.numSplats === N, `§6 ...every splat (${eR?.numSplats})`);

	// ---- §7 edit guards + Inspector ----------------------------------------------------------
	await A.page.evaluate((u) => window.__tp.test.v1.meshEdit?.enterEditMode?.(u), cA.uuid);
	await h.eventually(() => toasts(A.page), (t) => t.some((x) => /Gaussian splat: its box is only a click target/.test(x)), '§7 mesh edit refuses a splat', 5000);
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u, true), cA.uuid);
	const insp = await until(
		() => A.page.evaluate(() => ({ facts: document.querySelector('#splat-facts')?.textContent ?? '', opacity: !!document.querySelector('#splat-opacity') })),
		(x) => /^2,000 splats · /.test(x.facts.trim()) && x.opacity,
		'§7 the Inspector shows the Splat section',
		15000
	);
	h.check(!!insp, `§7 ...facts "${insp?.facts.trim()}"`);
	await A.page.screenshot({ path: `${OUT}/splats-inspector.png` }).catch(() => {});

	await h.finish(browser);
});
