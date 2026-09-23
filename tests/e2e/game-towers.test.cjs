// B8 ACCEPTANCE — the Towers game template (redesigned after the first playthrough:
// PRE-PLACED crates, no spawner, lit daylight, a pause/restart menu). Loaded from the
// REAL .tpscene in the sibling scenes checkout (or TOWERS_TPSCENE=<path>, a lane's staged
// build) with the REAL collectible zip, driven through the real surfaces. Skip-never-fail
// when the scenes checkout or the zip is absent — authored content, not core code, must
// keep a bare checkout green.
//
// 30 visuals-core: the finished look (glowing rings with select-through, a tiled floor from
// a shader graph, wooden crates, a sky + ground, stars that turn and breathe once a round
// starts), a centred HUD, a readable frame in play, and the BEST HEIGHT saved on this device
// (Store Value max) and shown on the menu, with the Round-over screen reading this round's
// height from `towers-last` — a perRound latch reads un-set the moment the round ends.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [
	path.resolve(__dirname, '../../../theprototype.app-scenes'),
	path.resolve(__dirname, '../../../scenes')
].find((p) => fs.existsSync(p));
const TPSCENE = process.env.TOWERS_TPSCENE || (SCENES_REPO && path.join(SCENES_REPO, 'games/towers/scene.tpscene'));

h.run(async () => {
	if (!TPSCENE || !fs.existsSync(TPSCENE)) {
		console.log('SKIP: no sibling scenes checkout with games/towers/scene.tpscene (or TOWERS_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	if (!(await h.installModule(A, 'collectible'))) {
		console.log('SKIP: no collectible.zip in the sibling modules checkout (npm run pack -- collectible)');
		await h.finish(browser);
		return;
	}

	const bytes = Array.from(fs.readFileSync(TPSCENE));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(2000);

	const snap = () =>
		page.evaluate(() => {
			const s = window.__stores;
			/** @param {any} st */
			const g = (st) => { let v; st.subscribe((/** @type {any} */ x) => (v = x))(); return v; };
			let group;
			s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
			const kids = group.children.map((/** @type {any} */ c) => ({
				name: c.name, uuid: c.uuid,
				dynamic: c.userData?.physics?.mode === 'dynamic',
				y: +c.position.y.toFixed(2)
			}));
			return {
				kids,
				sim: !!g(s.physics.simulating),
				state: g(s.gameState.gameState)?.state ?? null,
				play: g(s.scenePhysics.scenePlay),
				screen: s.hudDocs.visibleScreen('scene')?.id ?? null
			};
		});
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';
	const clickBtn = (text) => page.locator('#hud-layer button', { hasText: text }).click();

	// 1 — the world arrived whole and lit
	let st = await snap();
	// 30: 24 -> 36 (4 wall trims, the pad rim + its light, the height pole + 4 marks, the card camera)
	h.check(st.kids.length === 36, `the 36 objects arrived (${st.kids.length})`);
	const crates = st.kids.filter((k) => k.dynamic);
	h.check(crates.length === 9, `9 pre-placed dynamic crates (${crates.length})`);
	h.check(st.play?.simOnPlay === true && st.play?.interaction === 'grab', 'play block: grab + simOnPlay');
	h.check(st.state === 'menu' && st.screen === 'menu', `starts on the menu screen (${st.state}/${st.screen})`);

	// 1b — 30 visuals-core: the finished look is DATA in the file, measured rather than seen
	const look = await page.evaluate(() => {
		const s = window.__stores;
		const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const group = g(s.objectsGroup);
		const ring = group.getObjectByName('Height ring 2m');
		const floor = group.getObjectByName('Arena floor');
		const crate = group.getObjectByName('Cube 1');
		const star = group.getObjectByName('Star 1');
		const env = g(s.environment.environment);
		const anims = g(s.animationPreview.animations);
		const clip = anims[star?.uuid];
		return {
			ring: ring && { geo: ring.geometry.type, pick: ring.userData.pick ?? null, sensor: !!ring.userData.physics?.sensor, collider: ring.userData.physics?.collider },
			floorShader: !!g(s.shaderGraph.shaderGraphs)[floor?.uuid] && !g(s.shaderGraph.shaderErrors)[floor?.uuid],
			floorPatched: !!floor && Object.prototype.hasOwnProperty.call(floor.material, 'onBeforeCompile'),
			crate: crate && { type: crate.material.type, sheen: crate.material.sheen ?? 0, verts: crate.geometry.attributes.position.count },
			starClip: clip ? Object.values(clip.clips).map((c) => c.name) : [],
			gradient: !!env?.customPreset?.gradient, ground: !!env?.customPreset?.ground, exposure: env?.exposure,
			post: (g(s.scenePost.scenePost)?.effects ?? []).map((e) => e.kind)
		};
	});
	h.check(look.ring?.geo === 'TorusGeometry' && look.ring.pick === 'through' && look.ring.sensor && look.ring.collider === 'box', `the height markers are thin glowing ring SENSORS, select-through (${JSON.stringify(look.ring)})`);
	h.check(look.floorShader && look.floorPatched, `the arena floor carries its tile shader graph, compiled and installed (${look.floorShader}/${look.floorPatched})`);
	h.check(look.crate?.type === 'MeshPhysicalMaterial' && look.crate.sheen > 0 && look.crate.verts > 36, `the crates are chamfered wood: physical + sheen (${JSON.stringify(look.crate)})`);
	h.check(look.starClip.includes('Star glow'), `every star carries the Turntable + Pulse clip (${look.starClip})`);
	h.check(look.gradient && look.ground && look.exposure >= 0.9, `a real sky and ground, exposure >= 0.9 (${look.gradient}/${look.ground}/${look.exposure})`);
	h.check(['ao', 'tonemapping', 'bloom', 'smaa'].every((k) => look.post.includes(k)), `the post floor: AO, tone mapping, bloom, SMAA (${look.post})`);
	// no toast on load (the Stars Room emitter-cap toast was the finding)
	const loadToasts = await page.locator('.tp-toast').allTextContents().catch(() => []);
	h.check(!loadToasts.some((t) => /cap|error|went wrong/i.test(t)), `no warning toast on load (${JSON.stringify(loadToasts).slice(0, 120)})`);

	// 2 — entering play starts the sim (simOnPlay honoured from the file)
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering play starts the sim', 10000);
	// 30 P1: a game's menu is drawn in PLAY, not over the editor (game-editor-flow covers
	// the editor half), so the menu check lives on this side of the play press now
	h.check(/TOWERS/.test(await hud()), 'the menu renders in play (TOWERS)');
	h.check(/Your best tower: 0 m/.test(await hud()), 'the menu shows this device\'s best height (none yet: 0 m)');
	// 30: a centred HUD text is CENTRED — the words, not the box (a flex row shrank the line
	// to its text, so text-align did nothing and every centred title sat flush left)
	const centring = await page.evaluate(() => {
		const out = {};
		for (const el of document.querySelectorAll('#hud-layer .hud-text')) {
			const t = el.textContent.trim();
			if (t !== 'TOWERS' && !/^Your best tower/.test(t)) continue;
			const r = document.createRange();
			r.selectNodeContents(el);
			const words = r.getBoundingClientRect();
			const box = el.getBoundingClientRect();
			out[t.slice(0, 12)] = +((words.left + words.width / 2) - (box.left + box.width / 2)).toFixed(1);
		}
		return out;
	});
	h.check(Object.keys(centring).length === 2 && Object.values(centring).every((d) => Math.abs(d) < 3), `centred HUD texts are centred on their box (offsets ${JSON.stringify(centring)})`);

	// 3 — the Start button flips to playing and swaps the menu for the HUD
	await clickBtn('Start round');
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'playing', 'Start flips to playing', 8000);
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'hud', 'the in-game HUD screen shows', 6000);
	// 30: the stars turn and breathe once the round starts (a Play Animation per star)
	await h.eventually(
		() => page.evaluate(() => {
			const s = window.__stores; let group, pb;
			s.objectsGroup.subscribe((v) => (group = v))(); s.animationPreview.playback.subscribe((v) => (pb = v))();
			return ['Star 1', 'Star 2', 'Star 3'].filter((n) => pb[group.getObjectByName(n)?.uuid]?.playing).length;
		}),
		(n) => n === 3, 'Start sets all three stars turning (their Star glow clip plays)', 6000
	);
	// 30: a READABLE frame in play — mean luminance of the centred 360 px square (fork 11)
	await page.waitForTimeout(800);
	const lum = await page.evaluate(async (b64) => {
		const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
		const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
		const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
		const d = x.getImageData(Math.round(bmp.width / 2 - 180), Math.round(bmp.height / 2 - 180), 360, 360).data;
		let sum = 0;
		for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
		return sum / (d.length / 4) / 255;
	}, (await page.screenshot()).toString('base64'));
	h.check(lum >= 0.25, `the play frame reads: centre luminance ${lum.toFixed(3)} >= 0.25`);

	// 4 — crates rest stably (no cycling): population and dynamic count hold over 4s
	const before = (await snap()).kids.length;
	await page.waitForTimeout(4000);
	st = await snap();
	h.check(st.kids.length === before, `object count is stable, no spawn churn (${before} -> ${st.kids.length})`);
	h.check(st.kids.filter((k) => k.dynamic).length === 9, 'still exactly 9 crates (none recycled)');

	// 5 — a crate lifted through the rings latches the height HUD (grab stand-in:
	// an external write carries a crate up through the ring sensors)
	const crate = st.kids.find((k) => k.dynamic);
	await page.evaluate((uuid) => {
		const s = window.__stores;
		let group; s.objectsGroup.subscribe((/** @type {any} */ v) => (group = v))();
		const o = group.children.find((/** @type {any} */ c) => c.uuid === uuid);
		o.position.set(0, 3.5, 0); o.updateMatrix();
	}, crate.uuid);
	await h.eventually(async () => await hud(), (t) => /Best height: [1-3] m/.test(t), 'lifting a crate latches the height HUD', 12000);
	h.check(/Stars left: 3/.test(await hud()), 'the collectible module reports 3 stars left');
	// 30: the crossing SAVED the height on this device (Store Value max + the round's `set`)
	const stored = () => page.evaluate(() => {
		const out = {};
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (/^tp:scene:.*:towers-(best|last)$/.test(k)) out[k.split(':').pop().replace('towers-', '')] = JSON.parse(localStorage.getItem(k));
		}
		return out;
	});
	await h.eventually(stored, (v) => v.best >= 1 && v.last === v.best, 'the best height is saved on this device (towers-best, towers-last)', 6000);
	h.check(/\d+s/.test(await hud()), 'the round clock renders');

	// 5b — GRAB: aim at a crate and pointerdown carries it (the user's "cannot take
	// objects with mouse click"). The ray is NDC (0,0), so put a crate in front of the
	// aiming camera; the sim is already running from Start.
	const grabCrate = (await snap()).kids.find((k) => k.dynamic).uuid;
	await page.evaluate((uuid) => {
		const THREE = window.__stores.THREE;
		let camera; window.__stores.globalCamera.subscribe((v) => (camera = v))();
		let group; window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const at = camera.getWorldPosition(new THREE.Vector3())
			.addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 3.5);
		const o = group.getObjectByProperty('uuid', uuid);
		o.position.copy(at); o.updateMatrixWorld(); window.__stores.objectsGroup.update((v) => v);
	}, grabCrate);
	await page.waitForTimeout(500);
	const aiming = await page.evaluate(() => {
		let s; window.__stores.playInteract.playInteractState.subscribe((v) => (s = v))(); return s;
	});
	h.check(aiming.mode === 'aiming', `the reticle finds a grabbable crate (${aiming.mode})`);
	await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })));
	await page.waitForTimeout(300);
	const carrying = await page.evaluate(() => {
		let d; window.__stores.playInteract.playInteractState.subscribe((v) => (d = v))();
		return window.__stores.playInteract.playInteractDebug().carrying;
	});
	h.check(carrying === grabCrate, `pointerdown grabs the crate (${carrying === grabCrate})`);
	await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true })));
	await page.waitForTimeout(300);

	// 5c — 30: Round over reads THIS round's height from the stored `towers-last` (a perRound
	// latch reads 0 the instant the round ends, which is what the old line showed) and the
	// best from `towers-best`; Play again starts a fresh round and re-zeroes the round's value
	const kept = await stored();
	// clear the pad first: a crate still standing through a ring re-crosses it in the next
	// round (the sensor overlap is live), which would make "this round" honestly 1 m — and
	// was, measured, the base's red on "Restart cleared the height latches"
	await page.evaluate(() => {
		let group; window.__stores.objectsGroup.subscribe((v) => (group = v))();
		let n = 0;
		for (const c of group.children) {
			if (c.userData?.physics?.mode !== 'dynamic') continue;
			if (Math.hypot(c.position.x, c.position.z) > 1.6 && c.position.y < 0.9) continue;
			c.position.set(-9 + (n++ % 6) * 0.9, 0.35, 8);
			c.updateMatrix();
		}
		window.__stores.objectsGroup.update((v) => v);
	});
	await page.waitForTimeout(1200);
	await page.evaluate(() => window.__stores.gameState.setGameState('over', { outcome: "Time's up!" }));
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'over', 'the round ends on the Round-over screen', 6000);
	await h.eventually(async () => await hud(), (t) => new RegExp('This round: ' + kept.last + ' m').test(t) && new RegExp('Best ever: ' + kept.best + ' m').test(t), `Round over reads this round (${kept.last} m) and the best (${kept.best} m) from storage`, 6000);
	// a crate jittering in a ring sensor after the round ended re-fires the crossing while
	// every latch reads 0 — the round's stored height must survive it (a `set` would wipe it)
	await page.evaluate(() => {
		let group; window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const ring = group.getObjectByName('Height ring 1m');
		const crate = group.getObjectByName('Cube 1');
		window.__stores.flowRuntime.fireObjectEnter(ring.uuid, crate.uuid);
	});
	await page.waitForTimeout(800);
	const afterJitter = await stored();
	h.check(afterJitter.last === kept.last && new RegExp('This round: ' + kept.last + ' m').test(await hud()), `a crossing re-fired on the Round-over screen leaves this round's height alone (${JSON.stringify(afterJitter)})`);
	await clickBtn('Play again');
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'playing', 'Play again starts a fresh round', 8000);
	await h.eventually(stored, (v) => v.last === 0 && v.best === kept.best, 'the fresh round zeroes this round\'s height and keeps the best', 6000);

	// 6 — PAUSE menu (P) offers Restart while playing
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', bubbles: true }));
	});
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'pause', 'P opens the pause menu', 6000);
	h.check(/PAUSED/.test(await hud()) && /Restart round/.test(await hud()), 'pause shows a Restart button');

	// 7 — Restart resets the round: height latches clear, back to the HUD
	await clickBtn('Restart round');
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'hud', 'Restart returns to play', 8000);
	await h.eventually(async () => await hud(), (t) => /Best height: 0 m/.test(t), 'Restart cleared the height latches', 8000);

	// 8 — 30: Quit to menu, and the menu carries the saved best height
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', bubbles: true }));
	});
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'pause', 'P opens the pause menu again', 6000);
	await clickBtn('Quit to menu');
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'menu', 'Quit returns to the menu', 8000);
	await h.eventually(async () => await hud(), (t) => new RegExp('Your best tower: ' + kept.best + ' m').test(t), `the menu shows the saved best (${kept.best} m)`, 6000);

	await page.evaluate(() => window.__stores.isLocked.set(false));
	await page.waitForTimeout(400);
	await h.finish(browser);
});
