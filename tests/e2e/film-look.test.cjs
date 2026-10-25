// 77 L1 — FILM-LOOK EXTRAS: depth of field with a focus target / distance / aperture + focus
// pulls, a letterbox matte rendered into the frame, a look per camera that follows the active
// sequencer shot, and the look properties a property track drives (lookProps, 68's registry shape).
//
// Counterfactuals (red on v1.43.2): 1.1-1.3 (no dof / letterbox kinds, no lookProps), 2.x (no Film
// look section), 3.x (no tap-to-focus), 4.x (no focus target / pull), 5.x (no matte), 7.x (no live
// look params), 9.x (the lens fields + matte replicate), 10.x (no phone section).
// 6.x (shots switch the look) is GREEN on the base too — it pins the L-C behaviour L1 builds on.

const h = require('./helpers.cjs');

const read = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		let map = null;
		s.scenePost.postStacks.subscribe((m) => (map = m))();
		const prev = (() => {
			let v = null;
			s.cameraPreview.cameraPreview.subscribe((x) => (v = x))();
			return v;
		})();
		const dbg = window.__postDebug?.() ?? {};
		return { kinds: dbg.kinds ?? [], film: dbg.film ?? null, stacks: map, preview: prev?.uuid ?? null };
	});

/** the camera's spec (userData.camera) @param {any} page @param {string} uuid */
const specOf = (page, uuid) => page.evaluate((u) => ({ ...(window.__stores.cameraObjects.findCameraObject(u)?.userData?.camera ?? {}) }), uuid);

/** a world point projected through the camera ON SCREEN (the preview camera while previewing) */
const screenOf = (page, world) =>
	page.evaluate((w) => {
		const s = window.__stores;
		const cam = s.filmLook.currentRenderCamera();
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		const rect = r.domElement.getBoundingClientRect();
		cam.updateMatrixWorld();
		const v = cam.position.clone().set(w[0], w[1], w[2]).project(cam);
		return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height };
	}, world);

/** mean luminance of a canvas strip (fractions of the canvas rect) */
async function stripLuma(peer, fx, fy, fw, fh) {
	const rect = await peer.page.evaluate(() => {
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const b = r.domElement.getBoundingClientRect();
		return { x: b.x, y: b.y, w: b.width, h: b.height };
	});
	const clip = { x: Math.round(rect.x + rect.w * fx), y: Math.round(rect.y + rect.h * fy), width: Math.max(4, Math.round(rect.w * fw)), height: Math.max(4, Math.round(rect.h * fh)) };
	const png = await peer.page.screenshot({ clip });
	return peer.page.evaluate(async (b64) => {
		const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
		const c = new OffscreenCanvas(img.width, img.height);
		const g = c.getContext('2d');
		g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, img.width, img.height).data;
		let sum = 0;
		for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
		return sum / (d.length / 4);
	}, png.toString('base64'));
}

const wait = (page, ms) => page.waitForTimeout(ms);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;
	await h.answerRestore(A).catch(() => {});

	// ---------------------------------------------------------------- 1. registry
	console.log('\n=== 1. the kinds and the look properties ===');
	const reg = await page.evaluate(() => {
		const s = window.__stores;
		const kinds = s.scenePost.postEffectKinds().map((d) => d.kind);
		const live = s.postEffects.liveLookKinds();
		const table = Object.fromEntries(Object.entries(s.lookProps.LIVE_LOOK).map(([k, v]) => [k, Object.keys(v).sort()]));
		return { kinds, live, table, paths: Object.keys(s.lookProps.LOOK_PROPS) };
	});
	h.check(reg.kinds.includes('dof') && reg.kinds.includes('letterbox'), '1.1 the Depth of field and Letterbox kinds are registered (' + reg.kinds.filter((k) => /dof|letter/.test(k)) + ')');
	h.check(JSON.stringify(reg.live) === JSON.stringify(reg.table), '1.2 every live look param in lookProps has a uniform setter in postEffects (and no extra): ' + JSON.stringify(reg.live));
	h.check(['camera.focus', 'camera.aperture', 'camera.focusPull', 'look.letterbox.aspect', 'look.vignette.darkness'].every((p) => reg.paths.includes(p)), '1.3 the property paths a track can drive: ' + reg.paths.length);

	// ---------------------------------------------------------------- scene
	const ids = await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 900));
		const g = (() => {
			let v;
			s.objectsGroup.subscribe((x) => (v = x))();
			return v;
		})();
		const sphere = g.children.at(-1);
		sphere.position.set(0, 0, 0);
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 900));
		const box = g.children.at(-1);
		box.position.set(1.5, 0, -6);
		s.sceneStore?.pokeScene?.();
		// the camera where the editor looks from, aimed at the origin
		s.commandsHandler.sceneCommand('/create camera');
		await new Promise((r) => setTimeout(r, 1200));
		const cam = s.cameraObjects.listCameraObjects().at(-1);
		let ec;
		s.globalCamera.subscribe((v) => (ec = v))();
		ec.position.set(0, 1, 8);
		ec.lookAt(0, 0, 0);
		ec.updateMatrixWorld();
		s.cameraObjects.setCameraFromView(cam.uuid);
		s.commandsHandler.sceneCommand('/create camera');
		await new Promise((r) => setTimeout(r, 1200));
		const camB = s.cameraObjects.listCameraObjects().find((c) => c.uuid !== cam.uuid);
		ec.position.set(6, 2, 6);
		ec.lookAt(0, 0, 0);
		ec.updateMatrixWorld();
		s.cameraObjects.setCameraFromView(camB.uuid);
		s.viewMode.set('shaded');
		return { sphere: sphere.uuid, box: box.uuid, cam: cam.uuid, camB: camB.uuid };
	});
	h.check(!!ids.sphere && !!ids.box && !!ids.cam && !!ids.camB && ids.cam !== ids.camB, '0.1 premise: a sphere, a box and two cameras');

	// ---------------------------------------------------------------- 2. Inspector
	console.log('\n=== 2. the Camera Inspector Film look ===');
	await page.evaluate((u) => {
		window.__stores.objectActions.selectObject(u, true);
		window.__stores.inspectorClose?.set?.(false);
	}, ids.cam);
	const dofToggle = page.locator('#film-dof');
	await dofToggle.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
	h.check(await dofToggle.isVisible().catch(() => false), '2.1 the camera Inspector shows a Film look section with Depth of field');
	await dofToggle.scrollIntoViewIfNeeded().catch(() => {});
	await dofToggle.click();
	await wait(page, 500);
	let st = await read(page);
	h.check((st.stacks[ids.cam]?.effects ?? []).some((e) => e.kind === 'dof' && e.params.source === 'camera'), '2.2 the toggle adds a Depth of field (focus from the camera) to THIS camera\'s look');
	h.check(!(st.stacks.scene?.effects ?? []).some((e) => e.kind === 'dof'), '2.3 ...not to the scene look');
	h.check(await page.locator('#film-aperture').isVisible(), '2.4 the lens rows appear (aperture, pull time, distance)');
	await page.evaluate((u) => window.__stores.cameraPreview.startCameraPreview(u), ids.cam);
	st = await h.eventually(() => read(page), (v) => v.kinds.includes('dof') && !!v.film?.dof, 'the chain builds the DOF while looking through the camera', 15000).then(() => read(page));
	h.check(st.film.camera === ids.cam && st.kinds.includes('dof'), '2.5 looking through the camera builds the DOF pass (' + st.kinds.join(',') + ')');
	h.check(Math.abs(st.film.dof.focusDistance - 10) < 1e-6, '2.6 a lens with no focus of its own falls back to the effect values (10 m): ' + st.film.dof.focusDistance);

	// ---------------------------------------------------------------- 3. tap to focus
	console.log('\n=== 3. tap to focus ===');
	await page.locator('#film-focus-pick').click();
	h.check(await page.locator('#focus-pick-overlay').isVisible(), '3.1 Tap to focus arms the pick layer over the picture');
	await page.keyboard.press('Escape');
	await wait(page, 200);
	h.check(!(await page.locator('#focus-pick-overlay').isVisible().catch(() => false)), '3.2 Esc cancels it');
	await page.locator('#film-focus-pick').click();
	const at = await screenOf(page, [0, 0, 0]);
	await page.mouse.click(at.x, at.y);
	await wait(page, 600);
	let spec = await specOf(page, ids.cam);
	const depth = Math.hypot(0, 1, 8) * (8 / Math.hypot(1, 8)); // the origin along the camera's view axis
	h.check(spec.focusTarget === ids.sphere && Array.isArray(spec.focusPoint), '3.3 a click on the sphere makes it the focus target, with the tapped point (' + spec.focusTarget?.slice(0, 8) + ')');
	h.check(!(await page.locator('#focus-pick-overlay').isVisible().catch(() => false)), '3.4 one pick, then the layer goes');
	st = await h.eventually(() => read(page), (v) => Math.abs((v.film?.dof?.focusDistance ?? 0) - depth) < 1.2, 'the DOF focuses on the sphere', 6000).then(() => read(page));
	h.check(Math.abs(st.film.dof.focusDistance - depth) < 1.2, '3.5 the DOF focus distance is the sphere\'s depth (' + st.film.dof.focusDistance.toFixed(2) + ' m, sphere centre ' + depth.toFixed(2) + ' m, minus its radius at the hit)');
	h.check(await page.locator('#film-focus-following').isVisible(), '3.6 the Inspector says it is following a target');
	// undo puts the previous lens back
	await page.evaluate(() => window.__stores.history.undo());
	await wait(page, 400);
	spec = await specOf(page, ids.cam);
	h.check(!spec.focusTarget, '3.7 undo takes the focus target back off (one props step)');
	await page.evaluate(() => window.__stores.history.redo());
	await wait(page, 400);
	spec = await specOf(page, ids.cam);
	h.check(spec.focusTarget === ids.sphere, '3.8 redo puts it back');

	// ---------------------------------------------------------------- 4. follow + pull
	console.log('\n=== 4. focus follows the target, and a pull eases ===');
	const before = (await read(page)).film.dof.focusDistance;
	await page.evaluate((u) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		g.getObjectByProperty('uuid', u).position.z = -4; // 4 m further away
	}, ids.sphere);
	st = await h.eventually(() => read(page), (v) => v.film.dof.focusDistance > before + 3, 'the focus follows the moving target', 6000).then(() => read(page));
	h.check(st.film.dof.focusDistance > before + 3, '4.1 moving the target moves the focus with it (' + before.toFixed(2) + ' -> ' + st.film.dof.focusDistance.toFixed(2) + ' m)');
	// a 1.5 s pull to the box
	await page.evaluate(({ cam, box }) => window.__stores.cameraObjects.setCameraFor(cam, { focusPull: 1.5, focusTarget: box, focusPoint: null }), { cam: ids.cam, box: ids.box });
	const from = st.film.dof.focusDistance;
	const samples = [];
	const t0 = Date.now();
	while (Date.now() - t0 < 2600) {
		samples.push({ t: Date.now() - t0, d: (await read(page)).film.dof.focusDistance });
		await wait(page, 150);
	}
	const target = await page.evaluate(({ cam, box }) => {
		const s = window.__stores;
		const marker = s.cameraObjects.findCameraObject(cam);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const p = g.getObjectByProperty('uuid', box).getWorldPosition(marker.position.clone());
		return -marker.worldToLocal(p).z;
	}, { cam: ids.cam, box: ids.box });
	const mid = samples.filter((x) => x.t > 150 && x.t < 1100).map((x) => x.d);
	const last = samples.at(-1).d;
	h.check(mid.some((d) => Math.abs(d - from) > 0.05 && Math.abs(d - target) > 0.05), '4.2 mid-pull the focus is BETWEEN the two subjects (' + mid.map((d) => d.toFixed(2)).join(' ') + ')');
	h.check(Math.abs(last - target) < 0.15, '4.3 after the pull time it lands on the box (' + last.toFixed(2) + ' vs ' + target.toFixed(2) + ' m)');
	const mono = samples.every((x, i) => i === 0 || Math.sign(target - from) * (x.d - samples[i - 1].d) >= -1e-6);
	h.check(mono, '4.4 the pull never overshoots or turns back');
	await page.evaluate((cam) => window.__stores.cameraObjects.setCameraFor(cam, { focusPull: 0, focusTarget: '', focusPoint: null, focus: 3 }), ids.cam);
	st = await h.eventually(() => read(page), (v) => Math.abs(v.film.dof.focusDistance - 3) < 1e-6, 'a cut', 3000).then(() => read(page));
	h.check(Math.abs(st.film.dof.focusDistance - 3) < 1e-6, '4.5 pull 0 = a cut to the typed distance (3 m)');

	// ---------------------------------------------------------------- 5. letterbox
	console.log('\n=== 5. the letterbox matte ===');
	// the 16-P5 framing guide is a DOM mask over the canvas: off here, so the pixels are the frame's
	await page.evaluate((cam) => window.__stores.cameraObjects.setCameraFor(cam, { guide: false }), ids.cam);
	await wait(page, 300);
	// where the 2.39 bar falls on THIS canvas (its shape depends on the window chrome): the middle of the bar
	const barOf = (matte) =>
		page.evaluate((m) => {
			let r;
			window.__stores.globalRenderer.subscribe((v) => (r = v))();
			const b = r.domElement.getBoundingClientRect();
			return window.__stores.filmLookCore.matteBars(b.width / b.height, 16 / 9, m);
		}, matte);
	const bar239 = (await barOf(2.39)).y;
	// left of the centred chrome (the Connect pill and the "Previewing" banner sit over the top bar)
	const topStrip = [0.08, bar239 * 0.45, 0.18, bar239 * 0.35];
	const lumaOpen = await stripLuma(A, ...topStrip);
	await page.locator('[data-matte="2.39"]').first().click();
	await wait(page, 600);
	st = await read(page);
	const matteEntry = (st.stacks[ids.cam]?.effects ?? []).find((e) => e.kind === 'letterbox');
	h.check(!!matteEntry && Math.abs(matteEntry.params.aspect - 2.39) < 1e-6, '5.1 the 2.39:1 chip puts a Letterbox (2.39) in this camera\'s look');
	h.check(await page.locator('[data-matte="2.39"][aria-pressed="true"]').count() === 1, '5.2 ...and shows it pressed');
	st = await h.eventually(() => read(page), (v) => v.kinds.includes('letterbox'), 'the matte builds', 8000).then(() => read(page));
	await wait(page, 600);
	h.check(Math.abs((st.film.matte?.framing ?? 0) - 16 / 9) < 1e-4, '5.2b the matte is cut from the camera framing (16:9): ' + st.film.matte?.framing);
	const lumaBar = await stripLuma(A, ...topStrip);
	const lumaMiddle = await stripLuma(A, 0.3, 0.45, 0.4, 0.1);
	h.check(lumaBar < 8 && lumaOpen > lumaBar + 20, '5.3 PIXELS: the top of the frame is a black bar now (bar ' + (bar239 * 100).toFixed(1) + '% of the canvas; luma ' + lumaOpen.toFixed(0) + ' -> ' + lumaBar.toFixed(0) + ')');
	h.check(lumaMiddle > 20, '5.4 ...and the picture inside it is not (' + lumaMiddle.toFixed(0) + ')');
	await page.locator('[data-matte="1.3333333333333333"]').first().click();
	await wait(page, 900);
	const bar43 = (await barOf(4 / 3)).x;
	const lumaPillar = await stripLuma(A, bar43 * 0.45, 0.4, bar43 * 0.35, 0.2);
	const lumaTop43 = await stripLuma(A, ...topStrip);
	h.check(lumaPillar < 8 && lumaTop43 > 20, '5.5 a 4:3 matte is PILLARS instead (left ' + lumaPillar.toFixed(0) + ', top ' + lumaTop43.toFixed(0) + ')');
	await page.locator('[data-matte="2.39"]').first().click();
	await wait(page, 400);

	// ---------------------------------------------------------------- 6. shots
	console.log('\n=== 6. switching shots switches the look ===');
	const seq = await page.evaluate(async ({ cam, camB }) => {
		const s = window.__stores;
		s.cameraPreview.stopCameraPreview();
		s.scenePost.addPostEffect('vignette', undefined, camB);
		const id = s.sequences.createSequence('film-look shots', { duration: 4 });
		const track = s.sequences.addTrack(id, 'camera', 'Shots');
		s.sequences.addItem(id, track, { t: 0, dur: 2, camera: cam });
		s.sequences.addItem(id, track, { t: 2, dur: 2, camera: camB });
		await new Promise((r) => setTimeout(r, 300));
		return id;
	}, ids);
	await page.evaluate((id) => window.__stores.sequencePlayer.scrubSequence(id, 1), seq);
	st = await h.eventually(() => read(page), (v) => v.preview === ids.cam && v.kinds.includes('letterbox'), 'shot 1 = camera A with its look', 8000).then(() => read(page));
	h.check(st.preview === ids.cam && st.kinds.includes('dof') && st.kinds.includes('letterbox') && !st.kinds.includes('vignette'), '6.1 shot 1: camera A, its DOF + matte (' + st.kinds.join(',') + ')');
	await page.evaluate((id) => window.__stores.sequencePlayer.scrubSequence(id, 3), seq);
	st = await h.eventually(() => read(page), (v) => v.preview === ids.camB && v.kinds.includes('vignette'), 'shot 2 = camera B with its look', 8000).then(() => read(page));
	h.check(st.preview === ids.camB && st.kinds.includes('vignette') && !st.kinds.includes('letterbox') && !st.kinds.includes('dof'), '6.2 shot 2: camera B, its vignette and NOT A\'s matte (' + st.kinds.join(',') + ')');
	h.check(st.film.camera === ids.camB, '6.3 the film look follows the shot (lookCamera = B)');

	// ---------------------------------------------------------------- 7. look properties
	console.log('\n=== 7. look properties a track drives (68 registry shape) ===');
	const authoredDark = await page.evaluate((camB) => {
		let m;
		window.__stores.scenePost.postStacks.subscribe((x) => (m = x))();
		return m[camB].effects.find((e) => e.kind === 'vignette').params.darkness;
	}, ids.camB);
	const posed = await page.evaluate(async (camB) => {
		const s = window.__stores;
		const def = s.lookProps.LOOK_PROPS['look.vignette.darkness'];
		const marker = s.cameraObjects.findCameraObject(camB);
		const applies = def.applies(marker);
		const base = def.get(marker);
		def.set(marker, 0.95);
		await new Promise((r) => setTimeout(r, 700));
		const during = window.__postDebug().film;
		let m;
		s.scenePost.postStacks.subscribe((x) => (m = x))();
		const doc = m[camB].effects.find((e) => e.kind === 'vignette').params.darkness;
		def.set(marker, base); // the release: propPlayback writes the base back
		await new Promise((r) => setTimeout(r, 700));
		const after = window.__postDebug().film;
		return { applies, base, during, doc, after, live: s.lookProps.liveLookDebug() };
	}, ids.camB);
	h.check(posed.applies && posed.base === authoredDark, '7.1 look.vignette.darkness applies to camera B and reads the AUTHORED value as its base (' + posed.base + ')');
	h.check(Math.abs(posed.during.vignette.darkness - 0.95) < 1e-6 && posed.during.applied.some((a) => a.kind === 'vignette'), '7.2 posing it reaches the built effect live, no rebuild (' + posed.during.vignette.darkness + ')');
	h.check(posed.doc === authoredDark, '7.3 ...and never touches the replicated look document (' + posed.doc + ')');
	h.check(Math.abs(posed.after.vignette.darkness - authoredDark) < 1e-6 && !posed.after.applied.length && !Object.keys(posed.live).length, '7.4 the release puts the authored value back and leaves no override');
	const lens = await page.evaluate(async ({ id, cam }) => {
		const s = window.__stores;
		s.sequencePlayer.scrubSequence(id, 1);
		await new Promise((r) => setTimeout(r, 900));
		const marker = s.cameraObjects.findCameraObject(cam);
		s.lookProps.LOOK_PROPS['camera.focus'].set(marker, 6.5);
		s.lookProps.LOOK_PROPS['look.letterbox.aspect'].set(marker, 1.85);
		await new Promise((r) => setTimeout(r, 700));
		const film = window.__postDebug().film;
		s.lookProps.LOOK_PROPS['look.letterbox.aspect'].set(marker, 2.39);
		const registry = { position: {} };
		const added = s.lookProps.registerLookProps(registry);
		return { film, added: added.length, total: Object.keys(registry).length };
	}, { id: seq, cam: ids.cam });
	h.check(Math.abs(lens.film.dof.focusDistance - 6.5) < 1e-6, '7.5 camera.focus (the path 68 Film records) drives the DOF focus (' + lens.film.dof.focusDistance + ')');
	h.check(Math.abs(lens.film.matte.aspect - 1.85) < 1e-6, '7.6 look.letterbox.aspect opens the matte live (' + lens.film.matte.aspect + ')');
	h.check(lens.added === lens.total - 1, '7.7 registerLookProps merges every path into a registry (' + lens.added + ' added)');
	await page.evaluate(() => {
		window.__stores.sequencePlayer.releaseScrub();
		window.__stores.cameraPreview.stopCameraPreview();
	});
	await wait(page, 600);
	st = await read(page);
	h.check(!st.kinds.includes('dof') && !st.kinds.includes('letterbox'), '7.8 back in the editor view the camera look is gone (' + st.kinds.join(',') + ')');

	// ---------------------------------------------------------------- 8. persistence
	console.log('\n=== 8. the lens and the matte save with the scene ===');
	const saved = await page.evaluate((cam) => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('film look');
		const post = payload.post?.stacks?.[cam]?.effects?.map((e) => e.kind) ?? [];
		return { post, objects: typeof payload.objects === 'string' ? payload.objects.includes('focusPull') || payload.objects.includes('"focus"') : JSON.stringify(payload.objects ?? '').includes('focus') };
	}, ids.cam);
	h.check(saved.post.includes('dof') && saved.post.includes('letterbox'), '8.1 the camera look (DOF + matte) is in the save (' + saved.post + ')');
	h.check(saved.objects, '8.2 the lens fields ride the camera marker in the save');

	// ---------------------------------------------------------------- 9. two peers
	console.log('\n=== 9. a second peer sees the same film look ===');
	const B = await h.setupPageQuiet(browser, 'B', [A]);
	await h.answerRestore(B).catch(() => {});
	await h.connect(B, A);
	await page.evaluate(({ cam, sphere }) => window.__stores.cameraObjects.setCameraFor(cam, { focusTarget: sphere, focusPoint: null, aperture: 1.8 }), ids);
	const readB = () =>
		B.page.evaluate((cam) => {
			const s = window.__stores;
			const marker = s.cameraObjects.findCameraObject(cam);
			let m;
			s.scenePost.postStacks.subscribe((x) => (m = x))();
			return { spec: { ...(marker?.userData?.camera ?? {}) }, look: (m[cam]?.effects ?? []).map((e) => e.kind + ':' + (e.params.aspect ?? '')) };
		}, ids.cam);
	await h.eventually(readB, (v) => v.spec.focusTarget === ids.sphere && v.look.some((k) => k.startsWith('letterbox')), '9.0 B has the lens and the look', 30000);
	const onB = await readB();
	h.check(!!onB && onB.spec.focusTarget === ids.sphere && onB.spec.aperture === 1.8, '9.1 B receives the camera\'s focus target and aperture');
	h.check(!!onB && onB.look.includes('dof:') && onB.look.includes('letterbox:2.39'), '9.2 B receives the camera look (' + onB?.look + ')');
	await Promise.all([A, B].map((p) => p.page.evaluate((cam) => window.__stores.cameraPreview.startCameraPreview(cam), ids.cam)));
	const focusA = await h.eventually(() => read(page), (v) => !!v.film?.dof, 'A dof', 10000).then(() => read(page));
	const focusB = await h.eventually(() => read(B.page), (v) => !!v.film?.dof && Math.abs(v.film.dof.focusDistance - focusA.film.dof.focusDistance) < 0.2, 'B focuses where A does', 15000).then(() => read(B.page));
	h.check(Math.abs(focusB.film.dof.focusDistance - focusA.film.dof.focusDistance) < 0.2, '9.3 both peers focus on the sphere at the same distance (' + focusA.film.dof.focusDistance.toFixed(2) + ' / ' + focusB.film.dof.focusDistance.toFixed(2) + ')');
	h.check(focusB.kinds.includes('letterbox'), '9.4 ...and B renders the matte through that camera');
	// B taps to focus on the box -> A follows
	const tapB = await B.page.evaluate(({ cam }) => {
		const s = window.__stores;
		const cam3 = s.filmLook.currentRenderCamera();
		const marker = s.cameraObjects.findCameraObject(cam);
		cam3.updateMatrixWorld();
		return !!marker && !!cam3;
	}, ids);
	if (tapB) {
		const pt = await B.page.evaluate(({ box }) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const cam = s.filmLook.currentRenderCamera();
			const v = g.getObjectByProperty('uuid', box).getWorldPosition(cam.position.clone()).project(cam);
			return [v.x, v.y];
		}, ids);
		await B.page.evaluate(({ cam, pt }) => window.__stores.focusPick.focusAt(cam, pt[0], pt[1]), { cam: ids.cam, pt });
	}
	await h.eventually(() => specOf(page, ids.cam), (v) => v.focusTarget === ids.box, '9.5 a tap-to-focus on B moves the focus on A too (one shared lens)', 15000);
	await h.closePeer(B);

	// ---------------------------------------------------------------- 10. N6
	console.log('\n=== 10. N6 folded + unfolded: the section and tap to focus by touch ===');
	await page.evaluate(() => window.__stores.cameraPreview.stopCameraPreview());
	for (const [label, ctxOpts] of [
		['folded', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 }],
		['unfolded', { viewport: { width: 770, height: 850 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 }]
	]) {
		const P = await h.setupPageQuiet(browser, 'N6-' + label, [A], { context: ctxOpts, storage: { toursSeen: '{"editor":true,"editor-touch":true}' } });
		await h.answerRestore(P).catch(() => {});
		const pIds = await P.page.evaluate(async () => {
			const s = window.__stores;
			s.commandsHandler.sceneCommand('/create sphere');
			await new Promise((r) => setTimeout(r, 900));
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const sphere = g.children.at(-1);
			sphere.position.set(0, 0, 0);
			s.commandsHandler.sceneCommand('/create camera');
			await new Promise((r) => setTimeout(r, 1200));
			const cam = s.cameraObjects.listCameraObjects().at(-1);
			let ec;
			s.globalCamera.subscribe((v) => (ec = v))();
			ec.position.set(0, 1, 8);
			ec.lookAt(0, 0, 0);
			ec.updateMatrixWorld();
			s.cameraObjects.setCameraFromView(cam.uuid);
			s.scenePost.addPostEffect('dof', undefined, cam.uuid);
			s.objectActions.selectObject(cam.uuid, true);
			s.inspectorClose?.set?.(false);
			return { sphere: sphere.uuid, cam: cam.uuid };
		});
		const pick = P.page.locator('#film-focus-pick');
		await pick.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
		await pick.scrollIntoViewIfNeeded().catch(() => {});
		const reachable = await pick.isVisible().catch(() => false);
		h.check(reachable, `10.1 ${label}: the Film look section is on screen and reachable`);
		if (reachable) {
			await pick.tap().catch(() => pick.click());
			const armed = await P.page.locator('#focus-pick-overlay').isVisible().catch(() => false);
			h.check(armed, `10.2 ${label}: Tap to focus arms the pick layer by touch`);
			// the dock (the Inspector tab) steps aside while the pick is armed, so the picture is free
			await wait(P.page, 500);
			const where = await screenOf(P.page, [0, 0, 0]);
			const free = await P.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'focus-pick-overlay', where);
			h.check(free, `10.3 ${label}: the sphere on the picture is tappable while the pick is armed (the dock steps aside)`);
			await P.page.screenshot({ path: `test-results/77-look/10-${label}-armed.png` }).catch(() => {});
			await P.page.touchscreen.tap(where.x, where.y);
			await h.eventually(() => specOf(P.page, pIds.cam), (v) => v.focusTarget === pIds.sphere, `10.4 ${label}: a finger tap on the picture focuses on the sphere`, 6000);
			const back = await P.page.evaluate(() => {
				let m;
				window.__stores.bottomDock.dockMinimized.subscribe((v) => (m = v))();
				return m;
			});
			h.check(back === false, `10.5 ${label}: the dock comes back after the pick (minimized ${back})`);
			await P.page.screenshot({ path: `test-results/77-look/10-${label}.png` }).catch(() => {});
		}
		await h.closePeer(P);
	}

	await h.finish(browser);
});
