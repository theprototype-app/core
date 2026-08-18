// R1 — a movement plays from where the object IS.
//
// Position keys used to be absolute world values, so moving an object and pressing
// play snapped it back to wherever the clip was authored. A position track is read
// as an offset from its FIRST key now, replayed on top of the pose the run starts
// at. Rotation and scale stay absolute: an angle and a factor mean the same thing
// wherever the object sits.
//
// The auto-key half is the one that bites if it is wrong: it records the object's
// current WORLD value, so without the inverse mapping the current base gets baked
// into the key and the movement DOUBLES on the next run.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const setup = await A.page.evaluate(async () => {
		const w = window.__stores;
		const ap = w.animationPreview;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 800));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.children[g.children.length - 1];
		object.position.set(0, 0, 0);
		object.updateMatrixWorld(true);
		// a clip authored AT THE ORIGIN: y 0 -> 2
		ap.addTrack(object.uuid, 'pos.y', object);
		let set;
		ap.animations.subscribe((v) => (set = v))();
		const clipId = set[object.uuid].active;
		const track = set[object.uuid].clips[clipId].tracks[0];
		return {
			uuid: object.uuid,
			clipId,
			keys: track.keys.map((k) => ({ t: k.t, v: k.v }))
		};
	});
	h.check(
		setup.keys.length === 2 && setup.keys[0].v === 0 && setup.keys[1].v === 2,
		`a clip authored at the origin, y 0 -> 2 (premise: ${JSON.stringify(setup.keys)})`
	);

	// ---- 1. move the object, then play -------------------------------------
	const moved = await A.page.evaluate(async (s) => {
		const w = window.__stores;
		const ap = w.animationPreview;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', s.uuid);
		object.position.set(3, 5, -2); // somewhere else entirely
		object.updateMatrixWorld(true);
		ap.scrub(s.uuid, 0); // the FIRST frame of the clip
		const atStart = object.position.toArray();
		ap.scrub(s.uuid, 2); // the last
		const atEnd = object.position.toArray();
		ap.stop(s.uuid);
		ap.resetPreview(s.uuid);
		const afterReset = object.position.toArray();
		return { atStart, atEnd, afterReset };
	}, setup);

	h.check(
		Math.abs(moved.atStart[1] - 5) < 1e-3,
		`frame 0 leaves it where it stands, not at the authored 0 (y=${moved.atStart[1].toFixed(3)})`
	);
	h.check(
		Math.abs(moved.atEnd[1] - 7) < 1e-3,
		`THE FIX: a 0->2 movement plays as 5->7 from its new home (y=${moved.atEnd[1].toFixed(3)})`
	);
	h.check(
		Math.abs(moved.atStart[0] - 3) < 1e-3 && Math.abs(moved.atStart[2] + 2) < 1e-3,
		'the unkeyed axes are untouched'
	);
	h.check(
		Math.abs(moved.afterReset[1] - 5) < 1e-3,
		`clearing the preview returns it to where the user put it (y=${moved.afterReset[1].toFixed(3)})`
	);

	// ---- 2. rotation stays ABSOLUTE ----------------------------------------
	const rotation = await A.page.evaluate(async (s) => {
		const w = window.__stores;
		const ap = w.animationPreview;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', s.uuid);
		ap.addTrack(s.uuid, 'rot.y', object);
		let set;
		ap.animations.subscribe((v) => (set = v))();
		const track = set[s.uuid].clips[s.clipId].tracks.find((t) => t.channel === 'rot.y');
		const last = track.keys[track.keys.length - 1].v;
		object.rotation.y = 1; // turn it by hand first
		ap.scrub(s.uuid, 2);
		const at = object.rotation.y;
		ap.stop(s.uuid);
		ap.resetPreview(s.uuid);
		return { last, at };
	}, setup);
	h.check(
		Math.abs(rotation.at - rotation.last) < 1e-3,
		`a rotation key still means that ANGLE, not an offset (${rotation.at.toFixed(3)} = key ${rotation.last.toFixed(3)})`
	);

	// ---- 3. auto-key does NOT double the movement --------------------------
	// The inverse mapping's whole job. Record a key while the object is posed at
	// base+offset, then play again: the movement must be the same size, not twice.
	const autoKey = await A.page.evaluate(async (s) => {
		const w = window.__stores;
		const ap = w.animationPreview;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', s.uuid);
		object.position.set(0, 10, 0); // a big base, so a doubled key is obvious
		object.updateMatrixWorld(true);
		ap.setAutoKey(s.uuid);
		ap.scrub(s.uuid, 1); // mid-clip: y = 10 + 1 = 11
		const posed = object.position.y;
		object.position.y = posed + 0.5; // the user nudges it up half a unit
		ap.captureAutoKey(s.uuid, 1);
		ap.setAutoKey(null);
		// what got STORED
		let set;
		ap.animations.subscribe((v) => (set = v))();
		const track = set[s.uuid].clips[s.clipId].tracks.find((t) => t.channel === 'pos.y');
		const recorded = track.keys.find((k) => Math.abs(k.t - 1) < 1e-6)?.v ?? null;
		// and what it plays back as, from the same base
		ap.scrub(s.uuid, 1);
		const replayed = object.position.y;
		ap.stop(s.uuid);
		ap.resetPreview(s.uuid);
		return { posed, recorded, replayed, base: 10 };
	}, setup);

	h.check(
		Math.abs(autoKey.posed - 11) < 1e-2,
		`premise: mid-clip the object sits at base+1 (y=${autoKey.posed.toFixed(3)})`
	);
	h.check(
		autoKey.recorded !== null && autoKey.recorded < 5,
		`the recorded key is an OFFSET (${autoKey.recorded}), not the world value ${autoKey.posed.toFixed(1)} — that is the doubling bug`
	);
	h.check(
		Math.abs(autoKey.replayed - (autoKey.posed + 0.5)) < 1e-2,
		`and it replays exactly where the user left it (${autoKey.replayed.toFixed(3)} vs ${(autoKey.posed + 0.5).toFixed(3)})`
	);

	// ---- 4. the glTF bake uses the same mapping ----------------------------
	const baked = await A.page.evaluate((s) => {
		const w = window.__stores;
		const ap = w.animationPreview;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', s.uuid);
		object.position.set(0, 20, 0);
		object.updateMatrixWorld(true);
		let set;
		ap.animations.subscribe((v) => (set = v))();
		const clip = set[s.uuid].clips[s.clipId];
		const three = ap.clipToThreeClip(object, clip);
		const posTrack = three?.tracks?.find((t) => /position/.test(t.name));
		if (!posTrack) return { found: false };
		const ys = [];
		for (let i = 1; i < posTrack.values.length; i += 3) ys.push(posTrack.values[i]);
		return { found: true, min: Math.min(...ys), max: Math.max(...ys) };
	}, setup);
	h.check(baked.found, 'the bake produced a position track (premise)');
	h.check(
		baked.min >= 19.5,
		`the exported clip is around the object's real home, not the authored origin (min y=${baked.min?.toFixed(2)})`
	);

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
