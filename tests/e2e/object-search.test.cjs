// Phase 125: viewport object search — opt-in "Search objects…" entry opens a
// swap-box listing scene objects; typing filters, pick selects + flies the
// camera. Hidden until enabled in settings.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// three named objects
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		window.__stores.commandsHandler.sceneCommand('/create cylinder');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const kids = group.children.slice(-3);
		kids[0].name = 'Barrel';
		kids[1].name = 'Ball';
		kids[2].name = 'Pillar';
		window.__pillar = kids[2].uuid;
		kids[2].position.set(12, 0, -8);
	});

	const openMenu = () =>
		A.page.evaluate(() => window.__stores.viewportMenu.set({ x: 200, y: 160, point: { x: 0, y: 0, z: 0 } }));

	// --- hidden by default ---
	await openMenu();
	await A.page.waitForTimeout(300);
	const hidden = await A.page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes('Search objects'))
	);
	h.check(!hidden, 'the Search objects entry is hidden by default');
	await A.page.evaluate(() => window.__stores.viewportMenu.set(null));

	// --- appears after enabling the setting ---
	await A.page.evaluate(() => window.__stores.objectSearchEnabled.set(true));
	await openMenu();
	await A.page.waitForTimeout(300);
	const shown = await A.page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes('Search objects'))
	);
	h.check(shown, 'enabling the setting adds the Search objects entry');

	// --- clicking it opens the search box; typing filters ---
	await A.page.evaluate(() => window.__stores.objectSearch.set({ x: 200, y: 160 }));
	await A.page.waitForTimeout(300);
	const boxOpen = await A.page.evaluate(() => !!document.querySelector('#object-search-box'));
	h.check(boxOpen, 'the object-search box opens');

	const filtered = await A.page.evaluate(() => {
		const input = document.querySelector('#object-search-input');
		input.value = 'pill';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		return new Promise((resolve) =>
			setTimeout(() => {
				const rows = [...document.querySelectorAll('#object-search-box button')].map((b) => b.textContent.trim());
				resolve(rows);
			}, 150)
		);
	});
	h.check(
		filtered.length === 1 && filtered[0].includes('Pillar'),
		`typing filters to matching objects (${filtered.join(',')})`
	);

	// --- picking selects the object and flies the camera toward it ---
	const picked = await A.page.evaluate(() => {
		let camBefore;
		window.__stores.globalCamera.subscribe((c) => (camBefore = c?.position.clone()))();
		document.querySelector('#object-search-box button').click();
		return new Promise((resolve) =>
			setTimeout(() => {
				let sel, cam;
				window.__stores.selectedObject.subscribe((v) => (sel = v?.uuid))();
				window.__stores.globalCamera.subscribe((c) => (cam = c))();
				resolve({
					selected: sel === window.__pillar,
					boxClosed: !document.querySelector('#object-search-box'),
					moved: camBefore ? cam.position.distanceTo(camBefore) > 0.01 : false
				});
			}, 700)
		);
	});
	h.check(picked.selected, 'picking selects the object');
	h.check(picked.boxClosed, 'the search box closes after picking');
	h.check(picked.moved, 'the camera flies toward the picked object');

	await h.finish(browser);
});
