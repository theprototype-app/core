// 33 P2 (contract P2): ANIMATED, FUNCTIONAL PACK ITEMS. A door placed from a pack is STILL
// (nothing autoplays on placement, on load or in Edit), opens on a click in Interact, its
// leaf collider follows the swing so the walker capsule passes an open door and is stopped
// by a shut one, every peer sees the same state (a late joiner too), Edit keeps the closed
// pose, and the Animation panel previews a clip locally without touching the shared state.
// The door is tests/e2e/fixtures/test-door.glb (gltf-transform: a one-piece frame + a
// hinged `Leaf` + idle/open/close clips), served as a routed pack so the Explorer path —
// badge, double-click place — is the real one.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const DOOR_GLB = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-door.glb'));
const PACK = 'https://anim-pack.invalid';
const DOOR_BEHAVIOR = { type: 'door', clip: 'open', closeClip: 'close', trigger: 'click', autoplay: false, sound: 'door', collider: 'follow' };

/** route the test pack: an item list with one door, and its glb @param {any} page */
async function routePack(page) {
	await page.route(PACK + '/**', (route) => {
		const url = route.request().url();
		if (url.endsWith('/default.json'))
			return route.fulfill({
				contentType: 'application/json',
				body: JSON.stringify([
					{ name: 'TestDoor', label: 'Test door', variants: { 'glTF-Binary': 'TestDoor.glb' }, behavior: DOOR_BEHAVIOR },
					{ name: 'PlainCrate', label: 'Plain crate', variants: { 'glTF-Binary': 'TestDoor.glb' } }
				])
			});
		if (url.endsWith('.glb')) return route.fulfill({ contentType: 'model/gltf-binary', body: DOOR_GLB });
		return route.fulfill({ status: 404, body: '' });
	});
}

/** the door's live numbers on a page @param {any} page */
const doorOf = (page) =>
	page.evaluate(() => {
		const s = window.__stores;
		const dbg = s.packBehavior.packBehaviorDebug();
		const item = dbg.items[0];
		if (!item) return null;
		let root = null;
		s.objectsGroup.subscribe((g) => (root = g?.getObjectByProperty('uuid', item.uuid)))();
		const leaf = root?.getObjectByName('Leaf');
		return {
			uuid: item.uuid,
			name: root?.name,
			state: item.state,
			spec: item.spec,
			qy: leaf ? leaf.quaternion.y : null,
			pos: root ? root.position.toArray() : null,
			physics: item.physics,
			colliders: dbg.colliders.length,
			sounds: dbg.sounds,
			triggers: dbg.triggers,
			preview: item.preview
		};
	});

const OPEN_QY = -Math.SQRT1_2; // -90 deg about Y

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await routePack(A.page);
	await h.connect(B, A);

	console.log('\n=== 1. the pack row carries the spec; the Explorer badges it ===');
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(800);
	await A.page.evaluate((base) => {
		const s = window.__stores;
		s.packs.packs.update((list) => [
			...list.filter((p) => p.name !== 'anim-test'),
			{ name: 'anim-test', title: 'Anim test', source: 'default', base, listUrl: base + '/default.json', zip: '', attributionUrl: '', sourceUrl: '', copyright: '', license: 'CC0-1.0' }
		]);
	}, PACK);
	await A.page.locator('#packs-folder').dblclick();
	await A.page.waitForTimeout(300);
	await A.page.locator('#explorer-list [data-pack="anim-test"]').click();
	await h.eventually(
		() => A.page.locator('#explorer-list .explorer-card').count(),
		(n) => n === 2,
		'1.1 the routed pack lists its two items'
	);
	const badges = await A.page.evaluate(() =>
		[...document.querySelectorAll('#explorer-list .explorer-card')].map((c) => ({
			text: c.textContent.trim(),
			badge: c.querySelector('.explorer-animated')?.getAttribute('data-behavior') ?? null,
			title: c.querySelector('.explorer-animated')?.getAttribute('title') ?? ''
		}))
	);
	const doorCard = badges.find((b) => /TestDoor/.test(b.text));
	const crateCard = badges.find((b) => /PlainCrate/.test(b.text));
	h.check(doorCard?.badge === 'door', '1.2 the door card wears the "animated" badge (' + JSON.stringify(doorCard) + ')');
	h.check(/opens and closes on a click/.test(doorCard?.title ?? ''), '1.3 the badge says what it does and what sets it off');
	h.check(crateCard && crateCard.badge === null, '1.4 a plain item has no badge');

	console.log('\n=== 2. placed from the Explorer: still, and nothing plays ===');
	await A.page.locator('#explorer-list .explorer-card', { hasText: 'TestDoor' }).dblclick();
	await h.eventually(() => doorOf(A.page), (d) => !!d?.uuid, '2.1 double-click places the door (the real pack path)', 15000);
	let door = await doorOf(A.page);
	h.check(door.spec?.type === 'door' && door.spec?.collider === 'follow', '2.2 the placed root carries the spec from the pack row');
	const animState = await A.page.evaluate((uuid) => {
		let st = null;
		window.__stores.animatedImports.animatedObjects.subscribe((m) => (st = m[uuid]))();
		return st;
	}, door.uuid);
	h.check(animState && animState.playing === false, '2.3 the transport is NOT playing after placement (' + JSON.stringify(animState) + ')');
	const q0 = door.qy;
	await A.page.waitForTimeout(800);
	door = await doorOf(A.page);
	h.check(Math.abs(q0) < 1e-4 && Math.abs(door.qy) < 1e-4, '2.4 the leaf is shut and stays shut (qy ' + q0 + ' -> ' + door.qy + ')');
	h.check(door.state === null, '2.5 no shared state until something triggers it');
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		let root = null;
		s.objectsGroup.subscribe((g) => (root = g?.getObjectByProperty('uuid', uuid)))();
		root.position.set(0, 0, -3);
		root.updateMatrixWorld(true);
		s.peers.subscribe((p) => p.send({ type: 'move', uuid, pos: [0, 0, -3], rot: [0, 0, 0, 'XYZ'], scale: [1, 1, 1] }))();
	}, door.uuid);
	await h.eventually(() => doorOf(B.page), (d) => d?.uuid === door.uuid && Math.abs(d.pos[2] + 3) < 1e-3, '2.6 B received the door (objectfile + the move)', 15000);
	h.check((await doorOf(B.page)).spec?.type === 'door', '2.7 the spec rode the objectfile to B');

	console.log('\n=== 3. the frame collider has the doorway cut out ===');
	door = await doorOf(A.page);
	const pieces = door.physics?.colliderPieces?.length ?? 0;
	h.check(door.physics?.collider === 'custom' && pieces >= 3, '3.1 the frame is a custom compound of ' + pieces + ' slabs');
	const opening = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		let root = null;
		s.objectsGroup.subscribe((g) => (root = g?.getObjectByProperty('uuid', uuid)))();
		const v = root.userData.physics.colliderVerts;
		const bad = [];
		for (const [start, count] of root.userData.physics.colliderPieces) {
			let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
			for (let i = start; i < start + count; i += 3) {
				minx = Math.min(minx, v[i]); maxx = Math.max(maxx, v[i]);
				miny = Math.min(miny, v[i + 1]); maxy = Math.max(maxy, v[i + 1]);
			}
			// anything spanning the doorway's middle below the lintel blocks it
			if (minx < 0 && maxx > 0 && miny < 1 && maxy > 1) bad.push([minx, maxx, miny, maxy]);
		}
		return bad;
	}, door.uuid);
	h.check(opening.length === 0, '3.2 no frame slab crosses the doorway (' + JSON.stringify(opening) + ')');

	console.log('\n=== 4. Edit: a click selects, never opens ===');
	const editClick = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		let root = null;
		s.objectsGroup.subscribe((g) => (root = g?.getObjectByProperty('uuid', uuid)))();
		return s.moduleSDK.runClickHandlers(root.getObjectByName('Leaf'), 'edit');
	}, door.uuid);
	h.check(editClick === false && (await doorOf(A.page)).state === null, '4.1 the click handler stands down in Edit');

	console.log('\n=== 5. Interact: a REAL click opens it, with its sound ===');
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject?.());
	await A.page.waitForTimeout(300);
	const pt = await h.projectPoint(A.page, [0.2, 1.2, -3]);
	const under = await A.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, pt);
	h.check(under === 'CANVAS', '5.1 the aim point is the viewport (' + under + ')');
	// once open, the leaf swings OUT of that point: later toggles aim at the right POST,
	// which belongs to the same functional root
	const framePt = await h.projectPoint(A.page, [0.58, 1.2, -3]);
	const soundsBefore = door.sounds;
	await A.page.mouse.click(pt.x, pt.y);
	await h.eventually(() => doorOf(A.page), (d) => d?.state?.on === true, '5.2 the click opened it (state on)');
	await h.eventually(() => doorOf(A.page), (d) => Math.abs(d.qy - OPEN_QY) < 0.01, '5.3 the leaf swung to 90 degrees on A');
	h.check((await doorOf(A.page)).sounds > soundsBefore, '5.4 the door sound played');

	console.log('\n=== 6. B sees it open (in Interact) and shut (in Edit) ===');
	await h.eventually(() => doorOf(B.page), (d) => d?.state?.on === true, '6.1 the state reached B');
	await B.page.waitForTimeout(1300);
	h.check(Math.abs((await doorOf(B.page)).qy) < 1e-4, '6.2 B in EDIT renders the closed pose (the rule)');
	await B.page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await h.eventually(() => doorOf(B.page), (d) => Math.abs(d.qy - OPEN_QY) < 0.01, '6.3 B in Interact shows it open');

	console.log('\n=== 7. the leaf collider follows: open passes, shut stops ===');
	// THE FALLBACK GUARD: with nothing dynamic, a sim start simulates the (sticky) selected
	// object — which used to be the door just placed, so it fell and every click carried it
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.objectActions.selectObject(uuid);
		s.objectActions.deselectObject(); // selectedObject stays the door (sticky)
	}, door.uuid);
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await A.page.waitForTimeout(1500);
	const fallback = await A.page.evaluate((uuid) => {
		const p = window.__stores.physics;
		const running = !!p.physicsRuntime();
		const dynamicDoor = running && p.physicsDebug().some((b) => b.uuid === uuid);
		if (running) p.stopSimulation();
		return { running, dynamicDoor };
	}, door.uuid);
	h.check(!fallback.dynamicDoor, '7.0a a sim start never makes the functional door the fallback dynamic body (' + JSON.stringify(fallback) + ')');
	// a real dynamic body elsewhere, so a simulation runs
	const crate = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 800));
		let g = null;
		s.objectsGroup.subscribe((v) => (g = v))();
		const box = [...g.children].reverse().find((c) => c.isMesh && !c.userData.behavior);
		box.position.set(6, 3, 6);
		box.updateMatrixWorld(true);
		s.physics.setPhysicsFor(box.uuid, { mode: 'dynamic', mass: 1 });
		s.objectActions.deselectObject();
		return box.uuid;
	});
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(() => A.page.evaluate(() => !!window.__stores.physics.physicsRuntime()), (v) => v, '7.0 a simulation runs on A', 15000);
	const bodies = await A.page.evaluate(() => {
		const p = window.__stores.physics;
		return {
			dynamic: p.physicsDebug().map((b) => b.uuid),
			fixed: p.physicsWorldDebug().fixed.find((f) => f.name === 'TestDoor') ?? null
		};
	});
	h.check(
		!bodies.dynamic.includes(door.uuid) && bodies.fixed && bodies.fixed.colliders >= 3,
		'7.0b the door is a FIXED body of frame slabs, never the fallback dynamic one (' + JSON.stringify({ crate: bodies.dynamic.includes(crate), fixed: bodies.fixed }) + ')'
	);
	await A.page.waitForTimeout(400);
	/** walk the capsule from in front of the door straight through the doorway */
	const walk = () =>
		A.page.evaluate(() => {
			const cc = window.__stores.charController;
			cc.resetWalker();
			let p = { x: 0, y: 0.05, z: -1.4 };
			let source = '';
			for (let i = 0; i < 90; i++) {
				const r = cc.resolveWalk(p, 1.7, 1 / 60, { dx: 0, dz: -0.05 }, { gravity: false });
				p = { x: p.x + r.dx, y: r.feet, z: p.z + r.dz };
				source = r.source;
			}
			return { z: p.z, source };
		});
	h.check((await doorOf(A.page)).colliders === 1, '7.1 one kinematic leaf collider follows the Leaf node');
	// charController primes its physics import LAZILY on the first call, so the very first
	// walk resolves on the plane tier — prime it, then measure
	await walk();
	await A.page.waitForTimeout(300);
	let w = await walk();
	h.check(w.source === 'rapier' && w.z < -4, '7.2 OPEN: the capsule walks through the doorway (z ' + w.z.toFixed(2) + ', ' + w.source + ')');
	await A.page.mouse.click(framePt.x, framePt.y); // shut it — a click on the frame toggles the same root
	await h.eventually(() => doorOf(A.page), (d) => d?.state?.on === false, '7.3 a second click shuts it');
	await h.eventually(() => doorOf(A.page), (d) => Math.abs(d.qy) < 0.01, '7.4 the leaf swung back');
	await A.page.waitForTimeout(200);
	w = await walk();
	h.check(w.z > -2.9, '7.5 SHUT: the leaf stops the capsule (z ' + w.z.toFixed(2) + ')');
	// counterfactual: the whole-door box (no doorway cut) blocks even an OPEN door
	const diagBefore = await A.page.evaluate(({ x, y }) => ({ under: document.elementFromPoint(x, y)?.tagName, dbg: window.__stores.packBehavior.packBehaviorDebug().clicks }), framePt);
	await A.page.mouse.click(framePt.x, framePt.y);
	await A.page.waitForTimeout(300);
	const diag = await A.page.evaluate(() => {
		const d = window.__stores.packBehavior.packBehaviorDebug();
		let pi = null;
		window.__stores.playInteract.playInteractState?.subscribe?.((v) => (pi = v))();
		return { clicks: d.clicks, lastClick: d.lastClick, state: d.items[0]?.state, pi };
	});
	console.log('   7.6 diagnosis: before ' + JSON.stringify(diagBefore) + ' after ' + JSON.stringify(diag));
	await h.eventually(() => doorOf(A.page), (d) => Math.abs(d.qy - OPEN_QY) < 0.01, '7.6 reopened');
	await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		s.physics.stopSimulation();
		let root = null;
		s.objectsGroup.subscribe((g) => (root = g?.getObjectByProperty('uuid', uuid)))();
		root.userData.__savedPhysics = root.userData.physics;
		delete root.userData.physics;
		await s.physics.toggleSimulation();
	}, door.uuid);
	await A.page.waitForTimeout(600);
	w = await walk();
	h.check(w.z > -2.9, '7.7 COUNTERFACTUAL: without the cut frame the open doorway is a wall (z ' + w.z.toFixed(2) + ')');
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.physics.stopSimulation();
		let root = null;
		s.objectsGroup.subscribe((g) => (root = g?.getObjectByProperty('uuid', uuid)))();
		root.userData.physics = root.userData.__savedPhysics;
		delete root.userData.__savedPhysics;
	}, door.uuid);

	console.log('\n=== 8. Edit keeps the closed pose; a save carries the spec, never the state ===');
	await A.page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await h.eventually(() => doorOf(A.page), (d) => Math.abs(d.qy) < 1e-4, '8.1 back in Edit the leaf rests shut while the shared state says open');
	h.check((await doorOf(A.page)).state?.on === true, '8.2 ...and the shared state is untouched');
	const saved = await A.page.evaluate(() => {
		const s = window.__stores;
		let g = null;
		s.objectsGroup.subscribe((v) => (g = v))();
		return s.animatedImports.animatedImportsSnapshot(g).map((e) => ({ behavior: e.behavior, state: e.behaviorState ?? null }));
	});
	h.check(saved.length === 1 && saved[0].behavior?.type === 'door' && saved[0].state === null, '8.3 the save entry has the spec and no open/shut state');

	console.log('\n=== 9. a late joiner gets the state with the door ===');
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(() => doorOf(C.page), (d) => d?.uuid === door.uuid && d.state?.on === true, '9.1 C holds the door, open, from the handshake', 20000);
	const [aState, cState] = [(await doorOf(A.page)).state, (await doorOf(C.page)).state];
	h.check(aState.at === cState.at && aState.n === cState.n, '9.2 C has the SAME stamp and count as A');
	h.check(Math.abs((await doorOf(C.page)).qy) < 1e-4, '9.3 C is in Edit, so it shows the door shut');

	console.log('\n=== 10. Animation panel preview: local, unsent, back to rest ===');
	const sent = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		let peer = null;
		s.peers.subscribe((p) => (peer = p))();
		const types = [];
		const orig = peer.send.bind(peer);
		peer.send = (msg) => (types.push(msg?.type), orig(msg));
		s.animatedImports.setAnimationState(uuid, { playing: true, clip: 'open' });
		let root = null;
		s.objectsGroup.subscribe((g) => (root = g?.getObjectByProperty('uuid', uuid)))();
		// sample the whole preview window (1 s clip + the hold): one instant read on a loaded
		// page can land before the first preview frame
		let mid = 0;
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 50));
			mid = Math.min(mid, root.getObjectByName('Leaf').quaternion.y);
		}
		peer.send = orig;
		return { types, mid };
	}, door.uuid);
	h.check(sent.mid < -0.2, '10.1 the preview moves the leaf in Edit (deepest qy ' + sent.mid.toFixed(3) + ')');
	h.check(!sent.types.includes('objectParameters') && !sent.types.includes('behavior'), '10.2 nothing was sent (' + JSON.stringify(sent.types) + ')');
	await h.eventually(() => doorOf(A.page), (d) => Math.abs(d.qy) < 1e-4 && !d.preview, '10.3 the preview hands the pose back to rest', 4000);
	h.check((await doorOf(A.page)).state?.n === aState.n, '10.4 the shared state did not change');

	console.log('\n=== 11. the wire shape is validated ===');
	const valid = await A.page.evaluate((uuid) => {
		const v = window.__stores.wireValidate.validateWireMessage;
		return {
			good: v({ type: 'behavior', uuid, on: true, at: 1, from: 0, n: 1 }),
			nan: v({ type: 'behavior', uuid, on: true, at: NaN, from: 0, n: 1 }),
			str: v({ type: 'behavior', uuid, on: 'yes', at: 1, from: 0, n: 1 }),
			neg: v({ type: 'behavior', uuid, on: true, at: 1, from: 0, n: -1 })
		};
	}, door.uuid);
	h.check(valid.good && !valid.nan && !valid.str && !valid.neg, '11.1 behavior: good passes, NaN/string/negative refused (' + JSON.stringify(valid) + ')');
	const stale = await B.page.evaluate((uuid) => window.__stores.packBehavior.applyBehaviorState({ uuid, on: false, at: 1, from: 0, n: 1 }), door.uuid);
	h.check(stale === false && (await doorOf(B.page)).state?.on === true, '11.2 an older state is refused (latest wins)');

	console.log('\n=== 12. a GLB with no behavior no longer autoplays ===');
	const plain = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const s = window.__stores;
				const THREE = s.THREE;
				const root = new THREE.Group();
				const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
				mesh.name = 'mover';
				root.add(mesh);
				const track = new THREE.VectorKeyframeTrack('mover.position', [0, 1, 2], [0, 0, 0, 2, 0, 0, 0, 0, 0]);
				new s.GLTFExporterModule.GLTFExporter().parse(
					root,
					async (buffer) => {
						const uuid = await s.fileHandler.importFile(new File([buffer], 'slide.glb'), 'Slider');
						let g = null;
						s.objectsGroup.subscribe((v) => (g = v))();
						const node = () => g.getObjectByProperty('uuid', uuid)?.getObjectByName('mover')?.position.x;
						const x1 = node();
						await new Promise((r) => setTimeout(r, 600));
						let st = null;
						s.animatedImports.animatedObjects.subscribe((m) => (st = m[uuid]))();
						resolve({ x1, x2: node(), playing: st?.playing, behavior: s.animatedImports.behaviorOf(uuid) });
					},
					() => resolve(null),
					{ binary: true, animations: [new THREE.AnimationClip('slide', 2, [track])] }
				);
			})
	);
	h.check(plain && plain.playing === false && plain.x1 === plain.x2, '12.1 placing an animated GLB plays nothing (' + JSON.stringify(plain) + ')');
	h.check(plain && plain.behavior === null, '12.2 ...and it is not a functional item');

	console.log('\n=== 13. the module seam: api.behavior ===');
	const sdk = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		await s.moduleSDK.initModules([
			{ id: 'behavior33', name: 'Behavior test', version: '1.0.0', description: '33 P2 seam', register(api) { window.__bapi = api; } }
		]);
		await new Promise((r) => setTimeout(r, 300));
		const api = window.__bapi;
		const list = api.behavior.list();
		const before = api.behavior.state(uuid);
		const changed = api.behavior.trigger(uuid, false);
		const again = api.behavior.trigger(uuid, false); // already shut: nothing to do
		return { list, before, changed, again, after: api.behavior.state(uuid) };
	}, door.uuid);
	h.check(sdk.list.length === 1 && sdk.list[0].type === 'door' && sdk.list[0].open === true, '13.1 api.behavior.list() names the open door (' + JSON.stringify(sdk.list) + ')');
	h.check(sdk.changed === true && sdk.again === false && sdk.after.on === false, '13.2 trigger(uuid, false) shuts it once and is a no-op after');
	await h.eventually(() => doorOf(B.page), (d) => d?.state?.on === false, '13.3 the module trigger replicated to B');

	console.log('\n=== 14. a knock door: a fast hand opens it, a slow one does not ===');
	const knock = await A.page.evaluate(async (bytes) => {
		const s = window.__stores;
		const behavior = { type: 'door', clip: 'open', closeClip: 'close', trigger: 'knock', sound: 'door' };
		const uuid = await s.fileHandler.importFile(new File([new Uint8Array(bytes)], 'knock.glb'), 'Knock door', 'glb', [3, 0, -3], undefined, { behavior });
		// a fake hand seam (no headset headless): the frame loop samples it every frame
		window.__hand = null;
		s.packBehavior.startPackBehaviors({ hands: (hand) => (hand === 'right' && window.__hand ? { position: window.__hand } : null) });
		const frames = (n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
		const stateOf = () => s.packBehavior.behaviorState(uuid);
		s.objectActions.setEditorMode('interact');
		// SLOW: creep in at ~1 mm per frame (~0.06 m/s) — touching is not knocking
		for (let z = -2.5; z >= -3.0; z -= 0.001) {
			window.__hand = [3, 1.2, z];
			await frames(1);
		}
		const slow = stateOf();
		window.__hand = [3, 1.2, -2.0];
		await frames(3);
		// FAST: out to in, in one frame
		window.__hand = [3, 1.2, -3.0];
		await frames(3);
		const fast = stateOf();
		window.__hand = null;
		s.packBehavior.startPackBehaviors({ hands: s.vrControls.handSnapshot });
		return { uuid, slow, fast, knocks: s.packBehavior.packBehaviorDebug().knocks };
	}, Array.from(DOOR_GLB));
	h.check(knock.slow === null, '14.1 a hand creeping into the door does not knock (' + JSON.stringify(knock.slow) + ')');
	h.check(knock.fast?.on === true && knock.knocks >= 1, '14.2 a hand arriving fast knocks it open (' + JSON.stringify(knock.fast) + ')');

	await h.finish(browser);
});
