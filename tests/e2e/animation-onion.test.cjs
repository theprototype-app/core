// 17-E F6 — ONION SKIN: faint copies of the object at the neighbouring keys.
//
// A working aid, so it is LOCAL in every sense: the ghosts are SCENE-ROOT clones
// (golden rule 5 — as children of the object they would ride the GLTF sync and
// duplicate on every peer), nothing about them replicates, and nothing reaches a
// save. Off by default.
//
// The checks that matter are the ones about where the ghosts LIVE and what they
// are POSED to, because those are the two ways this feature could quietly corrupt a
// scene rather than just look wrong.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.onionSkin, { timeout: 20000 });

	// a box that travels 0 -> 4 on x across three keys
	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.name = 'Slider';
		obj.position.set(0, 0, 0);
		obj.updateMatrix();
		const ap = s.animationPreview;
		const t = ap.addTrack(obj.uuid, 'pos.x', obj);
		ap.updateKey(obj.uuid, t, 0, { t: 0, v: 0 });
		ap.updateKey(obj.uuid, t, 1, { t: 1, v: 2 });
		ap.addKey(obj.uuid, t, 2, 4);
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		s.objectActions.selectObject(obj.uuid, false);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		await new Promise((r) => setTimeout(r, 700));
		return obj.uuid;
	});

	const ghosts = () => A.page.evaluate(() => window.__stores.onionSkin.onionSkinDebug());
	/** the ghost meshes as the SCENE sees them: name, parent, and world x */
	const sceneGhosts = () =>
		A.page.evaluate(() => {
			let scene;
			window.__stores.globalScene.subscribe((/** @type {any} */ s) => (scene = s))();
			let group;
			window.__stores.objectsGroup.subscribe((/** @type {any} */ g) => (group = g))();
			/** @type {any[]} */
			const found = [];
			scene.traverse((/** @type {any} */ n) => {
				if (n.name === 'onion-ghost') {
					n.updateMatrixWorld(true);
					found.push({
						x: n.matrixWorld.elements[12],
						opacity: n.material?.opacity ?? null,
						colour: n.material?.color?.getHex?.() ?? null,
						depthWrite: n.material?.depthWrite ?? null,
						// is it anywhere under objectsGroup? that is the thing that must
						// never be true
						inObjectsGroup: (() => {
							let p = n.parent;
							while (p) {
								if (p === group) return true;
								p = p.parent;
							}
							return false;
						})(),
						rootName: (() => {
							let p = n.parent;
							let last = '';
							while (p) {
								last = p.name || last;
								p = p.parent;
							}
							return last;
						})()
					});
				}
			});
			return found;
		});

	// ---------- 1. off by default ----------
	const initial = await ghosts();
	h.check(initial.on === false, `onion skin is OFF by default (${initial.on})`);
	h.check(initial.ghosts.length === 0, `so nothing is drawn (${initial.ghosts.length})`);
	const toggle = await A.page.evaluate(() => {
		const b = document.getElementById('animation-onion');
		return { there: !!b, pressed: b?.getAttribute('aria-pressed') };
	});
	h.check(toggle.there, 'the pane offers a toggle for it');
	h.check(toggle.pressed === 'false', `which reads as off (${toggle.pressed})`);

	// ---------- 2. turning it on draws the two NEIGHBOURING keys ----------
	await A.page.evaluate((id) => window.__stores.animationPreview.scrub(id, 0.5), uuid);
	await A.page.waitForTimeout(200);
	await A.page.locator('#animation-onion').click();
	await A.page.waitForTimeout(600); // a frame or two of the scene loop
	const on = await ghosts();
	h.check(on.on === true, 'the toggle turns it on');
	h.check(
		on.ghosts.length === 2,
		`at 0.5s of keys 0/1/2 it draws the key either side (${on.ghosts.length}: ${on.ghosts.map((/** @type {any} */ g) => g.when).join(', ')})`
	);
	h.check(
		on.ghosts.some((/** @type {any} */ g) => Math.abs(g.when - 0) < 1e-6) &&
			on.ghosts.some((/** @type {any} */ g) => Math.abs(g.when - 1) < 1e-6),
		`and they are the PREVIOUS and NEXT key, not the far one (${on.ghosts.map((/** @type {any} */ g) => g.when).join(', ')})`
	);
	h.check(
		on.ghosts[0].colour !== on.ghosts[1].colour,
		'past and future are told apart by colour'
	);

	// ---------- 3. they live at the SCENE ROOT, never in objectsGroup ----------
	const inScene = await sceneGhosts();
	h.check(inScene.length === 2, `both ghosts are really in the scene (${inScene.length})`);
	h.check(
		inScene.every((/** @type {any} */ g) => g.inObjectsGroup === false),
		'and NONE of them is under objectsGroup, so they cannot ride the GLTF sync'
	);
	h.check(
		inScene.every((/** @type {any} */ g) => g.opacity < 0.5 && g.depthWrite === true),
		`each is faint and still depth-WRITING (opacity ${inScene[0].opacity}, depthWrite ${inScene[0].depthWrite})`
	);

	// ---------- 4. posed at their key, not at the object ----------
	// the real object sits at x=1 (half way to key 1); the ghosts belong at 0 and 2
	const posed = await A.page.evaluate((id) => {
		let g;
		window.__stores.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		return g.getObjectByProperty('uuid', id).position.x;
	}, uuid);
	const xs = inScene.map((/** @type {any} */ g) => g.x).sort((a, b) => a - b);
	h.check(
		Math.abs(posed - 1) < 0.05,
		`the object itself is posed at the playhead (x=${posed.toFixed(2)})`
	);
	h.check(
		Math.abs(xs[0] - 0) < 0.05 && Math.abs(xs[1] - 2) < 0.05,
		`and the ghosts sit at their own keys' values (${xs.map((/** @type {number} */ n) => n.toFixed(2)).join(', ')})`
	);

	// ---------- 5. they FOLLOW the playhead ----------
	await A.page.evaluate((id) => window.__stores.animationPreview.scrub(id, 1.5), uuid);
	await A.page.waitForTimeout(600);
	const moved = await ghosts();
	h.check(
		moved.ghosts.some((/** @type {any} */ g) => Math.abs(g.when - 1) < 1e-6) &&
			moved.ghosts.some((/** @type {any} */ g) => Math.abs(g.when - 2) < 1e-6),
		`scrubbing past a key re-brackets them (${moved.ghosts.map((/** @type {any} */ g) => g.when).join(', ')})`
	);

	// ---------- 6. nothing about them reaches a SAVE ----------
	const saved = await A.page.evaluate(async () => {
		const payload = await window.__stores.sessions.saveSession('onion-check');
		const names = payload.objects
			.map((/** @type {any} */ o) => o.object ?? o)
			.map((/** @type {any} */ o) => o.name ?? '');
		return { count: payload.objects.length, ghostNames: names.filter((/** @type {string} */ n) => n === 'onion-ghost') };
	});
	h.check(
		saved.ghostNames.length === 0,
		`a save carries no ghosts (${saved.ghostNames.length} of ${saved.count} objects)`
	);

	// ---------- 7. and none of it goes on the WIRE ----------
	// Spied on the send channel rather than through a second peer: this box cannot
	// reach a signaling server, and the property being asserted is send-side anyway —
	// no ghost, and no pref, may ever leave this browser.
	const sent = await A.page.evaluate(async () => {
		/** @type {string[]} */
		const types = [];
		let peer;
		window.__stores.peers.subscribe((/** @type {any} */ p) => (peer = p))();
		const original = peer.send.bind(peer);
		peer.send = (/** @type {any} */ msg) => {
			types.push(msg?.type ?? '?');
			return original(msg);
		};
		const onion = window.__stores.onionSkin;
		// off, then on again: both edges, plus many frames of the per-frame update
		onion.setOnionSkin(false);
		await new Promise((r) => setTimeout(r, 500));
		onion.setOnionSkin(true);
		await new Promise((r) => setTimeout(r, 900));
		peer.send = original;
		return types;
	});
	h.check(
		sent.length === 0,
		`toggling and running onion skin sends NOTHING (${sent.length ? sent.join(', ') : 'silent'})`
	);

	// ---------- 8. turning it off takes them away ----------
	await A.page.locator('#animation-onion').click();
	await A.page.waitForTimeout(600);
	const off = await ghosts();
	const offScene = await sceneGhosts();
	h.check(off.on === false && off.ghosts.length === 0, `the toggle turns it off again (${off.ghosts.length})`);
	h.check(offScene.length === 0, `and the clones leave the scene (${offScene.length})`);

	// the object itself must be untouched by any of it
	const finalX = await A.page.evaluate((id) => {
		let g;
		window.__stores.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		return { x: obj.position.x, opacity: obj.material?.opacity ?? 1 };
	}, uuid);
	h.check(
		Math.abs(finalX.x - 3) < 0.1 && finalX.opacity === 1,
		`the real object is unharmed by the ghosts (x=${finalX.x.toFixed(2)}, opacity ${finalX.opacity})`
	);

	await h.finish(browser);
});
