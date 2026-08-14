// 17-E A7 — authored clips leave with the model.
//
// An authored clip is keys over OUR channels (pos.y, rot.y, a stepped `visible`),
// which nothing downstream understands. A GLTF export now SAMPLES them into real
// KeyframeTracks, so a door built here opens in Blender, three.js or any viewer.
//
// The round trip is the proof: bake, run the real GLTFExporter, parse the result
// back with the real GLTFLoader, drive the parsed clip with an AnimationMixer and
// compare the posed values against our own evaluator. Sampling error at 30fps is
// the only allowed difference.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.animationPreview, { timeout: 20000 });

	// ---------- what a bake produces ----------
	const baked = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.name = 'Lift';
		obj.position.set(0, 0, 0);
		obj.updateMatrix();
		const track = ap.addTrack(obj.uuid, 'pos.y', obj);
		ap.updateKey(obj.uuid, track, 0, { t: 0, v: 0, ease: [0.42, 0, 0.58, 1] });
		ap.updateKey(obj.uuid, track, 1, { t: 2, v: 4 });
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'once' });
		const clip = ap.clipToThreeClip(obj, ap.activeClip(obj.uuid));
		return {
			uuid: obj.uuid,
			isClip: clip?.constructor?.name,
			name: clip?.name,
			duration: clip?.duration,
			trackNames: clip?.tracks.map((/** @type {any} */ t) => t.name),
			trackTypes: clip?.tracks.map((/** @type {any} */ t) => t.constructor.name),
			frames: clip?.tracks[0]?.times?.length
		};
	});
	h.check(baked.isClip === 'AnimationClip', `a clip bakes to a real AnimationClip (${baked.isClip})`);
	h.check(Math.abs(baked.duration - 2) < 1e-6, `keeping its length (${baked.duration}s)`);
	h.check(
		baked.trackNames?.[0] === 'Lift.position' && baked.trackTypes?.[0] === 'VectorKeyframeTrack',
		`targeting the object by name (${baked.trackNames?.join(', ')})`
	);
	h.check(baked.frames === 61, `sampled at 30fps (${baked.frames} frames for 2s)`);

	// only the channels the clip drives become tracks
	const channels = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const rotClip = ap.createClip(id, 'Turn');
		const rt = ap.addTrack(id, 'rot.y', obj, rotClip);
		ap.updateKey(id, rt, 1, { t: 1, v: Math.PI }, rotClip);
		const visClip = ap.createClip(id, 'Blink');
		const vt = ap.addTrack(id, 'visible', obj, visClip);
		ap.updateKey(id, vt, 1, { t: 1, v: 0 }, visClip);
		const rot = ap.clipToThreeClip(obj, ap.getAnimSet(id).clips[rotClip]);
		const vis = ap.clipToThreeClip(obj, ap.getAnimSet(id).clips[visClip]);
		return {
			rot: rot.tracks.map((/** @type {any} */ t) => t.constructor.name),
			vis: vis.tracks.map((/** @type {any} */ t) => t.constructor.name),
			all: ap.bakeAnimations(obj, id).map((/** @type {any} */ c) => c.name)
		};
	}, baked.uuid);
	h.check(
		channels.rot.includes('QuaternionKeyframeTrack'),
		`rotation bakes as QUATERNIONS, which is all glTF has (${channels.rot.join(', ')})`
	);
	h.check(
		channels.vis.join() === 'BooleanKeyframeTrack',
		`a stepped visibility channel bakes as booleans (${channels.vis.join(', ')})`
	);
	h.check(
		channels.all.length === 3 && channels.all.includes('Turn'),
		`every clip of the object bakes (${channels.all.join(', ')})`
	);

	// ---------- the ROUND TRIP through the real exporter and loader ----------
	const trip = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		const THREE = s.THREE;
		const { GLTFExporter } = s.GLTFExporterModule;
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		// export the LIFT clip (its own first clip), the way the exporter is fed
		const set = ap.getAnimSet(id);
		const liftId = Object.keys(set.clips)[0];
		ap.setActiveClip(id, liftId);
		const clip = ap.clipToThreeClip(obj, set.clips[liftId]);

		const glb = await new Promise((resolve, reject) =>
			new GLTFExporter().parse(obj, resolve, reject, { binary: true, animations: [clip] })
		);
		// the app's own loader, so the parse path is the real one
		const loader = s.animatedImports.createGltfLoader();
		const parsed = await new Promise((resolve, reject) => loader.parse(glb, '', resolve, reject));
		const gltfClip = parsed.animations?.[0];
		if (!gltfClip) return { clips: 0 };

		// drive the PARSED model with a mixer and compare against our evaluator
		const root = parsed.scene ?? parsed.root;
		const mixer = new THREE.AnimationMixer(root);
		const action = mixer.clipAction(gltfClip);
		// glTF carries no LOOP MODE - that stays our concept - so a consumer of a
		// once-clip sets this itself. Without it setTime(duration) wraps to 0 under
		// the default LoopRepeat and the last frame reads as the first.
		action.loop = THREE.LoopOnce;
		action.clampWhenFinished = true;
		action.play();
		const target = root.getObjectByName('Lift') ?? root.children[0];
		const samples = [];
		for (const t of [0, 0.5, 1, 1.5, 2]) {
			mixer.setTime(t);
			root.updateMatrixWorld(true);
			const mine = ap.sampleTrack(ap.getAnimSet(id).clips[liftId].tracks[0], t);
			samples.push([t, +target.position.y.toFixed(4), +mine.toFixed(4)]);
		}
		return {
			clips: parsed.animations.length,
			name: gltfClip.name,
			duration: +gltfClip.duration.toFixed(3),
			samples,
			worst: Math.max(...samples.map((/** @type {any[]} */ sample) => Math.abs(sample[1] - sample[2])))
		};
	}, baked.uuid);
	h.check(trip.clips === 1, `the exported glb carries the animation (${trip.clips} clip)`);
	h.check(
		Math.abs(trip.duration - 2) < 0.05,
		`with its name and length intact (${trip.name}, ${trip.duration}s)`
	);
	h.check(
		trip.worst !== undefined && trip.worst < 0.02,
		`and a mixer poses the exported model exactly like our evaluator (worst delta ${trip.worst?.toFixed(4)}, samples ${JSON.stringify(trip.samples)})`
	);

	// ---------- the DOOR case: the pivot has to be baked in too ----------
	const door = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		const THREE = s.THREE;
		s.commandsHandler.sceneCommand('/create Box 1 2 0.1');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.name = 'Door';
		obj.position.set(0, 1, 0);
		obj.rotation.set(0, 0, 0);
		obj.updateMatrix();
		s.objectOrigin.setOriginFor(obj.uuid, [-0.5, 0, 0]);
		ap.applyPreset('door', obj.uuid, obj);
		const clip = ap.clipToThreeClip(obj, ap.activeClip(obj.uuid));
		// a hinged door must carry BOTH a rotation and a position track: glTF has no
		// pivot, so the swing about the origin is position + rotation together
		const kinds = clip.tracks.map((/** @type {any} */ t) => t.constructor.name);
		// walk the baked tracks and check the hinge point stays put
		const posTrack = clip.tracks.find((/** @type {any} */ t) => t.name.endsWith('.position'));
		const rotTrack = clip.tracks.find((/** @type {any} */ t) => t.name.endsWith('.quaternion'));
		const hinge = new THREE.Vector3(-0.5, 0, 0);
		const points = [];
		for (const i of [0, Math.floor(posTrack.times.length / 2), posTrack.times.length - 1]) {
			const p = new THREE.Vector3().fromArray(posTrack.values, i * 3);
			const q = new THREE.Quaternion().fromArray(rotTrack.values, i * 4);
			points.push(hinge.clone().applyQuaternion(q).add(p).toArray());
		}
		const drift = Math.max(
			...points.map((/** @type {number[]} */ p) =>
				Math.hypot(p[0] - points[0][0], p[1] - points[0][1], p[2] - points[0][2])
			)
		);
		return { kinds, drift, first: points[0], last: points[points.length - 1] };
	});
	h.check(
		door.kinds.includes('VectorKeyframeTrack') && door.kinds.includes('QuaternionKeyframeTrack'),
		`a hinged door bakes position AND rotation (${door.kinds.join(', ')})`
	);
	h.check(
		door.drift < 0.001,
		`so the exported hinge point never moves (drift ${door.drift.toFixed(5)})`
	);

	await h.finish(browser);
});
