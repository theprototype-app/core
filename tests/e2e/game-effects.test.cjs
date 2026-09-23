// 30b (vr-play) P2 — C6 EFFECTS and api.announce. The user, on Towers: "When I reach some of
// the rings and go to the top, it should dynamically tell me and give effects such as
// sparkles or anything similar."
//
// 1 a burst is a scene-root, pooled, LOCAL particle system (nothing in objectsGroup,
// nothing on the wire) · 2 it moves the way its kind says (confetti falls, smoke rises) ·
// 3 it dies after its life and leaves the frame loop · 4 the pool is bounded and recycles ·
// 5 inputs are clamped and bad ones refused · 6 it reaches the PIXELS · 7 announce shows a
// big banner, replaces the one showing, and goes by itself · 8 a scene clear takes both.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;

	await page.evaluate(async () => {
		const s = window.__stores;
		await s.moduleSDK.initModules([
			{ id: 'fx30b', name: 'Effects test', version: '1.0.0', description: 'the 30b effect seams', register(api) { window.__api = api; } }
		]);
		window.__sent = [];
		let peer;
		s.peers.subscribe((p) => (peer = p))();
		const orig = peer.send.bind(peer);
		peer.send = (data) => {
			window.__sent.push(data?.type);
			return orig(data);
		};
	});
	await page.waitForTimeout(600); // the primed effects import

	console.log('\n=== 1. a burst is local, scene-root, pooled ===');
	const fired = await page.evaluate(() => {
		const s = window.__stores;
		let scene, group;
		s.globalScene.subscribe((v) => (scene = v))();
		s.objectsGroup.subscribe((v) => (group = v))();
		const before = group.children.length;
		let rd;
		s.globalRenderer.subscribe((v) => (rd = v))();
		const pointsBefore = rd.info.programs.length;
		const ok = window.__api.effects.burst([0, 1.5, -3], { kind: 'confetti' });
		// synchronously, before ANY frame has drawn the burst
		const pointsAfter = rd.info.programs.length;
		const fx = s.gameKit.effectsBurst.burstDebug();
		const live = fx.live[0];
		const points = live ? scene.getObjectByName(live.name) : null;
		return {
			ok,
			live,
			parentIsScene: points?.parent === scene,
			inGroup: !!group.getObjectByName(live?.name ?? '-'),
			groupDelta: group.children.length - before,
			drawCount: points?.geometry?.drawRange?.count ?? -1,
			sent: window.__sent.slice(),
			pointsBefore,
			pointsAfter
		};
	});
	h.check(fired.ok === true && fired.live?.kind === 'confetti', '1.1 api.effects.burst starts a confetti burst (' + JSON.stringify(fired.live) + ')');
	h.check(fired.parentIsScene && !fired.inGroup && fired.groupDelta === 0, '1.2 it lives at the scene root, never in objectsGroup');
	h.check(fired.drawCount === 80, '1.3 confetti draws its recipe count (80, got ' + fired.drawCount + ')');
	h.check(!fired.sent.length, '1.4 nothing was sent (' + JSON.stringify(fired.sent) + ')');
	h.check(
		fired.pointsAfter > fired.pointsBefore,
		'1.5 the burst program is compiled when the pool is built, not on the first draw (' + fired.pointsBefore + ' -> ' + fired.pointsAfter + ')'
	);

	console.log('\n=== 2. each kind moves the way it says ===');
	const motion = await page.evaluate(() => {
		const s = window.__stores;
		const fx = s.gameKit.effectsBurst;
		fx.clearBursts();
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const meanY = (name) => {
			const p = scene.getObjectByName(name);
			const a = p.geometry.attributes.position.array;
			const n = p.geometry.drawRange.count;
			let y = 0;
			for (let i = 0; i < n; i++) y += a[i * 3 + 1];
			return y / n;
		};
		const spread = (name) => {
			const p = scene.getObjectByName(name);
			const a = p.geometry.attributes.position.array;
			let m = 0;
			for (let i = 0; i < p.geometry.drawRange.count; i++) m = Math.max(m, Math.hypot(a[i * 3], a[i * 3 + 1] - 1, a[i * 3 + 2]));
			return m;
		};
		const c = fx.burst([0, 1, 0], { kind: 'confetti' });
		const m = fx.burst([0, 1, 0], { kind: 'smoke' });
		for (let i = 0; i < 12; i++) fx.stepBursts(1 / 60);
		const early = { confetti: meanY(c), smoke: meanY(m), spread: spread(c) };
		for (let i = 0; i < 60; i++) fx.stepBursts(1 / 60);
		const late = { confetti: meanY(c), smoke: meanY(m) };
		return { early, late };
	});
	h.check(motion.early.spread > 0.3, '2.1 the particles fly apart (' + motion.early.spread.toFixed(2) + ' m after 0.2 s)');
	h.check(motion.late.confetti < motion.early.confetti, '2.2 confetti falls under gravity (' + motion.early.confetti.toFixed(2) + ' -> ' + motion.late.confetti.toFixed(2) + ')');
	h.check(motion.late.smoke > motion.early.smoke && motion.late.smoke > 1, '2.3 smoke rises (' + motion.early.smoke.toFixed(2) + ' -> ' + motion.late.smoke.toFixed(2) + ')');

	console.log('\n=== 3. a burst dies and leaves the frame loop ===');
	const lifetime = await page.evaluate(async () => {
		const s = window.__stores;
		const fx = s.gameKit.effectsBurst;
		fx.clearBursts();
		await new Promise((r) => setTimeout(r, 200)); // let the idle task leave
		const tasksBefore = s.moduleSDK.moduleFrameTasks.length;
		fx.burst([0, 1, -2], { kind: 'sparks' });
		const during = s.moduleSDK.moduleFrameTasks.length;
		await new Promise((r) => setTimeout(r, 1400)); // sparks live 0.55 s, on the REAL frame loop
		return { tasksBefore, during, after: s.moduleSDK.moduleFrameTasks.length, live: fx.burstDebug().live.length };
	});
	h.check(lifetime.during === lifetime.tasksBefore + 1, '3.1 a live burst ticks from the frame loop (' + JSON.stringify(lifetime) + ')');
	h.check(lifetime.live === 0, '3.2 the real frame loop aged it out (no live bursts after its life)');
	h.check(lifetime.after === lifetime.tasksBefore, '3.3 and its frame task left the loop with it');

	console.log('\n=== 4. the pool is bounded and recycles ===');
	const pool = await page.evaluate(() => {
		const s = window.__stores;
		const fx = s.gameKit.effectsBurst;
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const before = fx.burstDebug().recycled;
		for (let i = 0; i < 20; i++) fx.burst([i * 0.1, 1, -2], { kind: 'sparkle' });
		const systems = scene.children.filter((c) => /^effects-burst-/.test(c.name)).length;
		return { systems, live: fx.burstDebug().live.length, recycled: fx.burstDebug().recycled - before, cap: fx.POOL_SIZE };
	});
	h.check(pool.systems === pool.cap && pool.live === pool.cap, '4.1 twenty bursts use at most the pool (' + JSON.stringify(pool) + ')');
	h.check(pool.recycled === 20 - pool.cap, '4.2 the oldest ones were recycled');

	console.log('\n=== 5. inputs are clamped and bad ones refused ===');
	const inputs = await page.evaluate(() => {
		const s = window.__stores;
		const fx = s.gameKit.effectsBurst;
		fx.clearBursts();
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		const big = fx.burst([0, 1, 0], { count: 5000, kind: 'nope', color: '#00ff00' });
		const p = scene.getObjectByName(big);
		const col = p.geometry.attributes.color.array;
		return {
			count: p.geometry.drawRange.count,
			kind: fx.burstDebug().live[0].kind,
			green: col[1] > 0.9 && col[0] < 0.1,
			bad: window.__api.effects.burst([0, NaN, 0]),
			short: window.__api.effects.burst([1, 2])
		};
	});
	h.check(inputs.count === 96, '5.1 count clamps to 96 (' + inputs.count + ')');
	h.check(inputs.kind === 'sparkle' && inputs.green, '5.2 an unknown kind falls back to sparkle, the colour is honoured');
	h.check(inputs.bad === false && inputs.short === false, '5.3 a bad position is refused');

	console.log('\n=== 6. it reaches the pixels ===');
	await page.evaluate(() => {
		window.__stores.gameKit.effectsBurst.clearBursts();
		window.__stores.objectActions.deselectObject?.();
	});
	await page.waitForTimeout(400);
	const quiet1 = await h.grabFrame(A);
	await page.waitForTimeout(150);
	const quiet2 = await h.grabFrame(A);
	const fired6 = await page.evaluate(() => {
		const s = window.__stores;
		let cam;
		s.globalCamera.subscribe((c) => (cam = c))();
		const THREE = s.THREE;
		const at = cam.getWorldPosition(new THREE.Vector3()).add(cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(4));
		const ok = window.__api.effects.burst(at.toArray(), { kind: 'confetti', count: 96 }); // 2.2 s of life: a slow frame cannot outlive it
		return { ok, live: s.gameKit.effectsBurst.burstDebug().live, tasks: s.moduleSDK.moduleFrameTasks.length };
	});
	// the burst lives 1.1 s; a loaded machine can take a while to render the next frame,
	// so sample until one differs (or the burst is surely gone)
	const idle = await h.frameDelta(page, quiet1, quiet2);
	let burstDelta = { changed: 0 };
	for (let i = 0; i < 6 && burstDelta.changed <= idle.changed + 400; i++) {
		await page.waitForTimeout(80);
		const frame = await h.grabFrame(A);
		burstDelta = await h.frameDelta(page, quiet2, frame);
	}
	const diag = await page.evaluate(async () => {
		const s = window.__stores;
		let rd, scene, cam;
		s.globalRenderer.subscribe((v) => (rd = v))();
		s.globalScene.subscribe((v) => (scene = v))();
		s.globalCamera.subscribe((v) => (cam = v))();
		const f0 = rd.info.render.frame;
		await new Promise((r) => setTimeout(r, 300));
		const live = s.gameKit.effectsBurst.burstDebug().live;
		const p = live[0] ? scene.getObjectByName(live[0].name) : null;
		return {
			frames: rd.info.render.frame - f0,
			live,
			parent: p?.parent === scene,
			cam: cam?.position.toArray().map((v) => +v.toFixed(1)),
			pos: p ? Array.from(p.geometry.attributes.position.array.slice(0, 3)).map((v) => +v.toFixed(1)) : null
		};
	});
	h.check(burstDelta.changed > idle.changed + 400, '6.1 a burst in view changes the frame (' + burstDelta.changed + ' px vs idle ' + idle.changed + ') ' + JSON.stringify({ fired6, diag }));

	console.log('\n=== 7. announce ===');
	const ann = await page.evaluate(async () => {
		const api = window.__api;
		const empty = api.announce('   ');
		const id1 = api.announce('Ring 1 reached', { ms: 3000 });
		const id2 = api.announce('GOAL!', { sub: 'Blue 1 - 0', ms: 900, color: '#22c55e' });
		await new Promise((r) => setTimeout(r, 100));
		const el = document.querySelector('#game-announce');
		const title = el?.querySelector('.game-announce-title');
		const out = {
			empty,
			id1,
			id2,
			count: document.querySelectorAll('#game-announce').length,
			text: el?.textContent?.replace(/\s+/g, ' ').trim(),
			color: title ? getComputedStyle(title).color : null,
			pe: el ? getComputedStyle(el).pointerEvents : null
		};
		await new Promise((r) => setTimeout(r, 1200));
		out.gone = !document.querySelector('#game-announce');
		return out;
	});
	h.check(ann.empty === 0 && ann.id1 > 0 && ann.id2 > ann.id1, '7.1 an empty line is refused, each banner gets an id');
	h.check(ann.count === 1 && ann.text === 'GOAL! Blue 1 - 0', '7.2 ONE banner, the newest replacing the first (' + ann.text + ')');
	h.check(ann.color === 'rgb(34, 197, 94)' && ann.pe === 'none', '7.3 the title takes its colour and the banner never takes a click');
	h.check(ann.gone, '7.4 it goes by itself after its ms');
	const vr = await page.evaluate(async () => {
		const s = window.__stores;
		s.isVRMode.set(true);
		window.__api.announce('Level 3');
		await new Promise((r) => setTimeout(r, 100));
		const shown = !!document.querySelector('#game-announce');
		s.isVRMode.set(false);
		return shown;
	});
	h.check(vr === false, '7.5 in VR the DOM banner stands down (the head-locked one takes over, P3)');

	console.log('\n=== 8. a scene clear takes both ===');
	const cleared = await page.evaluate(async () => {
		const s = window.__stores;
		window.__api.effects.burst([0, 1, -2], { kind: 'smoke' });
		window.__api.announce('Wave 2', { ms: 5000 });
		await new Promise((r) => setTimeout(r, 50));
		const before = { live: s.gameKit.effectsBurst.burstDebug().live.length, banner: !!document.querySelector('#game-announce') };
		s.moduleSDK.runSceneClearHandlers();
		await new Promise((r) => setTimeout(r, 100));
		return { before, live: s.gameKit.effectsBurst.burstDebug().live.length, banner: !!document.querySelector('#game-announce') };
	});
	h.check(cleared.before.live > 0 && cleared.before.banner, '8.1 premise: a burst and a banner are up');
	h.check(cleared.live === 0 && !cleared.banner, '8.2 a scene clear removes both (' + JSON.stringify(cleared) + ')');

	await h.finish(browser);
});
