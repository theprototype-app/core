// 36 X4: VR collider authoring, driven through the REAL per-frame VR path (fakeXR.cjs).
// The radial's Edit Collider opens the custom-collider session + the edit side-menu,
// which gains the collider rows; its Vertices/Faces tabs drive the scene-root PROXY
// (never the real object); a GRIP on the proxy's face reshapes the PROXY while the real
// object stays put — before X4 the face lookups searched objectsGroup only, missed the
// proxy, and the grip fell through to rigid-grabbing the object behind it; + Box piece,
// Done (saves a custom collider), Cancel/✕ (no write) and Decompose all work in-headset.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	const box = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 600));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const b = g.children[g.children.length - 1];
		b.scale.setScalar(0.6);
		b.position.set(0, 1.4, -1.5);
		b.updateMatrixWorld(true);
		s.physics.setPhysicsFor(b.uuid, { mode: 'static', collider: 'box' });
		s.objectActions.selectObject(b.uuid);
		s.isVRMode.set(true);
		window.__cbox = b;
		return b.uuid;
	});
	await xr.install(A.page);
	// the POINTER is the hand that does not hold the menu; it aims straight at the box
	const menuHand = await A.page.evaluate(() => {
		let v;
		window.__stores.vrMenuHand.subscribe((x) => (v = x))();
		return v;
	});
	const pointer = menuHand === 'right' ? 'left' : 'right';
	await xr.pose(A.page, menuHand, [0.4, 1.2, 0], { pitch: -0.6 }); // aimed away
	await xr.pose(A.page, pointer, [0, 1.4, 0]);
	await A.page.waitForTimeout(300);

	const state = () =>
		A.page.evaluate(() => {
			const s = window.__stores;
			const get = (store) => {
				let v;
				store.subscribe((x) => (v = x))();
				return v;
			};
			const ce = s.colliderEdit;
			let scene;
			s.globalScene.subscribe((v) => (scene = v))();
			const menu = scene.getObjectByName('vr-edit-menu');
			const rows = [];
			menu?.traverse((o) => o.name?.startsWith('vredit-') && rows.push(o.name.slice(7)));
			return {
				session: get(ce.colliderEditObject),
				proxy: ce.colliderProxyUuid(),
				face: get(s.faceEdit.faceEditObject),
				vertex: get(s.meshEdit.editingObject),
				menuOpen: get(s.vrEditMenuOpen),
				rows,
				shells: ce.colliderShellCount(),
				physics: window.__cbox.userData.physics,
				pos: window.__cbox.position.toArray()
			};
		});

	// --- 1) the radial entry opens the session + the side-menu with the collider rows
	await A.page.evaluate(() => {
		window.__stores.vrMenuOpen.set(true);
		window.__stores.vrControls.executeVRMenuAction('obj:editcollider');
	});
	await A.page.waitForTimeout(500);
	let st = await state();
	h.check(st.session === box && !!st.proxy, `Edit Collider starts the session on the box (proxy ${st.proxy?.slice(0, 8)})`);
	h.check(st.menuOpen && st.face === st.proxy, 'the side-menu opens and face edit runs ON THE PROXY');
	h.check(
		['collider:add:box', 'collider:add:sphere', 'collider:decompose', 'collider:done', 'collider:cancel'].every((r) => st.rows.includes(r)),
		`the side-menu carries the collider rows (${st.rows.filter((r) => r.startsWith('collider:')).join(', ')})`
	);
	h.check(!st.rows.includes('edit:mode:stretch'), 'no Stretch tab while editing a collider');

	// --- 2) the mode tabs drive the proxy, never the real object
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('edit:mode:vertices'));
	st = await state();
	h.check(st.vertex === st.proxy && st.vertex !== box, `the Vertices tab edits the proxy (${st.vertex === st.proxy})`);
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('edit:mode:faces'));
	st = await state();
	h.check(st.face === st.proxy && !st.vertex, 'the Faces tab goes back to the proxy');

	// --- 3) a GRIP on the proxy's face reshapes the proxy; the real box stays put
	const proxySum = () =>
		A.page.evaluate(() => {
			const p = window.__stores.faceEdit.lookupEditable(window.__stores.colliderEdit.colliderProxyUuid());
			return Array.from(p.geometry.attributes.position.array).reduce((a, b) => a + b, 0);
		});
	const sum0 = await proxySum();
	await h.eventually(
		() => A.page.evaluate(() => {
			let v;
			window.__stores.faceEdit.faceEditHoverTri.subscribe((x) => (v = x))();
			return v;
		}),
		(tri) => typeof tri === 'number' && tri >= 0,
		'the pointer ray highlights a PROXY face (the frame path finds the proxy)',
		8000
	);
	await xr.button(A.page, pointer, 1, true); // grip
	await A.page.waitForTimeout(250);
	await xr.pose(A.page, pointer, [0, 1.4, 0.35]); // pull the face toward you
	await A.page.waitForTimeout(400);
	await xr.button(A.page, pointer, 1, false);
	await A.page.waitForTimeout(400);
	const sum1 = await proxySum();
	st = await state();
	h.check(Math.abs(sum1 - sum0) > 0.05, `the grip moved the proxy's face (vertex sum ${sum0.toFixed(3)} -> ${sum1.toFixed(3)})`);
	h.check(
		JSON.stringify(st.pos.map((v) => +v.toFixed(3))) === JSON.stringify([0, 1.4, -1.5]),
		`the real box did NOT move (no rigid grab behind the proxy) (${st.pos.map((v) => v.toFixed(3))})`
	);
	await xr.pose(A.page, pointer, [0, 1.4, 0]);

	// --- 4) + Box piece, then Done saves a custom collider and closes everything
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('collider:add:box'));
	st = await state();
	h.check(st.shells === 2, `+ Box piece adds a second shell (${st.shells})`);
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('collider:done'));
	await A.page.waitForTimeout(300);
	st = await state();
	h.check(st.physics.collider === 'custom' && st.physics.colliderPieces?.length === 2, `Done saves a 2-piece custom collider (${st.physics.collider}, ${st.physics.colliderPieces?.length})`);
	h.check(!st.session && !st.menuOpen && !st.face, 'Done ends the session and closes the side-menu');

	// --- 5) ✕ during a session cancels: nothing is written
	const openSession = async () => {
		await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('obj:editcollider'));
		await h.eventually(() => state(), (s) => !!s.session && s.menuOpen, 'the session re-opens (the entry loads colliderEdit lazily)');
	};
	await openSession();
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('collider:add:sphere'));
	await A.page.waitForTimeout(300);
	const mid = await state();
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('edit:close'));
	await A.page.waitForTimeout(300);
	st = await state();
	h.check(mid.shells === 3 && !st.session && !st.menuOpen, `✕ cancels the session (had ${mid.shells} shells)`);
	h.check(st.physics.colliderPieces?.length === 2, `the cancelled edit wrote nothing (${st.physics.colliderPieces?.length} pieces)`);
	h.check(!st.face && !st.vertex, 'no mesh session is left behind on the proxy or the object');

	// --- 6) Decompose from the headset (X3) leaves the session and writes the result
	await openSession();
	await A.page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('collider:decompose'));
	await h.eventually(
		() => state(),
		(s) => !s.session && s.physics.collider === 'custom' && s.physics.colliderPieces?.length >= 1 && s.physics.colliderPieces?.length !== 2,
		'Decompose from VR replaces the collider with the V-HACD pieces',
		60000
	);

	await xr.uninstall(A.page);
	await h.finish(browser);
});
