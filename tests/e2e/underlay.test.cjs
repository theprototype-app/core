// 60 Q5: REFERENCE IMAGE UNDERLAYS. Drop an image on the viewport → "Use as reference" → a locked,
// unpickable, see-through plane on the ground (or facing the view), with its own opacity. A working
// aid, not scene content: hidden in Play, absent from the GLTF export, the .tpscene payload (which
// Export and Publish build from) and the viewport/room thumbnail; LOCAL by default, and "Share with
// session" shows it read-only to the peers in your room until the owner turns the switch off.
// Persisted per scene on this device: a reload keeps it.
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;
const RED = [230, 20, 20];

/** park the editor camera at `pos` looking at `target` (through the OrbitControls, which own the view) */
const aim = (page, pos, target) =>
	page.evaluate(
		({ pos, target }) => {
			const s = window.__stores;
			const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
			const cam = get(s.editorCam);
			const oc = get(s.orbitControls);
			oc.target.set(...target);
			cam.position.set(...pos);
			cam.lookAt(...target);
			oc.update();
			cam.updateMatrixWorld(true);
		},
		{ pos, target }
	);

/** drop a solid-red PNG (made on a canvas) on the viewport centre, the way a file drag does */
const dropImage = (page, name = 'floor-plan.png') =>
	page.evaluate(
		async ({ name, rgb }) => {
			const c = document.createElement('canvas');
			c.width = 64;
			c.height = 32;
			const ctx = c.getContext('2d');
			ctx.fillStyle = `rgb(${rgb.join(',')})`;
			ctx.fillRect(0, 0, 64, 32);
			const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
			const dt = new DataTransfer();
			dt.items.add(new File([blob], name, { type: 'image/png' }));
			let canvas;
			window.__stores.globalRenderer.subscribe((r) => (canvas = r.domElement))();
			const box = canvas.getBoundingClientRect();
			const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
			canvas.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
			canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
		},
		{ name, rgb: RED }
	);

/** the layer's meshes, and whether any of them sits under sceneObjects */
const layer = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const root = get(s.globalScene)?.getObjectByName('reference-underlays');
		let inObjects = false;
		get(s.objectsGroup).traverse((o) => {
			if (o.userData?.underlay) inObjects = true;
		});
		return {
			found: !!root,
			meshes: (root?.children ?? []).map((m) => ({ id: m.userData.underlay, visible: m.visible, opacity: m.material.opacity, owner: m.userData.owner, layer: m.layers.mask })),
			inObjects
		};
	});

/** the centre pixel of a fresh editor render (helper layer as the camera has it), and of the
 * viewport thumbnail (sessions.viewportThumbnail, which rooms and the session list use) */
const centrePixels = (page) =>
	page.evaluate(async () => {
		const s = window.__stores;
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const renderer = get(s.globalRenderer);
		const scene = get(s.globalScene);
		const camera = get(s.globalCamera);
		const read = (source) => {
			const c = document.createElement('canvas');
			c.width = source.width;
			c.height = source.height;
			const ctx = c.getContext('2d');
			ctx.drawImage(source, 0, 0);
			return [...ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data.slice(0, 3)];
		};
		renderer.render(scene, camera);
		const live = read(renderer.domElement);
		const url = s.sessions.viewportThumbnail(256);
		const img = new Image();
		await new Promise((r) => ((img.onload = r), (img.onerror = r), (img.src = url)));
		return { live, thumb: read(img) };
	});
const reddish = (p) => p[0] > 150 && p[0] > p[1] + 80 && p[0] > p[2] + 80;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const P = A.page;

	// ---- 1. drop an image → "Use as reference — on the ground" -------------------------------------
	await aim(P, [0, 12, 6], [0, 0, 0]);
	await dropImage(P);
	const row = P.getByRole('menuitem', { name: 'Use as reference — on the ground' });
	h.check(await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false), 'an image-only drop asks what the image is for');
	const items = await P.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim()));
	h.check(items.some((t) => t.includes('Add to the Explorer')), `...the Explorer stays an answer (${JSON.stringify(items)})`);
	await row.click();
	await h.eventually(() => P.evaluate(() => window.__stores.underlays.underlaysDebug().mine.length), (n) => n === 1, 'the image becomes one reference image of mine');
	const mine = (await P.evaluate(() => window.__stores.underlays.underlaysDebug())).mine[0];
	h.check(mine.mode === 'ground' && Math.abs(mine.position[1]) < 0.01 && mine.shared === false && mine.name === 'floor-plan', `on the ground, local, named after the file (${JSON.stringify({ m: mine.mode, p: mine.position, s: mine.shared, n: mine.name })})`);
	h.check(Math.abs(mine.position[0]) < 0.01 && Math.abs(mine.position[2]) < 0.01, '...under the point the view orbits around');
	h.check(mine.px[0] === 64 && mine.px[1] === 32, `...keeping the image's aspect (${mine.px})`);
	h.check(await P.locator('#underlay-window').isVisible(), 'the Reference images window opens');
	await P.waitForTimeout(400);
	let L = await layer(P);
	h.check(L.found && L.meshes.length === 1 && L.meshes[0].visible, `one plane in the reference layer (${JSON.stringify(L)})`);
	h.check(!L.inObjects, 'nothing of it under sceneObjects (never synced, saved or exported)');
	h.check(L.meshes[0].layer === 1 << 30, `...on the editor helper layer only (mask ${L.meshes[0].layer})`);

	// ---- 2. locked and unpickable: a ray THROUGH it finds nothing, a click selects nothing ---------
	const ray = await P.evaluate(() => {
		const s = window.__stores;
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const mesh = get(s.globalScene).getObjectByName('reference-underlays').children[0];
		const rc = new s.THREE.Raycaster(new s.THREE.Vector3(0, 5, 0), new s.THREE.Vector3(0, -1, 0));
		const twin = new s.THREE.Mesh(mesh.geometry, mesh.material);
		twin.position.copy(mesh.position);
		twin.quaternion.copy(mesh.quaternion);
		twin.scale.copy(mesh.scale);
		twin.updateMatrixWorld(true);
		return { real: rc.intersectObject(mesh).length, twin: rc.intersectObject(twin).length };
	});
	h.check(ray.twin === 1 && ray.real === 0, `a ray through it hits an ordinary plane of the same shape, not the underlay (${JSON.stringify(ray)})`);
	await P.evaluate(() => window.__stores.objectActions.applySelectionSet([]));
	const canvasBox = await P.evaluate(() => {
		let el;
		window.__stores.globalRenderer.subscribe((r) => (el = r.domElement))();
		const b = el.getBoundingClientRect();
		return { x: b.x, y: b.y, width: b.width, height: b.height };
	});
	await P.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
	await P.waitForTimeout(400);
	h.check((await P.evaluate(store('selectedObjects'))).length === 0, 'a click on it selects nothing');

	// ---- 3. the opacity slider drives the material --------------------------------------------------
	await P.locator('#underlay-window [data-ul="opacity"] input[type="range"]').fill('1');
	await P.waitForTimeout(300);
	L = await layer(P);
	h.check(Math.abs(L.meshes[0].opacity - 1) < 0.01, `opacity 100% reaches the plane (${L.meshes[0].opacity})`);
	await P.locator('#underlay-window [data-ul="opacity"] input[type="range"]').fill('0.3');
	await P.waitForTimeout(300);
	L = await layer(P);
	h.check(Math.abs(L.meshes[0].opacity - 0.3) < 0.01, `opacity 30% reaches the plane (${L.meshes[0].opacity})`);
	await P.locator('#underlay-window [data-ul="opacity"] input[type="range"]').fill('1');
	await P.waitForTimeout(300);

	// ---- 4. the editor sees it; the thumbnail does not (counterfactual on one frame) ---------------
	const px = await centrePixels(P);
	h.check(reddish(px.live), `the live editor render shows the image at the centre (${px.live})`);
	h.check(!reddish(px.thumb), `the viewport thumbnail leaves it out (${px.thumb})`);

	// ---- 5. hidden in Play ---------------------------------------------------------------------------
	await P.mouse.move(700, 450);
	await P.keyboard.press('Control+Enter');
	for (let i = 0; i < 40 && (await P.evaluate(store('isLocked'))) !== true; i++) await P.waitForTimeout(100);
	h.check((await P.evaluate(store('isLocked'))) === true, 'Ctrl+Enter enters Play');
	await P.waitForTimeout(300);
	L = await layer(P);
	h.check(L.meshes.length === 1 && !L.meshes[0].visible, 'in Play the plane is hidden');
	h.check(!(await P.locator('#underlay-window').isVisible()), '...and so is its window');
	await h.leavePlay(A);
	await P.waitForTimeout(300);
	L = await layer(P);
	h.check(L.meshes[0].visible, 'back in the editor it shows again');

	// ---- 6. never exported: the GLTF bytes and the .tpscene payload (Export/Publish) carry nothing --
	const exp = await P.evaluate(async (id) => {
		const s = window.__stores;
		const get = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const bytes = await s.fileHandler.gltfBytesFor([get(s.objectsGroup)], { binary: false });
		const gltf = typeof bytes === 'string' ? bytes : bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes) ? new TextDecoder().decode(bytes) : JSON.stringify(bytes);
		const payload = JSON.stringify(await s.sessions.buildSessionPayload('underlay-check'));
		return { gltf: gltf.length, gltfHit: gltf.includes('underlay') || gltf.includes(id), payload: payload.length, payloadHit: payload.includes(id) || payload.includes('floor-plan') || payload.includes('reference-underlays') };
	}, mine.id);
	h.check(exp.payload > 0 && !exp.payloadHit, `the .tpscene payload holds no reference image (${exp.payload} chars)`);
	h.check(!exp.gltfHit, `the GLTF export holds none (${exp.gltf} chars)`);

	// ---- 7. a peer: nothing until Share; then read-only, following the owner; unshare takes it back --
	const B = await h.setupPageQuiet(browser, 'B', [A], { context: { viewport: { width: 1280, height: 800 } } });
	const Q = B.page;
	await h.connect(B, A);
	const theirs = () => Q.evaluate(() => Object.values(window.__stores.underlays.underlaysDebug().theirs).flat());
	h.check((await theirs()).length === 0 && (await layer(Q)).meshes.length === 0, 'B sees nothing of A\'s local reference image');
	await P.locator('#underlay-window [data-ul="share"]').check();
	await h.eventually(theirs, (l) => l.length === 1 && l[0].id === mine.id, 'A ticks Share with session: B has the row', 15000);
	await h.eventually(() => layer(Q), (l) => l.meshes.length === 1 && l.meshes[0].visible && l.meshes[0].owner === A.id, 'B draws the plane, owned by A');
	h.check(!(await layer(Q)).inObjects, '...outside B\'s sceneObjects too');
	await Q.evaluate(() => window.__stores.underlays.underlayWindowOpen.set(true));
	await Q.waitForTimeout(400);
	const bRow = Q.locator(`#underlay-window [data-underlay="${mine.id}"]`);
	h.check((await bRow.locator('[data-ul="from"]').count()) === 1 && (await bRow.locator('[data-ul="opacity"]').count()) === 0, 'B\'s window lists it read-only (no controls)');
	await P.locator('#underlay-window [data-ul="opacity"] input[type="range"]').fill('0.4');
	await h.eventually(() => layer(Q), (l) => l.meshes.length === 1 && Math.abs(l.meshes[0].opacity - 0.4) < 0.01, 'A moves the opacity: B follows');
	// one writer per row: B's own edit call on A's row is a no-op (it is not B's), nothing reaches A
	await Q.evaluate((id) => window.__stores.underlays.updateUnderlay(id, { opacity: 0.9 }), mine.id);
	await P.waitForTimeout(600);
	h.check(Math.abs((await layer(P)).meshes[0].opacity - 0.4) < 0.01, 'B cannot edit A\'s row (owner-only writer)');
	await P.locator('#underlay-window [data-ul="share"]').uncheck();
	await h.eventually(theirs, (l) => l.length === 0, 'A unticks Share: B drops the row');
	await h.eventually(() => layer(Q), (l) => l.meshes.length === 0, '...and the plane');
	h.check((await layer(P)).meshes.length === 1, 'A keeps it');

	// ---- 8. share again (A's reload below re-shares it: a reload is not an unshare), then B leaves ---
	await P.locator('#underlay-window [data-ul="share"]').check();
	await h.eventually(theirs, (l) => l.length === 1, 'shared again: B has it');
	await h.closePeer(B);
	await P.waitForTimeout(1500);

	// ---- 9. A reloads: the image is kept on this device, per scene ---------------------------------
	await P.waitForTimeout(500); // the idb write is debounced
	await h.freshReload(A);
	await h.answerRestore(A);
	// a reload is a new peer: the id the joiner below dials is the new one
	await P.waitForFunction(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(!!p?.peer?.id))()), null, { timeout: 30000 });
	A.id = await P.evaluate(() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p?.peer?.id))()));
	await h.eventually(() => P.evaluate(() => window.__stores.underlays.underlaysDebug()), (d) => d.loaded && d.mine.length === 1 && d.mine[0].id === mine.id && Math.abs(d.mine[0].opacity - 0.4) < 0.01, 'after a reload A still has the image (opacity kept)');
	await h.eventually(() => layer(P), (l) => l.meshes.length === 1 && l.meshes[0].visible, '...drawn again');

	// ---- 10. a joiner arriving after the share gets it from the full-state reply ------------------
	const C = await h.setupPageQuiet(browser, 'C', [A], { context: { viewport: { width: 1280, height: 800 } } });
	await h.connect(C, A);
	await h.eventually(() => C.page.evaluate(() => Object.values(window.__stores.underlays.underlaysDebug().theirs).flat().length), (n) => n === 1, 'a joiner gets the shared image from the full-state reply', 15000);
	await h.eventually(() => layer(C.page), (l) => l.meshes.length === 1, '...and draws it');
	// removing it on A takes it away from the joiner
	await P.evaluate(() => window.__stores.underlays.underlayWindowOpen.set(true));
	await P.waitForTimeout(400);
	await P.locator('#underlay-window [data-ul="remove"]').click();
	await h.eventually(() => layer(C.page), (l) => l.meshes.length === 0, 'A removes it: gone for the joiner');
	h.check((await layer(P)).meshes.length === 0, '...and for A');

	await h.finish(browser);
});
