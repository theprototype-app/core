// 31 R1 — THE RADIAL FOLLOWS THE STICK. The user, on a Quest 3: "In VR, when I open radial
// menu, i do not see highlights when i move joystick, fix navigation."
//
// The cause was not the input: vrControls always set `vrHovered` to the sector under the stick.
// VRMenu.svelte is a LEGACY-mode component, where `color={sectorColor(s.entry)}` compiles to
// untrack(() => sectorColor(...)) depending on `s` alone, so the $vrHovered read INSIDE the helper
// registered nothing and no sector mesh ever repainted — under the stick OR the ray. And a
// stick-lit sector could not be picked with the trigger (only a ray hit could).
//
// Driven through fakeXR (the real per-frame updateVRControls + Scene's real select handler):
// 1 the menu button opens the radial · 2 each of the 8 stick directions lights exactly its
// sector's MESH (the colour, not just the store) · 3 one haptic tick per sector change (Interact;
// Edit is silent by the C4 rule) · 4 the trigger picks the stick-lit sector (its own ray misses
// the ring) · 5 a stick-click picks it · 6 the pointer hand's stick navigates too · 7 the ray
// lights the sector it hits · 8 a greyed sector is never lit by the stick.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await xr.install(page);

	const read = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const g = (st) => {
				let v;
				st.subscribe((x) => (v = x))();
				return v;
			};
			const grp = g(s.vrControls.vrMenuGroup);
			const lit = [];
			grp?.traverse((o) => {
				if (o.name?.startsWith('vrmenu-') && o.material?.color?.getHexString() === 'ff4000') lit.push(o.name.slice(7));
			});
			const ring = g(s.vrRadialMenu.activeRing);
			return {
				open: g(s.vrMenuOpen),
				hand: g(s.vrMenuHand),
				hov: g(s.vrControls.vrHovered),
				ring,
				entries: s.vrRadialMenu.ringEntries(ring).map((e) => e.id),
				lit
			};
		});
	const settle = () => page.waitForTimeout(160);

	// posed away from the ring (the ring is not posed without a real session: it sits at the origin)
	await xr.pose(page, 'left', [-0.3, 1.1, 0.6], { pitch: -1.3 });
	await xr.pose(page, 'right', [0.3, 1.1, 0.6], { pitch: -1.3 });
	const hand = (await read()).hand;
	const other = hand === 'left' ? 'right' : 'left';

	// --- 1 open through the real button path
	await xr.button(page, hand, 5, true);
	await settle();
	await xr.button(page, hand, 5, false);
	await settle();
	let st = await read();
	h.check(st.open && st.ring === 'root' && st.entries.length === 8, `the menu button opens the root ring (${st.entries.length} sectors)`);

	// --- 2 every direction lights exactly its sector's mesh
	let allLit = true;
	let allHov = true;
	const detail = [];
	for (let i = 0; i < 8; i++) {
		const a = (i * Math.PI * 2) / 8; // clockwise from 12 o'clock; stick UP is -y
		await xr.stick(page, hand, Math.sin(a), -Math.cos(a));
		await settle();
		st = await read();
		const want = st.entries[i];
		if (st.hov !== want) allHov = false;
		if (!(st.lit.length === 1 && st.lit[0] === want)) allLit = false;
		detail.push(`${i}:${st.hov}/${st.lit.join('+')}`);
	}
	h.check(allHov, `the stick hovers each of the 8 sectors in order (${detail.join(' ')})`);
	h.check(allLit, 'the hovered sector MESH repaints, and only that one');
	await xr.stick(page, hand, 0, 0);
	await settle();
	st = await read();
	h.check(st.hov === null && st.lit.length === 0, 'a centred stick lights nothing');

	// --- 3 a haptic tick per sector change (Interact — Edit is silent by the C4 rule)
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	const before = await xr.pulses(page);
	for (const [x, y] of [[0, -1], [1, 0], [0, 1]]) {
		await xr.stick(page, hand, x, y);
		await settle();
	}
	const after = await xr.pulses(page);
	const ticks = after[hand] - before[hand];
	h.check(ticks >= 3, `three sector changes tick the controller three times (${ticks})`);
	await xr.stick(page, hand, 0, 0);
	await settle();
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));

	// --- 4 the trigger picks the stick-lit sector; its own ray misses the ring
	const menuHandIndex = hand === 'left' ? 0 : 1;
	await xr.stick(page, hand, Math.sin(Math.PI / 4), -Math.cos(Math.PI / 4)); // sector 1 = nav:add
	await settle();
	st = await read();
	const target = st.hov;
	const rayMiss = await page.evaluate((i) => window.__stores.vrControls.raycastMenu(i), menuHandIndex);
	await page.evaluate((i) => {
		const r = window.__fakeXR.renderer;
		const c = r.xr.getController(i);
		c.dispatchEvent({ type: 'select', target: c });
	}, menuHandIndex);
	await settle();
	st = await read();
	h.check(target === 'nav:add' && rayMiss === null, `premise: the stick lights Add while the trigger hand's ray misses the ring (${target}, ray ${rayMiss})`);
	h.check(st.ring === 'add', `the trigger opens the stick-lit sector (ring ${st.ring})`);
	await xr.stick(page, hand, 0, 0);
	await settle();
	await page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('back'));
	await settle();

	// --- 5 a stick-click picks it too (the 74 gesture, kept)
	await xr.stick(page, hand, 1, 0); // sector 2 = nav:scene
	await settle();
	await xr.button(page, hand, 3, true);
	await settle();
	await xr.button(page, hand, 3, false);
	await xr.stick(page, hand, 0, 0);
	await settle();
	st = await read();
	h.check(st.ring === 'scene', `a stick-click opens the lit sector (ring ${st.ring})`);
	await page.evaluate(() => window.__stores.vrControls.executeVRMenuAction('back'));
	await settle();

	// --- 6 the pointer hand's stick navigates too
	await xr.stick(page, other, -1, 0); // sector 6
	await settle();
	st = await read();
	h.check(st.hov === st.entries[6] && st.lit[0] === st.entries[6], `the other hand's stick lights sector 6 (${st.hov})`);
	await xr.stick(page, other, 0, 0);
	await settle();

	// --- 7 the ray lights the sector it hits (the ring sits at the origin facing +z)
	const aim = await page.evaluate(() => {
		const m = window.__stores.vrRadialMenu;
		const l = m.sectorLayout(2, 8);
		return [l.labelX, l.labelY];
	});
	const pointerIndex = other === 'left' ? 0 : 1;
	await xr.pose(page, other, [aim[0], aim[1], 0.4]);
	await settle();
	st = await read();
	h.check(st.hov === st.entries[2] && st.lit.length === 1 && st.lit[0] === st.entries[2], `the pointer ray lights the sector it hits (${st.hov}/${st.lit})`);
	await xr.pose(page, other, [0.3, 1.1, 0.6], { pitch: -1.3 });
	await settle();

	// --- 8 a greyed sector is never lit by the stick
	const greyed = await page.evaluate(() => {
		const m = window.__stores.vrRadialMenu;
		m.registerVRMenuEntry({ id: 'r1-grey', label: 'Grey', group: 'r1test', disabled: () => true });
		m.registerVRMenuEntry({ id: 'r1-live', label: 'Live', group: 'r1test' });
		m.pushRing('r1test');
		return m.ringEntries('r1test').map((e) => e.id);
	});
	await settle();
	await xr.stick(page, hand, 0, -1); // sector 0 of 2 = the greyed one
	await settle();
	st = await read();
	h.check(greyed[0] === 'r1-grey' && st.hov === null && st.lit.length === 0, `a greyed sector is not lit (${st.hov})`);
	await xr.stick(page, hand, 0, 1); // sector 1 = live
	await settle();
	st = await read();
	h.check(st.hov === 'r1-live' && st.lit[0] === 'r1-live', `its live neighbour is (${st.hov})`);
	await xr.stick(page, hand, 0, 0);

	await xr.uninstall(page);
	await h.finish(browser);
});
