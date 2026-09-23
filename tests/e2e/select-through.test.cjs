// 30 P2 — SELECT-THROUGH and CLICK-CYCLE.
//
// Measured before this (roadmap 30, "Selection and the object list", cause 1): the pick
// returned the NEAREST hit whatever its opacity, so Stars Room's 0.12-opacity walls took
// every click on a star, a pad or a planet (16 of 16 selected "Wall south") and
// Football's 0.06 ceiling ate the lamps. Now a plain editor click prefers the first
// OPAQUE target down the ray, an object flagged `userData.pick = 'through'` stands aside
// whatever its opacity, and a REPEAT on the same spot (after the double-click window)
// walks down the stack — which is how the shell itself stays reachable.
//
// Real mouse clicks on pixels proven to cross the intended objects (premises), and the
// flag is set through the REAL Inspector checkbox, then read back on a second peer.

const h = require('./helpers.cjs');

const selection = (page) =>
	page.evaluate(() => {
		let v;
		window.__stores.selectedObjects.subscribe((x) => (v = x))();
		return v.slice();
	});

/** make a box, name/place/scale it, return its uuid (re-seated after /create's own) */
async function makeBox(page, name, pos, scale = [1, 1, 1]) {
	const uuid = await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		return group.children[group.children.length - 1].uuid;
	});
	await page.waitForTimeout(700);
	await page.evaluate(
		({ uuid, name, pos, scale }) => {
			const s = window.__stores;
			let group;
			s.objectsGroup.subscribe((v) => (group = v))();
			const o = group.getObjectByProperty('uuid', uuid);
			o.name = name;
			o.position.fromArray(pos);
			o.scale.fromArray(scale);
			delete o.userData.physics;
			o.updateMatrixWorld(true);
			s.objectsGroup.update((v) => v);
		},
		{ uuid, name, pos, scale }
	);
	return uuid;
}

/** the screen pixel of a world point, and the ORDERED names the app's pick finds there */
function pixelAt(page, world) {
	return page.evaluate((world) => {
		const s = window.__stores;
		const THREE = s.THREE;
		let camera, renderer;
		s.globalCamera.subscribe((v) => (camera = v))();
		s.globalRenderer.subscribe((v) => (renderer = v))();
		const v = new THREE.Vector3(...world).project(camera);
		const rect = renderer.domElement.getBoundingClientRect();
		const ray = new THREE.Raycaster();
		ray.setFromCamera(new THREE.Vector2(v.x, v.y), camera);
		const names = [];
		for (const hit of s.scenePick.sceneHits(ray)) {
			let n = hit.object;
			while (n.parent && n.parent.name !== 'sceneObjects') n = n.parent;
			if (!names.includes(n.name)) names.push(n.name);
		}
		const x = rect.left + ((v.x + 1) / 2) * rect.width;
		const y = rect.top + ((1 - v.y) / 2) * rect.height;
		return { x, y, names, onCanvas: document.elementFromPoint(x, y) === renderer.domElement };
	}, world);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const page = A.page;
	await h.connect(A, B);

	// ---------------------------------------------------------------- fixtures
	// a box INSIDE a 0.1-opacity shell, and an opaque wall in front of a crate
	const inner = await makeBox(page, 'Inner', [0, 0.5, 0], [0.6, 0.6, 0.6]);
	const shell = await makeBox(page, 'Shell', [0, 0.5, 0], [2.4, 2.4, 2.4]);
	await page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group.getObjectByProperty('uuid', uuid);
		o.material.transparent = true;
		o.material.opacity = 0.1;
		o.material.needsUpdate = true;
	}, shell);
	const crate = await makeBox(page, 'Crate', [5, 0.5, -1], [0.8, 0.8, 0.8]);
	const wall = await makeBox(page, 'Wall', [5, 0.8, 1.5], [3, 1.6, 0.2]);
	await page.evaluate(() => {
		const s = window.__stores;
		s.objectActions.deselectObject();
		// look at both fixtures from the front, so each ray crosses shell->inner / wall->crate
		s.objectActions.flyTo([2.5, 2.2, 9], [2.5, 0.6, 0], 0);
	});
	await page.waitForTimeout(1200);

	// ---------------------------------------------------------------- 1
	console.log('\n=== 1. a box inside a 0.1-opacity shell selects the BOX ===');
	let at = await pixelAt(page, [0, 0.5, 0]);
	h.check(at.onCanvas, '1.1 (premise) the pixel is the canvas');
	h.check(at.names[0] === 'Shell' && at.names.includes('Inner'), `1.2 (premise) the ray meets the SHELL first, the box behind it (${at.names.join(' > ')})`);
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(400);
	h.check((await selection(page)).join() === inner, '1.3 the click selects the box, not the near-invisible shell');
	const hint = await page.evaluate(() => document.body.innerText.includes('Click again to select behind'));
	h.check(hint, '1.4 the first stacked pick says how to reach what is behind');

	// ---------------------------------------------------------------- 2
	console.log('\n=== 2. a repeat on the same spot walks down the stack (and reaches the shell) ===');
	await page.waitForTimeout(650); // past the double-click window, inside the cycle window
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(400);
	h.check((await selection(page)).join() === shell, '2.1 the repeat click reaches the SHELL (the next entry down, wrapping)');
	await page.waitForTimeout(650);
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(400);
	h.check((await selection(page)).join() === inner, '2.2 ...and once more comes back round to the box');
	// a DOUBLE-click is still the double-click action, never a cycle
	await page.waitForTimeout(1700);
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.mouse.dblclick(at.x, at.y);
	await page.waitForTimeout(500);
	h.check((await selection(page)).join() === inner, '2.3 a double-click stays on the box (no cycle inside the double-click window)');
	await page.waitForTimeout(1700);
	await page.mouse.click(at.x + 30, at.y + 30);
	await page.waitForTimeout(300);

	// ---------------------------------------------------------------- 3
	console.log('\n=== 3. the Click-through checkbox: an OPAQUE wall is clicked through ===');
	at = await pixelAt(page, [5, 0.5, -1]);
	h.check(at.names[0] === 'Wall' && at.names.includes('Crate'), `3.1 (premise) the ray meets the opaque WALL first (${at.names.join(' > ')})`);
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(1700);
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(400);
	h.check((await selection(page)).join() === wall, '3.2 (premise) unflagged, an opaque wall takes the click');
	// open its properties and tick the real checkbox
	await page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), wall);
	await page.waitForTimeout(700);
	const box = page.locator('#inspector-pick-through');
	h.check((await box.count()) === 1, '3.3 the Inspector carries "Click-through in the viewport"');
	await box.check();
	await page.waitForTimeout(400);
	const flag = await page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return group.getObjectByProperty('uuid', uuid).userData.pick ?? null;
	}, wall);
	h.check(flag === 'through', `3.4 ticking it writes userData.pick (${flag})`);
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(1700);
	await page.mouse.click(at.x, at.y);
	await page.waitForTimeout(400);
	h.check((await selection(page)).join() === crate, '3.5 flagged, the wall stands aside: the click selects the crate behind it');
	await h.eventually(
		() =>
			B.page.evaluate((uuid) => {
				let group;
				window.__stores.objectsGroup.subscribe((v) => (group = v))();
				return group.getObjectByProperty('uuid', uuid)?.userData?.pick ?? null;
			}, wall),
		(v) => v === 'through',
		'3.6 the flag reaches the peer (a props write, like physics)'
	);
	// one undo clears it, and the clear replicates too
	await page.evaluate(() => window.__stores.history.undo());
	await page.waitForTimeout(400);
	const undone = await page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return group.getObjectByProperty('uuid', uuid).userData.pick ?? null;
	}, wall);
	h.check(undone === null, `3.7 one undo clears it (${undone})`);
	await h.eventually(
		() =>
			B.page.evaluate((uuid) => {
				let group;
				window.__stores.objectsGroup.subscribe((v) => (group = v))();
				return group.getObjectByProperty('uuid', uuid)?.userData?.pick ?? null;
			}, wall),
		(v) => v === null,
		'3.8 ...on the peer too'
	);
	// an object never flagged carries NO pick key (saved scenes stay byte-identical)
	const clean = await page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return 'pick' in group.getObjectByProperty('uuid', uuid).userData;
	}, crate);
	h.check(!clean, '3.9 an unflagged object has no pick key at all');

	h.check(h.pageErrors(A).length === 0, `the page threw nothing (${h.pageErrors(A).join(' / ')})`);
	await h.finish(browser);
});
