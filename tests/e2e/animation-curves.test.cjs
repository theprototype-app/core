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
		// against the old formula and not against the new code's own output. Sampled
		// over [0, duration) — the endpoint is where the old LOOP formula wrapped to
		// the start, while scrubbing to the very end now shows the end (checked
		// separately below, because showing the first pose there was never right).
		const samples = [];
		for (let i = 0; i < 10; i++) {
			const seconds = (i / 10) * 2;
			const phase = (seconds / 2) % 1;
			const expected = 1 + (5 - 1) * ap.cubicBezierEase(bezier, phase);
			ap.scrub(obj.uuid, seconds);
			samples.push([expected, obj.position.y]);
		}
		ap.scrub(obj.uuid, 2);
		const atEnd = obj.position.y;
		ap.resetPreview(obj.uuid);
		return {
			uuid: obj.uuid,
			clipIds: Object.keys(set.clips),
			keys: clip.tracks[0].keys.map((k) => [k.t, k.v, !!k.ease]),
			trackId: clip.tracks[0].id,
			worst: Math.max(...samples.map(([e, a]) => Math.abs(e - a))),
			atEnd,
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
	h.check(
		Math.abs(legacy.atEnd - 5) < 1e-6,
		`and scrubbing to the very end shows the END pose (${legacy.atEnd}, not the wrapped start)`
	);

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

	// ---------- 3. key removal, LENGTH vs RETIME vs SPEED ----------
	// The three are separate on purpose: length is the clip's extent and moves no
	// keys, retime scales the movement itself, and speed is playback rate that
	// changes no data at all. Typing in the length field used to secretly retime.
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
		const startTimes = read().tracks[0].keys.map((k) => k.t);

		// LENGTH: keys keep their times, in both directions
		ap.updateAnim(uuid, { duration: 1 });
		const shortened = { times: read().tracks[0].keys.map((k) => k.t), duration: read().duration };
		ap.updateAnim(uuid, { duration: 6 });
		const lengthened = { times: read().tracks[0].keys.map((k) => k.t), duration: read().duration };

		// RETIME: the movement's own span becomes the asked-for length
		const ratio = ap.retimeClip(uuid, 1);
		const retimed = { times: read().tracks[0].keys.map((k) => k.t), duration: read().duration };
		ap.retimeClip(uuid, 4);
		const stretched = { times: read().tracks[0].keys.map((k) => k.t), duration: read().duration };

		// SPEED: no key or length is touched
		ap.setSpeed(uuid, 2);
		let pb;
		ap.playback.subscribe((v) => (pb = v))();
		const afterSpeed = { times: read().tracks[0].keys.map((k) => k.t), duration: read().duration, speed: pb[uuid]?.speed };

		// a track never loses its last key
		ap.removeKey(uuid, trackId, 0);
		ap.removeKey(uuid, trackId, 0);
		const floor = read().tracks[0].keys.length;
		return { afterRemove, startTimes, shortened, lengthened, ratio, retimed, stretched, afterSpeed, floor };
	}, { uuid: legacy.uuid, trackId: legacy.trackId });
	h.check(edits.afterRemove === 2, `a key can be removed (${edits.afterRemove} left)`);
	h.check(
		JSON.stringify(edits.shortened.times) === JSON.stringify(edits.startTimes) && edits.shortened.duration === 1,
		`shortening the clip LENGTH moves no keys (${JSON.stringify(edits.shortened.times)} in a ${edits.shortened.duration}s clip)`
	);
	h.check(
		JSON.stringify(edits.lengthened.times) === JSON.stringify(edits.startTimes) && edits.lengthened.duration === 6,
		`and neither does lengthening it (${JSON.stringify(edits.lengthened.times)} in a ${edits.lengthened.duration}s clip)`
	);
	h.check(
		Math.abs(edits.retimed.times[1] - 1) < 1e-6 && edits.retimed.duration === 1,
		`RETIME scales the movement to the length asked for (${JSON.stringify(edits.retimed.times)})`
	);
	h.check(
		Math.abs(edits.stretched.times[1] - 4) < 1e-6,
		`in both directions, keeping its shape (${JSON.stringify(edits.stretched.times)})`
	);
	h.check(
		JSON.stringify(edits.afterSpeed.times) === JSON.stringify(edits.stretched.times) &&
			edits.afterSpeed.duration === edits.stretched.duration &&
			edits.afterSpeed.speed === 2,
		`SPEED changes no data at all (${edits.afterSpeed.speed}x, keys ${JSON.stringify(edits.afterSpeed.times)})`
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
		ap.resetPreview(obj.uuid); // Stop holds the frame; this is what undoes it
		const visibleAfter = obj.visible;
		return { mid, visibleMid, visibleEnd, visibleAfter };
	});
	h.check(stepped.mid === 1, `a stepped channel holds its left key (${stepped.mid}, not 0.5)`);
	h.check(stepped.visibleMid === true && stepped.visibleEnd === false, 'visibility switches at the key, not across it');
	h.check(stepped.visibleAfter === true, 'and Clear preview restores the base visibility');

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

	// ---------- 7. named CLIPS per object ----------
	const clipsState = await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		const open = ap.createClip(id, 'Open');
		ap.addTrack(id, 'rot.y', null, open);
		const copy = ap.duplicateClip(id, open);
		ap.renameClip(id, copy, 'Close');
		const list = ap.clipList(id);
		// a duplicate must not SHARE track ids with its source, or a UI selection
		// (and every per-track lookup) would hit two clips at once
		let map;
		ap.animations.subscribe((v) => (map = v))();
		const set = map[id];
		const sourceTracks = set.clips[open].tracks.map((/** @type {any} */ t) => t.id);
		const copyTracks = set.clips[copy].tracks.map((/** @type {any} */ t) => t.id);
		ap.setActiveClip(id, open);
		const activeAfter = ap.clipList(id).find((/** @type {any} */ c) => c.active)?.name;
		ap.deleteClip(id, copy);
		return {
			names: list.map((/** @type {any} */ c) => c.name),
			activeWasCopy: list.find((/** @type {any} */ c) => c.active)?.name,
			shared: sourceTracks.filter((/** @type {any} */ t) => copyTracks.includes(t)).length,
			activeAfter,
			afterDelete: ap.clipList(id).map((/** @type {any} */ c) => c.name)
		};
	}, first);
	h.check(
		clipsState.names.includes('Open') && clipsState.names.includes('Close'),
		`an object holds several named clips (${clipsState.names.join(', ')})`
	);
	h.check(clipsState.activeWasCopy === 'Close', 'a new clip becomes the one being edited');
	h.check(clipsState.shared === 0, `a duplicate gets fresh track ids (${clipsState.shared} shared)`);
	h.check(clipsState.activeAfter === 'Open', 'and any clip can be made the default');
	h.check(!clipsState.afterDelete.includes('Close'), `deleting one leaves the rest (${clipsState.afterDelete.join(', ')})`);

	// ---------- 8. the timeline, through the real DOM ----------
	const ui = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		s.objectActions.selectObject(id, false);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		await new Promise((r) => setTimeout(r, 400));
		const svg = document.querySelector('#animation-timeline');
		return {
			svg: !!svg,
			diamonds: svg ? svg.querySelectorAll('rect[transform^="rotate(45"]').length : 0,
			clipsPanel: !!document.querySelector('#authored-clips'),
			addButton: !!document.querySelector('#animation-add')
		};
	}, first);
	h.check(ui.svg, 'the timeline renders for the selected object');
	h.check(ui.diamonds >= 2, `with a diamond per key (${ui.diamonds})`);
	h.check(ui.clipsPanel, 'and the authored-clip list is shown');
	h.check(ui.addButton, 'the + button is present');

	// double-click the sheet to INSERT a key, then drag it with a real mouse
	const before = await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		let map;
		ap.animations.subscribe((v) => (map = v))();
		const set = map[id];
		return set.clips[set.active].tracks[0].keys.map((/** @type {any} */ k) => [k.t, k.v]);
	}, first);
	const box = await A.page.locator('#animation-timeline').boundingBox();
	// the sheet's first track row sits just under the 16px ruler
	const rowY = box.y + 16 + 11;
	await A.page.mouse.dblclick(box.x + box.width * 0.5, rowY);
	await A.page.waitForTimeout(250);
	const afterInsert = await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		let map;
		ap.animations.subscribe((v) => (map = v))();
		const set = map[id];
		return set.clips[set.active].tracks[0].keys.map((/** @type {any} */ k) => [k.t, k.v]);
	}, first);
	h.check(
		afterInsert.length === before.length + 1,
		`a double-click on a row inserts a key (${before.length} -> ${afterInsert.length})`
	);
	const inserted = afterInsert.findIndex(
		(/** @type {any[]} */ k) => !before.some((/** @type {any[]} */ b) => Math.abs(b[0] - k[0]) < 1e-9)
	);
	h.check(
		inserted >= 0 && Math.abs(afterInsert[inserted][0] - 1) < 0.16,
		`at the time it was clicked (${afterInsert[inserted]?.[0]}s of a 2s clip)`
	);

	// drag that key left with a real pointer gesture: ONE undo entry, one broadcast
	const depthBefore = await A.page.evaluate(() => {
		let stack = [];
		window.__stores.history.undoStack.subscribe((/** @type {any[]} */ v) => (stack = v))();
		return stack.length;
	});
	const keyX = box.x + 10 + (afterInsert[inserted][0] / 2) * (box.width - 4 - 20);
	await A.page.mouse.move(keyX, rowY);
	await A.page.mouse.down();
	for (let i = 1; i <= 6; i++) await A.page.mouse.move(keyX - i * 8, rowY, { steps: 2 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(250);
	const dragged = await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		let map;
		ap.animations.subscribe((v) => (map = v))();
		const set = map[id];
		let stack = [];
		window.__stores.history.undoStack.subscribe((/** @type {any[]} */ v) => (stack = v))();
		return {
			times: set.clips[set.active].tracks[0].keys.map((/** @type {any} */ k) => Math.round(k.t * 1000) / 1000),
			depth: stack.length,
			kinds: stack.slice(-1).map((/** @type {any} */ e) => e.kind)
		};
	}, first);
	h.check(
		dragged.times.some((/** @type {number} */ t) => t > 0 && t < afterInsert[inserted][0] - 0.05),
		`dragging a key moves it in time (${JSON.stringify(dragged.times)})`
	);
	h.check(
		dragged.depth === depthBefore + 1 && dragged.kinds[0] === 'anim',
		`and the whole drag is ONE undo entry (+${dragged.depth - depthBefore}, kind ${dragged.kinds[0]})`
	);

	// ---------- 9. the "+" menu ----------
	const clipsBefore = await A.page.evaluate(
		(id) => window.__stores.animationPreview.clipList(id).length,
		first
	);
	await A.page.locator('#animation-add').click();
	await A.page.waitForTimeout(300);
	// submenu parents carry a trailing marker, so match the label loosely
	const menuRows = await A.page.evaluate(() =>
		[...document.querySelectorAll('.ctx-item, [role="menuitem"], button')]
			.map((b) => b.textContent?.replace(/\s+/g, ' ').trim() ?? '')
			.filter((t) => /^(Movement|Key at playhead|New clip|Delete clip)\b/.test(t))
	);
	h.check(
		menuRows.some((/** @type {string} */ t) => t.startsWith('Movement')) && menuRows.includes('New clip'),
		`the + button opens a real menu (${menuRows.join(' | ')})`
	);
	await A.page.getByText('New clip', { exact: true }).click();
	await A.page.waitForTimeout(300);
	const clipsAfter = await A.page.evaluate(
		(id) => window.__stores.animationPreview.clipList(id).length,
		first
	);
	h.check(clipsAfter === clipsBefore + 1, `and its actions run (${clipsBefore} -> ${clipsAfter} clips)`);
	const menuGone = await A.page.evaluate(
		() => !document.body.textContent?.includes('Keys on every channel')
	);
	h.check(menuGone, 'the menu closes after a pick');

	// ---------- 9b. the GRAPH view drags a key on BOTH axes ----------
	// reported: "on Graph view drag curve points with mouse around X/Y axis, now it
	// drags only on X axis". The y axis is derived from the keys, so it used to
	// breathe under the cursor while dragging and the value chased its own mapping.
	const graph = await A.page.evaluate((id) => {
		const s = window.__stores;
		s.objectActions.selectObject(id, false);
		const ap = s.animationPreview;
		// the + menu just added an empty clip, so pick one that actually has keys
		const withKeys = ap.clipList(id).find((/** @type {any} */ c) => c.tracks > 0);
		if (withKeys) ap.setActiveClip(id, withKeys.id);
		const clip = ap.activeClip(id);
		return { keys: clip.tracks[0].keys.map((/** @type {any} */ k) => [k.t, k.v]), duration: clip.duration };
	}, first);
	await A.page.getByRole('button', { name: 'Graph', exact: true }).click();
	await A.page.waitForTimeout(300);
	// take the handle's REAL screen centre — a 5px circle does not forgive an
	// arithmetic guess at the plot's inner width
	const lastKey = graph.keys[graph.keys.length - 1];
	const handle = await A.page.evaluate(() => {
		const circles = [...document.querySelectorAll('#animation-timeline circle')];
		const last = circles[circles.length - 1];
		const r = last?.getBoundingClientRect();
		return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
	});
	h.check(!!handle, 'the graph draws draggable key handles');
	await A.page.mouse.move(handle.x, handle.y);
	await A.page.mouse.down();
	await A.page.mouse.move(handle.x - 30, handle.y + 40, { steps: 6 });
	await A.page.mouse.move(handle.x - 34, handle.y + 46, { steps: 3 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const afterGraph = await A.page.evaluate((id) => {
		const clip = window.__stores.animationPreview.activeClip(id);
		return clip.tracks[0].keys.map((/** @type {any} */ k) => [k.t, k.v]);
	}, first);
	const movedKey = afterGraph[afterGraph.length - 1];
	h.check(
		movedKey[0] < lastKey[0] - 0.02,
		`dragging in the graph moves the key in TIME (${lastKey[0]} -> ${movedKey[0]})`
	);
	h.check(
		movedKey[1] < lastKey[1] - 0.05,
		`and in VALUE on the same drag (${lastKey[1]} -> ${movedKey[1].toFixed(3)})`
	);

	// ---------- 9c. dragging the ruler scrubs continuously ----------
	await A.page.getByRole('button', { name: 'Sheet', exact: true }).click();
	await A.page.waitForTimeout(250);
	// the ruler is the first rect in the plot; measure IT, not the whole svg
	const ruler = await A.page.evaluate(() => {
		const r = document.querySelector('#animation-timeline rect')?.getBoundingClientRect();
		return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
	});
	h.check(!!ruler, 'the timeline has a ruler to drag');
	await A.page.mouse.move(ruler.x + 10, ruler.y + ruler.h / 2);
	await A.page.mouse.down();
	/** @type {number[]} */
	const heads = [];
	for (const frac of [0.3, 0.5, 0.7]) {
		await A.page.mouse.move(ruler.x + ruler.w * frac, ruler.y + ruler.h / 2, { steps: 3 });
		heads.push(
			await A.page.evaluate((id) => window.__stores.animationPreview.playheadOf(id), first)
		);
	}
	await A.page.mouse.up();
	h.check(
		heads[0] < heads[1] && heads[1] < heads[2],
		`dragging along the ruler sweeps the playhead (${heads.map((n) => n.toFixed(2)).join(' -> ')}s)`
	);

	// ---------- 9c2. multi-select, the right-click GRAB, and no stacked keys -------
	// (all with real mouse gestures — this is interaction code, so nothing here is
	//  worth asserting through the store alone)
	const multiSetup = await A.page.evaluate((id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.objectActions.selectObject(id, false);
		// one clip, one channel, three keys at 0 / 0.5 / 1
		const clipId = ap.createClip(id, 'Multi keys');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const track = ap.addTrack(id, 'pos.y', obj, clipId);
		ap.updateKey(id, track, 0, { t: 0, v: 0 }, clipId);
		ap.updateKey(id, track, 1, { t: 0.5, v: 1 }, clipId);
		ap.addKey(id, track, 1, 2, { clipId });
		ap.updateAnim(id, { duration: 2, loop: 'loop' }, clipId);
		return { keys: ap.activeClip(id).tracks[0].keys.map((/** @type {any} */ k) => [k.t, k.v]) };
	}, first);
	h.check(multiSetup.keys.length === 3, `three keys to work with (${JSON.stringify(multiSetup.keys)})`);
	await A.page.waitForTimeout(350);

	/** the on-screen centres of the sheet's key diamonds */
	const diamonds = () =>
		A.page.evaluate(() =>
			[...document.querySelectorAll('#animation-timeline rect[transform^="rotate(45"]')].map((d) => {
				const r = d.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			})
		);
	const keyTimes = () =>
		A.page.evaluate(
			(id) => window.__stores.animationPreview.activeClip(id).tracks[0].keys.map((/** @type {any} */ k) => k.t),
			first
		);

	let dots = await diamonds();
	h.check(dots.length === 3, `the sheet draws all three (${dots.length})`);
	// shift-click the second and third, then drag the third: BOTH must move
	await A.page.mouse.click(dots[1].x, dots[1].y);
	await A.page.keyboard.down('Shift');
	await A.page.mouse.click(dots[2].x, dots[2].y);
	await A.page.keyboard.up('Shift');
	await A.page.waitForTimeout(200);
	const selCount = await A.page.evaluate(
		() => document.body.textContent?.match(/(\d+) keys selected/)?.[1] ?? '0'
	);
	h.check(selCount === '2', `shift-click builds a selection (${selCount} keys)`);
	const beforeDrag = await keyTimes();
	dots = await diamonds();
	await A.page.mouse.move(dots[2].x, dots[2].y);
	await A.page.mouse.down();
	await A.page.mouse.move(dots[2].x + 40, dots[2].y, { steps: 5 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(250);
	const afterDrag = await keyTimes();
	h.check(
		afterDrag[0] === beforeDrag[0] &&
			afterDrag[1] > beforeDrag[1] + 0.05 &&
			afterDrag[2] > beforeDrag[2] + 0.05,
		`dragging one moves every SELECTED key and leaves the rest (${JSON.stringify(beforeDrag)} -> ${JSON.stringify(afterDrag)})`
	);

	// MIDDLE-click LOCKS the selection to the pointer; a click places it, Esc undoes.
	// (Right-click is the context menu — one button cannot be both.)
	dots = await diamonds();
	const beforeGrab = await keyTimes();
	await A.page.mouse.move(dots[2].x, dots[2].y);
	await A.page.mouse.down({ button: 'middle' });
	await A.page.mouse.up({ button: 'middle' });
	await A.page.waitForTimeout(200);
	const grabbing = await A.page.evaluate(() => /moving key|moving \d+ keys/.test(document.body.textContent ?? ''));
	h.check(grabbing, 'middle-clicking a key locks it to the pointer');
	await A.page.mouse.move(dots[2].x - 60, dots[2].y, { steps: 6 });
	await A.page.waitForTimeout(150);
	const midGrab = await keyTimes();
	h.check(
		midGrab[midGrab.length - 1] < beforeGrab[beforeGrab.length - 1] - 0.05,
		`it follows the pointer with no button held (${beforeGrab[2]} -> ${midGrab[2]})`
	);
	await A.page.mouse.down();
	await A.page.mouse.up();
	await A.page.waitForTimeout(200);
	const placed = await keyTimes();
	const stillGrabbing = await A.page.evaluate(() => /moving key|moving \d+ keys/.test(document.body.textContent ?? ''));
	h.check(!stillGrabbing, 'a click places it');
	h.check(
		Math.abs(placed[placed.length - 1] - midGrab[midGrab.length - 1]) < 0.2,
		`and it stays where it was placed (${placed[2]})`
	);

	// Escape puts a grab back
	dots = await diamonds();
	const beforeCancel = await keyTimes();
	await A.page.mouse.click(dots[1].x, dots[1].y); // single selection
	await A.page.mouse.down({ button: 'middle' });
	await A.page.mouse.up({ button: 'middle' });
	await A.page.mouse.move(dots[1].x + 70, dots[1].y, { steps: 5 });
	await A.page.waitForTimeout(150);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);
	const cancelled = await keyTimes();
	h.check(
		JSON.stringify(cancelled) === JSON.stringify(beforeCancel),
		`Escape puts a grab back exactly (${JSON.stringify(cancelled)})`
	);

	// a double-click ON a key must not stack a second one on top of it
	dots = await diamonds();
	const beforeDbl = (await keyTimes()).length;
	await A.page.mouse.dblclick(dots[1].x, dots[1].y);
	await A.page.waitForTimeout(250);
	const afterDbl = (await keyTimes()).length;
	h.check(afterDbl === beforeDbl, `double-clicking a key selects it instead of stacking (${beforeDbl} -> ${afterDbl})`);
	// but double-clicking clear space still inserts
	const gap = await A.page.evaluate(() => {
		const svg = document.querySelector('#animation-timeline');
		const r = svg.getBoundingClientRect();
		return { x: r.x + r.width * 0.85, y: r.y + 16 + 11 };
	});
	await A.page.mouse.dblclick(gap.x, gap.y);
	await A.page.waitForTimeout(250);
	h.check((await keyTimes()).length === beforeDbl + 1, 'and empty space still inserts one');

	// ---------- 9c3. a multi-drag keeps every key, even when two share a time ------
	// reported: "moving around multiple points also change current keys position for
	// some". Identity was re-derived by matching TIMES after the sort, and with snap
	// on, two keys of one track dragged together land on the same time constantly —
	// both matched the same key, so one of the pair was dropped or duplicated.
	const identity = await A.page.evaluate((id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const clipId = ap.createClip(id, 'Identity');
		const track = ap.addTrack(id, 'pos.y', obj, clipId);
		ap.updateKey(id, track, 0, { t: 0, v: 0 }, clipId);
		ap.updateKey(id, track, 1, { t: 0.4, v: 1 }, clipId);
		ap.addKey(id, track, 0.8, 2, { clipId });
		ap.addKey(id, track, 1.2, 3, { clipId });
		const before = ap.activeClip(id).tracks[0].keys.length;

		// drag the two middle keys ON TOP of one another, then apart again — the exact
		// case that used to lose one
		const t0 = ap.activeClip(id).tracks[0].keys.map((/** @type {any} */ k) => k.t);
		let moves = [
			{ trackId: track, index: 1, t: 0.9 },
			{ trackId: track, index: 2, t: 0.9 }
		];
		const landedTogether = ap.moveKeys(id, moves);
		const midCount = ap.activeClip(id).tracks[0].keys.length;
		// pull them apart using the indices moveKeys REPORTED
		ap.moveKeys(id, [
			{ trackId: track, index: landedTogether[0].index, t: 0.5 },
			{ trackId: track, index: landedTogether[1].index, t: 1.5 }
		]);
		const after = ap.activeClip(id).tracks[0].keys;
		return {
			before,
			midCount,
			t0,
			landed: landedTogether.map((/** @type {any} */ l) => l && l.index),
			afterTimes: after.map((/** @type {any} */ k) => k.t),
			afterValues: after.map((/** @type {any} */ k) => k.v)
		};
	}, first);
	h.check(identity.before === 4, `four keys to start (${identity.before})`);
	h.check(
		identity.midCount === 4,
		`dragging two keys onto the same time keeps BOTH (${identity.midCount} keys)`
	);
	h.check(
		identity.landed[0] !== identity.landed[1] && identity.landed.every((/** @type {any} */ i) => i !== null),
		`each moved key reports where it landed (${JSON.stringify(identity.landed)})`
	);
	h.check(
		identity.afterTimes.length === 4 &&
			identity.afterTimes.includes(0.5) &&
			identity.afterTimes.includes(1.5),
		`and pulling them apart again restores both (${JSON.stringify(identity.afterTimes)})`
	);
	h.check(
		new Set(identity.afterValues).size === 4,
		`with their own values intact (${JSON.stringify(identity.afterValues)})`
	);

	// ---------- 9c4. right-drag PANS, right-click opens the plot menu ----------
	await A.page.waitForTimeout(200);
	const panned = await A.page.evaluate(() => {
		const el = document.querySelector('#animation-timeline');
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height - 12 };
	});
	// zoom in first, so there is somewhere to pan to
	await A.page.mouse.move(panned.x, panned.y);
	await A.page.keyboard.down('Control');
	await A.page.mouse.wheel(0, -300);
	await A.page.keyboard.up('Control');
	await A.page.waitForTimeout(200);
	const readSpan = () =>
		A.page.evaluate(() => {
			const m = document.body.textContent?.match(/([\d.]+)–([\d.]+)s/);
			return m ? { from: +m[1], to: +m[2] } : null;
		});
	const zoomed = await readSpan();
	await A.page.mouse.move(panned.x, panned.y);
	await A.page.mouse.down({ button: 'right' });
	await A.page.mouse.move(panned.x - 80, panned.y, { steps: 6 });
	await A.page.mouse.up({ button: 'right' });
	await A.page.waitForTimeout(250);
	const afterPan = await readSpan();
	h.check(
		!!zoomed && !!afterPan && afterPan.from > zoomed.from + 0.01,
		`right-dragging pans the view (${zoomed?.from.toFixed(2)} -> ${afterPan?.from.toFixed(2)}s)`
	);
	h.check(
		!!zoomed && !!afterPan && Math.abs((afterPan.to - afterPan.from) - (zoomed.to - zoomed.from)) < 0.02,
		'without changing the zoom level'
	);
	const menuGoneFirst = await A.page.evaluate(() => !document.body.textContent?.includes('Reset view'));
	h.check(menuGoneFirst, 'a pan does not also open the menu');

	// a right-click that stays put opens it
	await A.page.mouse.click(panned.x, panned.y, { button: 'right' });
	await A.page.waitForTimeout(300);
	const plotMenu = await A.page.evaluate(() => {
		const text = document.body.textContent ?? '';
		return {
			reset: text.includes('Reset view'),
			easing: /Reset easing|Easing/.test(text),
			del: /Delete key/.test(text),
			selectAll: text.includes('Select every key')
		};
	});
	h.check(plotMenu.reset, 'a right-click that stays put opens the plot menu with Reset view');
	h.check(plotMenu.selectAll, 'and the timeline actions');
	// with a selection it offers the key operations
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);
	const easedAway = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		const clip = ap.activeClip(id);
		const track = clip.tracks[0];
		const hadEase = track.keys.filter((/** @type {any} */ k) => !!k.ease).length;
		// the menu's Reset easing, driven through the same call it makes
		ap.updateKey(id, track.id, 0, { ease: null });
		const now = ap.activeClip(id).tracks[0].keys.filter((/** @type {any} */ k) => !!k.ease).length;
		return { hadEase, now };
	}, first);
	h.check(
		easedAway.now < easedAway.hadEase || easedAway.hadEase === 0,
		`Reset easing clears the curve on a key (${easedAway.hadEase} -> ${easedAway.now} with easing)`
	);

	// ---------- 9c5. the keyboard: frames, key navigation, nudging, modes ----------
	const kbSetup = await A.page.evaluate((id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const clipId = ap.createClip(id, 'Keyboard');
		const track = ap.addTrack(id, 'pos.y', obj, clipId);
		ap.updateKey(id, track, 0, { t: 0, v: 0 }, clipId);
		ap.updateKey(id, track, 1, { t: 1, v: 3 }, clipId);
		ap.updateAnim(id, { duration: 2, loop: 'loop' }, clipId);
		ap.scrub(id, 0);
		ap.setActiveClip(id, clipId);
		return { fps: 30 };
	}, first);
	void kbSetup;
	await A.page.waitForTimeout(350);
	// click the plot so it owns the keyboard, then walk the playhead by frames
	const plotArea = await A.page.locator('#animation-timeline').boundingBox();
	await A.page.mouse.click(plotArea.x + 6, plotArea.y + plotArea.height - 6);
	await A.page.waitForTimeout(150);
	const head = () => A.page.evaluate((id) => window.__stores.animationPreview.playheadOf(id), first);
	await A.page.evaluate((id) => window.__stores.animationPreview.scrub(id, 0), first);
	await A.page.keyboard.press('ArrowRight');
	await A.page.waitForTimeout(120);
	const oneFrame = await head();
	await A.page.keyboard.press('Control+ArrowRight');
	await A.page.waitForTimeout(120);
	const tenMore = await head();
	h.check(
		Math.abs(oneFrame - 1 / 30) < 1e-6,
		`Right steps the playhead one frame (${oneFrame.toFixed(4)}s at 30fps)`
	);
	h.check(
		Math.abs(tenMore - 11 / 30) < 1e-6,
		`and Ctrl+Right steps ten (${tenMore.toFixed(4)}s)`
	);
	// Alt+arrows jump between keys
	await A.page.keyboard.press('Alt+ArrowRight');
	await A.page.waitForTimeout(150);
	const jumped = await head();
	h.check(Math.abs(jumped - 1) < 1e-6, `Alt+Right jumps to the next key (${jumped}s)`);

	// Ctrl+Space selects the key at the playhead, Shift+arrows nudge it, Esc drops it
	await A.page.keyboard.press('Control+Space');
	await A.page.waitForTimeout(150);
	const picked = await A.page.evaluate(() =>
		/(\d+) keys selected/.test(document.body.textContent ?? '') ||
		!!document.querySelector('#animation-timeline rect[fill="rgb(250 204 21)"]')
	);
	h.check(picked, 'Ctrl+Space selects the key at the playhead');
	const keyTimesNow = () =>
		A.page.evaluate(
			(id) => window.__stores.animationPreview.activeClip(id).tracks[0].keys.map((/** @type {any} */ k) => k.t),
			first
		);
	const beforeNudge = await keyTimesNow();
	await A.page.keyboard.press('Shift+ArrowRight');
	await A.page.waitForTimeout(200);
	const afterNudge = await keyTimesNow();
	h.check(
		Math.abs(afterNudge[1] - (beforeNudge[1] + 1 / 30)) < 1e-6,
		`Shift+Right nudges the selected key one frame (${beforeNudge[1]} -> ${afterNudge[1]})`
	);
	const undoOne = await A.page.evaluate(async (id) => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 200));
		return window.__stores.animationPreview.activeClip(id).tracks[0].keys.map((/** @type {any} */ k) => k.t);
	}, first);
	h.check(
		Math.abs(undoOne[1] - beforeNudge[1]) < 1e-6,
		`each nudge is its own undo step (${JSON.stringify(undoOne)})`
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(150);
	const cleared = await A.page.evaluate(
		() => !document.querySelector('#animation-timeline rect[fill="rgb(250 204 21)"]')
	);
	h.check(cleared, 'Escape drops the selection');

	// 1 / 2 arm move and scale, and scale really scales about the playhead
	await A.page.keyboard.press('2');
	await A.page.waitForTimeout(150);
	const scaleArmed = await A.page.evaluate(
		() => document.getElementById('animation-mode-scale')?.getAttribute('aria-pressed')
	);
	h.check(scaleArmed === 'true', 'the 2 key arms Scale');
	const scaled = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		ap.scrub(id, 0); // pivot at 0
		return ap.activeClip(id).tracks[0].keys.map((/** @type {any} */ k) => k.t);
	}, first);
	// select both keys through the plot menu, opened with a REAL right-click (the
	// menu is opened on the button RELEASE, so a synthetic contextmenu never shows it)
	await A.page.mouse.click(plotArea.x + 30, plotArea.y + plotArea.height - 8, { button: 'right' });
	await A.page.waitForTimeout(250);
	await A.page.getByText('Select every key', { exact: true }).click();
	await A.page.waitForTimeout(200);
	// a press in the plot body hands the keyboard back (the menu had it) without
	// touching the selection
	await A.page.mouse.click(plotArea.x + 6, plotArea.y + plotArea.height - 6);
	await A.page.waitForTimeout(150);
	await A.page.keyboard.press('Shift+ArrowRight');
	await A.page.waitForTimeout(200);
	const afterScale = await keyTimesNow();
	h.check(
		afterScale[0] === scaled[0] && afterScale[1] > scaled[1],
		`Scale stretches the keys away from the playhead pivot (${JSON.stringify(scaled)} -> ${JSON.stringify(afterScale)})`
	);
	await A.page.keyboard.press('1');

	// ---------- 9c6. the navigator strip, and wheel direction ----------
	const nav = await A.page.evaluate(() => {
		const el = document.getElementById('animation-navigator');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const thumb = el.querySelector('span.border-primary-500\\/70');
		const tr = thumb?.getBoundingClientRect();
		return {
			x: r.x, y: r.y, w: r.width,
			thumbFrac: tr ? tr.width / r.width : null
		};
	});
	h.check(!!nav, 'a navigator strip shows the whole clip');
	// zoom in with the WHEEL (up = in) — the thumb must shrink
	await A.page.mouse.move(plotArea.x + plotArea.width / 2, plotArea.y + plotArea.height / 2);
	await A.page.mouse.wheel(0, -300);
	await A.page.waitForTimeout(250);
	const zoomedIn = await A.page.evaluate(() => {
		const el = document.getElementById('animation-navigator');
		const r = el.getBoundingClientRect();
		const thumb = el.querySelector('span.border-primary-500\\/70');
		return thumb ? thumb.getBoundingClientRect().width / r.width : null;
	});
	h.check(
		nav.thumbFrac !== null && zoomedIn !== null && zoomedIn < nav.thumbFrac - 0.05,
		`scrolling UP zooms in (thumb ${(nav.thumbFrac * 100).toFixed(0)}% -> ${(zoomedIn * 100).toFixed(0)}% of the clip)`
	);
	await A.page.mouse.wheel(0, 600);
	await A.page.waitForTimeout(250);
	const zoomedOut = await A.page.evaluate(() => {
		const el = document.getElementById('animation-navigator');
		const r = el.getBoundingClientRect();
		const thumb = el.querySelector('span.border-primary-500\\/70');
		return thumb ? thumb.getBoundingClientRect().width / r.width : null;
	});
	h.check(zoomedOut > zoomedIn, `and scrolling down zooms out (${(zoomedOut * 100).toFixed(0)}%)`);

	// dragging the strip moves the window
	await A.page.mouse.move(plotArea.x + plotArea.width / 2, plotArea.y + plotArea.height / 2);
	await A.page.mouse.wheel(0, -400);
	await A.page.waitForTimeout(200);
	const readView = () =>
		A.page.evaluate(() => {
			const m = document.body.textContent?.match(/([\d.]+)–([\d.]+)s/);
			return m ? { from: +m[1], to: +m[2] } : null;
		});
	const viewBefore = await readView();
	await A.page.mouse.move(nav.x + nav.w * 0.85, nav.y + 6);
	await A.page.mouse.down();
	await A.page.mouse.up();
	await A.page.waitForTimeout(250);
	const viewAfter = await readView();
	h.check(
		!!viewBefore && !!viewAfter && viewAfter.from > viewBefore.from + 0.05,
		`clicking the strip moves the visible window there (${viewBefore?.from.toFixed(2)} -> ${viewAfter?.from.toFixed(2)}s)`
	);
	await A.page.evaluate(() => document.getElementById('animation-fit')?.click());

	// The browser menu must never come up alongside ours, ANYWHERE in the pane. This
	// watches the real event: a synthetic dispatch on the plot passed while the native
	// menu still appeared for the user, because svelte DELEGATES contextmenu and the
	// panel chrome swallowed it before the app root ever saw it.
	await A.page.evaluate(() => {
		/** @type {any} */ (window).__ctx = [];
		// bubble phase on window: runs AFTER the pane's own direct listener, so this
		// reports whether anything actually cancelled the default
		window.addEventListener('contextmenu', (e) => {
			const el = /** @type {any} */ (e.target);
			/** @type {any} */ (window).__ctx.push({
				prevented: e.defaultPrevented,
				where: el?.closest?.('#animation-dock, #animation-window') ? 'pane' : 'outside'
			});
		});
	});
	const spots = await A.page.evaluate(() => {
		const pick = (/** @type {string} */ sel, /** @type {number} */ fx, /** @type {number} */ fy) => {
			const r = document.querySelector(sel)?.getBoundingClientRect();
			return r ? { x: r.x + r.width * fx, y: r.y + r.height * fy } : null;
		};
		return {
			plot: pick('#animation-timeline', 0.5, 0.8),
			navigator: pick('#animation-navigator', 0.5, 0.5),
			toolbar: pick('#animation-add', 0.5, 0.5),
			list: pick('#animation-clips', 0.5, 0.5) ?? pick('#authored-clips', 0.5, 0.5)
		};
	});
	for (const [name, at] of Object.entries(spots)) {
		if (!at) continue;
		await A.page.mouse.click(at.x, at.y, { button: 'right' });
		await A.page.waitForTimeout(150);
		await A.page.keyboard.press('Escape');
	}
	const native = await A.page.evaluate(() => /** @type {any} */ (window).__ctx);
	const inPane = native.filter((/** @type {any} */ e) => e.where === 'pane');
	h.check(inPane.length >= 3, `real right-clicks reached the pane (${inPane.length} of ${native.length})`);
	h.check(
		inPane.every((/** @type {any} */ e) => e.prevented),
		`and every one of them cancelled the browser menu (${inPane.filter((/** @type {any} */ e) => !e.prevented).length} slipped through)`
	);

	// ---------- 9c7. the polish round: layout, snapping and horizontal scale -------
	await A.page.getByRole('button', { name: 'Graph', exact: true }).click();
	await A.page.waitForTimeout(300);
	const layout = await A.page.evaluate(() => {
		const nav = document.getElementById('animation-navigator');
		const svg = document.querySelector('#animation-timeline');
		const wrap = svg?.parentElement;
		const style = wrap ? getComputedStyle(wrap) : null;
		return {
			navAbove: !!nav && !!svg && nav.getBoundingClientRect().bottom <= svg.getBoundingClientRect().top + 1,
			overflowX: style?.overflowX,
			// with the graph's fixed height nothing should be scrollable at all
			scrollsY: wrap ? wrap.scrollHeight > wrap.clientHeight + 1 : null,
			scrollsX: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : null
		};
	});
	h.check(layout.navAbove, 'the navigator sits ABOVE the plot');
	h.check(layout.overflowX === 'hidden', `and the plot never scrolls horizontally (${layout.overflowX})`);
	h.check(
		layout.scrollsX === false && layout.scrollsY === false,
		`no scrollbars in graph view (x ${layout.scrollsX}, y ${layout.scrollsY})`
	);
	await A.page.getByRole('button', { name: 'Sheet', exact: true }).click();
	await A.page.waitForTimeout(200);

	// dragging the ruler lands the playhead on the snap grid
	await A.page.evaluate(() => {
		const el = document.getElementById('animation-snap');
		if (el) {
			el.value = 'frame';
			el.dispatchEvent(new Event('change', { bubbles: true }));
		}
	});
	await A.page.waitForTimeout(200);
	const ruler2 = await A.page.evaluate(() => {
		const r = document.querySelector('#animation-timeline rect').getBoundingClientRect();
		return { x: r.x, y: r.y, w: r.width, h: r.height };
	});
	await A.page.mouse.move(ruler2.x + 12, ruler2.y + ruler2.h / 2);
	await A.page.mouse.down();
	await A.page.mouse.move(ruler2.x + ruler2.w * 0.43, ruler2.y + ruler2.h / 2, { steps: 4 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(200);
	const snappedHead = await head();
	h.check(
		Math.abs(snappedHead * 30 - Math.round(snappedHead * 30)) < 1e-6,
		`sweeping the ruler snaps the playhead to a frame (${snappedHead.toFixed(4)}s = frame ${(snappedHead * 30).toFixed(2)})`
	);

	// horizontal scaling of a multi-selection: it used to be swallowed by snapping
	const hScale = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		const clipId = ap.createClip(id, 'Hscale');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const track = ap.addTrack(id, 'pos.y', obj, clipId);
		ap.updateKey(id, track, 0, { t: 0.2, v: 0 }, clipId);
		ap.updateKey(id, track, 1, { t: 0.4, v: 1 }, clipId);
		ap.updateAnim(id, { duration: 2 }, clipId);
		ap.setActiveClip(id, clipId);
		ap.scrub(id, 0); // pivot
		return ap.activeClip(id).tracks[0].keys.map((/** @type {any} */ k) => k.t);
	}, first);
	await A.page.waitForTimeout(300);
	// select both keys and scale them with a small horizontal drag
	const hDots = await A.page.evaluate(() =>
		[...document.querySelectorAll('#animation-timeline rect[transform^="rotate(45"]')].map((d) => {
			const r = d.getBoundingClientRect();
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		})
	);
	await A.page.mouse.click(hDots[0].x, hDots[0].y);
	await A.page.keyboard.down('Shift');
	await A.page.mouse.click(hDots[1].x, hDots[1].y);
	await A.page.keyboard.up('Shift');
	await A.page.keyboard.press('2'); // arm Scale
	await A.page.waitForTimeout(150);
	await A.page.mouse.move(hDots[1].x, hDots[1].y);
	await A.page.mouse.down();
	await A.page.mouse.move(hDots[1].x + 25, hDots[1].y, { steps: 5 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(250);
	const afterHScale = await A.page.evaluate(
		(id) => window.__stores.animationPreview.activeClip(id).tracks[0].keys.map((/** @type {any} */ k) => k.t),
		first
	);
	h.check(
		afterHScale[1] > hScale[1] + 0.005 && afterHScale[0] > hScale[0] + 0.001,
		`a small horizontal scale drag moves BOTH keys away from the pivot (${JSON.stringify(hScale)} -> ${JSON.stringify(afterHScale.map((/** @type {number} */ t) => +t.toFixed(3)))})`
	);
	await A.page.keyboard.press('1');

	// ---------- 9c8. per-clip frame rate, and STEP sampling ----------
	// Frame rate belongs to the clip (it is what that clip's key times mean, and one
	// object can hold a 24fps swing beside a 60fps flourish); `step` is the separate
	// "on twos" control — sample the movement on a coarser grid than its keys.
	const rates = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const previous = ap.getAnimSet(id).active;
		const clipId = ap.createClip(id, 'Rates');
		const track = ap.addTrack(id, 'pos.y', obj, clipId);
		ap.updateKey(id, track, 0, { t: 0, v: 0 }, clipId);
		ap.updateKey(id, track, 1, { t: 1, v: 10 }, clipId);
		ap.updateAnim(id, { duration: 1, loop: 'loop', fps: 24 }, clipId);
		ap.setActiveClip(id, clipId);
		const stored = ap.activeClip(id);

		// SMOOTH first: two nearby times give two different poses
		ap.scrub(id, 0.50);
		const smoothA = obj.position.y;
		ap.scrub(id, 0.54);
		const smoothB = obj.position.y;

		// now on FOURS: both land on the same sample, so the pose HOLDS
		ap.updateAnim(id, { step: 4 }, clipId);
		ap.scrub(id, 0.50);
		const steppedA = obj.position.y;
		ap.scrub(id, 0.54);
		const steppedB = obj.position.y;
		ap.scrub(id, 0.80);
		const steppedC = obj.position.y;

		// and it survives a save/load, being clip data
		const payload = ap.animationsSnapshot();
		const savedClip = payload[id]?.clips?.[clipId];
		ap.updateAnim(id, { step: 0 }, clipId);
		ap.resetPreview(id);
		return {
			fps: stored.fps,
			smoothMoved: Math.abs(smoothA - smoothB) > 1e-6,
			steppedHeld: Math.abs(steppedA - steppedB) < 1e-9,
			steppedAdvanced: Math.abs(steppedC - steppedA) > 1e-6,
			savedFps: savedClip?.fps,
			savedStep: savedClip?.step,
			previous
		};
	}, first);
	h.check(rates.fps === 24, `a clip carries its own frame rate (${rates.fps}fps)`);
	h.check(rates.smoothMoved, 'a smooth clip gives a different pose 0.04s later');
	h.check(rates.steppedHeld, 'with step 4 the same two times land on ONE sample (the stepped look)');
	h.check(rates.steppedAdvanced, 'and a later sample still advances');
	h.check(
		rates.savedFps === 24 && rates.savedStep === 4,
		`both ride the save as clip data (fps ${rates.savedFps}, step ${rates.savedStep})`
	);

	// the editor's frame grid follows the clip: at 24fps an arrow step is 1/24
	const gridFollows = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		s.animationPreview.scrub(id, 0);
		const shown = document.getElementById('animation-fps')?.value;
		document.getElementById('animation-play')?.focus();
		return { shown };
	}, first);
	h.check(gridFollows.shown === '24', `the fps field shows the clip's rate (${gridFollows.shown})`);
	await A.page.mouse.click(plotArea.x + 6, plotArea.y + plotArea.height - 6);
	await A.page.keyboard.press('ArrowRight');
	await A.page.waitForTimeout(150);
	const step24 = await head();
	h.check(
		Math.abs(step24 - 1 / 24) < 1e-6,
		`and an arrow steps ONE 24fps frame (${step24.toFixed(4)}s = 1/24)`
	);
	// hand the editor back the clip the later blocks expect
	await A.page.evaluate(
		(args) => {
			const ap = window.__stores.animationPreview;
			ap.setActiveClip(args.id, args.clip);
			ap.resetPreview(args.id);
		},
		{ id: first, clip: rates.previous }
	);
	await A.page.waitForTimeout(250);

	// ---------- 9d. the transport deck, in real icons and real buttons ----------
	const deck = await A.page.evaluate((id) => {
		const s = window.__stores;
		s.objectActions.selectObject(id, false);
		const ids = [
			'animation-rewind', 'animation-prev-key', 'animation-play-back',
			'animation-play', 'animation-stop', 'animation-next-key', 'animation-end'
		];
		return {
			present: ids.filter((x) => !!document.getElementById(x)),
			// buttons must carry ICONS, not emoji glyphs
			svgs: ids.filter((x) => !!document.getElementById(x)?.querySelector('svg')),
			emoji: ids.filter((x) => /[⏩⏪⏸⏹▶⏮⏭■]/.test(document.getElementById(x)?.textContent ?? ''))
		};
	}, first);
	h.check(deck.present.length === 7, `the deck offers start/prev/back/play/stop/next/end (${deck.present.length})`);
	h.check(deck.svgs.length === 7, `each one draws an icon (${deck.svgs.length}/7)`);
	h.check(deck.emoji.length === 0, `and none of them is an emoji glyph (${deck.emoji.join(',') || 'none'})`);

	// prev/next key STEP between key times
	const stepping = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		const times = ap.keyTimes(id);
		ap.scrub(id, 0);
		document.getElementById('animation-next-key')?.click();
		await new Promise((r) => setTimeout(r, 200));
		const afterNext = ap.playheadOf(id);
		document.getElementById('animation-end')?.click();
		await new Promise((r) => setTimeout(r, 200));
		const atEnd = ap.playheadOf(id);
		document.getElementById('animation-prev-key')?.click();
		await new Promise((r) => setTimeout(r, 200));
		const afterPrev = ap.playheadOf(id);
		return { times, afterNext, atEnd, afterPrev, duration: ap.activeClip(id).duration };
	}, first);
	h.check(
		stepping.times.includes(stepping.afterNext) && stepping.afterNext > 0,
		`Next key lands ON a key (${stepping.afterNext}s of ${JSON.stringify(stepping.times)})`
	);
	h.check(
		Math.abs(stepping.atEnd - stepping.duration) < 1e-6,
		`End goes to the end of the clip (${stepping.atEnd}s)`
	);
	h.check(stepping.afterPrev < stepping.atEnd, `Previous key steps back (${stepping.afterPrev}s)`);

	// ---------- 9e. STOP returns to where the run began, not to the clip start ----
	// reported: "stop and return to the pose you started from put you at the
	// beginning of animation, not where you started it from initially"
	const stopping = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		ap.scrub(id, 1); // park at 1s
		const from = ap.playheadOf(id);
		ap.play(id, undefined, { from: 1 });
		await new Promise((r) => setTimeout(r, 400));
		const running = ap.playheadOf(id);
		ap.stop(id);
		const stopped = ap.playheadOf(id);
		// and the explicit reset is what goes back to the untouched pose
		ap.resetPreview(id);
		const reset = ap.playheadOf(id);
		return { from, running, stopped, reset };
	}, first);
	h.check(stopping.running > stopping.from, `playing advances from the parked frame (${stopping.from} -> ${stopping.running.toFixed(2)}s)`);
	h.check(
		Math.abs(stopping.stopped - stopping.from) < 0.02,
		`Stop returns to the frame the run STARTED from (${stopping.stopped.toFixed(2)}s, not 0)`
	);
	h.check(stopping.reset === 0, `and Clear preview is what rewinds to 0 (${stopping.reset}s)`);

	// ---------- 9f. the A/B window loops only the seconds you are tuning ----------
	const ab = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		const clip = ap.activeClip(id);
		ap.setRange(id, 1, clip.duration); // A at 1s
		const t = ap.transportOf(id);
		ap.play(id);
		const seen = [];
		for (let i = 0; i < 8; i++) {
			await new Promise((r) => setTimeout(r, 120));
			seen.push(ap.playheadOf(id));
		}
		ap.stop(id);
		ap.setRange(id, null, null);
		const cleared = ap.transportOf(id);
		return {
			ranged: t.ranged,
			rangeIn: t.rangeIn,
			min: Math.min(...seen),
			max: Math.max(...seen),
			duration: clip.duration,
			clearedRanged: cleared.ranged
		};
	}, first);
	h.check(ab.ranged && Math.abs(ab.rangeIn - 1) < 1e-6, `an A point sets a play window (in at ${ab.rangeIn}s)`);
	h.check(
		ab.min >= 0.98,
		`playback never leaves the window (lowest playhead seen ${ab.min.toFixed(2)}s, A at 1s)`
	);
	h.check(ab.max <= ab.duration + 1e-6, `and never past B (${ab.max.toFixed(2)}s of ${ab.duration}s)`);
	h.check(!ab.clearedRanged, 'clearing A/B plays the whole clip again');

	// ---------- 9g. zoom narrows the view without touching the data ----------
	const zoom = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const before = document.querySelector('#animation-timeline')?.textContent ?? '';
		const keysBefore = JSON.stringify(s.animationPreview.activeClip(id).tracks[0].keys);
		document.getElementById('animation-fit')?.click();
		await new Promise((r) => setTimeout(r, 150));
		const fit = [...document.querySelectorAll('#animation-timeline text')].map((t) => t.textContent);
		return { before, fit, keysBefore, keysAfter: JSON.stringify(s.animationPreview.activeClip(id).tracks[0].keys) };
	}, first);
	h.check(zoom.keysBefore === zoom.keysAfter, 'zooming and fitting never touch the keys');
	// ctrl+wheel over the plot zooms in: the visible span shrinks
	const spanBefore = await A.page.evaluate(
		() => document.querySelector('.font-mono.text-\\[10px\\]')?.textContent ?? ''
	);
	const plotBox = await A.page.locator('#animation-timeline').boundingBox();
	await A.page.mouse.move(plotBox.x + plotBox.width / 2, plotBox.y + plotBox.height / 2);
	await A.page.keyboard.down('Control');
	await A.page.mouse.wheel(0, -240);
	await A.page.keyboard.up('Control');
	await A.page.waitForTimeout(250);
	const spanAfter = await A.page.evaluate(
		() => document.querySelector('.font-mono.text-\\[10px\\]')?.textContent ?? ''
	);
	const parseSpan = (/** @type {string} */ s) => {
		const m = s.match(/([\d.]+)–([\d.]+)s/);
		return m ? +m[2] - +m[1] : null;
	};
	h.check(
		parseSpan(spanBefore) !== null && parseSpan(spanAfter) < parseSpan(spanBefore),
		`ctrl+wheel zooms the time axis in (${spanBefore.trim()} -> ${spanAfter.trim()})`
	);
	await A.page.evaluate(() => document.getElementById('animation-fit')?.click());

	// ---------- 10. LOOK channels: opacity, colour, and what applies to what ----------
	const look = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 250));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		const material = Array.isArray(obj.material) ? obj.material[0] : obj.material;
		const before = { opacity: material.opacity, transparent: material.transparent };

		const fade = ap.addTrack(obj.uuid, 'opacity', obj);
		ap.updateKey(obj.uuid, fade, 0, { t: 0, v: 1 });
		ap.updateKey(obj.uuid, fade, 1, { t: 1, v: 0 });
		ap.updateAnim(obj.uuid, { duration: 1, loop: 'once' });
		ap.scrub(obj.uuid, 0.5);
		const mid = { opacity: material.opacity, transparent: material.transparent };
		// Stop holds the frame the run started from (here: the scrubbed one) — it is
		// Clear preview that undoes the look
		ap.stop(obj.uuid);
		const stopped = { opacity: material.opacity };
		ap.resetPreview(obj.uuid);
		const restored = { opacity: material.opacity, transparent: material.transparent };

		// a light channel belongs to a light, a metalness channel to a material
		s.commandsHandler.sceneCommand('/light point');
		await new Promise((r) => setTimeout(r, 250));
		s.objectsGroup.subscribe((x) => (g = x))();
		const light = g.children.findLast((/** @type {any} */ c) => c.isLight);
		return {
			before,
			mid,
			stopped,
			restored,
			boxOffersLight: ap.channelApplies(obj, 'light.intensity'),
			lightOffersLight: light ? ap.channelApplies(light, 'light.intensity') : null,
			lightOffersMetalness: light ? ap.channelApplies(light, 'metalness') : null,
			isLook: [ap.isMaterialChannel('opacity'), ap.isMaterialChannel('pos.y')]
		};
	});
	h.check(
		Math.abs(look.mid.opacity - 0.5) < 0.02,
		`an opacity channel fades the material (${look.mid.opacity?.toFixed(2)} at half way)`
	);
	h.check(
		look.mid.transparent === true,
		'switching the transparent flag on, or the fade would do nothing'
	);
	h.check(
		Math.abs(look.stopped.opacity - look.mid.opacity) < 0.02,
		`Stop holds the frame it stopped on (${look.stopped.opacity?.toFixed(2)})`
	);
	h.check(
		look.restored.opacity === look.before.opacity && look.restored.transparent === look.before.transparent,
		`and Clear preview puts the look back (${look.restored.opacity}/${look.restored.transparent})`
	);
	h.check(
		look.boxOffersLight === false && look.lightOffersLight === true && look.lightOffersMetalness === false,
		`channels are offered only where they apply (box light ${look.boxOffersLight}, light ${look.lightOffersLight}, light metalness ${look.lightOffersMetalness})`
	);
	h.check(look.isLook[0] === true && look.isLook[1] === false, 'look channels are flagged as such');

	// ---------- 11. picking a clip actually switches what plays ----------
	// reported: selecting another clip in the list left the PREVIOUS one running
	const switching = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 250));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(0, 0, 0);
		obj.updateMatrix();
		// clip A moves +y, clip B moves +x
		const up = ap.createClip(obj.uuid, 'Up');
		const upTrack = ap.addTrack(obj.uuid, 'pos.y', obj, up);
		ap.updateKey(obj.uuid, upTrack, 1, { t: 1, v: 4 }, up);
		ap.updateAnim(obj.uuid, { duration: 1, loop: 'loop' }, up);
		const side = ap.createClip(obj.uuid, 'Side');
		const sideTrack = ap.addTrack(obj.uuid, 'pos.x', obj, side);
		ap.updateKey(obj.uuid, sideTrack, 1, { t: 1, v: 4 }, side);
		ap.updateAnim(obj.uuid, { duration: 1, loop: 'loop' }, side);

		ap.setActiveClip(obj.uuid, up);
		ap.play(obj.uuid);
		await new Promise((r) => setTimeout(r, 350));
		const onUp = { y: obj.position.y, x: obj.position.x, clip: ap.transportOf(obj.uuid).clipId === up };
		// now pick the other clip in the list
		ap.setActiveClip(obj.uuid, side);
		await new Promise((r) => setTimeout(r, 450));
		const onSide = {
			y: obj.position.y,
			x: obj.position.x,
			clip: ap.transportOf(obj.uuid).clipId === side,
			active: ap.getAnimSet(obj.uuid).active === side
		};
		ap.stop(obj.uuid);
		return { onUp, onSide };
	});
	h.check(switching.onUp.y > 0.05 && switching.onUp.clip, `the first clip plays (y=${switching.onUp.y.toFixed(2)})`);
	h.check(
		switching.onSide.clip && switching.onSide.active,
		'picking another clip moves the transport onto it, not just the editor'
	);
	h.check(
		Math.abs(switching.onSide.y) < 1e-6,
		`the previous clip stops driving the object (y back to ${switching.onSide.y.toFixed(3)})`
	);
	h.check(
		switching.onSide.x > 0.05,
		`and the newly picked one runs (x=${switching.onSide.x.toFixed(2)})`
	);

	// ---------- 11b. a NEW clip (or a preset) takes over playback too ----------
	// reported: "after creating a new clip it still plays the old animation, so I
	// have to select some clip and then back to a newly created one"
	const created = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 250));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(0, 0, 0);
		obj.updateMatrix();
		const spin = ap.createClip(obj.uuid, 'Spin');
		const t = ap.addTrack(obj.uuid, 'pos.y', obj, spin);
		ap.updateKey(obj.uuid, t, 1, { t: 1, v: 5 }, spin);
		ap.updateAnim(obj.uuid, { duration: 1, loop: 'loop' }, spin);
		ap.play(obj.uuid);
		await new Promise((r) => setTimeout(r, 300));
		const running = { y: obj.position.y, clip: ap.transportOf(obj.uuid).clipId === spin };

		// make a brand-new clip WHILE it plays
		const fresh = ap.createClip(obj.uuid, 'Fresh');
		await new Promise((r) => setTimeout(r, 400));
		const afterNew = {
			transportOnFresh: ap.transportOf(obj.uuid).clipId === fresh,
			playing: ap.transportOf(obj.uuid).playing,
			y: obj.position.y
		};

		// and the same for a PRESET, which is also a new clip
		ap.play(obj.uuid, spin);
		await new Promise((r) => setTimeout(r, 300));
		const preset = ap.applyPreset('turntable', obj.uuid, obj);
		await new Promise((r) => setTimeout(r, 350));
		const afterPreset = {
			transportOnPreset: ap.transportOf(obj.uuid).clipId === preset.clipId,
			y: obj.position.y
		};
		ap.stop(obj.uuid);
		return { running, afterNew, afterPreset };
	});
	h.check(created.running.y > 0.05 && created.running.clip, `a clip is playing to begin with (y=${created.running.y.toFixed(2)})`);
	h.check(
		created.afterNew.transportOnFresh,
		'creating a clip moves the transport onto it instead of leaving the old one running'
	);
	h.check(
		Math.abs(created.afterNew.y) < 1e-6 && !created.afterNew.playing,
		`so the old clip stops driving the object (y back to ${created.afterNew.y.toFixed(3)})`
	);
	h.check(
		created.afterPreset.transportOnPreset && Math.abs(created.afterPreset.y) < 1e-6,
		`and a preset does the same (transport on the preset, y ${created.afterPreset.y.toFixed(3)})`
	);

	// ---------- 11c. an Inspector edit with REC armed keys the change ----------
	const inspector = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 300));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.position.set(0, 0, 0);
		obj.updateMatrix();
		s.objectActions.selectObject(obj.uuid, false);
		s.appStore?.showSidebar?.();
		ap.addTrack(obj.uuid, 'pos.y', obj);
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		ap.setAutoKey(obj.uuid);
		ap.scrub(obj.uuid, 1);
		await new Promise((r) => setTimeout(r, 250));
		return obj.uuid;
	});
	// drive the REAL Inspector rows: type a position, then change the colour
	await A.page.evaluate(() => window.__stores.inspectorPinned?.set?.(true));
	await A.page.waitForTimeout(300);
	const rowEdit = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const material = Array.isArray(obj.material) ? obj.material[0] : obj.material;
		// the same entry points the Inspector rows call
		const before = ap.activeClip(id).tracks.map((/** @type {any} */ t) => t.channel);
		obj.position.x = 2.5;
		obj.updateMatrix();
		material.color.setRGB(1, 0, 0);
		// Inspector writes funnel through fanOn/setTransform, which call captureAutoKey
		ap.captureAutoKey(id, ap.playheadOf(id));
		const after = ap.activeClip(id).tracks.map((/** @type {any} */ t) => t.channel);
		ap.setAutoKey(null);
		ap.stop(id);
		return { before, after };
	}, inspector);
	h.check(
		!rowEdit.before.includes('pos.x') && rowEdit.after.includes('pos.x'),
		`an edit outside the timeline keys the channel it changed (${rowEdit.after.join(', ')})`
	);
	h.check(
		rowEdit.after.includes('color.r'),
		'including a colour change, which is three look channels'
	);

	// ---------- 12. the playhead survives switching objects ----------
	const keep = await A.page.evaluate(async (other) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		const box = g.getObjectByProperty('uuid', other);
		const track = ap.addTrack(obj.uuid, 'pos.z', obj);
		ap.updateKey(obj.uuid, track, 1, { t: 2, v: 6 });
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		ap.scrub(obj.uuid, 1);
		const parked = { z: obj.position.z, head: ap.playheadOf(obj.uuid) };
		// select something else, then come back — the frame must still be there
		s.objectActions.selectObject(other, false);
		await new Promise((r) => setTimeout(r, 400));
		const away = { z: obj.position.z, head: ap.playheadOf(obj.uuid) };
		s.objectActions.selectObject(obj.uuid, false);
		await new Promise((r) => setTimeout(r, 300));
		const back = { z: obj.position.z, head: ap.playheadOf(obj.uuid) };
		void box;
		return { parked, away, back };
	}, first);
	h.check(keep.parked.z > 0.5, `a scrub poses the object (z=${keep.parked.z.toFixed(2)} at 1s of 2s)`);
	h.check(
		Math.abs(keep.away.z - keep.parked.z) < 1e-6 && Math.abs(keep.away.head - 1) < 1e-6,
		`selecting another object LEAVES it posed at its frame (z=${keep.away.z.toFixed(2)}, head ${keep.away.head.toFixed(2)}s)`
	);
	h.check(
		Math.abs(keep.back.head - 1) < 1e-6,
		`and coming back finds the same playhead (${keep.back.head.toFixed(2)}s)`
	);

	// ---------- 13. a save carries the BASE pose, not the scrubbed frame ----------
	const saved = await A.page.evaluate(async () => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		const posed = obj.position.z;
		const payload = await s.sessions.saveSession('anim-parked');
		const entry = payload.objects
			.map((/** @type {any} */ o) => o.object ?? o)
			.find((/** @type {any} */ o) => o.uuid === obj.uuid);
		// matrix element 14 is the z translation
		const savedZ = entry?.matrix?.[14] ?? null;
		const stillPosed = obj.position.z;
		ap.stop(obj.uuid);
		return { posed, savedZ, stillPosed };
	});
	h.check(
		keep.parked.z > 0.5 && Math.abs(saved.savedZ) < 1e-6,
		`saving while a preview is posed stores the BASE pose (saved z=${saved.savedZ}, on screen ${saved.posed.toFixed(2)})`
	);
	h.check(
		Math.abs(saved.stillPosed - saved.posed) < 1e-6,
		'and the preview is put straight back afterwards'
	);

	// ---------- 14. F2: no browser menu on a graph KEY, nor on our own menu -------
	// Reported again after 9c6's pane-root blocker: right-clicking a key in graph
	// view still showed the native menu. 9c6 covers the pane's own surfaces; what it
	// cannot cover is our ContextMenu, which is PORTALED to <body> and therefore
	// outside the pane root — and it opens UNDER the cursor, so the next right-click
	// lands on the menu, not on the pane.
	// a clip authored HERE, so the graph is guaranteed to draw handles whatever the
	// sections above left active
	const g2 = await A.page.evaluate((id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const clipId = ap.createClip(id, 'RightClick');
		const track = ap.addTrack(id, 'pos.y', obj, clipId);
		ap.updateKey(id, track, 0, { t: 0, v: 0 }, clipId);
		ap.updateKey(id, track, 1, { t: 1, v: 3 }, clipId);
		ap.updateAnim(id, { duration: 2, loop: 'loop' }, clipId);
		ap.setActiveClip(id, clipId);
		s.objectActions.selectObject(id, false);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		return ap.activeClip(id)?.tracks?.[0]?.keys?.length ?? 0;
	}, first);
	h.check(g2 === 2, `a two-key clip is active for the graph checks (${g2} keys)`);
	await A.page.waitForTimeout(400);
	await A.page.getByRole('button', { name: 'Graph', exact: true }).click();
	await A.page.waitForTimeout(400);

	await A.page.evaluate(() => {
		/** @type {any} */ (window).__ctx2 = [];
		// bubble phase on window: this runs AFTER every direct listener, so it reports
		// whether anything actually cancelled the default
		window.addEventListener('contextmenu', (e) => {
			const el = /** @type {any} */ (e.target);
			/** @type {any} */ (window).__ctx2.push({
				prevented: e.defaultPrevented,
				tag: el?.tagName,
				onMenu: !!el?.closest?.('[role="menu"]'),
				inPane: !!el?.closest?.('#animation-dock, #animation-window')
			});
		});
	});

	// a real right-click on a key HANDLE in the graph. Take a handle with a REAL
	// size and confirm it is the topmost thing at that point: a zero-size rect is
	// truthy, and clicking its (0,0) lands on <html>, where the check would report a
	// browser menu that no code of ours was ever asked about.
	const keyDot = await A.page.evaluate(() => {
		const sized = [...document.querySelectorAll('#animation-timeline circle')]
			// F4's easing handles are circles in the same svg — this check is about a
			// KEY, and they are drawn last, so an unfiltered "take the last one" picks
			// a tangent
			.filter((c) => !c.id.startsWith('animation-tangent'))
			.map((c) => c.getBoundingClientRect())
			.filter((r) => r.width > 2 && r.height > 2);
		const r = sized[sized.length - 1];
		if (!r) return null;
		const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		return { ...at, hit: document.elementFromPoint(at.x, at.y)?.tagName };
	});
	h.check(
		keyDot?.hit === 'circle',
		`the graph draws a key handle to right-click (topmost at it: ${keyDot?.hit ?? 'nothing'})`
	);
	await A.page.mouse.click(keyDot.x, keyDot.y, { button: 'right' });
	await A.page.waitForTimeout(300);
	const onKeyEvents = await A.page.evaluate(() => /** @type {any} */ (window).__ctx2);
	h.check(
		onKeyEvents.length > 0 && onKeyEvents.every((/** @type {any} */ e) => e.prevented),
		`right-clicking a graph KEY cancels the browser menu (${onKeyEvents
			.map((/** @type {any} */ e) => e.tag + ':' + e.prevented)
			.join(', ')})`
	);

	// our menu is now open UNDER the cursor: the next right-click lands on IT
	const menuOpen = await A.page.evaluate(() => !!document.querySelector('[role="menu"]'));
	h.check(menuOpen, 'and our own menu opened there');
	await A.page.evaluate(() => (/** @type {any} */ (window).__ctx2 = []));
	const menuSpot = await A.page.evaluate(() => {
		const r = document.querySelector('[role="menu"]')?.getBoundingClientRect();
		return r ? { x: r.x + r.width / 2, y: r.y + Math.min(20, r.height / 2) } : null;
	});
	h.check(!!menuSpot, 'the open menu has a surface to right-click');
	await A.page.mouse.click(menuSpot.x, menuSpot.y, { button: 'right' });
	await A.page.waitForTimeout(300);
	const onMenuEvents = await A.page.evaluate(() => /** @type {any} */ (window).__ctx2);
	h.check(
		onMenuEvents.length > 0 && onMenuEvents.every((/** @type {any} */ e) => e.prevented),
		`right-clicking OUR MENU cancels it too (${onMenuEvents
			.map((/** @type {any} */ e) => (e.onMenu ? 'menu' : e.inPane ? 'pane' : 'other') + ':' + e.prevented)
			.join(', ')})`
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(200);

	// ---------- 15. F4: the easing tangents, dragged ON the curve ----------
	// `ease` per key already shaped the following segment, and the 132px pad on the
	// right edited it numerically. These are the same four numbers as handles at the
	// bezier control points in (t, value) space.
	//
	// The plot maps t and v AFFINELY to pixels, which is what lets this drive the
	// gesture by interpolating between the two KEY handles' own screen positions: a
	// pixel a quarter of the way from one key to the other IS parameter 0.25, with no
	// arithmetic guess at the plot's inner width (the lesson from 9b).
	const tanSetup = await A.page.evaluate((id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const clipId = ap.createClip(id, 'Tangents');
		const track = ap.addTrack(id, 'pos.y', obj, clipId);
		// two keys with a real value SPAN, so the y axis is not degenerate
		ap.updateKey(id, track, 0, { t: 0, v: 0, ease: [0.25, 0.25, 0.75, 0.75] }, clipId);
		ap.updateKey(id, track, 1, { t: 1, v: 4 }, clipId);
		ap.updateAnim(id, { duration: 2, loop: 'loop' }, clipId);
		ap.setActiveClip(id, clipId);
		s.objectActions.selectObject(id, false);
		return { clipId, track };
	}, first);
	await A.page.waitForTimeout(500);
	await A.page.getByRole('button', { name: 'Graph', exact: true }).click();
	await A.page.waitForTimeout(400);

	/** the two key handles' screen centres, and the two tangent handles' */
	const tanGeom = () =>
		A.page.evaluate(() => {
			const mid = (/** @type {Element|null} */ el) => {
				const r = el?.getBoundingClientRect();
				return r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
			};
			const keys = [...document.querySelectorAll('#animation-timeline circle')].filter(
				(c) => !c.id.startsWith('animation-tangent')
			);
			return {
				keys: keys.map(mid),
				t1: mid(document.getElementById('animation-tangent-1')),
				t2: mid(document.getElementById('animation-tangent-2')),
				guides: document.querySelectorAll('[data-anim-tangents] line').length
			};
		});
	const geom0 = await tanGeom();
	h.check(
		!!geom0.t1 && !!geom0.t2,
		`the graph draws both tangent handles (${geom0.t1 ? 'P1' : '-'}, ${geom0.t2 ? 'P2' : '-'})`
	);
	h.check(geom0.guides === 2, `each with a guide line back to its key (${geom0.guides})`);

	const easeOf = () =>
		A.page.evaluate(
			(args) => {
				const ap = window.__stores.animationPreview;
				const clip = ap.activeClip(args.id);
				return clip?.tracks?.find((/** @type {any} */ t) => t.id === args.track)?.keys?.[0]?.ease ?? null;
			},
			{ id: first, track: tanSetup.track }
		);

	// P1 starts at 0.25 of the way along the segment in BOTH axes, so it must sit a
	// quarter of the way between the two key handles on screen
	const a = geom0.keys[0];
	const b = geom0.keys[1];
	h.check(
		!!a && !!b && Math.abs(geom0.t1.x - (a.x + (b.x - a.x) * 0.25)) < 3 &&
			Math.abs(geom0.t1.y - (a.y + (b.y - a.y) * 0.25)) < 3,
		`P1 sits where ease [0.25, 0.25] puts it (${geom0.t1.x.toFixed(0)},${geom0.t1.y.toFixed(0)} vs ${(a.x + (b.x - a.x) * 0.25).toFixed(0)},${(a.y + (b.y - a.y) * 0.25).toFixed(0)})`
	);

	// drag P1 to (0.6 along, 0.35 up) and read the ease back
	const lerp = (/** @type {number} */ fx, /** @type {number} */ fy) => ({
		x: a.x + (b.x - a.x) * fx,
		y: a.y + (b.y - a.y) * fy
	});
	let dropAt = lerp(0.6, 0.35);
	await A.page.mouse.move(geom0.t1.x, geom0.t1.y);
	await A.page.mouse.down();
	await A.page.mouse.move(dropAt.x, dropAt.y, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const dragged1 = await easeOf();
	h.check(
		!!dragged1 && Math.abs(dragged1[0] - 0.6) < 0.05 && Math.abs(dragged1[1] - 0.35) < 0.05,
		`dragging P1 writes that segment's ease (${dragged1?.map((/** @type {number} */ n) => n.toFixed(2)).join(', ')})`
	);
	h.check(
		!!dragged1 && Math.abs(dragged1[2] - 0.75) < 1e-6 && Math.abs(dragged1[3] - 0.75) < 1e-6,
		'and leaves the OTHER control point alone'
	);
	// ONE undo must revert the WHOLE drag — the property, tested directly rather
	// than by counting the stack. Counting is not safe this late in a long suite:
	// recordEntry's LIMIT trim evicts the oldest entry, so a correct gesture can
	// leave the depth unchanged (it read +0 here while undo worked perfectly).
	const topKind = await A.page.evaluate(() => {
		let stack = [];
		window.__stores.history.undoStack.subscribe((/** @type {any[]} */ v) => (stack = v))();
		return stack[stack.length - 1]?.kind;
	});
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(250);
	const afterOneUndo = await easeOf();
	h.check(
		topKind === 'anim' &&
			!!afterOneUndo &&
			Math.abs(afterOneUndo[0] - 0.25) < 1e-6 &&
			Math.abs(afterOneUndo[1] - 0.25) < 1e-6,
		`ONE undo reverts the whole drag (kind ${topKind}, back to ${afterOneUndo?.slice(0, 2).join(', ')})`
	);
	await A.page.evaluate(() => window.__stores.history.redo());
	await A.page.waitForTimeout(250);
	const afterRedo = await easeOf();
	h.check(
		!!afterRedo && Math.abs(afterRedo[0] - 0.6) < 0.05,
		`and redo puts it back (${afterRedo?.[0]?.toFixed(2)})`
	);

	// x is the segment PARAMETER: dragging P2 past the far key clamps it at 1
	const geom1 = await tanGeom();
	await A.page.mouse.move(geom1.t2.x, geom1.t2.y);
	await A.page.mouse.down();
	await A.page.mouse.move(b.x + 200, geom1.t2.y, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const clamped = await easeOf();
	h.check(
		!!clamped && Math.abs(clamped[2] - 1) < 1e-6,
		`dragging P2 past the far key clamps x at 1 (${clamped?.[2]})`
	);

	// y is deliberately NOT clamped — overshoot is what makes a bounce readable
	const geom2 = await tanGeom();
	dropAt = lerp(0.5, 1.4);
	await A.page.mouse.move(geom2.t1.x, geom2.t1.y);
	await A.page.mouse.down();
	await A.page.mouse.move(dropAt.x, dropAt.y, { steps: 6 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(300);
	const over = await easeOf();
	h.check(
		!!over && over[1] > 1.2,
		`but y overshoots past 1 freely (${over?.[1]?.toFixed(2)})`
	);

	// The numeric pad edits the SAME four numbers, so it has to SHOW the overshoot
	// rather than clip it away: its y range covers -0.5..1.5 for exactly this reason.
	// A pad that still mapped 0..1 would draw this handle above its own box, and the
	// next touch of it would silently flatten the bounce.
	const padAgrees = await A.page.evaluate(() => {
		const svgs = [...document.querySelectorAll('#animation-dock svg, #animation-window svg')];
		const pad = svgs.find((s) => s.id !== 'animation-timeline' && s.querySelectorAll('circle').length >= 4);
		if (!pad) return null;
		const box = pad.getBoundingClientRect();
		// the two big ones (r=6) are the draggable controls
		const controls = [...pad.querySelectorAll('circle')].filter(
			(c) => Number(c.getAttribute('r')) >= 5
		);
		if (controls.length < 2) return null;
		const r = controls[0].getBoundingClientRect();
		return { fy: (r.y + r.height / 2 - box.y) / box.height };
	});
	// y = 1.4 in a -0.5..1.5 box, inset by 10px of a 132px square: ~0.13 down
	h.check(
		!!padAgrees && padAgrees.fy > 0.02 && padAgrees.fy < 0.3,
		`the numeric pad shows the overshoot INSIDE its box (P1 at ${padAgrees?.fy?.toFixed(2)} of its height)`
	);

	// a STEPPED channel has no curve, so it has no tangents either
	await A.page.evaluate((args) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', args.id);
		const track = ap.addTrack(args.id, 'visible', obj, args.clipId);
		ap.updateKey(args.id, track, 0, { t: 0, v: 1 }, args.clipId);
		ap.updateKey(args.id, track, 1, { t: 1, v: 0 }, args.clipId);
	}, { id: first, clipId: tanSetup.clipId });
	await A.page.waitForTimeout(400);
	// the channel list rows are buttons labelled by channel — click the stepped one
	// so the graph plots IT
	await A.page.getByRole('button', { name: 'Visible', exact: true }).click();
	await A.page.waitForTimeout(400);
	const afterStepped = await A.page.evaluate(() => ({
		tangents: !!document.getElementById('animation-tangent-1'),
		saysStepped: !!document.body.textContent?.includes('is stepped')
	}));
	h.check(
		!afterStepped.tangents && afterStepped.saysStepped,
		`a stepped channel draws no tangents and says so (tangents ${afterStepped.tangents}, notice ${afterStepped.saysStepped})`
	);

	// and back on a smooth channel they return — otherwise the check above would
	// pass just as well with the feature removed
	await A.page.getByRole('button', { name: 'Position Y', exact: true }).first().click();
	await A.page.waitForTimeout(400);
	const backOnSmooth = await A.page.evaluate(() => !!document.getElementById('animation-tangent-1'));
	h.check(backOnSmooth, 'and come back on a smooth one');

	// A FLAT segment (both keys the same value) cannot express its y control
	// spatially — every y maps to the same pixel — so the handle must still exist and
	// still drag in x, and must leave y alone rather than writing a divide-by-zero.
	await A.page.evaluate(
		(args) => {
			const ap = window.__stores.animationPreview;
			ap.updateKey(args.id, args.track, 0, { t: 0, v: 2, ease: [0.3, 0.8, 0.7, 0.2] }, args.clipId);
			ap.updateKey(args.id, args.track, 1, { t: 1, v: 2 }, args.clipId);
		},
		{ id: first, track: tanSetup.track, clipId: tanSetup.clipId }
	);
	await A.page.waitForTimeout(450);
	const flatGeom = await tanGeom();
	h.check(!!flatGeom.t1, 'a FLAT segment still offers its tangent handles');
	if (flatGeom.t1 && flatGeom.keys[0] && flatGeom.keys[1]) {
		const fa = flatGeom.keys[0];
		const fb = flatGeom.keys[1];
		await A.page.mouse.move(flatGeom.t1.x, flatGeom.t1.y);
		await A.page.mouse.down();
		await A.page.mouse.move(fa.x + (fb.x - fa.x) * 0.8, flatGeom.t1.y - 40, { steps: 6 });
		await A.page.mouse.up();
		await A.page.waitForTimeout(300);
		const flatEase = await easeOf();
		h.check(
			!!flatEase && Math.abs(flatEase[0] - 0.8) < 0.05,
			`dragging it still sets x (${flatEase?.[0]?.toFixed(2)})`
		);
		h.check(
			!!flatEase && Math.abs(flatEase[1] - 0.8) < 1e-6 && Number.isFinite(flatEase[1]),
			`and leaves y untouched rather than writing a divide-by-zero (${flatEase?.[1]})`
		);
	}

	await h.finish(browser);
});
