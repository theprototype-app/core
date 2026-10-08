// 36 F22 / S6 / S8 / S12 — SELECTING INSIDE AND BEHIND THINGS.
//
// The reports: "I cannot click the fish inside the Aquarium's water" (1.23 production), and
// (orchestrator) "Examples ▸ Fluid tank toy: a click on a sphere seen through the tank water must
// select that sphere; Alt+click cycles tank → sphere → …".
//
// Measured on 1.23.0: the water volume's own mesh is a plain OPAQUE box for picking (the water
// renderer swaps its material per render call only), so it was the first opaque target in front
// of every fish — the click selected "Aquarium water".
//
//   1. Aquarium: a real click on a fish seen through the water selects the FISH (premise: the
//      water is the nearest hit on that pixel).
//   2. Alt held: a preview chip names what an Alt+click would take ("1 of N", the water — the
//      front); letting Alt go removes it (S6).
//   3. Alt+click walks the stack front to back: water (1 of N) → fish (2 of N) → …; the live
//      region announces each pick (S12).
//   4. Configure Scene ▸ Advanced ▸ "Selection passes through ▸ Water" (the real checkbox) off:
//      the same click selects the water; the setting is saved with the scene (S8).
//   5. Fluid tank toy: a click on a duck seen through the tank selects the duck; Alt+click cycles
//      tank → duck.
//   6. Games: the Interact/Play click target and the VR laser end on the fish, not the water.
//   7. Ctrl+Alt+click still pings (the gesture plain Alt+click used to be).
//
// Scenes: SCENES_DIR (an `examples/` tree of the scenes repo at origin/main or later); SKIPS
// (never fails) when the Aquarium is not there.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SCENES_DIR = process.env.SCENES_DIR || '/home/deck/.code/theprototype-app/scenes';
const SHOTS = process.env.SHOTS_DIR || '';
const AQUARIUM = path.join(SCENES_DIR, 'examples/aquarium/scene.tpscene');
const FLUID = path.join(SCENES_DIR, 'examples/fluid-tank-toy/scene.tpscene');

const selection = (page) =>
	page.evaluate(() => {
		let v;
		window.__stores.selectedObjects.subscribe((x) => (v = x))();
		let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return (v ?? []).map((uuid) => group.getObjectByProperty('uuid', uuid)?.name ?? uuid);
	});

const pingCount = (page) =>
	page.evaluate(() => {
		let p;
		window.__stores.ping.pings.subscribe((v) => (p = v))();
		return (p ?? []).length;
	});

async function loadScene(page, file) {
	const b64 = fs.readFileSync(file).toString('base64');
	await page.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const s = window.__stores.sessions;
		const payload = await s.readSessionZip(bytes.buffer);
		await s.applySession(payload, { backup: false, quiet: true });
	}, b64);
	await h.eventually(
		() => page.evaluate(() => { let v; window.__stores.sceneLoader.sceneLoad.subscribe((x) => (v = x))(); return v; }),
		(v) => v === null,
		'the scene finished loading',
		30000
	);
	// the fish SWIM (Path Patrol nodes): a pixel aimed at one is empty a second later, so the
	// suite stops the scene's logic — the fish rest at their base poses
	await page.evaluate(() => {
		const s = window.__stores;
		s.flowGraphs.set({ scene: { nodes: [], edges: [] } });
		s.flowNodes.set([]);
		s.flowEdges.set([]);
	});
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(1200);
}

/** the world centre of a named top-level object */
const centreOf = (page, name) =>
	page.evaluate((name) => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const o = group.children.find((c) => c.name === name);
		const box = new s.THREE.Box3().setFromObject(o);
		return box.getCenter(new s.THREE.Vector3()).toArray();
	}, name);

/** what the app's own pick sees at a pixel, nearest first (no pass-through), + what is under the cursor */
const stackAt = (page, px) =>
	page.evaluate(({ x, y }) => {
		const s = window.__stores;
		let camera, renderer, group;
		s.globalCamera.subscribe((v) => (camera = v))();
		s.globalRenderer.subscribe((v) => (renderer = v))();
		s.objectsGroup.subscribe((v) => (group = v))();
		const rect = renderer.domElement.getBoundingClientRect();
		const ray = new s.THREE.Raycaster();
		ray.setFromCamera(new s.THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), camera);
		const none = { water: false, transparent: false, triggers: false };
		const hits = ray.intersectObjects(group.children, true);
		// (the selectThrough hook is absent on 1.23.0 — the before-run lists distinct targets itself)
		const names = s.selectThrough
			? s.selectThrough.pickStack(hits, s.objectActions.topLevelObjectOf, none).map((e) => e.target.name)
			: [...new Set(hits.map((h) => s.objectActions.topLevelObjectOf(h.object)?.name).filter(Boolean))];
		const at = document.elementFromPoint(x, y);
		return { names, canvas: at === renderer.domElement };
	}, px);

/** a pixel on `name` where the app's pick finds `front` first and `name` behind it */
async function aimThrough(page, name, front) {
	const c = await centreOf(page, name);
	for (const [dx, dy, dz] of [[0, 0, 0], [0.03, 0, 0], [-0.03, 0, 0], [0, 0.03, 0], [0, -0.03, 0], [0, 0, 0.03]]) {
		const px = await h.projectPoint(page, [c[0] + dx, c[1] + dy, c[2] + dz]);
		const st = await stackAt(page, px);
		if (st.canvas && st.names[0] === front && st.names.includes(name)) return { px, names: st.names };
	}
	return { px: null, names: (await stackAt(page, await h.projectPoint(page, c))).names };
}

h.run(async () => {
	if (!fs.existsSync(AQUARIUM)) {
		console.log('SKIP: no ' + AQUARIUM + ' (set SCENES_DIR to a scenes checkout at origin/main)');
		process.exit(0);
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	// THEME=light for the light-theme screenshots (the default is dark)
	const A = await h.setupPage(browser, 'A', process.env.THEME ? { storage: { theme: process.env.THEME } } : {});
	const page = A.page;

	await loadScene(page, AQUARIUM);
	// the fish the loaded Aquarium has: 1.32 (40 F14) swapped the primitive fish for reef fish
	const fishName = await page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return ['Clownfish 1', 'Fish orange'].find((n) => g.getObjectByName(n)) ?? 'Fish orange';
	});
	const aim = await aimThrough(page, fishName, 'Aquarium water');
	h.check(!!aim.px, 'premise: a pixel on the orange fish whose nearest hit is the water (' + aim.names.join(' > ') + ')');
	if (!aim.px) return h.finish(browser);
	const { x, y } = aim.px;

	// ---- 1: the fish through the water --------------------------------------------------------
	await page.mouse.click(x, y);
	await page.waitForTimeout(500);
	h.check((await selection(page)).join() === fishName, 'a click on the fish through the water selects the fish (' + (await selection(page)).join() + ')');
	if (SHOTS) await page.screenshot({ path: SHOTS + '-fish.png' });

	// ---- 2: the Alt-held preview (S6) --------------------------------------------------------
	await page.mouse.move(x + 1, y);
	await page.keyboard.down('Alt');
	await page.mouse.move(x, y);
	await h.eventually(() => page.locator('#pick-cycle-hint').getAttribute('data-mode').catch(() => null), (v) => v === 'preview', 'holding Alt shows the preview chip', 3000);
	const chip = (await page.locator('#pick-cycle-hint').innerText().catch(() => '')).replace(/\s+/g, ' ');
	h.check(/^1 of \d+ Aquarium water/.test(chip), 'the preview names the FRONT of the stack ("' + chip + '")');
	h.check((await page.evaluate(() => window.__stores.pickCycle.pickPreviewDebug())).visible, 'a preview box is drawn around it');
	if (SHOTS) await page.screenshot({ path: SHOTS + '-alt-preview.png' });
	await page.keyboard.up('Alt');
	await h.eventually(() => page.locator('#pick-cycle-hint').count(), (n) => n === 0, 'letting Alt go removes the preview', 2000);
	await page.mouse.move(x + 3, y + 2);
	await page.waitForTimeout(300);
	h.check((await page.locator('#pick-cycle-hint').count()) === 0, 'no preview without Alt');

	// ---- 3: Alt+click cycles front to back (S12 announcement) --------------------------------
	const altClick = async () => {
		await page.keyboard.down('Alt');
		await page.mouse.click(x, y);
		await page.keyboard.up('Alt');
		await page.waitForTimeout(450);
	};
	await altClick();
	h.check((await selection(page)).join() === 'Aquarium water', 'Alt+click #1 takes the front: the water (' + (await selection(page)).join() + ')');
	const live1 = await page.locator('#pick-cycle-live').innerText();
	h.check(/^Selected 1 of \d+: Aquarium water$/.test(live1), 'the live region announces it ("' + live1 + '")');
	h.check((await page.locator('#pick-cycle-live').getAttribute('aria-live')) === 'polite', 'the region is aria-live polite');
	await altClick();
	h.check((await selection(page)).join() === fishName, 'Alt+click #2 takes the next one down: the fish');
	const chip2 = (await page.locator('#pick-cycle-hint').innerText().catch(() => '')).replace(/\s+/g, ' ');
	h.check(new RegExp('^2 of \\d+ ' + fishName).test(chip2), 'the chip says "2 of N" (' + chip2 + ')');
	if (SHOTS) await page.screenshot({ path: SHOTS + '-alt-cycle.png' });
	const seen = new Set(['Aquarium water', ...(await selection(page))]);
	// N comes from the app's own chip: what the editor's pick sees under the cursor
	const total = Number(await page.locator('#pick-cycle-hint').getAttribute('data-of').catch(() => '0')) || aim.names.length;
	for (let i = 2; i < total; i++) {
		await altClick();
		seen.add((await selection(page)).join());
	}
	await altClick();
	h.check((await selection(page)).join() === 'Aquarium water' && seen.size === total, 'Alt+click visits every object under the cursor and wraps (' + seen.size + ' of ' + total + ')');
	h.check((await pingCount(page)) === 0, 'a plain Alt+click no longer pings');

	// ---- 4: the setting (S8) — the real checkbox in Configure Scene ▸ Advanced ----------------
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.evaluate(() => window.__stores.openSceneSection('Advanced'));
	await h.eventually(() => page.locator('#pick-through-water').isVisible(), (v) => v, 'Configure Scene ▸ Advanced shows the setting', 5000);
	// 38 R5: the switches are Toggles — their state is aria-pressed
	const isOn = async (/** @type {string} */ sel) => (await page.locator(sel).getAttribute('aria-pressed')) === 'true';
	h.check(await isOn('#pick-through-water'), 'water passes through by default');
	h.check(!(await isOn('#pick-through-transparent')) && !(await isOn('#pick-through-triggers')), 'transparent and triggers do not by default');
	if (SHOTS) await page.locator('#pick-through-water').screenshot({ path: SHOTS + '-setting-row.png' }).catch(() => {});
	if (SHOTS) await page.screenshot({ path: SHOTS + '-setting.png' });
	await page.locator('#pick-through-water').click();
	const saved = await page.evaluate(() => window.__stores.sessions.buildSessionPayload('probe').physics?.pick ?? null);
	h.check(saved && saved.water === false, 'the setting is saved with the scene (' + JSON.stringify(saved) + ')');
	await page.evaluate(() => window.__stores.closeSelectionInspector?.());
	await page.waitForTimeout(400);
	const blocked = await aimThrough(page, fishName, 'Aquarium water');
	if (blocked.px) {
		await page.mouse.click(blocked.px.x, blocked.px.y);
		await page.waitForTimeout(500);
		h.check((await selection(page)).join() === 'Aquarium water', 'with "Water" off the same click selects the water (' + (await selection(page)).join() + ')');
	} else h.check(false, 'premise: the fish is still behind the water');
	await page.evaluate(() => window.__stores.scenePhysics.setScenePhysics({ pick: { water: true, transparent: false, triggers: false } }));
	h.check((await page.evaluate(() => window.__stores.sessions.buildSessionPayload('probe').physics?.pick ?? null)) === null, 'back at the defaults the scene writes no `pick` key');

	// ---- 6: game rays + the VR laser ----------------------------------------------------------
	const rays = await page.evaluate(({ x, y }) => {
		const s = window.__stores;
		let camera, renderer;
		s.globalCamera.subscribe((v) => (camera = v))();
		s.globalRenderer.subscribe((v) => (renderer = v))();
		const rect = renderer.domElement.getBoundingClientRect();
		const ray = new s.THREE.Raycaster();
		ray.setFromCamera(new s.THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), camera);
		const game = s.vrGameInput.clickTargetAlong(ray);
		const beam = s.vrControls.beamTarget(ray);
		return { game: game?.uuid ?? null, gameName: game?.object?.name ?? null, beam: beam.object?.name ?? null };
	}, { x, y });
	h.check(rays.beam === fishName, 'the VR laser ends on the fish, not the water (' + rays.beam + ')');
	// a GAME's click: the editor's Interact mode routes a real click through playInteract's
	// interactClick — the same stack and pass a Play tap uses — to a module click handler
	await page.evaluate(() => {
		const s = window.__stores;
		window.__f22Clicked = [];
		window.__f22Handler = (object) => {
			window.__f22Clicked.push(s.objectActions.topLevelObjectOf(object)?.name ?? null);
			return true;
		};
		s.moduleSDK.moduleClickHandlers.push(window.__f22Handler);
		s.objectActions.setEditorMode('interact');
	});
	await page.waitForTimeout(300);
	await page.mouse.click(x, y);
	await page.waitForTimeout(400);
	const gameClicked = await page.evaluate(() => {
		const s = window.__stores;
		const list = s.moduleSDK.moduleClickHandlers;
		list.splice(list.indexOf(window.__f22Handler), 1);
		s.objectActions.setEditorMode('edit');
		return window.__f22Clicked;
	});
	h.check(gameClicked.length === 1 && gameClicked[0] === fishName, "a game's click (Interact) reaches the fish, not the water (" + gameClicked.join() + ')');

	// ---- 7: Ctrl+Alt+click pings --------------------------------------------------------------
	const pingsBefore = await pingCount(page);
	await page.keyboard.down('Control');
	await page.keyboard.down('Alt');
	await page.mouse.click(x, y);
	await page.keyboard.up('Alt');
	await page.keyboard.up('Control');
	await page.waitForTimeout(400);
	h.check((await pingCount(page)) > pingsBefore, 'Ctrl+Alt+click pings (the gesture plain Alt+click used to be)');

	// ---- 5: Fluid tank toy --------------------------------------------------------------------
	if (fs.existsSync(FLUID)) {
		await loadScene(page, FLUID);
		// the ducks are SAVED above the tank (y 1.6 / 1.7; the glass spans 0.6-1.5) and drop into
		// the water when the simulation runs — run it until Duck 1 floats inside the glass
		await page.evaluate(() => window.__stores.physics.toggleSimulation());
		await h.eventually(
			() => centreOf(page, 'Duck 1'),
			(c) => c[1] < 1.42,
			'premise: Duck 1 has dropped into the tank (simulation running)',
			15000
		);
		await page.waitForTimeout(2500); // let it settle on the surface
		const duck = await centreOf(page, 'Duck 1');
		const tank = await centreOf(page, 'Water tank');
		await page.evaluate(({ duck, tank }) => {
			// straight on from the front, level with the duck (just below its centre — it floats
			// near the top): only the tank's front wall is between the camera and the duck
			const from = [duck[0], duck[1] - 0.04, tank[2] + 2.6];
			window.__stores.objectActions.flyTo(from, [duck[0], duck[1] - 0.04, duck[2]], 0);
		}, { duck, tank });
		await page.waitForTimeout(900);
		const duckAim = await aimThrough(page, 'Duck 1', 'Water tank');
		h.check(!!duckAim.px, 'premise: a pixel on Duck 1 whose nearest hit is the tank (' + duckAim.names.join(' > ') + ')');
		if (duckAim.px) {
			await page.mouse.click(duckAim.px.x, duckAim.px.y);
			await page.waitForTimeout(500);
			h.check((await selection(page)).join() === 'Duck 1', 'a click on the duck through the tank selects the duck (' + (await selection(page)).join() + ')');
			if (SHOTS) await page.screenshot({ path: SHOTS + '-duck.png' });
			await page.keyboard.down('Alt');
			await page.mouse.click(duckAim.px.x, duckAim.px.y);
			await page.waitForTimeout(400);
			const first = (await selection(page)).join();
			await page.mouse.click(duckAim.px.x, duckAim.px.y);
			await page.waitForTimeout(400);
			const second = (await selection(page)).join();
			await page.keyboard.up('Alt');
			h.check(first === 'Water tank' && second === 'Duck 1', 'Alt+click cycles tank → duck (' + first + ' → ' + second + ')');
		}
		await page.evaluate(() => window.__stores.physics.toggleSimulation());
	} else console.log('SKIP 5: no ' + FLUID);

	h.check(h.pageErrors(A).length === 0, 'no page errors (' + h.pageErrors(A).join(' | ') + ')');
	await h.finish(browser);
});
