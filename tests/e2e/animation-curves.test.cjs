// 17-E — authored animation as KEYFRAMES.
//
// The window used to author one `{from, to, bezier}` segment per channel. It now
// stores named CLIPS of tracks of KEYS at absolute clip seconds, with the easing
// on the key that OPENS each segment. This suite pins the parts that could
// silently change behaviour:
//
//  * a legacy (v1) animation loaded from an old save poses IDENTICALLY,
//  * segment easing is per segment, not per track,
//  * keys can be inserted / moved / removed, and `duration` means clip length,
//  * a stepped channel (visible) holds instead of interpolating,
//  * an object with an ORIGIN rotates about it — the door hinge,
//  * several objects play at once (a preview is no longer exclusive).
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.animationPreview, { timeout: 20000 });

	/** make a box and return its uuid */
	const makeBox = (page, label) =>
		page.evaluate((name) => {
			const s = window.__stores;
			s.commandsHandler.sceneCommand('/create box');
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const obj = g.children[g.children.length - 1];
			obj.name = name;
			obj.position.set(0, 0, 0);
			obj.rotation.set(0, 0, 0);
			obj.updateMatrix();
			return obj.uuid;
		}, label);

	// ---------- 1. a v1 animation migrates to keys and poses identically ----------
	const legacy = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 200));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(0, 0, 0);
		obj.updateMatrix();

		// exactly what a pre-17-E save holds: one track, from -> to, ONE bezier,
		// no clips and no keys anywhere.
		const bezier = [0.42, 0, 0.58, 1];
		const saved = {
			[obj.uuid]: {
				tracks: [{ id: 't1', channel: 'pos.y', from: 1, to: 5, bezier }],
				duration: 2,
				loop: 'loop'
			}
		};
		ap.animationsRestore(saved);

		let map;
		ap.animations.subscribe((v) => (map = v))();
		const set = map[obj.uuid];
		const clip = set.clips[set.active];

		// v1 math, computed here from the SAME easing solver, so the comparison is
		// against the old formula and not against the new code's own output.
		const samples = [];
		for (let i = 0; i <= 9; i++) {
			const seconds = (i / 9) * 2;
			const phase = (seconds / 2) % 1;
			const expected = 1 + (5 - 1) * ap.cubicBezierEase(bezier, phase);
			ap.scrub(obj.uuid, seconds);
			samples.push([expected, obj.position.y]);
		}
		ap.stop(obj.uuid);
		return {
			uuid: obj.uuid,
			clipIds: Object.keys(set.clips),
			keys: clip.tracks[0].keys.map((k) => [k.t, k.v, !!k.ease]),
			trackId: clip.tracks[0].id,
			worst: Math.max(...samples.map(([e, a]) => Math.abs(e - a))),
			samples
		};
	});
	h.check(legacy.clipIds.length === 1, `a v1 anim becomes one clip (${legacy.clipIds.join(',')})`);
	h.check(
		legacy.keys.length === 2 &&
			legacy.keys[0][0] === 0 && legacy.keys[0][1] === 1 && legacy.keys[0][2] === true &&
			legacy.keys[1][0] === 2 && legacy.keys[1][1] === 5,
		`from/to became keys at 0 and duration, easing on the first (${JSON.stringify(legacy.keys)})`
	);
	h.check(legacy.worst < 1e-6, `the migrated clip poses identically at 10 times (worst delta ${legacy.worst.toExponential(1)})`);
	h.check(legacy.keys[0][1] !== legacy.keys[1][1], 'the migration is exact, not a reset to defaults');

	// ---------- 2. easing is PER SEGMENT ----------
	const perSegment = await A.page.evaluate((state) => {
		const ap = window.__stores.animationPreview;
		const { uuid, trackId } = state;
		// three keys: 0 -> 1 -> 5 with a hard ease-in on the FIRST segment only
		ap.updateKey(uuid, trackId, 0, { t: 0, v: 0, ease: [0.9, 0, 1, 1] });
		ap.addKey(uuid, trackId, 1, 1, { ease: [0, 0, 0.1, 1] }); // ease-out second
		ap.updateKey(uuid, trackId, 2, { t: 2, v: 5 });
		let map;
		ap.animations.subscribe((v) => (map = v))();
		const set = map[uuid];
		const clip = set.clips[set.active];
		const track = clip.tracks[0];
		return {
			keyCount: track.keys.length,
			// mid-first-segment must lag its linear midpoint (0.5), mid-second must lead
			firstMid: ap.sampleTrack(track, 0.5),
			secondMid: ap.sampleTrack(track, 1.5),
			atKey: ap.sampleTrack(track, 1),
			eases: track.keys.map((k) => (k.ease ? k.ease.join(',') : null))
		};
	}, { uuid: legacy.uuid, trackId: legacy.trackId });
	h.check(perSegment.keyCount === 3, `a key can be inserted mid-clip (${perSegment.keyCount} keys)`);
	h.check(Math.abs(perSegment.atKey - 1) < 1e-6, `the value at a key is the key (${perSegment.atKey})`);
	h.check(perSegment.firstMid < 0.35, `segment 1 eases in slowly (${perSegment.firstMid.toFixed(3)} < 0.5 of its span)`);
	h.check(perSegment.secondMid > 3.6, `segment 2 eases out fast (${perSegment.secondMid.toFixed(3)} > 3 = its linear midpoint)`);
	h.check(
		perSegment.eases[0] !== perSegment.eases[1],
		'the two segments carry different easings at the same time'
	);

	// ---------- 3. key removal, and duration = clip length ----------
	const edits = await A.page.evaluate((state) => {
		const ap = window.__stores.animationPreview;
		const { uuid, trackId } = state;
		ap.removeKey(uuid, trackId, 1);
		let map;
		const read = () => {
			ap.animations.subscribe((v) => (map = v))();
			const set = map[uuid];
			return set.clips[set.active];
		};
		const afterRemove = read().tracks[0].keys.length;

		// the movement FILLS the clip, so halving the duration halves the key times
		ap.updateAnim(uuid, { duration: 1 });
		const scaled = read().tracks[0].keys.map((k) => k.t);

		// now build a deliberate TAIL: stretch to 4s (the movement still fills it, so
		// the keys scale to 0..4), then drag the last key back to 1s. Moving a key
		// never shrinks the clip, so the movement now ends 3s before the loop does.
		ap.updateAnim(uuid, { duration: 4 });
		const stretched = read().tracks[0].keys.map((k) => k.t);
		ap.updateKey(uuid, trackId, 1, { t: 1 });
		const tail = read();
		// a further length change must leave that hold alone
		ap.updateAnim(uuid, { duration: 8 });
		const held = read().tracks[0].keys.map((k) => k.t);
		const heldDuration = read().duration;

		// a track never loses its last key
		ap.removeKey(uuid, trackId, 0);
		ap.removeKey(uuid, trackId, 0);
		const floor = read().tracks[0].keys.length;
		return { afterRemove, scaled, stretched, tailKeys: tail.tracks[0].keys.map((k) => k.t), held, heldDuration, floor };
	}, { uuid: legacy.uuid, trackId: legacy.trackId });
	h.check(edits.afterRemove === 2, `a key can be removed (${edits.afterRemove} left)`);
	h.check(
		Math.abs(edits.scaled[1] - 1) < 1e-6,
		`shortening a clip that the movement fills rescales its keys (${JSON.stringify(edits.scaled)})`
	);
	h.check(
		Math.abs(edits.stretched[1] - 4) < 1e-6,
		`lengthening rescales it the same way (${JSON.stringify(edits.stretched)})`
	);
	h.check(
		Math.abs(edits.tailKeys[1] - 1) < 1e-6 && Math.abs(edits.held[1] - 1) < 1e-6 && edits.heldDuration === 8,
		`a clip with a hold at the end keeps its key times (${JSON.stringify(edits.held)} in a ${edits.heldDuration}s clip)`
	);
	h.check(edits.floor === 1, 'a track keeps at least one key');

	// ---------- 4. a stepped channel HOLDS ----------
	const stepped = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 200));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		const id = ap.addTrack(obj.uuid, 'visible', obj);
		ap.updateKey(obj.uuid, id, 0, { t: 0, v: 1 });
		ap.updateKey(obj.uuid, id, 1, { t: 1, v: 0 });
		let map;
		ap.animations.subscribe((v) => (map = v))();
		const set = map[obj.uuid];
		const track = set.clips[set.active].tracks[0];
		const mid = ap.sampleTrack(track, 0.5);
		ap.scrub(obj.uuid, 0.5);
		const visibleMid = obj.visible;
		ap.scrub(obj.uuid, 1);
		const visibleEnd = obj.visible;
		ap.stop(obj.uuid);
		const visibleAfter = obj.visible;
		return { mid, visibleMid, visibleEnd, visibleAfter };
	});
	h.check(stepped.mid === 1, `a stepped channel holds its left key (${stepped.mid}, not 0.5)`);
	h.check(stepped.visibleMid === true && stepped.visibleEnd === false, 'visibility switches at the key, not across it');
	h.check(stepped.visibleAfter === true, 'and Stop restores the base visibility');

	// ---------- 5. the DOOR: rotation turns about the object's origin ----------
	const door = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 200));
		const THREE = s.THREE;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(0, 0, 0);
		obj.rotation.set(0, 0, 0);
		obj.scale.set(1, 1, 1);
		obj.updateMatrix();
		obj.updateMatrixWorld(true);

		// hinge on the box's -X edge, the way "Move origin" would place it
		obj.userData.origin = [-0.5, 0, 0];
		const hingeBefore = obj.localToWorld(new THREE.Vector3(-0.5, 0, 0)).toArray();
		const centreBefore = obj.getWorldPosition(new THREE.Vector3()).toArray();

		const id = ap.addTrack(obj.uuid, 'rot.y', obj);
		ap.updateKey(obj.uuid, id, 0, { t: 0, v: 0 });
		ap.updateKey(obj.uuid, id, 1, { t: 1, v: Math.PI / 2 });
		ap.scrub(obj.uuid, 1);
		obj.updateMatrixWorld(true);
		const hingeOpen = obj.localToWorld(new THREE.Vector3(-0.5, 0, 0)).toArray();
		const centreOpen = obj.getWorldPosition(new THREE.Vector3()).toArray();
		const rotOpen = obj.rotation.y;

		// the SAME clip on an object with no origin must be a plain spin in place
		ap.stop(obj.uuid);
		delete obj.userData.origin;
		ap.scrub(obj.uuid, 1);
		obj.updateMatrixWorld(true);
		const centreNoOrigin = obj.getWorldPosition(new THREE.Vector3()).toArray();
		ap.stop(obj.uuid);
		obj.updateMatrixWorld(true);
		const centreRestored = obj.getWorldPosition(new THREE.Vector3()).toArray();

		const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		return {
			hingeDrift: dist(hingeBefore, hingeOpen),
			centreMoved: dist(centreBefore, centreOpen),
			rotOpen,
			noOriginMoved: dist(centreBefore, centreNoOrigin),
			restoreDrift: dist(centreBefore, centreRestored)
		};
	});
	h.check(door.hingeDrift < 1e-6, `the hinge point stays put while the door swings (drift ${door.hingeDrift.toExponential(1)})`);
	h.check(Math.abs(door.rotOpen - Math.PI / 2) < 1e-6, `the door reaches 90 degrees (${((door.rotOpen * 180) / Math.PI).toFixed(1)}deg)`);
	h.check(door.centreMoved > 0.3, `so its body swings across the opening (centre moved ${door.centreMoved.toFixed(3)})`);
	h.check(door.noOriginMoved < 1e-6, `the same clip without an origin spins in place (moved ${door.noOriginMoved.toExponential(1)})`);
	h.check(door.restoreDrift < 1e-6, 'Stop restores the closed pose exactly');

	// ---------- 6. several objects animate at once ----------
	const first = await makeBox(A.page, 'Multi A');
	const second = await makeBox(A.page, 'Multi B');
	const multi = await A.page.evaluate(async (ids) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		for (const uuid of ids) {
			const obj = g.getObjectByProperty('uuid', uuid);
			const id = ap.addTrack(uuid, 'pos.y', obj);
			ap.updateKey(uuid, id, 1, { t: 2, v: 4 });
			ap.updateAnim(uuid, { duration: 2, loop: 'loop' });
			ap.play(uuid);
		}
		await new Promise((r) => setTimeout(r, 400));
		let pb;
		ap.playback.subscribe((v) => (pb = v))();
		let heads;
		ap.playheads.subscribe((v) => (heads = v))();
		const ys = ids.map((uuid) => g.getObjectByProperty('uuid', uuid).position.y);
		for (const uuid of ids) ap.stop(uuid);
		await new Promise((r) => setTimeout(r, 100));
		const after = ids.map((uuid) => g.getObjectByProperty('uuid', uuid).position.y);
		return {
			playing: ids.filter((u) => pb[u]?.playing).length,
			heads: ids.filter((u) => (heads[u] ?? 0) > 0).length,
			moved: ys.filter((y) => y > 0.01).length,
			restored: after.every((y) => Math.abs(y) < 1e-6)
		};
	}, [first, second]);
	h.check(multi.playing === 2, `two objects play at the same time (${multi.playing})`);
	h.check(multi.moved === 2, 'both are actually posed by the runtime');
	h.check(multi.heads === 2, `the per-frame playhead readout tracks both (${multi.heads})`);
	h.check(multi.restored, 'stopping each restores its own base pose');

	await h.finish(browser);
});
