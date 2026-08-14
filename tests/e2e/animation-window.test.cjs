// Animation window (roadmap #9 tail, keyframes since 17-E): a transform animator
// opened from the Flow "+" menu. Verifies the easing math, that the window renders
// for the selected object with movement tracks, and that Play drives the object per
// frame while Stop restores the pose captured at Play.
//
// Since 17-E the store holds named CLIPS of keyed tracks (v1's single from->to
// segment migrates to two keys) and the data is saved + replicated, so the old
// "nothing lands anywhere but a local store" check became a SHAPE check instead.
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
		return { y: obj.position.y, playing: !!pb[id]?.playing, uuid: pb[id] ? id : null };
	}, uuid);
	h.check(during.playing && during.uuid === uuid, 'playback reports the object is playing');
	h.check(during.y > 0.01 && during.y < 4.1, `the object is driven along pos.y while playing (y=${during.y.toFixed(2)})`);

	// --- Stop restores the pose captured at Play ---
	await A.page.evaluate((id) => window.__stores.animationPreview.stop(id), uuid);
	await A.page.waitForTimeout(80);
	const after = await A.page.evaluate((id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		let pb;
		s.animationPreview.playback.subscribe((v) => (pb = v))();
		return { y: obj.position.y, playing: !!pb[id]?.playing };
	}, uuid);
	h.check(!after.playing, 'Stop clears the playing state');
	h.check(Math.abs(after.y) < 0.001, `Stop restores the base pose (y back to 0, got ${after.y.toFixed(3)})`);

	// --- the v2 shape: named clips of KEYED tracks, in the side-channel store ---
	// (it stays off userData: a uuid-keyed store is what the save/replication paths
	//  read, and userData would ride the lossy GLTF round trip)
	const shape = await A.page.evaluate((id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		let map;
		s.animationPreview.animations.subscribe((v) => (map = v))();
		const set = map[id];
		const clip = set?.clips?.[set.active];
		const track = clip?.tracks?.[0];
		return {
			inStore: !!set,
			inUserData: !!obj.userData.animation,
			clipIds: Object.keys(set?.clips ?? {}),
			active: set?.active ?? null,
			keys: track?.keys?.map((/** @type {any} */ k) => [k.t, k.v]) ?? [],
			easeOnFirstKey: Array.isArray(track?.keys?.[0]?.ease)
		};
	}, uuid);
	h.check(shape.inStore && !shape.inUserData, 'authored animation lives in the uuid-keyed store, not on userData');
	h.check(shape.clipIds.length === 1 && shape.active === shape.clipIds[0], `the object has one active clip (${shape.active})`);
	h.check(
		shape.keys.length === 2 && shape.keys[0][0] === 0 && Math.abs(shape.keys[0][1]) < 1e-6 && Math.abs(shape.keys[1][1] - 4) < 1e-6,
		`the from/to edit became two keys (${JSON.stringify(shape.keys)})`
	);
	h.check(shape.easeOnFirstKey, 'the easing rides the key that opens the segment');

	// --- the pane must SURVIVE two keys sharing a time -------------------------
	// Reported as "animation pane does not open anymore". A presentational each-block
	// in the navigator strip was keyed by key TIME, and two keys legitimately share
	// one while a multi-selection is dragged through itself — a duplicate each-key
	// THROWS in svelte, which took the whole window down. Nothing about the crash was
	// visible to a store-reading check, which is why the helper now fails a suite on
	// a render error at all.
	await A.page.evaluate((id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		const clip = ap.activeClip(id);
		const track = clip.tracks[0];
		ap.addKey(id, track.id, 0.5, 1);
		ap.addKey(id, track.id, 0.9, 2);
		// put two of them on the SAME time, as a drag does in passing
		const fresh = ap.activeClip(id).tracks[0];
		ap.moveKeys(id, [
			{ trackId: fresh.id, index: 1, t: 0.7 },
			{ trackId: fresh.id, index: 2, t: 0.7 }
		]);
	}, uuid);
	await A.page.waitForTimeout(400);
	const survived = await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		return {
			dock: !!document.querySelector('#animation-dock'),
			timeline: !!document.querySelector('#animation-timeline'),
			navigator: !!document.querySelector('#animation-navigator'),
			deck: !!document.getElementById('animation-play'),
			keys: ap.activeClip(id).tracks[0].keys.length
		};
	}, uuid);
	h.check(survived.keys === 4, `four keys, two of them at the same time (${survived.keys})`);
	h.check(survived.dock && survived.timeline, 'the pane still renders with two keys on one time');
	h.check(survived.navigator && survived.deck, 'navigator and transport included');
	h.check(
		h.pageErrors(A).length === 0,
		`and the page threw nothing (${h.pageErrors(A).slice(0, 1).join('') || 'clean'})`
	);

	// closing and reopening it must work too — that is the actual reported symptom
	await A.page.evaluate(() => window.__stores.animationClose.set(true));
	await A.page.waitForTimeout(250);
	const closed = await A.page.evaluate(() => !document.querySelector('#animation-dock'));
	await A.page.evaluate(() => {
		window.__stores.animationClose.set(false);
		window.__stores.bottomDock.activateDock('animation');
	});
	await A.page.waitForTimeout(500);
	const reopened = await A.page.evaluate(() => ({
		dock: !!document.querySelector('#animation-dock'),
		timeline: !!document.querySelector('#animation-timeline')
	}));
	h.check(closed, 'the pane closes');
	h.check(reopened.dock && reopened.timeline, 'and OPENS AGAIN');

	await h.finish(browser);
});
