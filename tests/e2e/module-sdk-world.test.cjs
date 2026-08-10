// 17-A: the modules moved OUT of core (piano/avatar/essentials/car) install as
// real user modules from their real zips, through the real manager, and the SDK
// surface built for them works: api.create / moveObject / physics.set /
// physics.createJoint. Guards the move - core no longer bundles these, so only
// this suite proves the api they now depend on stays intact.
const h = require('./helpers.cjs');
const fs = require('fs');

// the sibling modules-repo checkout that holds the packed zips. Skipped (not
// failed) when it is absent, so the suite is safe on a fresh clone.
const REPO = require('path').resolve(__dirname, '../../../theprototype.app-modules') + '/';

async function install(page, id) {
	await page.evaluate(() => window.__stores.modulesOpen.set(true));
	await page.waitForTimeout(300);
	await page.getByRole('tab', { name: /^User/ }).click();
	await page.waitForTimeout(200);
	await page.locator('#install-module-zip').setInputFiles({
		name: id + '.zip',
		mimeType: 'application/zip',
		buffer: fs.readFileSync(REPO + id + '.zip')
	});
	await page.waitForTimeout(1500);
}
const loaded = (page) =>
	page.evaluate(() => window.__stores.moduleSDK.loadedModules.map((m) => m.id));
const objectCount = (page) =>
	page.evaluate(
		() =>
			new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children.length ?? 0))())
	);

h.run(async () => {
	if (!fs.existsSync(REPO + 'car.zip')) {
		console.log('SKIP: ../theprototype.app-modules zips not built (npm run pack -- --all there)');
		return;
	}
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const errors = [];
	A.page.on('pageerror', (e) => errors.push(String(e)));

	for (const id of ['piano', 'avatar', 'essentials', 'car']) {
		await install(A.page, id);
		await h.eventually(() => loaded(A.page), (ids) => ids.includes(id), `${id} installs + registers as a user module`);
	}

	// piano: spawns its scene-root group from the card
	await A.page.locator('#user-module-card-piano').getByRole('button', { name: /Piano/ }).click();
	await h.eventually(
		() =>
			A.page.evaluate(
				() =>
					new Promise((r) =>
						window.__stores.globalScene.subscribe((s) => r(!!s?.getObjectByName('piano-module')))()
					)
			),
		(v) => v === true,
		'piano (ported) builds its keyboard through api.THREE'
	);

	// essentials: the demo row uses api.create + api.moveObject
	const before = await objectCount(A.page);
	await A.page.locator('#user-module-card-essentials').getByRole('button', { name: /demo row/ }).click();
	await h.eventually(
		() => objectCount(A.page),
		(n) => n >= before + 6,
		'essentials (ported) spawns 6 replicated objects via api.create'
	);
	const placed = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const ess = (g?.children ?? []).filter((c) => c.name?.startsWith('Ess'));
					r(ess.map((c) => [c.name, +c.position.x.toFixed(2)]));
				})()
			)
	);
	h.check(
		placed.length >= 6 && new Set(placed.map((p) => p[1])).size >= 6,
		`essentials laid out on X via api.moveObject (${JSON.stringify(placed.slice(0, 3))})`
	);

	// car: spawn uses api.create + api.physics.set + api.physics.createJoint
	const beforeCar = await objectCount(A.page);
	await A.page.locator('#user-module-card-car').getByRole('button', { name: /spawn demo car/ }).click();
	await h.eventually(
		() => objectCount(A.page),
		(n) => n >= beforeCar + 5,
		'car (ported) spawns body + 4 wheels via api.create'
	);
	const carState = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const body = (g?.children ?? []).find((c) => c.name === 'Carbody');
					r({ physics: body?.userData?.physics ?? null, pos: body?.position?.toArray() });
				})()
			)
	);
	h.check(
		carState.physics?.mode === 'dynamic' && carState.physics?.mass === 30,
		`car body physics set via api.physics.set (${JSON.stringify(carState.physics)})`
	);
	h.check(
		Math.abs((carState.pos?.[1] ?? 0) - 0.55) < 0.01,
		`car body placed via api.moveObject (y=${carState.pos?.[1]})`
	);
	const joints = await A.page.evaluate(() => window.__stores.joints.jointsSnapshot().length);
	h.check(joints >= 4, `car created 4 axle joints via api.physics.createJoint (${joints})`);

	const real = errors.filter((e) => !/ResizeObserver|Pointer Lock/.test(e));
	h.check(real.length === 0, `no page errors from the ported modules (${real.slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
