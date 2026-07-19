// Animation window v1 (roadmap #9 tail): a LOCAL-ONLY transform animator opened
// from the Flow "+" menu. Verifies the easing math, that the window renders for the
// selected object with movement tracks, and that Play drives the object per frame
// while Stop restores the pose captured at Play. Local-only => not replicated.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- easing math: linear is identity; ease-in starts slow (< linear) ---
	const ease = await A.page.evaluate(() => {
		const { cubicBezierEase, EASINGS } = window.__stores.animationPreview;
		return {
			lin: cubicBezierEase(EASINGS.linear, 0.5),
			easeIn: cubicBezierEase(EASINGS['ease-in'], 0.5),
			end: cubicBezierEase(EASINGS['ease-in-out'], 1)
		};
	});
	h.check(Math.abs(ease.lin - 0.5) < 0.02, `linear easing is identity at 0.5 (${ease.lin.toFixed(3)})`);
	h.check(ease.easeIn < 0.45, `ease-in is slow at the start (${ease.easeIn.toFixed(3)} < 0.5)`);
	h.check(Math.abs(ease.end - 1) < 0.001, 'every easing ends at 1');

	// --- open the window on a selected object ---
	const uuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		s.objectActions.selectObject(obj.uuid);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation'); // starts docked -> make it the visible tab
		return obj.uuid;
	});
	await A.page.waitForTimeout(200);
	h.check(await A.page.locator('#animation-dock').isVisible(), 'the Animation view opens (docked) for the selection');

	// --- add a movement track: it shows on the left ---
	await A.page.evaluate((id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		obj.position.y = 0;
		obj.updateMatrix();
		const tid = s.animationPreview.addTrack(id, 'pos.y', obj);
		s.animationPreview.updateTrack(id, tid, { from: 0, to: 4 });
		s.animationPreview.updateAnim(id, { duration: 1, loop: 'loop' });
	}, uuid);
	await A.page.waitForTimeout(150);
	h.check(await A.page.locator('#animation-dock button:has-text("Position Y")').first().isVisible(), 'the movement track renders in the layer list');

	// docked dropdowns must use the panel's light text color (they inherit it from the
	// dock container) so the <option> items are readable, matching the floating window
	const dropColor = await A.page.evaluate(() => {
		const sel = document.querySelector('#animation-dock select');
		const c = sel ? getComputedStyle(sel).color : '';
		const m = c.match(/\d+/g);
		return m ? { r: +m[0], g: +m[1], b: +m[2] } : null;
	});
	h.check(!!dropColor && (dropColor.r + dropColor.g + dropColor.b) / 3 > 140, `docked dropdowns use a light text color (${JSON.stringify(dropColor)})`);

	// --- Play drives the object per frame ---
	await A.page.evaluate((id) => window.__stores.animationPreview.play(id), uuid);
	await A.page.waitForTimeout(280);
	const during = await A.page.evaluate((id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		let pb;
		s.animationPreview.playback.subscribe((v) => (pb = v))();
		return { y: obj.position.y, playing: pb.playing, uuid: pb.uuid };
	}, uuid);
	h.check(during.playing && during.uuid === uuid, 'playback reports the object is playing');
	h.check(during.y > 0.01 && during.y < 4.1, `the object is driven along pos.y while playing (y=${during.y.toFixed(2)})`);

	// --- Stop restores the pose captured at Play ---
	await A.page.evaluate(() => window.__stores.animationPreview.stop());
	await A.page.waitForTimeout(80);
	const after = await A.page.evaluate((id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		let pb;
		s.animationPreview.playback.subscribe((v) => (pb = v))();
		return { y: obj.position.y, playing: pb.playing };
	}, uuid);
	h.check(!after.playing, 'Stop clears the playing state');
	h.check(Math.abs(after.y) < 0.001, `Stop restores the base pose (y back to 0, got ${after.y.toFixed(3)})`);

	// --- local-only: nothing about the authored animation is broadcast ---
	// (sanity: the animation lives in a local store, not the object's userData that
	//  would ride GLTF sync)
	const localOnly = await A.page.evaluate((id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		let map;
		s.animationPreview.animations.subscribe((v) => (map = v))();
		return { inStore: !!map[id], inUserData: !!obj.userData.animation };
	}, uuid);
	h.check(localOnly.inStore && !localOnly.inUserData, 'authored animation is local (store only, not on userData)');

	await h.finish(browser);
});
