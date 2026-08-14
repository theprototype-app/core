// 17-E A2 — authored animation REPLICATES, deterministically.
//
// Authored movements were local-only by deliberate scope, which made them the one
// thing a user could build that nobody else in the room could see. They now travel
// as DATA (`animdata`, latest-wins per object) and playback as a synced-clock
// STAMP (`animplay`); each peer evaluates the same keys itself, so no pose is ever
// streamed. This suite proves the data arrives, the two peers stay in phase, a
// late joiner catches up through the handshake, and undo replicates.
const h = require('./helpers.cjs');

/** the authored state of one object as a peer sees it */
const readAnim = (page, uuid) =>
	page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		let map;
		ap.animations.subscribe((v) => (map = v))();
		let pb;
		ap.playback.subscribe((v) => (pb = v))();
		const set = map[id] ?? null;
		const clip = set ? (set.clips[set.active] ?? null) : null;
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		return {
			has: !!set,
			clipIds: Object.keys(set?.clips ?? {}),
			duration: clip?.duration ?? null,
			keys: clip?.tracks?.[0]?.keys?.map((/** @type {any} */ k) => [k.t, k.v]) ?? [],
			playing: !!pb[id]?.playing,
			y: obj ? obj.position.y : null,
			rotY: obj ? obj.rotation.y : null
		};
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);

	// ---------- A authors a movement ----------
	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(0, 0, 0);
		obj.updateMatrix();
		const ap = s.animationPreview;
		const track = ap.addTrack(obj.uuid, 'pos.y', obj);
		ap.updateKey(obj.uuid, track, 1, { t: 2, v: 4 });
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		return obj.uuid;
	});
	await A.page.waitForTimeout(1200);

	await h.eventually(
		() => readAnim(B.page, uuid),
		(r) => r.has && r.keys.length === 2 && Math.abs(r.keys[1][1] - 4) < 1e-6,
		'B receives the authored keys'
	);
	const bData = await readAnim(B.page, uuid);
	h.check(bData.duration === 2, `with the clip length (${bData.duration}s)`);

	// ---------- playing on A plays on B, IN PHASE ----------
	await A.page.evaluate((id) => window.__stores.animationPreview.play(id), uuid);
	await A.page.waitForTimeout(900);
	const [onA, onB] = await Promise.all([readAnim(A.page, uuid), readAnim(B.page, uuid)]);
	h.check(onA.playing && onB.playing, `both peers report it playing (A ${onA.playing}, B ${onB.playing})`);
	h.check(onA.y > 0.05 && onB.y > 0.05, `both are posed by their own runtime (A y=${onA.y?.toFixed(2)}, B y=${onB.y?.toFixed(2)})`);

	// Being "in phase" is the transport agreeing on the synced-clock STAMP, not two
	// samples read at the same wall-clock instant: reading a moving object over two
	// CDP calls skews by tens of ms, which is real motion (2 units/s here) and would
	// make the assertion a coin toss. Compare the stamps, then compare the POSE with
	// the clip paused — a paused clip holds one exact frame on every peer.
	const stamps = await Promise.all(
		[A, B].map((peer) =>
			peer.page.evaluate((id) => {
				let pb;
				window.__stores.animationPreview.playback.subscribe((v) => (pb = v))();
				const p = pb[id];
				return p ? { at: p.at, pausedAt: p.pausedAt, speed: p.speed, clipId: p.clipId } : null;
			}, uuid)
		)
	);
	h.check(
		!!stamps[0] && !!stamps[1] && stamps[0].at === stamps[1].at && stamps[0].pausedAt === stamps[1].pausedAt,
		`both evaluate from the same clock stamp (A at=${stamps[0]?.at}, B at=${stamps[1]?.at})`
	);
	h.check(
		stamps[0]?.speed === stamps[1]?.speed && stamps[0]?.clipId === stamps[1]?.clipId,
		'and the same clip and speed'
	);

	// nothing streams the pose — only the transport was sent
	const traffic = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const peer = await new Promise((r) => s.peers.subscribe(r)());
		const seen = [];
		const orig = peer.send.bind(peer);
		peer.send = (m) => {
			seen.push(m?.type);
			return orig(m);
		};
		await new Promise((r) => setTimeout(r, 1200));
		peer.send = orig;
		return { types: [...new Set(seen)], count: seen.length };
	}, uuid);
	h.check(
		!traffic.types.includes('move') && !traffic.types.includes('animdata'),
		`a running clip sends no per-frame traffic (${traffic.count} msg: ${traffic.types.join(',') || 'none'})`
	);

	// ---------- pause on B stops it on A, at the SAME frame ----------
	await B.page.evaluate((id) => window.__stores.animationPreview.pause(id), uuid);
	await B.page.waitForTimeout(900);
	const [pausedA, pausedB] = await Promise.all([readAnim(A.page, uuid), readAnim(B.page, uuid)]);
	h.check(!pausedA.playing && !pausedB.playing, 'either peer can pause it for everyone');
	h.check(
		pausedA.y > 0.05 && Math.abs(pausedA.y - pausedB.y) < 0.01,
		`and both hold the identical paused pose (A ${pausedA.y?.toFixed(4)} vs B ${pausedB.y?.toFixed(4)})`
	);

	// ---------- an edit on B reaches A (both directions) ----------
	await B.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		let map;
		ap.animations.subscribe((v) => (map = v))();
		const set = map[id];
		const track = set.clips[set.active].tracks[0];
		ap.updateKey(id, track.id, 1, { v: 9 });
	}, uuid);
	await h.eventually(
		() => readAnim(A.page, uuid),
		(r) => Math.abs(r.keys[1][1] - 9) < 1e-6,
		'an edit on B reaches A'
	);

	// ---------- undo on B is an edit like any other ----------
	await B.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(
		() => readAnim(A.page, uuid),
		(r) => Math.abs(r.keys[1][1] - 4) < 1e-6,
		'undo on B reverts the key on A too'
	);
	await B.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(
		() => readAnim(A.page, uuid),
		(r) => Math.abs(r.keys[1][1] - 9) < 1e-6,
		'and redo re-applies it'
	);

	// ---------- one undo entry per GESTURE ----------
	const gesture = await B.page.evaluate((id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let map;
		const read = () => {
			ap.animations.subscribe((v) => (map = v))();
			return map[id];
		};
		const set = read();
		const track = set.clips[set.active].tracks[0];
		const depth = () => {
			let stack = [];
			s.history.undoStack.subscribe((/** @type {any[]} */ v) => (stack = v))();
			return stack.length;
		};
		const before = depth();
		// a key drag: many store writes, ONE undoable step
		ap.beginAnimGesture(id, 'Drag key');
		for (let i = 1; i <= 12; i++) ap.updateKey(id, track.id, 1, { v: 9 + i * 0.1 });
		ap.endAnimGesture();
		const after = depth();
		const value = read().clips[set.active].tracks[0].keys[1].v;
		s.history.undo();
		const undone = read().clips[set.active].tracks[0].keys[1].v;
		return { before, after, value, undone };
	}, uuid);
	h.check(
		Math.abs(gesture.value - 10.2) < 1e-6,
		`a 12-write drag lands its final value (${gesture.value.toFixed(2)})`
	);
	h.check(
		Math.abs(gesture.undone - 9) < 1e-6,
		`and ONE undo reverts the whole drag (back to ${gesture.undone.toFixed(2)}, not 10.1)`
	);
	if (gesture.before !== null && gesture.after !== null) {
		h.check(gesture.after - gesture.before === 1, `the drag pushed exactly one entry (${gesture.after - gesture.before})`);
	}

	// ---------- a LATE JOINER catches up through the handshake ----------
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(
		() => readAnim(C.page, uuid),
		(r) => r.has && r.keys.length === 2,
		'a late joiner receives the authored animation (getanim)'
	);

	// and a door built on A opens on C, hinged on its origin
	const doorUuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(3, 0, 0);
		obj.rotation.set(0, 0, 0);
		obj.updateMatrix();
		// a direct pose write is local — replicate it the way the app's own move does
		const peer = await new Promise((r) => s.peers.subscribe(r)());
		peer?.send({
			type: 'move',
			uuid: obj.uuid,
			pos: obj.position.toArray(),
			rot: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
			scale: obj.scale.toArray()
		});
		// the origin is scene data (userData), so it replicates on its own
		s.objectOrigin.setOriginFor(obj.uuid, [-0.5, 0, 0]);
		const ap = s.animationPreview;
		const track = ap.addTrack(obj.uuid, 'rot.y', obj);
		ap.updateKey(obj.uuid, track, 0, { t: 0, v: 0 });
		ap.updateKey(obj.uuid, track, 1, { t: 1, v: Math.PI / 2 });
		ap.updateAnim(obj.uuid, { duration: 1, loop: 'once' });
		return obj.uuid;
	});
	await A.page.waitForTimeout(1500);

	// where C thinks the hinge is BEFORE the door opens — the invariant to hold
	const hingeClosed = await C.page.evaluate((id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		if (!obj) return null;
		obj.updateMatrixWorld(true);
		return {
			hinge: obj.localToWorld(new s.THREE.Vector3(-0.5, 0, 0)).toArray(),
			centre: obj.getWorldPosition(new s.THREE.Vector3()).toArray()
		};
	}, doorUuid);
	h.check(
		!!hingeClosed && Math.abs(hingeClosed.centre[0] - 3) < 0.01,
		`the door reached the joiner at its real place (x=${hingeClosed?.centre?.[0]?.toFixed(2)})`
	);
	await A.page.evaluate((id) => window.__stores.animationPreview.play(id), doorUuid);
	await A.page.waitForTimeout(1600); // a 'once' clip: both peers end at 90deg

	const [doorA, doorC] = await Promise.all([readAnim(A.page, doorUuid), readAnim(C.page, doorUuid)]);
	h.check(
		Math.abs(doorA.rotY - Math.PI / 2) < 0.02,
		`the door finished opening on A (${((doorA.rotY * 180) / Math.PI).toFixed(1)}deg)`
	);
	h.check(
		doorC.rotY !== null && Math.abs(doorC.rotY - Math.PI / 2) < 0.02,
		`and on the late joiner (${doorC.rotY === null ? 'missing' : ((doorC.rotY * 180) / Math.PI).toFixed(1) + 'deg'})`
	);
	// a 'once' clip ends itself on each peer — nobody has to send the ending
	h.check(!doorA.playing && !doorC.playing, 'a once-clip ends itself on every peer');

	const hinge = await C.page.evaluate((id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		obj.updateMatrixWorld(true);
		const THREE = s.THREE;
		return {
			hinge: obj.localToWorld(new THREE.Vector3(-0.5, 0, 0)).toArray(),
			centre: obj.getWorldPosition(new THREE.Vector3()).toArray(),
			origin: obj.userData.origin ?? null
		};
	}, doorUuid);
	const dist = (/** @type {number[]} */ a, /** @type {number[]} */ b) =>
		Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	h.check(
		Array.isArray(hinge.origin),
		`the origin travelled with the object (${JSON.stringify(hinge.origin)})`
	);
	h.check(
		!!hingeClosed && dist(hinge.hinge, hingeClosed.hinge) < 0.02,
		`the hinge point never moved on the joiner (drift ${hingeClosed ? dist(hinge.hinge, hingeClosed.hinge).toFixed(4) : 'n/a'})`
	);
	h.check(
		!!hingeClosed && dist(hinge.centre, hingeClosed.centre) > 0.3,
		`while the door body swung across the opening (${hingeClosed ? dist(hinge.centre, hingeClosed.centre).toFixed(3) : 'n/a'})`
	);

	await h.finish(browser);
});
