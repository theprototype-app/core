// 17-E A6 — auto-key and the preset library.
//
// Auto-key is the difference between typing numbers into a key list and ANIMATING:
// arm it, park the playhead, pose the object, and the pose becomes keys. This
// drives it the way a user does — a REAL mouse drag on the REAL gizmo arrow — so
// the wiring in Scene's drag-end hook is covered, not just the store function.
//
// The presets are the other half of "make it possible to build a door": Door keys
// rot.y 0 -> 90 as a `once` clip, which the Play Animation node's toggle then
// opens and shuts, and it swings about the object's ORIGIN.
const h = require('./helpers.cjs');

/** screen point on the gizmo's +Y translate arrow (the real picker, not a guess) */
const arrowPoint = (page, axis) =>
	page.evaluate((name) => {
		let controls = null;
		let cam = null;
		window.__stores.TControls.subscribe((/** @type {any} */ v) => (controls = v))();
		window.__stores.globalCamera.subscribe((/** @type {any} */ v) => (cam = v))();
		const helper = controls?.getHelper?.() ?? controls;
		if (!helper || !cam) return null;
		let pick = null;
		helper.traverse((/** @type {any} */ n) => {
			if (!pick && n.isMesh && n.name === name) pick = n;
		});
		if (!pick) return null;
		const v = new window.__stores.THREE.Vector3();
		pick.getWorldPosition(v);
		v.project(cam);
		return [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
	}, axis);

const keysOf = (page, uuid) =>
	page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		const clip = ap.activeClip(id);
		return (clip?.tracks ?? []).map((/** @type {any} */ t) => ({
			channel: t.channel,
			keys: t.keys.map((/** @type {any} */ k) => [Math.round(k.t * 100) / 100, Math.round(k.v * 1000) / 1000])
		}));
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.animationPreview, { timeout: 20000 });

	// ---------- a movement to record into, with the object selected ----------
	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(0, 0, 0);
		obj.updateMatrix();
		s.objectActions.selectObject(obj.uuid, false);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		const ap = s.animationPreview;
		ap.addTrack(obj.uuid, 'pos.y', obj);
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		return obj.uuid;
	});
	await A.page.waitForTimeout(700);

	// ---------- the REC button arms it ----------
	const recBtn = A.page.locator('#animation-autokey');
	h.check(await recBtn.isVisible(), 'the Animation window offers an auto-key toggle');
	await recBtn.click();
	await A.page.waitForTimeout(200);
	const armed = await A.page.evaluate(
		(id) =>
			new Promise((r) =>
				window.__stores.animationPreview.autoKeyFor.subscribe((/** @type {any} */ v) => r(v === id))()
			),
		uuid
	);
	h.check(armed, 'clicking REC arms auto-key for the selected object');

	// ---------- park the playhead, then drag the object with the REAL gizmo ----------
	await A.page.evaluate((id) => window.__stores.animationPreview.scrub(id, 1), uuid);
	await A.page.waitForTimeout(300);
	const before = await keysOf(A.page, uuid);
	const point = await arrowPoint(A.page, 'Y');
	h.check(Array.isArray(point), `the gizmo's Y arrow is on screen (${JSON.stringify(point)})`);
	if (Array.isArray(point)) {
		await A.page.mouse.move(point[0], point[1]);
		await A.page.mouse.down();
		for (let i = 1; i <= 8; i++) await A.page.mouse.move(point[0], point[1] - i * 9, { steps: 2 });
		await A.page.mouse.up();
		await A.page.waitForTimeout(400);
	}
	const after = await keysOf(A.page, uuid);
	const posTrack = after.find((/** @type {any} */ t) => t.channel === 'pos.y');
	const added = (posTrack?.keys?.length ?? 0) - (before[0]?.keys?.length ?? 0);
	h.check(added === 1, `a gizmo drag at the playhead writes ONE key (${added} added)`);
	const atPlayhead = posTrack?.keys?.find((/** @type {any} */ k) => Math.abs(k[0] - 1) < 0.02);
	h.check(!!atPlayhead, `the key lands at the playhead (${JSON.stringify(posTrack?.keys)})`);
	h.check(
		!!atPlayhead && Math.abs(atPlayhead[1]) > 0.05,
		`and carries the pose the drag produced (y=${atPlayhead?.[1]})`
	);

	// dragging with auto-key OFF must NOT write keys — the guard, not a side effect
	await recBtn.click();
	await A.page.waitForTimeout(200);
	const beforeOff = await keysOf(A.page, uuid);
	const point2 = await arrowPoint(A.page, 'Y');
	if (Array.isArray(point2)) {
		await A.page.mouse.move(point2[0], point2[1]);
		await A.page.mouse.down();
		for (let i = 1; i <= 8; i++) await A.page.mouse.move(point2[0], point2[1] - i * 9, { steps: 2 });
		await A.page.mouse.up();
		await A.page.waitForTimeout(400);
	}
	const afterOff = await keysOf(A.page, uuid);
	h.check(
		JSON.stringify(beforeOff) === JSON.stringify(afterOff),
		'with REC off the same drag writes nothing'
	);

	// re-posing the SAME time replaces that key instead of stacking duplicates
	const replaced = await A.page.evaluate((id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		ap.setAutoKey(id);
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const track = ap.activeClip(id).tracks[0];
		const countBefore = track.keys.length;
		obj.position.y = 3.5;
		ap.captureAutoKey(id, 1);
		obj.position.y = 3.5; // unchanged: nothing to record the second time
		const second = ap.captureAutoKey(id, 1);
		const keys = ap.activeClip(id).tracks[0].keys;
		ap.setAutoKey(null);
		return {
			countBefore,
			countAfter: keys.length,
			value: keys.find((/** @type {any} */ k) => Math.abs(k.t - 1) < 0.02)?.v,
			second
		};
	}, uuid);
	h.check(
		replaced.countAfter === replaced.countBefore,
		`re-posing the same time replaces that key (${replaced.countBefore} -> ${replaced.countAfter})`
	);
	h.check(Math.abs(replaced.value - 3.5) < 1e-6, `with the new value (${replaced.value})`);
	h.check(replaced.second === 0, 'and an unchanged pose records nothing at all');

	// ---------- REC creates the channels you pose, not just the ones you listed ----
	// Auto-key used to update EXISTING tracks only, so recording a rotation onto a
	// clip that had only a position track silently did nothing.
	const created = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 350));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(0, 0, 0);
		obj.rotation.set(0, 0, 0);
		obj.scale.set(1, 1, 1);
		obj.updateMatrix();
		const material = Array.isArray(obj.material) ? obj.material[0] : obj.material;
		// a clip with ONE position channel
		ap.addTrack(obj.uuid, 'pos.y', obj);
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		ap.setAutoKey(obj.uuid); // arming takes the reference pose

		// now pose rotation, scale, visibility and the look, all at 1s
		obj.rotation.y = Math.PI / 4;
		obj.scale.set(1, 2, 1);
		obj.visible = false;
		material.opacity = 0.4;
		obj.updateMatrix();
		const written = ap.captureAutoKey(obj.uuid, 1);
		const clip = ap.activeClip(obj.uuid);
		const byChannel = {};
		for (const track of clip.tracks) {
			byChannel[track.channel] = track.keys.map((/** @type {any} */ k) => [
				Math.round(k.t * 100) / 100,
				Math.round(k.v * 1000) / 1000
			]);
		}
		ap.setAutoKey(null);
		ap.stop(obj.uuid);
		return { written, channels: Object.keys(byChannel).sort(), byChannel };
	});
	h.check(
		created.channels.includes('rot.y') && created.channels.includes('scale.y'),
		`REC creates a channel for anything you pose (${created.channels.join(', ')})`
	);
	h.check(
		created.channels.includes('visible') && created.channels.includes('opacity'),
		'including visibility and the look channels'
	);
	h.check(
		!created.channels.includes('pos.z') && !created.channels.includes('metalness'),
		'and nothing for the channels you did not touch'
	);
	h.check(
		JSON.stringify(created.byChannel['rot.y']?.[0]) === JSON.stringify([0, 0]),
		`a created channel opens with the pose it came FROM (${JSON.stringify(created.byChannel['rot.y'])})`
	);
	h.check(
		Math.abs((created.byChannel['rot.y']?.[1]?.[1] ?? 0) - 0.785) < 0.01,
		'and keys the new pose at the playhead'
	);

	// ---------- the presets ----------
	const presets = await A.page.evaluate(() => {
		const s = window.__stores;
		const ap = s.animationPreview;
		return Object.entries(ap.PRESETS).map(([kind, p]) => [kind, p.name, p.loop, p.tracks.length]);
	});
	h.check(presets.length >= 5, `a preset library ships (${presets.map((/** @type {any[]} */ p) => p[1]).join(', ')})`);

	const door = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create Box 1 2 0.1');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(0, 1, 0);
		obj.rotation.set(0, 0, 0);
		obj.updateMatrix();
		// no origin yet: the preset must SAY so instead of silently spinning in place
		const warned = ap.applyPreset('door', obj.uuid, obj);
		s.objectOrigin.setOriginFor(obj.uuid, [-0.5, 0, 0]);
		const quiet = ap.applyPreset('door', obj.uuid, obj);
		const clip = ap.activeClip(obj.uuid);
		return {
			uuid: obj.uuid,
			needsOriginFirst: warned?.needsOrigin,
			needsOriginAfter: quiet?.needsOrigin,
			name: clip.name,
			loop: clip.loop,
			channels: clip.tracks.map((/** @type {any} */ t) => t.channel),
			degrees: clip.tracks[0].keys.map((/** @type {any} */ k) => Math.round((k.v * 180) / Math.PI))
		};
	});
	h.check(door.name === 'Door' && door.loop === 'once', `the Door preset is a once-clip (${door.name}/${door.loop})`);
	h.check(
		door.channels.join() === 'rot.y' && door.degrees.join() === '0,90',
		`keying rot.y from 0 to 90 (${door.degrees.join(' -> ')})`
	);
	h.check(door.needsOriginFirst === true, 'it reports a missing hinge origin');
	h.check(door.needsOriginAfter === false, 'and stays quiet once the origin is placed');

	// a preset starts from where the object STANDS, not from the world origin
	const offset = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(0, 5, 0);
		obj.scale.set(2, 2, 2);
		obj.updateMatrix();
		ap.applyPreset('elevator', obj.uuid, obj);
		const lift = ap.activeClip(obj.uuid).tracks[0].keys.map((/** @type {any} */ k) => k.v);
		ap.applyPreset('pulse', obj.uuid, obj);
		const pulse = ap.activeClip(obj.uuid).tracks[0].keys.map((/** @type {any} */ k) => Math.round(k.v * 100) / 100);
		return { lift, pulse };
	});
	h.check(
		offset.lift[0] === 5 && offset.lift[1] === 8,
		`a transform preset starts where the object stands (${offset.lift.join(' -> ')})`
	);
	h.check(
		offset.pulse[0] === 2 && offset.pulse[1] > 2,
		`and a scale preset is relative to its own scale (${offset.pulse.join(' -> ')})`
	);

	// ---------- the door preset + the node = a working door ----------
	const swing = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		s.flowGraphsCtl.createObjectGraph(id);
		const nh = s.nodesHandler;
		nh.createFlowNode(
			{ id: 'dp-click', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } },
			id
		);
		nh.createFlowNode(
			{
				id: 'dp-play',
				type: 'playanim',
				position: { x: 220, y: 0 },
				data: { type: 'playanim', clip: 'Door', action: 'toggle', speed: 1 }
			},
			id
		);
		nh.createFlowEdge({ id: 'e-dp', source: 'dp-click', target: 'dp-play', targetHandle: 'trigger' }, id);
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		obj.updateMatrixWorld(true);
		const THREE = s.THREE;
		const hinge0 = obj.localToWorld(new THREE.Vector3(-0.5, 0, 0)).toArray();
		s.flowRuntime.fireObjectClick(id);
		await new Promise((r) => setTimeout(r, 1400));
		obj.updateMatrixWorld(true);
		const hinge1 = obj.localToWorld(new THREE.Vector3(-0.5, 0, 0)).toArray();
		return {
			deg: (obj.rotation.y * 180) / Math.PI,
			drift: Math.hypot(hinge0[0] - hinge1[0], hinge0[1] - hinge1[1], hinge0[2] - hinge1[2])
		};
	}, door.uuid);
	h.check(Math.abs(swing.deg - 90) < 1, `clicking the preset door opens it (${swing.deg.toFixed(1)}deg)`);
	h.check(swing.drift < 0.01, `about its hinge (drift ${swing.drift.toFixed(4)})`);

	await h.finish(browser);
});
