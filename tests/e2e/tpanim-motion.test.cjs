// 57 M3 + M8 — game-ready clips and split/join, host + peer, on the real KayKit knight + clips:
//  · CROSSFADE: a clip change with a fade blends on BOTH peers from one stamp — no snap (the
//    counterfactual: the same change with no fade snaps);
//  · BLEND BY SPEED: a node in the knight's own graph picks idle / walk from the knight's speed on
//    A (moving it) and on B (receiving its moves), no wiring;
//  · per-clip settings (In place / Moving, loop, speed, rename) are ref fields that replicate;
//  · Loop it / Trim / Split / Join write NEW clip files and swap the ref in one undo step;
//  · Extract clips turns a model's own clips into files, optionally used instead (bytes untouched);
//  · the Animation window shows the clip tools (facts + seam) for the selected model.
const h = require('./helpers.cjs');

const animOf = (page, uuid) =>
	page.evaluate((uuid) => {
		let map;
		window.__stores.animatedImports.animatedObjects.subscribe((m) => (map = m))();
		const st = map?.[uuid];
		if (!st) return null;
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const root = g.getObjectByProperty('uuid', uuid);
		return { ...st, info: window.__stores.animatedImports.clipInfo(uuid), refs: window.__stores.animatedImports.clipRefsOf(root) };
	}, uuid);

/** the largest frame-to-frame turn (degrees) of the knight's left upper arm over `ms`, sampled per animation frame */
const sampleJumps = (page, uuid, ms) =>
	page.evaluate(
		({ uuid, ms }) =>
			new Promise((resolve) => {
				const s = window.__stores;
				let g;
				s.objectsGroup.subscribe((x) => (g = x))();
				const bone = g.getObjectByProperty('uuid', uuid).getObjectByName(s.THREE.PropertyBinding.sanitizeNodeName('upperarm.l'));
				const q = new s.THREE.Quaternion();
				const prev = new s.THREE.Quaternion();
				let have = false;
				let worst = 0;
				let frames = 0;
				const end = performance.now() + ms;
				const step = () => {
					bone.updateWorldMatrix(true, false);
					bone.matrixWorld.decompose(new s.THREE.Vector3(), q, new s.THREE.Vector3());
					if (have) worst = Math.max(worst, (prev.angleTo(q) * 180) / Math.PI);
					prev.copy(q);
					have = true;
					frames++;
					if (performance.now() < end) requestAnimationFrame(step);
					else resolve({ worst, frames });
				};
				requestAnimationFrame(step);
			}),
		{ uuid, ms }
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// the knight + three clips from the shared clips file
	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		const knight = await (await fetch('/avatars/knight.glb')).arrayBuffer();
		const id = await s.fileHandler.importFile(new File([knight], 'knight.glb'), 'Knight');
		const clips = await (await fetch('/avatars/clips.glb')).arrayBuffer();
		const items = await s.explorer.importFiles([new File([clips], 'clips.glb')], null);
		for (const want of ['Idle', 'Walking_A', 'Running_A']) {
			const item = items.find((i) => i.name.endsWith(want + '.tpanim'));
			s.clipAssets.assignClipAsset(id, { hash: item.hash, name: want });
		}
		return id;
	});
	await h.eventually(() => animOf(A.page, uuid), (s) => s?.info?.filter((c) => c.asset).length === 3, 'three clip assets bound on A', 20000);
	await h.eventually(() => animOf(B.page, uuid), (s) => s?.info?.filter((c) => c.asset).length === 3, 'and on B', 30000);

	// ---------- M3 crossfade: no snap on either peer ----------
	await A.page.evaluate((uuid) => window.__stores.animatedImports.setAnimationState(uuid, { clip: 'Idle', playing: true }), uuid);
	await h.eventually(() => animOf(B.page, uuid), (s) => s?.clip === 'Idle' && s.playing, 'Idle plays on B');
	await A.page.waitForTimeout(800);
	const own = await sampleJumps(A.page, uuid, 600); // the idle's own frame-to-frame motion
	const [soft, softB] = await Promise.all([
		(async () => {
			const p = sampleJumps(A.page, uuid, 1400);
			await A.page.waitForTimeout(200);
			await A.page.evaluate((uuid) => window.__stores.animatedImports.setAnimationState(uuid, { clip: 'Running_A', playing: true, fade: 0.7 }), uuid);
			return p;
		})(),
		sampleJumps(B.page, uuid, 1600)
	]);
	const stA = await animOf(A.page, uuid);
	const stB = await animOf(B.page, uuid);
	h.check(stB.from === 'Idle' && stB.fade === 0.7 && Math.abs(stB.at - stA.at) < 1e-6, `M3: B crossfades from the same stamp (from ${stB.from}, fade ${stB.fade}, Δat ${(stB.at - stA.at).toFixed(6)})`);
	await A.page.waitForTimeout(600);
	await A.page.evaluate((uuid) => window.__stores.animatedImports.setAnimationState(uuid, { clip: 'Idle', playing: true }), uuid);
	await A.page.waitForTimeout(900);
	const hard = await (async () => {
		const p = sampleJumps(A.page, uuid, 900);
		await A.page.waitForTimeout(200);
		await A.page.evaluate((uuid) => window.__stores.animatedImports.setAnimationState(uuid, { clip: 'Running_A', playing: true }), uuid);
		return p;
	})();
	h.check(hard.worst > Math.max(own.worst * 3, 8), `M3 counterfactual: a change with NO fade snaps (${hard.worst.toFixed(1)}° in one frame, the idle moves ${own.worst.toFixed(1)}°)`);
	h.check(soft.worst < hard.worst / 2, `M3: the crossfade does not snap on A (worst ${soft.worst.toFixed(1)}° per frame vs ${hard.worst.toFixed(1)}° hard, ${soft.frames} frames)`);
	h.check(softB.worst < hard.worst / 2, `M3: ...nor on B (worst ${softB.worst.toFixed(1)}°)`);

	// ---------- M3 Blend by Speed: idle / walk from the knight's own speed, on A and on B ----------
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.animatedImports.setAnimationState(uuid, { playing: false });
		s.flowGraphsCtl.createObjectGraph(uuid);
		s.nodesHandler.createFlowNode({ id: 'knight-blend', type: 'blendspeed', position: { x: 0, y: 0 }, data: { type: 'blendspeed', idle: '', walk: '', run: '', walkSpeed: 1.4, runSpeed: 3.5, crossfade: 0.25 } }, uuid);
	}, uuid);
	const weightsOf = (page) => page.evaluate((uuid) => window.__stores.animatedImports.poseDriverOf(uuid)?.weights ?? null, uuid);
	await h.eventually(() => weightsOf(A.page), (w) => w && w.Idle > 0.95, 'M3: standing still, the blend is all Idle on A');
	await h.eventually(() => weightsOf(B.page), (w) => w && w.Idle > 0.95, 'M3: ...and on B (its graph replicated)', 15000);
	// walk the knight at 1.4 m/s along x for 3 s, broadcasting moves at ~10 Hz like a drag does
	const walking = A.page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				const s = window.__stores;
				let g;
				s.objectsGroup.subscribe((x) => (g = x))();
				const o = g.getObjectByProperty('uuid', uuid);
				let peer;
				s.peers.subscribe((p) => (peer = p))();
				const t0 = performance.now();
				const x0 = o.position.x;
				let lastSend = 0;
				const step = () => {
					const t = (performance.now() - t0) / 1000;
					o.position.x = x0 + 1.4 * t;
					if (performance.now() - lastSend > 100) {
						lastSend = performance.now();
						peer.send({ type: 'move', uuid, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
					}
					if (t < 3) requestAnimationFrame(step);
					else resolve(true);
				};
				requestAnimationFrame(step);
			}),
		uuid
	);
	await A.page.waitForTimeout(1500);
	const wA = await weightsOf(A.page);
	const wB = await weightsOf(B.page);
	h.check(wA && wA.Walking_A > 0.7, `M3: walking at 1.4 m/s the blend is Walk on A (${JSON.stringify(wA)})`);
	h.check(wB && wB.Walking_A > 0.6, `M3: ...and on B from the replicated moves (${JSON.stringify(wB)})`);
	await walking;
	await h.eventually(() => weightsOf(A.page), (w) => w && w.Idle > 0.9, 'M3: stopped, it eases back to Idle', 5000);
	await A.page.evaluate((uuid) => window.__stores.nodesHandler.deleteFlowNodes(['knight-blend'], uuid), uuid);

	// ---------- per-clip settings: ref fields, replicated ----------
	await A.page.evaluate((uuid) => window.__stores.clipAssets.updateClipRef(uuid, 'Walking_A', { mode: 'inplace', speed: 1.25, loop: true }), uuid);
	await h.eventually(() => animOf(B.page, uuid), (s) => s?.refs?.some((r) => r.name === 'Walking_A' && r.mode === 'inplace' && r.speed === 1.25), 'M3: In place + speed replicate as ref settings');
	await A.page.evaluate((uuid) => window.__stores.clipAssets.updateClipRef(uuid, 'Walking_A', { name: 'Walk' }), uuid);
	await h.eventually(() => animOf(B.page, uuid), (s) => s?.info?.some((c) => c.name === 'Walk' && c.asset) && !s.info.some((c) => c.name === 'Walking_A'), 'M8: a rename replicates (and rebinds under the new name)');

	// ---------- M3 Loop it + the seam check ----------
	const seam = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		const edit = s.clipEdit;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const ref = s.animatedImports.clipRefsOf(g.getObjectByProperty('uuid', uuid)).find((r) => r.name === 'Walk');
		const before = await edit.clipFactsFor(ref.hash);
		await edit.loopClipAsset(uuid, 'Walk');
		const ref2 = s.animatedImports.clipRefsOf(g.getObjectByProperty('uuid', uuid)).find((r) => r.name === 'Walk');
		const after = await edit.clipFactsFor(ref2.hash);
		return { before: before.seam, after: after.seam, swapped: ref2.hash !== ref.hash, kept: ref2.mode === 'inplace' && ref2.speed === 1.25, fps: after.fps, frames: after.frames };
	}, uuid);
	h.check(seam.swapped && seam.kept, 'M3: Loop it writes a new file and the ref keeps its settings');
	h.check(seam.after.ok && seam.after.angle <= seam.before.angle, `M3: the seam closes (${seam.before.angle.toFixed(2)}° → ${seam.after.angle.toFixed(2)}°, ${seam.fps} fps, ${seam.frames} frames)`);

	// ---------- M8 trim / split / join ----------
	const ops = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		const edit = s.clipEdit;
		const info = () => s.animatedImports.clipInfo(uuid);
		const run = info().find((c) => c.name === 'Running_A');
		await edit.trimClipAsset(uuid, 'Running_A', 0.1, 0.5);
		const trimmed = info().length && (await new Promise((r) => setTimeout(r, 300)), info().find((c) => c.name === 'Running_A'));
		await edit.splitClipAsset(uuid, 'Idle', 0.5, ['Idle start', 'Idle end']);
		await new Promise((r) => setTimeout(r, 400));
		const split = info().filter((c) => c.name.startsWith('Idle '));
		await edit.joinClipAssets(uuid, ['Idle start', 'Running_A'], 0.2, 'Idle to run');
		await new Promise((r) => setTimeout(r, 400));
		const joined = info().find((c) => c.name === 'Idle to run');
		return { run: run?.duration, trimmed: trimmed?.duration, split: split.map((c) => c.duration), joined: joined?.duration };
	}, uuid);
	h.check(Math.abs(ops.trimmed - 0.4) < 0.04, `M8: trim keeps the in–out part (${ops.run?.toFixed(2)} s → ${ops.trimmed?.toFixed(2)} s)`);
	h.check(ops.split.length === 2 && ops.split[0] > 0.4 && ops.split[0] < 0.6, `M8: split at the playhead makes two clips (${ops.split.map((d) => d.toFixed(2)).join(' + ')} s)`);
	h.check(ops.joined && Math.abs(ops.joined - (ops.split[0] + ops.trimmed - 0.2)) < 0.05, `M8: join overlaps by the crossfade (${ops.joined?.toFixed(2)} s)`);
	await h.eventually(() => animOf(B.page, uuid), (s) => s?.info?.some((c) => c.name === 'Idle to run' && c.asset), 'M8: the joined clip reached B (a new file, pulled once)', 20000);
	// one undo takes the join back off, everywhere
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => animOf(B.page, uuid), (s) => s && !s.info.some((c) => c.name === 'Idle to run'), 'M8: undo removes the joined clip on B');

	// ---------- M8 Extract clips from a model with its own clip (bytes untouched) ----------
	const mover = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const s = window.__stores;
				const { GLTFExporter } = s.GLTFExporterModule;
				const root = new s.THREE.Group();
				const mesh = new s.THREE.Mesh(new s.THREE.BoxGeometry(1, 1, 1), new s.THREE.MeshStandardMaterial());
				mesh.name = 'mover';
				root.add(mesh);
				const clip = new s.THREE.AnimationClip('slide', 2, [new s.THREE.VectorKeyframeTrack('mover.position', [0, 1, 2], [0, 0, 0, 2, 0, 0, 0, 0, 0])]);
				new GLTFExporter().parse(
					root,
					async (buffer) => {
						const id = await s.fileHandler.importFile(new File([buffer], 'mover.glb'), 'Mover');
						resolve(id);
					},
					() => resolve(null),
					{ binary: true, animations: [clip] }
				);
			})
	);
	await h.eventually(() => animOf(A.page, mover), (s) => s?.info?.some((c) => c.name === 'slide'), 'a model with its own clip');
	const bytesBefore = await A.page.evaluate((id) => window.__stores.explorer.hashBytes(window.__stores.animatedImports.animatedImportPayload(id)), mover);
	await A.page.evaluate((id) => window.__stores.clipEdit.extractClips(id, { useFiles: true }), mover);
	await h.eventually(() => animOf(A.page, mover), (s) => s?.info?.length === 1 && s.info[0].name === 'slide' && !!s.info[0].asset, 'M8: Extract ▸ use the files: the clip now comes from a .tpanim (same name)');
	await h.eventually(() => animOf(B.page, mover), (s) => s?.info?.length === 1 && !!s.info[0].asset, 'M8: ...on B too', 20000);
	const moves = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		s.animatedImports.setAnimationState(id, { clip: 'slide', playing: true });
		const rec = s.animatedImports.animatedRecordOf(id);
		rec.mixer.setTime(1);
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		return g.getObjectByProperty('uuid', id).getObjectByName('mover').position.x;
	}, mover);
	h.check(Math.abs(moves - 2) < 0.01, `M8: the extracted clip drives the node by name (x at 1 s = ${moves.toFixed(3)})`);
	const bytesAfter = await A.page.evaluate((id) => window.__stores.explorer.hashBytes(window.__stores.animatedImports.animatedImportPayload(id)), mover);
	h.check(bytesAfter === bytesBefore, 'M8: the model bytes did not change');
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => animOf(B.page, mover), (s) => s?.info?.some((c) => c.name === 'slide' && !c.asset), 'M8: one undo brings the embedded clip back on B');

	// ---------- the Animation window shows the clip tools ----------
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.objectActions.selectObject(uuid);
		s.animationClose.set(false);
		s.animatedImports.setAnimationState(uuid, { clip: 'Walk', playing: true });
	}, uuid);
	await A.page.locator('#clip-tools').waitFor({ timeout: 10000 });
	await h.eventually(() => A.page.locator('#clip-facts').innerText().catch(() => ''), (t) => /\d+ fps · \d+ f/.test(t), 'M3: the window shows the clip’s fps · frames · length');
	h.check(/seamless loop|loop seam/.test(await A.page.locator('#clip-seam').innerText()), 'M3: ...and its loop seam');
	await A.page.locator('#clip-mode-moving').click();
	await h.eventually(() => animOf(B.page, uuid), (s) => s?.refs?.some((r) => r.name === 'Walk' && r.mode === 'moving'), 'M3: the Moving button sets the ref on every peer');

	await h.finish(browser);
});
