// 64-2d (D4 wave 1) — SPRITES, FLIPBOOKS, 2D LAYERS. The rules are spriteCore.js (unit-tested in
// tests/unit/spriteCore.test.js); this suite checks the runtime and the wiring on real pages:
//   1 a sprite sheet: lossless PNG map, nearest sampler, the plane sized frame px / ppu, the frame
//     shown is the clip's (autoplay), flip, the static frame
//   2 parallax: a 2D layer is DRAWN offset while an orthographic camera looks, the authored pose
//     (what saves) never moves; the perspective editor view shows the authored layout
//   3 undo: a sprite edit is ONE props entry; undo restores the block
//   4 a peer: the sprite, its sheet and its image arrive and the peer shows the SAME frame
// Run: APP_URL=https://theprototype.app:5419/ npm run e2e -- sprite2d
const h = require('./helpers.cjs');

/** a 4x2 sheet of 16 px frames, frame i filled with a distinct colour; returns a PNG Blob in-page */
const SHEET_FN = `(async () => {
	const c = document.createElement('canvas');
	c.width = 64; c.height = 32;
	const g = c.getContext('2d');
	const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff', '#000000'];
	for (let i = 0; i < 8; i++) { g.fillStyle = colours[i]; g.fillRect((i % 4) * 16, Math.floor(i / 4) * 16, 16, 16); }
	return await new Promise((r) => c.toBlob(r, 'image/png'));
})()`;

/** @param {any} page @param {string} uuid */
const spriteInfo = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const o = group.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		const map = o.material?.map;
		o.geometry.computeBoundingBox();
		const box = o.geometry.boundingBox;
		return {
			sprite: JSON.parse(JSON.stringify(o.userData.sprite ?? null)),
			png: String(o.material?.userData?.mapDataUrl ?? '').startsWith('data:image/png'),
			image: map?.image ? [map.image.width, map.image.height] : null,
			nearest: map ? map.magFilter === 1003 && map.minFilter === 1003 : null,
			repeat: map ? [map.repeat.x, map.repeat.y] : null,
			offset: map ? [+map.offset.x.toFixed(4), +map.offset.y.toFixed(4)] : null,
			size: box ? [+(box.max.x - box.min.x).toFixed(4), +(box.max.y - box.min.y).toFixed(4)] : null,
			geoType: o.geometry.type,
			status: s.sprite2d.spriteStatus(o)
		};
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- 1 a sprite sheet -----------------------------------------------------------------------
	const uuid = await A.page.evaluate(async (sheetFn) => {
		const s = window.__stores;
		const id = s.commandsHandler.sceneCommand('/create Sprite');
		await new Promise((r) => setTimeout(r, 200));
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const o = group.children.find((c) => c.userData?.sprite);
		const blob = await eval(sheetFn);
		await s.sprite2dActions.setSpriteImage([o.uuid], blob);
		s.sprite2dActions.setSpriteFor(o.uuid, {
			sheet: { cols: 4, rows: 2, count: 7 },
			clips: [
				{ name: 'walk', from: 0, to: 3, fps: 4 },
				{ name: 'jump', frames: [4, 5, 6], fps: 6, loop: 'once', next: 'walk', events: [{ frame: 2, name: 'land' }] }
			],
			play: 'walk'
		});
		return o.uuid ?? id;
	}, SHEET_FN);
	await h.eventually(() => spriteInfo(A.page, uuid), (i) => !!i?.image, '1.0 the sheet image loaded', 8000);
	let info = await spriteInfo(A.page, uuid);
	h.check(info.png && info.image[0] === 64 && info.image[1] === 32, '1.1 the map is a LOSSLESS PNG at its own size (' + JSON.stringify(info.image) + ')');
	h.check(info.nearest === true, '1.2 nearest sampler (pixel art stays crisp)');
	h.check(info.repeat[0] === 0.25 && info.repeat[1] === 0.5, '1.3 the map shows ONE frame of the 4x2 grid (repeat ' + JSON.stringify(info.repeat) + ')');
	h.check(info.size[0] === 1 && info.size[1] === 1 && info.geoType === 'BufferGeometry', '1.4 the plane is frame px / ppu = 16/16 = 1 m, a plain BufferGeometry (' + JSON.stringify(info.size) + ' ' + info.geoType + ')');
	h.check(info.status.clip === 'walk' && info.status.playing, '1.5 the autoplay clip runs (' + JSON.stringify(info.status) + ')');
	const frames = new Set();
	for (let i = 0; i < 8; i++) {
		frames.add((await spriteInfo(A.page, uuid)).status.frame);
		await A.page.waitForTimeout(130);
	}
	h.check(frames.size >= 3 && [...frames].every((f) => f >= 0 && f <= 3), '1.6 the walk clip steps through frames 0..3 (' + JSON.stringify([...frames]) + ')');

	// flip + a static frame
	await A.page.evaluate((uuid) => window.__stores.sprite2dActions.setSpriteFor(uuid, { play: '', frame: 5, flipX: true }), uuid);
	await A.page.waitForTimeout(200);
	info = await spriteInfo(A.page, uuid);
	// frame 5 = col 1, row 1 (bottom row): x0 = 16/64, flipped -> offset x = 0.5, repeat x = -0.25
	h.check(info.status.frame === 5 && !info.status.playing, '1.7 no clip: the static frame shows (' + JSON.stringify(info.status) + ')');
	h.check(info.repeat[0] === -0.25 && info.offset[0] === 0.5 && info.offset[1] === 0, '1.8 flipX mirrors the frame in place (offset ' + JSON.stringify(info.offset) + ' repeat ' + JSON.stringify(info.repeat) + ')');

	// ---- 3 undo ---------------------------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(200);
	info = await spriteInfo(A.page, uuid);
	h.check(info.sprite.play === 'walk' && !info.sprite.flipX && info.status.clip === 'walk', '3.1 undo restores the previous sprite block in ONE step (' + JSON.stringify(info.sprite) + ')');

	// ---- 4 a peer -------------------------------------------------------------------------------
	await h.eventually(() => spriteInfo(B.page, uuid), (i) => !!i?.image && i.sprite?.play === 'walk', '4.1 the sprite, its sheet document and its image reached the peer', 10000);
	const both = await Promise.all([spriteInfo(A.page, uuid), spriteInfo(B.page, uuid)]);
	h.check(both[1].png && both[1].nearest && both[1].size[0] === 1, '4.2 the peer derives the same sampler and plane (' + JSON.stringify(both[1]) + ')');
	h.check(JSON.stringify(both[0].sprite) === JSON.stringify(both[1].sprite), '4.3 the stored blocks match');
	// the autoplay clip is a pure function of the shared clock: each page shows the frame its own
	// clock says, and the two clocks agree (so the frames agree up to the sampling latency)
	const sample = (page) =>
		page.evaluate((uuid) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const o = g.getObjectByProperty('uuid', uuid);
			const clock = s.sprite2d.spriteClock();
			const spec = s.sprite2d.spriteSpecOf(o);
			const clip = s.sprite2dCore.clipByName(spec, 'walk');
			const want = s.sprite2dCore.clipFrameAt(clip, clock - (clock - (clock % 3600))).frame;
			const session = (s.connectionState.sessionNow() % 86400000) / 1000;
			return { clock, session, want, frame: s.sprite2d.spriteStatus(o).frame, at: Date.now() };
		}, uuid);
	let same = 0;
	let onSession = 0;
	const skews = [];
	for (let i = 0; i < 6; i++) {
		const [a, b] = await Promise.all([sample(A.page), sample(B.page)]);
		if (a.frame === a.want && b.frame === b.want) same++;
		skews.push(Math.abs(a.clock - b.clock - (a.at - b.at) / 1000));
		if (Math.abs(a.clock - a.session) < 0.05 && Math.abs(b.clock - b.session) < 0.05) onSession++;
		await A.page.waitForTimeout(170);
	}
	h.check(same === 6, '4.4 each peer shows the frame the shared clock names, with no playback message (' + same + '/6)');
	// sprites keep time by the SESSION clock (what Play Animation stamps are written in), so two
	// peers agree exactly as well as the session clock does — its sync accuracy is the clock
	// module's (sessionClock.js), measured here for the record, not owned by this suite
	const offsets = await Promise.all([A, B].map((P) => P.page.evaluate(() => window.__stores.connectionState.sessionClockDebug?.() ?? null)));
	const skew = skews.sort((x, y) => x - y)[Math.floor(skews.length / 2)];
	h.check(onSession === 6, '4.5 each peer\'s sprite clock IS its session clock (' + onSession + '/6; peer-to-peer median skew ' + (skew * 1000).toFixed(0) + ' ms = the session clock\'s own sync error, ' + JSON.stringify(offsets) + ')');

	// ---- 5 Play Animation drives a flipbook clip, its event + end pulse nodes, host AND peer -------
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const nh = s.nodesHandler;
		s.flowGraphsCtl.createObjectGraph(uuid);
		let peer;
		s.peers.subscribe((p) => (peer = p))();
		// the editor's own path: the local applier + the nodecreate / edgecreate messages
		const mk = (id, type, data, x, y) => {
			const node = { id, type, position: { x, y }, data: { type, ...data } };
			nh.createFlowNode(node, uuid);
			peer?.send({ type: 'nodecreate', node, graphId: uuid });
		};
		const edge = (e) => {
			nh.createFlowEdge(e, uuid);
			peer?.send({ type: 'edgecreate', edge: e, graphId: uuid });
		};
		mk('sp-click', 'onclick', { pulse: 1.5 }, 0, 0);
		mk('sp-play', 'playanim', { clip: 'jump', action: 'restart', speed: 1 }, 220, 0);
		mk('sp-land', 'animmarker', { name: 'land', pulse: 0.3 }, 0, 160);
		mk('sp-lands', 'counter', { op: 'up', step: 1 }, 220, 160);
		mk('sp-end', 'animfinished', { pulse: 0.3 }, 0, 300);
		mk('sp-ends', 'counter', { op: 'up', step: 1 }, 220, 300);
		edge({ id: 'e-sp1', source: 'sp-click', target: 'sp-play', targetHandle: 'trigger' });
		edge({ id: 'e-sp2', source: 'sp-land', target: 'sp-lands', targetHandle: 'pulse' });
		edge({ id: 'e-sp3', source: 'sp-end', target: 'sp-ends', targetHandle: 'pulse' });
	}, uuid);
	const graphOn = (page) => page.evaluate((uuid) => {
		let gs;
		window.__stores.flowGraphs.subscribe((v) => (gs = v))();
		return { nodes: gs?.[uuid]?.nodes?.length ?? 0, edges: gs?.[uuid]?.edges?.length ?? 0 };
	}, uuid);
	await h.eventually(() => graphOn(B.page), (g) => g.nodes === 6 && g.edges === 3, '5.0 (premise) the sprite\'s flow graph reached the peer', 15000);
	const counts = (page) =>
		page.evaluate(() => {
			let v = {};
			window.__stores.flowValues.subscribe((x) => (v = x))();
			return { lands: v['sp-lands'] ?? 0, ends: v['sp-ends'] ?? 0 };
		});
	const before5 = await Promise.all([counts(A.page), counts(B.page)]);
	// record which clips each page shows, every animation frame, until the hand-over is done
	const record = (page) =>
		page.evaluate((uuid) => {
			const s = window.__stores;
			window.__spSeen = [];
			const t0 = performance.now();
			const tick = () => {
				let g;
				s.objectsGroup.subscribe((x) => (g = x))();
				const st = s.sprite2d.spriteStatus(g.getObjectByProperty('uuid', uuid));
				const last = window.__spSeen[window.__spSeen.length - 1];
				if (st && (!last || last.clip !== st.clip || last.frame !== st.frame)) window.__spSeen.push({ clip: st.clip, frame: st.frame, explicit: st.explicit });
				if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
			};
			tick();
		}, uuid);
	await Promise.all([record(A.page), record(B.page)]);
	await A.page.evaluate((uuid) => window.__stores.flowRuntime.fireObjectClick(uuid), uuid);
	await A.page.waitForTimeout(4200);
	const seen = await Promise.all([A.page.evaluate(() => window.__spSeen), B.page.evaluate(() => window.__spSeen)]);
	const jumpFrames = (list) => list.filter((e) => e.clip === 'jump').map((e) => e.frame);
	// sampled per animation frame — a headless page at a few fps can step over a 1/6 s frame, so the
	// run must START at 4 and only climb within 4..6 (5.4's marker on frame 6 proves the end was reached)
	const climbs = (f) => f.length >= 1 && f[0] === 4 && f.every((x, i) => x >= 4 && x <= 6 && (i === 0 || x > f[i - 1]));
	h.check(climbs(jumpFrames(seen[0])), '5.1 a click -> Play Animation plays the sprite\'s "jump" flipbook clip from frame 4 up through 4..6 (' + JSON.stringify(seen[0]) + ')');
	// the peer's sampler can step over the whole half-second clip at a few fps; what the trigger
	// changed is still visible: the sprite went from autoplay to explicitly played clips (5.3/5.4
	// show it was the jump: its land marker and end fired on the peer too)
	h.check(seen[1].every((e) => e.clip !== 'jump' || (e.frame >= 4 && e.frame <= 6)) && seen[1].some((e) => e.explicit), '5.2 the peer plays it from the replicated trigger alone (' + JSON.stringify(seen[1]) + ')');
	const after5 = await Promise.all([spriteInfo(A.page, uuid), spriteInfo(B.page, uuid)]);
	h.check(after5.every((i) => i.status.clip === 'walk' && i.status.explicit), '5.3 the once-clip hands over to its `next` clip (walk) on both (' + after5.map((i) => JSON.stringify(i.status)).join(' / ') + ')');
	const c5 = await Promise.all([counts(A.page), counts(B.page)]);
	h.check(c5.every((c, k) => c.lands - before5[k].lands === 1), '5.4 the "land" frame event pulsed Animation Marker exactly once on each peer (' + JSON.stringify(before5) + ' -> ' + JSON.stringify(c5) + ')');
	h.check(c5.every((c, k) => c.ends - before5[k].ends === 1), '5.5 the end of the once-clip pulsed Animation Finished once on each peer');

	// ---- 2 parallax -----------------------------------------------------------------------------
	const par = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const THREE = s.THREE;
		const layer = new THREE.Group();
		layer.name = 'Far hills';
		layer.position.set(0, 0, -5);
		group.add(layer);
		const sprite = group.getObjectByProperty('uuid', uuid);
		layer.add(sprite);
		layer.userData.layer2d = { parallax: 0.5 };
		s.pokeScene();
		await new Promise((r) => setTimeout(r, 300));
		const read = () => {
			layer.updateWorldMatrix(true, false);
			return { drawnX: +layer.matrixWorld.elements[12].toFixed(3), authoredX: layer.position.x };
		};
		const perspective = read();
		// look through an orthographic camera at x = 10
		s.commandsHandler.sceneCommand('/create CameraOrtho');
		await new Promise((r) => setTimeout(r, 300));
		const cam = group.children.find((c) => c.userData?.camera?.kind === 'orthographic');
		cam.position.set(10, 0, 10);
		s.cameraPreview.startCameraPreview(cam.uuid);
		await new Promise((r) => setTimeout(r, 800));
		const ortho = read();
		const frustum = { got: window.__cameraPreviewDebug?.().frustum ?? null, size: cam.userData.camera.orthoSize ?? null };
		s.cameraPreview.stopCameraPreview();
		await new Promise((r) => setTimeout(r, 600));
		const back = read();
		return { perspective, ortho, back, frustum, layers: s.sprite2d.sprite2dDebug().layers };
	}, uuid);
	h.check(par.layers === 1, '2.0 (premise) the runtime sees one 2D layer');
	h.check(par.perspective.drawnX === 0, '2.1 the perspective editor view draws the authored layout (' + JSON.stringify(par.perspective) + ')');
	h.check(par.ortho.drawnX === 5 && par.ortho.authoredX === 0, '2.2 through an ortho camera at x=10 a 0.5 layer is DRAWN at x=5, its authored x stays 0 (' + JSON.stringify(par.ortho) + ')');
	h.check(par.back.drawnX === 0, '2.3 back in the editor view the offset is gone (' + JSON.stringify(par.back) + ')');
	// the preview frames the camera's ortho size in METRES (threlte would reset it to the canvas in pixels)
	h.check(!!par.frustum.got && Math.abs(par.frustum.got[2] - (par.frustum.size ?? 5)) < 1e-6, '2.4 an orthographic camera preview frames its ortho size, not the canvas in pixels (' + JSON.stringify(par.frustum) + ')');

	// ---- 6 the 2D scene template (Templates ▸ 2D scene), host + peer ----------------------------
	await A.page.evaluate(() => {
		window.__t2d = null;
		import('/src/lib/sprite2d/template2d.js')
			.then((m) => m.open2dTemplate())
			.then((r) => (window.__t2d = r), (e) => (window.__t2d = 'error: ' + (e?.stack || e)));
	});
	const toastTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.tp-toast')].map((t) => t.textContent.trim().slice(0, 140)));
	const accept = B.page.locator('.tp-toast').filter({ hasText: 'wants to load' }).getByText('Accept');
	// generous: on a loaded machine a cold dev server takes 10+ s just to import the template's modules
	const asked = await accept.first().waitFor({ timeout: 90000 }).then(() => true, () => false);
	if (!asked) {
		const dialogs = (page) => page.evaluate(() => [...document.querySelectorAll('[role=dialog], [role=alertdialog], .modal, dialog[open]')].filter((d) => d.offsetParent).map((d) => d.textContent.trim().slice(0, 160)));
		console.log('  diag: A __t2d ' + JSON.stringify(await A.page.evaluate(() => window.__t2d)) + ' | A toasts ' + JSON.stringify(await toastTexts(A.page)) + ' | A dialogs ' + JSON.stringify(await dialogs(A.page)) + ' | B toasts ' + JSON.stringify(await toastTexts(B.page)) + ' | B dialogs ' + JSON.stringify(await dialogs(B.page)));
		await A.page.screenshot({ path: 'test-results/64-2d/6-A.png' }).catch(() => {});
		await B.page.screenshot({ path: 'test-results/64-2d/6-B.png' }).catch(() => {});
	}
	h.check(asked, '6.0 the peer is asked to load the 2D scene (a proposal: the template replaces the shared scene)');
	h.check((await A.page.evaluate(() => window.__t2d)) === false, '6.0b the opener\'s call returned "not applied yet" (it applies when everyone accepted)');
	if (asked) await accept.first().click();
	const scene2d = (page) =>
		page.evaluate(() => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const layers = g.children.filter((c) => c.userData?.layer2d).map((c) => ({ name: c.name, z: c.position.z, ...c.userData.layer2d }));
			const player = g.getObjectByName('Player');
			const cam = g.children.find((c) => c.userData?.camera?.kind === 'orthographic');
			player?.geometry?.computeBoundingBox?.();
			const box = player?.geometry?.boundingBox;
			return {
				count: g.children.length,
				layers,
				player: player
					? { status: s.sprite2d.spriteStatus(player), image: !!player.material?.map?.image?.width, nearest: player.material?.map?.magFilter === 1003, size: box ? +(box.max.x - box.min.x).toFixed(3) : null, x: player.getWorldPosition(new s.THREE.Vector3()).x }
					: null,
				cam: cam ? { x: cam.position.x, uuid: cam.uuid } : null,
				previewing: s.sprite2d.sprite2dDebug().ortho
			};
		});
	await h.eventually(() => scene2d(A.page), (r) => !!r.player?.image, '6.1 the peer accepted, the template applied and its sprites loaded their images', 60000);
	await h.eventually(() => scene2d(B.page), (r) => !!r.player?.image, '6.1b the peer applied the same scene', 20000);
	const t1 = await Promise.all([scene2d(A.page), scene2d(B.page)]);
	for (const [k, r] of t1.entries()) {
		const who = k ? 'peer' : 'host';
		const pars = r.layers.map((l) => l.parallax).sort();
		h.check(r.layers.length === 4 && JSON.stringify(pars) === JSON.stringify([0, 0.3, 0.6, 1]), '6.2 ' + who + ': four 2D layers, three of them parallax (' + JSON.stringify(r.layers) + ')');
		h.check(r.player && r.player.status.clip === 'walk' && r.player.status.playing && r.player.nearest && r.player.size === 1, '6.3 ' + who + ': the player is an animated sprite sheet (walk autoplays, nearest, 1 m) (' + JSON.stringify(r.player) + ')');
	}
	const v2 = await A.page.evaluate(() => window.__view2dDebug?.());
	h.check(t1[0].previewing && v2?.active && v2.ortho && v2.rotate === false, '6.4 the opener is in the 2D editor view: orthographic, no rotate (' + JSON.stringify(v2) + ')');
	// framed in METRES: 10 m tall (the template camera's size), not the canvas in pixels
	const aspect = await A.page.evaluate(() => innerWidth / innerHeight);
	h.check(!!v2?.frustum && Math.abs(v2.frustum[2] - 5) < 1e-6 && Math.abs(v2.frustum[1] / v2.frustum[2] - aspect) < 0.05, '6.4c the 2D view frames 10 m of the scene at the canvas aspect (' + JSON.stringify(v2?.frustum) + ', aspect ' + aspect.toFixed(3) + ')');
	h.check(!t1[1].previewing, '6.4b the peer\'s view is its own (the 2D view is local)');
	// the camera follows the walking player (dead zone 2 m, offset), on every peer
	const follow = [];
	for (let i = 0; i < 6; i++) {
		follow.push(await scene2d(A.page));
		await A.page.waitForTimeout(500);
	}
	const lag = follow.map((r) => Math.abs(r.player.x - r.cam.x));
	const moved = Math.abs(follow[5].cam.x - follow[0].cam.x);
	h.check(moved > 1 && lag.every((d) => d < 2.5), '6.5 Camera Follow 2D keeps the walking player in view (camera moved ' + moved.toFixed(2) + ' m, gaps ' + lag.map((d) => d.toFixed(2)).join(' ') + ')');
	// pan the 2D view 6 m right: the far hills (parallax 0.3) are drawn 0.7 x 6 = 4.2 m along
	const drawn = await A.page.evaluate(async () => {
		const s = window.__stores;
		let g;
		let controls;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.orbitControls.subscribe((x) => (controls = x))();
		controls.target.x += 6;
		controls.object.position.x += 6;
		controls.update();
		await new Promise((r) => setTimeout(r, 400));
		const hills = g.children.find((c) => c.userData?.layer2d?.parallax === 0.3);
		const sky = g.children.find((c) => c.userData?.layer2d?.parallax === 0);
		hills.updateWorldMatrix(true, false);
		sky.updateWorldMatrix(true, false);
		const view = window.__view2dDebug();
		return { viewX: view.pos[0], hillsX: +hills.matrixWorld.elements[12].toFixed(3), skyX: +sky.matrixWorld.elements[12].toFixed(3), authored: hills.position.x };
	});
	h.check(Math.abs(drawn.hillsX - drawn.viewX * 0.7) < 0.05 && Math.abs(drawn.skyX - drawn.viewX) < 0.05 && drawn.authored === 0, '6.6 panning the 2D view draws the hills at 0.7 x the view\'s x and the sky with the view (authored stays 0) (' + JSON.stringify(drawn) + ')');
	// leaving the 2D view hands the perspective controls back (rotate on), and the layers draw as authored
	const back2d = await A.page.evaluate(async () => {
		const s = window.__stores;
		const m = await import('/src/lib/sprite2d/view2d.js');
		m.exit2dView();
		await new Promise((r) => setTimeout(r, 600));
		let controls;
		let g;
		s.orbitControls.subscribe((x) => (controls = x))();
		s.objectsGroup.subscribe((x) => (g = x))();
		const hills = g.children.find((c) => c.userData?.layer2d?.parallax === 0.3);
		hills.updateWorldMatrix(true, false);
		return { rotate: controls?.enableRotate, persp: !!controls?.object?.isPerspectiveCamera, hillsX: hills.matrixWorld.elements[12] };
	});
	h.check(back2d.rotate === true && back2d.persp && back2d.hillsX === 0, '6.8 View ▸ 2D view off: the perspective controls are back and the layers draw as authored (' + JSON.stringify(back2d) + ')');
	// the follow is LOCAL per peer (same graph, each peer's own player pose): the peer's camera
	// keeps the peer's player in view, sampled together
	const pb = [];
	for (let i = 0; i < 4; i++) {
		pb.push(await scene2d(B.page));
		await B.page.waitForTimeout(400);
	}
	const lagB = pb.map((r) => Math.abs(r.player.x - r.cam.x));
	h.check(lagB.every((d) => d < 2.5), '6.7 the peer\'s camera marker follows its player too (gaps ' + lagB.map((d) => d.toFixed(2)).join(' ') + ')');

	await h.finish(browser);
});
