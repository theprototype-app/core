// VR sleeve palette (K1+K2), headless. No XR session runs here, so the suite
// drives the exported math/state seams with synthetic controller poses:
// strip structure (6 named ghosts, slot pitch), toggle gating (default OFF),
// ghost → create round-trip (held preview scales via stick, release creates a
// replicated primitive as ONE undo batch with grid/surface snap applied),
// navigation-suppression + trailing-select swallow predicates, and the K2
// custom slots (grip-drop capture with pose restore, idb persistence across a
// reload, ghost row + clear chips, spawn via the replicated prefab path, the
// 8-slot cap). On-device feel (strip placement on the forearm, grab
// ergonomics) is the user's manual check.
const h = require('./helpers.cjs');

const count = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g ? g.children.length : 0))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// capture every broadcast type
	await A.page.evaluate(() => {
		window.__sent = [];
		let peerRef;
		window.__stores.peers.subscribe((p) => (peerRef = p))();
		const orig = peerRef.send.bind(peerRef);
		peerRef.send = (data) => {
			window.__sent.push(data?.type);
			return orig(data);
		};
	});

	// idb slots persist across runs — start from a clean sleeve
	await A.page.evaluate(async () => {
		const lib = window.__stores.vrSleeve;
		await lib.loadSleeveSlots();
		let slots;
		lib.sleeveSlots.subscribe((s) => (slots = [...s]))();
		for (const slot of slots) lib.clearSlot(slot.id);
	});

	// ---- structure: 6 ghost primitives, wrist -> elbow spacing ----------------------
	const structure = await A.page.evaluate(() => {
		const lib = window.__stores.vrSleeve;
		const group = lib.ensureSleeveGroup();
		const ghosts = group.children.filter((c) => c.name.startsWith('vrsleeve-') && c.userData.sleeveKind);
		return {
			names: ghosts.map((g) => g.name),
			zs: ghosts.map((g) => Math.round(g.position.z * 1000) / 1000),
			pitch: lib.SLEEVE_SLOT_PITCH
		};
	});
	h.check(structure.names.length === 6, 'sleeve has 6 primitive ghosts (' + structure.names.join(',') + ')');
	h.check(
		['Box', 'Wedge', 'Stairs', 'Sphere', 'Cylinder', 'Torus'].every((k) => structure.names.includes('vrsleeve-' + k)),
		'ghosts are named vrsleeve-<kind>'
	);
	const pitchOk = structure.zs.every(
		(z, i) => i === 0 || Math.abs(z - structure.zs[i - 1] - structure.pitch) < 1e-6
	);
	h.check(pitchOk, 'slots are spaced by the strip pitch (' + structure.zs.join(', ') + ')');

	// ---- gating: default OFF refuses a hold ------------------------------------------
	const refusedOff = await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		return window.__stores.vrSleeve.beginHoldEntry(
			{ kind: 'Box' },
			{ position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
		);
	});
	h.check(refusedOff === false, 'hold refused while the sleeve toggle is OFF (default)');

	await A.page.evaluate(() => {
		window.__stores.vrSleeveEnabled.set(true);
		localStorage.setItem('vrSleeveEnabled', 'true'); // survives the reload below
	});

	// ---- K1: ghost -> create round-trip (grid snap + one undo batch) ------------------
	await A.page.evaluate(() => {
		window.__stores.snapping.snapEnabled.set(true);
		window.__stores.snapping.snapSettings.update((s) => ({ ...s, translate: 0.5 }));
		window.__stores.vrSnapMode.set('grid');
	});
	const base0 = await count(A);
	const undoLen0 = await A.page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	);
	const placed = await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		const lib = window.__stores.vrSleeve;
		const pos = new THREE.Vector3(0.13, 1, 0);
		const quat = new THREE.Quaternion();
		if (!lib.beginHoldEntry({ kind: 'Box' }, { position: pos, quaternion: quat })) return { error: 'no hold' };
		const suppressed = window.__stores.vrControls.vrNavigationSuppressed();
		// 10 frames of stick-forward (-1) grows the preview ~1.219x
		for (let i = 0; i < 10; i++) lib.updateHeldPose(pos, quat, -1);
		const holding = lib.sleeveState().holding;
		const object = lib.releaseSleeveHold(true);
		return {
			suppressed,
			holdScale: holding?.scale,
			swallow: lib.vrSleeveSwallowSelect(),
			suppressedAfter: window.__stores.vrControls.vrNavigationSuppressed(),
			uuid: object?.uuid ?? null,
			position: object ? object.position.toArray() : null,
			scale: object ? object.scale.toArray() : null
		};
	});
	h.check(!!placed.uuid, 'release created an object');
	h.check(placed.suppressed === true, 'stick navigation suppressed while holding');
	h.check(placed.suppressedAfter === false, 'suppression released with the hold');
	h.check(placed.swallow === true, 'trailing select click is swallowed after the place');
	h.check(Math.abs((placed.holdScale ?? 0) - Math.pow(1.02, 10)) < 0.01, 'stick-Y scaled the preview (' + placed.holdScale + ')');
	// preview spawned 0.9m along -Z from (0.13, 1, 0) -> (0.13, 1, -0.9); grid rounds x/z by 0.5
	h.check(
		placed.position && placed.position[0] === 0 && Math.abs(placed.position[1] - 1) < 1e-6 && placed.position[2] === -1,
		'grid snap rounded the release position (' + JSON.stringify(placed.position) + ')'
	);
	h.check(Math.abs((placed.scale?.[0] ?? 0) - Math.pow(1.02, 10)) < 0.01, 'held scale applied to the created object');
	await h.eventually(() => count(A), (n) => n === base0 + 1, 'objectsGroup gained the primitive');
	const undoInfo = await A.page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r({ length: s.length, topKind: s[s.length - 1]?.kind }))())
	);
	h.check(undoInfo.length === undoLen0 + 1 && undoInfo.topKind === 'aibatch', 'create + transform committed as ONE undo batch');
	let sent = await A.page.evaluate(() => window.__sent);
	h.check(sent.includes('create') && sent.includes('move'), 'replicated create + final move broadcast');
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => count(A), (n) => n === base0, 'one undo reverted the placed primitive');

	// ---- K1: surface snap rests the release on scenery --------------------------------
	await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Box 4 0.2 4');
		window.__stores.vrSnapMode.set('surface');
	});
	await h.eventually(() => count(A), (n) => n === base0 + 1, 'ground platform created');
	const surfaced = await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		const lib = window.__stores.vrSleeve;
		const pos = new THREE.Vector3(0, 3.9, 0.9); // preview lands at (0, 3.9, 0) above the platform
		const quat = new THREE.Quaternion();
		lib.beginHoldEntry({ kind: 'Sphere' }, { position: pos, quaternion: quat });
		lib.updateHeldPose(pos, quat, 0);
		const object = lib.releaseSleeveHold(true);
		return object ? { y: object.position.y } : null;
	});
	h.check(!!surfaced && surfaced.y < 3 && surfaced.y > 0, 'surface snap dropped the release onto the platform (y=' + (surfaced && surfaced.y) + ')');
	await A.page.evaluate(() => {
		window.__stores.vrSnapMode.set('off');
		window.__stores.snapping.snapEnabled.set(false);
	});

	// ---- K2: grip-drop capture (pose restored, slot persisted) ------------------------
	const capture = await A.page.evaluate(() => {
		const lib = window.__stores.vrSleeve;
		let scene, group;
		window.__stores.globalScene.subscribe((s) => (scene = s))();
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		// the strip normally rides the controller — anchor it at the scene root here
		const strip = lib.ensureSleeveGroup();
		scene.add(strip);
		window.__stores.commandsHandler.sceneCommand('/create Box 1 1 1');
		const object = group.children[group.children.length - 1];
		// "dropped onto the strip": the carried object sits within capture range
		object.position.set(0, 0.02, 0.2);
		const before = { pos: [5, 0.5, 5], rot: [0, 0, 0, 'XYZ'], scale: [1, 1, 1] };
		const captured = lib.sleeveGripDrop(object, before);
		return {
			captured,
			restored: object.position.toArray(),
			slots: lib.sleeveState().slots.length,
			ghostNames: strip.children.filter((c) => c.userData.sleeveCustom).map((c) => c.name)
		};
	});
	h.check(capture.captured === true, 'grip-drop onto the strip captured a slot');
	h.check(JSON.stringify(capture.restored) === JSON.stringify([5, 0.5, 5]), 'captured object snapped back to its pre-grab pose');
	h.check(capture.slots === 1, 'one custom slot stored');
	h.check(
		capture.ghostNames.some((n) => n.startsWith('vrsleeve-slot:')) && capture.ghostNames.some((n) => n.startsWith('vrsleeve-clear:')),
		'custom ghost + clear chip rendered on the strip (' + capture.ghostNames.join(',') + ')'
	);
	// a grab NOT over the strip must fall through to the normal drop
	const missed = await A.page.evaluate(() => {
		const lib = window.__stores.vrSleeve;
		let group;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const object = group.children[group.children.length - 1];
		object.position.set(4, 1, 4);
		return lib.sleeveGripDrop(object, { pos: [0, 0, 0], rot: [0, 0, 0, 'XYZ'], scale: [1, 1, 1] });
	});
	h.check(missed === false, 'a drop away from the strip is NOT captured');

	// ---- K2: slots survive a reload (idb persistence) ---------------------------------
	// the capture's idb write is fire-and-forget — give it a beat to commit
	// before the reload aborts pending transactions
	await A.page.waitForTimeout(800);
	await h.freshReload(A);
	// the debug hook can bind a SECOND module instance on an HMR-churned dev
	// server (see freshReload docs) — loading explicitly is a no-op when the
	// instance already loaded at module registration
	await A.page.evaluate(() => window.__stores.vrSleeve.loadSleeveSlots());
	await h.eventually(
		() => A.page.evaluate(() => (window.__stores.vrSleeve ? window.__stores.vrSleeve.sleeveState().slots.length : -1)),
		(n) => n === 1,
		'custom slot persisted across a reload (idb)'
	);
	await A.page.evaluate(() => {
		window.__sent = [];
		let peerRef;
		window.__stores.peers.subscribe((p) => (peerRef = p))();
		const orig = peerRef.send.bind(peerRef);
		peerRef.send = (data) => {
			window.__sent.push(data?.type);
			return orig(data);
		};
	});

	// ---- K2: slot spawn = replicated prefab instantiate at the release pose -----------
	const baseSpawn = await count(A);
	const spawned = await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		const lib = window.__stores.vrSleeve;
		let slot;
		lib.sleeveSlots.subscribe((s) => (slot = s[0]))();
		const pos = new THREE.Vector3(2, 1.5, 2);
		const quat = new THREE.Quaternion();
		if (!lib.beginHoldEntry({ slot }, { position: pos, quaternion: quat })) return null;
		lib.updateHeldPose(pos, quat, 0);
		const object = lib.releaseSleeveHold(true);
		return object ? { name: object.name, position: object.position.toArray() } : null;
	});
	h.check(!!spawned, 'slot ghost spawned an instance');
	await h.eventually(() => count(A), (n) => n === baseSpawn + 1, 'objectsGroup gained the prefab instance');
	sent = await A.page.evaluate(() => window.__sent);
	h.check(sent.includes('object'), 'prefab instance replicated (object message)');
	h.check(
		!!spawned && Math.abs(spawned.position[0] - 2) < 1e-6 && Math.abs(spawned.position[2] - (2 - 0.9)) < 1e-6,
		'instance landed at the release pose (' + JSON.stringify(spawned && spawned.position) + ')'
	);

	// ---- K2: clear chip + the 8-slot cap ----------------------------------------------
	const cleared = await A.page.evaluate(() => {
		const lib = window.__stores.vrSleeve;
		let slot;
		lib.sleeveSlots.subscribe((s) => (slot = s[0]))();
		lib.clearSlot(slot.id);
		return lib.sleeveState().slots.length;
	});
	h.check(cleared === 0, 'clear chip removes the slot');
	const capped = await A.page.evaluate(() => {
		const THREE = window.__stores.THREE;
		const lib = window.__stores.vrSleeve;
		const dummy = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial());
		dummy.name = 'CapTest';
		let filled = 0;
		for (let i = 0; i < lib.SLEEVE_MAX_SLOTS; i++) if (lib.captureSlotFromObject(dummy)) filled++;
		const overflow = lib.captureSlotFromObject(dummy);
		return { filled, overflow, slots: lib.sleeveState().slots.length };
	});
	h.check(capped.filled === 8 && capped.overflow === false && capped.slots === 8, 'slot cap enforced at 8 (' + JSON.stringify(capped) + ')');

	await h.finish(browser);
});
