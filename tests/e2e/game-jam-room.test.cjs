// 30 visuals-core P2 ACCEPTANCE — the Jam Room becomes a GAME. It was 23-D3's sandbox: the
// music modules' devices, all cabled, on one dark slab with no HUD. Now it is a small studio
// with a shell: Start -> a three-second count-in -> keep the band playing for EIGHT BARS
// (core's Transport node reads the shared clock; the bars count from the beat the count-in
// ended on, kept with Set Variable) -> Session complete, the tempo you finished at saved as
// this device's best (Store Value max). A FREE cursor (play.cursor 'free'): you play the
// instruments by pointing at them, no pointer lock.
//
// Loaded from the REAL .tpscene: JAM_ROOM_TPSCENE=<path> (a lane's staged build) or the
// sibling scenes checkout's games/jam-room/scene.tpscene, with the REAL music-lab and
// music-fx zips. Skip-never-fail when either is absent.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [
	path.resolve(__dirname, '../../../theprototype.app-scenes'),
	path.resolve(__dirname, '../../../scenes')
].find((p) => fs.existsSync(p));
const TPSCENE = process.env.JAM_ROOM_TPSCENE || (SCENES_REPO && path.join(SCENES_REPO, 'games/jam-room/scene.tpscene'));

h.run(async () => {
	if (!TPSCENE || !fs.existsSync(TPSCENE)) {
		console.log('SKIP: no games/jam-room/scene.tpscene in a sibling scenes checkout and no JAM_ROOM_TPSCENE');
		return;
	}
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	for (const id of ['music-lab', 'music-fx'])
		if (!(await h.installModule(A, id))) {
			console.log('SKIP: no ' + id + '.zip in the sibling modules checkout');
			await h.finish(browser);
			return;
		}
	await page.evaluate(() => window.__stores.modulesOpen.set(false));

	const bytes = Array.from(fs.readFileSync(TPSCENE));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(2500);

	const snap = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
			const group = g(s.objectsGroup);
			const kinds = [];
			group.traverse((o) => { if (o.userData?.device?.kind) kinds.push(o.userData.device.kind); });
			return {
				kinds,
				state: g(s.gameState.gameState)?.state ?? null,
				screen: s.hudDocs.visibleScreen('scene')?.id ?? null,
				cursor: s.playCursor.playCursorDebug(),
				transport: s.musicClock.transportState()
			};
		});
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';
	const clickBtn = (text) => page.getByRole('button', { name: text, exact: true }).click();
	const stored = () => page.evaluate(() => {
		const out = {};
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (/^tp:scene:.*:jam-(best|last)-bpm$/.test(k)) out[k.split(':').pop()] = JSON.parse(localStorage.getItem(k));
		}
		return out;
	});

	// 1 — the room arrived: twelve cabled devices in a studio, and the shell
	let st = await snap();
	h.check(st.kinds.length === 12, `the twelve devices arrived (${st.kinds.length}: ${[...new Set(st.kinds)].map((k) => k.replace(/^mod-music-(lab|fx)-/, '')).join(', ')})`);
	const look = await page.evaluate(() => {
		const s = window.__stores;
		const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
		const group = g(s.objectsGroup);
		const env = g(s.environment.environment);
		const lights = [];
		group.traverse((o) => { if (o.isLight) lights.push(o.type); });
		return {
			walls: ['Back wall', 'Left wall', 'Right wall'].every((n) => group.getObjectByName(n)?.userData?.pick === 'through'),
			rug: !!group.getObjectByName('Rug'), props: ['Amp', 'Plant', 'Stool', 'Lamp left'].every((n) => !!group.getObjectByName(n)),
			lights, gradient: !!env?.customPreset?.gradient, exposure: env?.exposure,
			post: (g(s.scenePost.scenePost)?.effects ?? []).map((e) => e.kind)
		};
	});
	h.check(look.walls && look.rug && look.props, 'a studio: select-through walls, a rug, a lamp, an amp, a plant, a stool');
	h.check(look.lights.includes('SpotLight') && look.lights.filter((t) => t === 'PointLight').length >= 2, `warm light: a spot and the lamps (${look.lights})`);
	h.check(look.gradient && look.exposure >= 0.9, `a real backdrop, exposure ${look.exposure}`);
	h.check(['ao', 'tonemapping', 'bloom', 'smaa'].every((k) => look.post.includes(k)), `the post floor (${look.post})`);
	h.check(st.state === 'menu' && st.screen === 'start', `it is a game now: the start screen (${st.state}/${st.screen})`);
	h.check(st.cursor.setting === 'free', `a free-cursor game (${JSON.stringify(st.cursor)})`);
	h.check(!st.transport.playing, 'the transport is stopped on load (nothing plays until you do)');

	// 1c — 30b: THE COCKPIT. Standing on the VR spawn, the controller TIP reaches a control on
	// every instrument (piano, drums, sampler, transport, mixer) at hand height, and the laser
	// has a clear line to every pedal and speaker. Measured from the scene, not believed.
	const reach = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		let scene, group;
		s.globalScene.subscribe((v) => (scene = v))();
		s.objectsGroup.subscribe((v) => (group = v))();
		group.updateMatrixWorld(true);
		const spawn = s.playSettings.resolvePlaySettings(scene).spawn;
		if (!spawn) return { spawn: null };
		const [fx, fy, fz] = spawn.position;
		const head = new THREE.Vector3(fx, fy + 1.6, fz);
		const devices = [];
		group.traverse((o) => { if (o.userData?.device?.kind) devices.push(o); });
		const out = {};
		for (const d of devices) {
			const kind = d.userData.device.kind.replace(/^mod-music-(lab|fx)-/, '');
			let best = null;
			d.traverse((m) => {
				if (!m.isMesh || m === d) return;
				if (!s.gameKit.vrGameInput.clickTargetOf({ object: m, point: new THREE.Vector3(), distance: 0 })) return;
				if (/^vrpatch/.test(m.name)) return; // a cable jack is not the instrument
				const b = new THREE.Box3().setFromObject(m);
				const c = b.getCenter(new THREE.Vector3());
				// horizontal distance from the feet axis to the nearest point of the control
				const nx = Math.max(b.min.x, Math.min(fx, b.max.x));
				const nz = Math.max(b.min.z, Math.min(fz, b.max.z));
				const flat = Math.hypot(nx - fx, nz - fz);
				// the laser: nothing opaque between the head and the control's centre
				const dir = c.clone().sub(head);
				const len = dir.length();
				const ray = new THREE.Raycaster(head, dir.normalize(), 0, len - 0.02);
				const blocker = ray.intersectObjects(group.children, true).find((hit) => {
					let n = hit.object;
					while (n && n !== group) {
						if (n === d || n.userData?.pick === 'through') return false;
						n = n.parent;
					}
					return true;
				});
				const row = { flat: +flat.toFixed(2), y: +c.y.toFixed(2), laser: +len.toFixed(2), blocked: blocker ? blocker.object.name : null };
				if (!best || row.flat < best.flat) best = row;
			});
			(out[kind] ??= []).push(best);
		}
		return { spawn, out };
	});
	h.check(reach.spawn?.vrOnly === true && reach.spawn.position.join() === '1,0,-1', `30b: a VR-only spawn in the middle of the cockpit (${JSON.stringify(reach.spawn)})`);
	const tipReach = ['piano', 'drums', 'sampler', 'transport', 'mixer'].map((k) => [k, reach.out?.[k]?.[0]]);
	h.check(tipReach.every(([, r]) => r && r.flat <= 0.85 && r.y >= 0.6 && r.y <= 1.6), `30b: the tip reaches every instrument at hand height from the spawn (${JSON.stringify(Object.fromEntries(tipReach))})`);
	const laserReach = Object.entries(reach.out ?? {}).flatMap(([k, rows]) => rows.map((r) => [k, r]));
	h.check(laserReach.length === 12 && laserReach.every(([, r]) => r && !r.blocked && r.laser <= 3.5), `30b: the laser has a clear line to all twelve devices (${JSON.stringify(laserReach.filter(([, r]) => !r || r.blocked || r.laser > 3.5))})`);

	// 2 — Play: no pointer lock, the start screen
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(1500);
	st = await snap();
	const lockEl = await page.evaluate(() => !!document.pointerLockElement);
	h.check(st.cursor.free === true && !lockEl, `in Play the cursor stays free (free ${st.cursor.free}, lock ${lockEl})`);
	h.check(/JAM ROOM/.test(await hud()) && /Start jam/.test(await hud()) && /Your best tempo: 0 BPM/.test(await hud()), 'the start screen: title, Start jam, this device\'s best (none yet)');
	// 30b: how to play, on a desktop and in VR; no music over the band; a desktop keeps its view
	h.check(/HOW TO PLAY/.test(await hud()) && /VR: hold the trigger and sweep/.test(await hud()), '30b: the start screen says how to play, VR included');
	const quiet = await page.evaluate(() => {
		const s = window.__stores;
		let m, cam;
		s.gameKit.gameMusic.gameMusicState.subscribe((v) => (m = v))();
		s.playerCam.subscribe((v) => (cam = v))();
		const p = cam.getWorldPosition(new s.THREE.Vector3());
		return { music: m, musicNodes: s.allNodes().filter((n) => n.type === 'gamemusic').length, eye: [p.x, p.y, p.z].map((n) => +n.toFixed(2)) };
	});
	h.check(quiet.music === null && quiet.musicNodes === 0, `30b: no game music — the room IS the music (${JSON.stringify(quiet.music)}, ${quiet.musicNodes} nodes)`);
	h.check(Math.hypot(quiet.eye[0] - 1, quiet.eye[2] + 1) > 0.5, `30b: desktop Play does not stand on the VR-only spawn (eye ${quiet.eye})`);

	// 3 — Start: the count-in, then the goal, which waits for the transport
	await clickBtn('Start jam');
	await h.eventually(() => snap().then((v) => `${v.state}/${v.screen}`), (v) => v === 'playing/countin', 'Start plays the count-in', 4000);
	h.check(/Get ready/.test(await hud()) && /[123]/.test(await hud()), 'the count-in counts');
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'hud', 'after three seconds the goal shows', 6000);
	await h.eventually(async () => await hud(), (t) => /Bar 0 \/ 8/.test(t) && /Press ▶ on the Transport/.test(t), 'Bar 0 / 8, and it says what starts the beat', 4000);
	// a READABLE frame in play, measured on the goal screen (the start screen's panel would be
	// measuring the menu): mean luminance of the centred 360 px square (fork 11)
	const lum = await page.evaluate(async (b64) => {
		const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
		const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
		const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
		const d = x.getImageData(Math.round(bmp.width / 2 - 180), Math.round(bmp.height / 2 - 180), 360, 360).data;
		let sum = 0;
		for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
		return sum / (d.length / 4) / 255;
	}, (await page.screenshot(process.env.SHOT ? { path: process.env.SHOT } : {})).toString('base64'));
	h.check(lum >= 0.25, `the play frame reads: centre luminance ${lum.toFixed(3)} >= 0.25`);
	await page.waitForTimeout(1500);
	h.check((await snap()).state === 'playing' && /Bar 0 \/ 8/.test(await hud()), 'with the transport stopped, no bar counts (the goal is the band playing)');

	// 4 — the transport runs (the device's ▶, here through the same shared clock) at 240 BPM:
	// eight bars are 32 beats, eight seconds
	await page.evaluate(() => { const m = window.__stores.musicClock; m.setBpm(240); m.playTransport(); });
	await h.eventually(async () => await hud(), (t) => /Keep the band going\s+·\s+240 BPM/.test(t), 'the hint follows the transport (playing, 240 BPM)', 4000);
	await h.eventually(async () => await hud(), (t) => /Bar [1-7] \/ 8/.test(t), 'the bars count up', 6000);
	await h.eventually(() => snap().then((v) => v.state), (v) => v === 'over', 'eight bars complete the session (over)', 14000);
	await h.eventually(async () => await hud(), (t) => /SESSION COMPLETE/.test(t) && /8 bars at 240 BPM/.test(t) && /Your best tempo: 240 BPM/.test(t), 'Session complete names the tempo and the best', 4000);
	h.check((await stored())['jam-best-bpm'] === 240, 'the best tempo is saved on this device (jam-best-bpm 240)');
	const done = await page.evaluate(() => window.__stores.gameKit.gameFeelActions.gameFeelActionsDebug());
	h.check(done.last.some((e) => e.type === 'announce' && e.text === 'Session complete!' && e.sub === '8 bars at 240 BPM') && done.last.some((e) => e.type === 'effectburst' && e.kind === 'confetti') && (done.sounds.levelup ?? 0) >= 1, '30b: the session ends with a banner (8 bars at 240 BPM), confetti and the fanfare');

	// 5 — Play again: a fresh count-in, and the bars count from where the count-in ENDED —
	// the transport is still running at beat 30-something
	await clickBtn('Play again');
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'countin', 'Play again counts in again', 5000);
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'hud', 'and returns to the goal', 6000);
	// flowValues publishes every 150 ms, so wait for the captured start beat to arrive there
	let barsNow = {};
	await h.eventually(
		async () => (barsNow = await page.evaluate(() => {
			let v; window.__stores.flowValues.subscribe((x) => (v = x))();
			return { bars: v['bars'], beat: v['tbeat'], start: v['startbeat'] };
		})),
		(v) => v.start > 16, 'the count-in kept the beat it ended on (a replicated sample-and-hold)', 4000
	);
	h.check(barsNow.beat > 16 && barsNow.bars < 1.5, `the new round counts from its own start, not the transport's (${JSON.stringify(barsNow)})`);

	// 6 — Quit to the start screen, which carries the best
	await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyP', bubbles: true }));
	});
	await h.eventually(() => snap().then((v) => v.screen), (v) => v === 'pause', 'P opens the menu', 6000);
	await clickBtn('Quit to menu');
	await h.eventually(() => snap().then((v) => `${v.state}/${v.screen}`), (v) => v === 'menu/start', 'Quit returns to the start screen', 6000);
	h.check(/Your best tempo: 240 BPM/.test(await hud()), 'the start screen shows the saved best');

	await page.evaluate(() => { window.__stores.musicClock.stopTransport(); window.__stores.isLocked.set(false); });
	await page.waitForTimeout(400);
	await h.finish(browser);
});
