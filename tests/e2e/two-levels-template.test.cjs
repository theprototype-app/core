// 78-int (device-lab-4 A5): the bundled "Two levels and a portal" template PLAYS: the player walks the courtyard,
// walks into the portal and arrives ON the tower top (not inside the tower). The template was authored while the
// default walker was on the union; 1.64 holds it back, so without its own Character Controller node walk mode was the
// eye-height pin over the ground plane and the hop put the eye 0.8 m up inside the tower.
//   1. the served template loads with its Character Controller (walk) node and its two levels
//   2. Play: the walker stands on the courtyard (rapier tier: the all-static level runs its world)
//   3. into the portal: level tower-top, the walker stands ON the tower top (feet ~10 m), eye above it
//   APP_URL=https://theprototype.app:5802/ node tests/e2e/two-levels-template.test.cjs
const h = require('./helpers.cjs');

const walker = (page) =>
	page.evaluate(() => {
		let st;
		window.__stores.charController.walkerState.subscribe((v) => (st = v))();
		return st;
	});
const level = (page) => page.evaluate(() => window.__stores.kit.kit.impls.levels?.current?.() ?? null);
const eye = (page) =>
	page.evaluate(() => {
		let cam;
		window.__stores.globalCamera.subscribe((c) => (cam = c))();
		// the camera sits in a group at y = 0.9: read the WORLD eye, not the local position
		return cam.getWorldPosition(cam.position.clone()).toArray();
	});
/** put the player at a spot (the rig the walker carries) */
const stand = (page, p) =>
	page.evaluate((e) => {
		let cam;
		window.__stores.globalCamera.subscribe((v) => (cam = v))();
		cam.position.set(e[0], e[1], e[2]);
		cam.updateMatrixWorld(true);
	}, p);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	console.log('\n=== 1. the template ===');
	const loaded = await page.evaluate(() =>
		window.__stores.sceneTemplates.loadRemoteScene({ sceneUrl: '/templates/two-levels/scene.tpscene', title: 'Two levels and a portal', slug: 'two-levels' })
	);
	h.check(loaded === true, 'premise: the bundled template loads');
	await h.eventually(
		() => page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r((g?.children ?? []).map((c) => c.name)))())),
		(n) => n.includes('Tower top') && n.includes('To the tower'),
		'premise: the courtyard, the tower top and the portal are in the scene',
		20000
	);
	const cc = await page.evaluate(() => (window.__stores.allNodes?.() ?? []).filter((n) => n.type === 'charcontroller').map((n) => n.data?.mode));
	h.check(cc.length === 1 && cc[0] === 'walk', `1.1 the template carries ONE Character Controller in walk mode (${JSON.stringify(cc)})`);

	console.log('\n=== 2. Play in the courtyard ===');
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(
		() => walker(page),
		(s) => s && s.source === 'rapier' && s.grounded && Math.abs(s.ground) < 0.06,
		'2.1 the walker stands on the courtyard floor (rapier tier)',
		15000
	);

	console.log('\n=== 3. into the portal ===');
	await stand(page, [0, 1.75, -11]);
	await h.eventually(() => level(page), (l) => l === 'tower-top', '3.1 walking into the portal goes to the tower-top level', 30000);
	await h.eventually(
		() => walker(page),
		(s) => s && s.source === 'rapier' && s.grounded && s.ground > 9.9 && s.ground < 10.1,
		'3.2 the walker stands ON the tower top (feet ~10 m), not inside the tower',
		15000
	);
	const e = await eye(page);
	h.check(Math.abs(e[1] - 11.7) < 0.1, `3.3 the eye is 1.7 m above the tower top (${e.map((v) => v.toFixed(2)).join(', ')})`);
	await h.leavePlay(A);
	await h.finish(browser);
});
