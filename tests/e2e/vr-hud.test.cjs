// 36 B12 — THE GAME HUD IN THE HEADSET (vrHud.js). The playing screen a template author laid
// out — a score card top-left, a clock top-right, a hint along the bottom — drawn on ONE curved
// band in front of the eyes, where 30b only had a strip of short lines.
//
// No headset runs headless: like vr-game-panel, the suite drives vrGamePanelFrame with a
// SYNTHETIC head pose and reads what a player would see — the band's pose, its groups, its atlas
// pixels, the draw calls it costs, and (vrEyes) what each eye renders.
// 1 in play the band is up, the menu board is not, the strip is gone · 2 the author's layout:
//   top-left stays up-left, top-right up-right, the crosshair has no VR form · 3 ONE draw call
//   for the band, <= 3 for every HUD surface together · 4 crisp: >= 1 texel per headset pixel,
//   text pixels in the atlas · 5 comfort: a tremor moves nothing, a turn brings it along with
//   lag, it never rolls · 6 depth: pulled in front of a nearer surface, back out after; both eyes
//   see it whole over that surface · 7 fixed in the world · 8 wrist only + the footer button
//   cycles the placement · 9 U8: the game's input actions as headset controls · 10 a module's own
//   element kind reads in the headset through `vrText` (counterfactual: one without it reads
//   nothing) · 11 size setting · 12 Edit mode / not presenting = nothing · 13 the settings rows.
const h = require('./helpers.cjs');
const eyes = require('./vrEyes.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	await page.evaluate(async () => {
		const s = window.__stores;
		s.viewMode.set('shaded');
		await s.moduleSDK.initModules([
			{
				id: 'hudtest',
				name: 'HUD test',
				version: '1.0.0',
				description: 'the 36 B12 VR HUD',
				register(api) {
					window.__api = api;
					api.registerHudElement('clock', { label: 'Clock', mount() {}, vrText: () => 'CLOCK 1:23' });
					api.registerHudElement('blank', { label: 'Blank', mount() {} });
				}
			}
		]);
		for (const k of ['vr:gameStrip', 'vr:hudPlacement', 'vr:hudSize', 'vr:hudHints']) localStorage.removeItem(k);
		s.gameKit.vrHudPrefs.setVrHudPlacement('head');
		s.gameKit.vrHudPrefs.setVrHudSize('medium');
		s.gameKit.vrHudPrefs.setVrHudHints(true);
		s.hudDocs.setHudDocFor('scene', {
			active: '',
			screens: [
				{
					id: 'menu',
					name: 'Menu',
					showWhile: 'menu',
					input: 'menu',
					elements: [{ id: 'start', kind: 'button', anchor: 'center', x: 0, y: 0, w: 320, h: 80, label: 'Start' }]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					elements: [
						{ id: 'card', kind: 'panel', anchor: 'top-left', x: 16, y: 16, w: 260, h: 84, style: { bg: '#0f172acc', radius: 10 } },
						{ id: 'score', kind: 'text', anchor: 'top-left', x: 28, y: 22, w: 230, h: 34, label: 'Score 120', style: { size: 26, weight: '800' } },
						{ id: 'clock', kind: 'mod-hudtest-clock', anchor: 'top-left', x: 28, y: 60, w: 230, h: 24 },
						{ id: 'time', kind: 'timer', anchor: 'top-right', x: 24, y: 24, w: 160, h: 40, label: '1:30', style: { size: 24, align: 'right' } },
						{ id: 'blank', kind: 'mod-hudtest-blank', anchor: 'top-right', x: 24, y: 120, w: 160, h: 30 },
						{ id: 'hint', kind: 'text', anchor: 'bottom-center', x: 0, y: 16, w: 600, h: 24, label: 'Stack the blocks as high as you can', style: { size: 14, align: 'center' } },
						{ id: 'aim', kind: 'crosshair', anchor: 'center', x: 0, y: 0, w: 24, h: 24 }
					]
				}
			]
		});
		s.gameState.setGameState('playing');
		s.objectActions.setEditorMode('interact');
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		for (const i of [0, 1]) {
			const c = r.xr.getController(i);
			c.matrixAutoUpdate = true;
			c.userData.handedness = i === 0 ? 'left' : 'right';
		}
		const THREE = s.THREE;
		window.__T = {
			head: (yawDeg = 0, o = {}) => ({
				position: new THREE.Vector3(o.x ?? 0, 1.6 + (o.y ?? 0), o.z ?? 0),
				quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(((o.pitch ?? 0) * Math.PI) / 180, (yawDeg * Math.PI) / 180, ((o.roll ?? 0) * Math.PI) / 180, 'YXZ'))
			}),
			leftHand: (facing = true) => ({
				position: new THREE.Vector3(-0.1, 1.2, -0.35),
				quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(facing ? 0.9 : -2.2, 0, 0, 'YXZ'))
			}),
			frame: (o = {}) => {
				const k = s.gameKit.vrGamePanel;
				return k.vrGamePanelFrame({ head: o.head === null ? null : window.__T.head(o.yaw ?? 0, o), hands: [o.hand === false ? null : window.__T.leftHand(o.facing !== false), null], dt: o.dt ?? 1 / 72 });
			},
			band: () => s.gameKit.vrHud.vrHudSurface()?.mesh ?? null,
			dbg: () => s.gameKit.vrHud.vrHudDebug(),
			/** the band's yaw/pitch (deg) of a stage point's group centre, in the HEAD's frame */
			groupAngles: (id) => {
				const d = s.gameKit.vrHud.vrHudDebug();
				const g = d.groups.find((x) => x.ids.includes(id));
				if (!g) return null;
				const L = s.gameKit.vrHudLayout;
				const a = L.stageAngles(g.rect.left + g.rect.w / 2, g.rect.top + g.rect.h / 2, d.halfWidth);
				return { yaw: (a.yaw * 180) / Math.PI, pitch: (a.pitch * 180) / Math.PI, f: g.f };
			},
			/** how many opaque-ish pixels the atlas holds inside a member's box */
			inkIn: (id) => {
				const d = s.gameKit.vrHud.vrHudDebug();
				const box = d.groups.flatMap((g) => g.boxes).find((b) => b.id === id);
				const cv = s.gameKit.vrHud.vrHudSurface()?.canvas;
				if (!box || !cv) return -1;
				const data = cv.getContext('2d').getImageData(Math.floor(box.x), Math.floor(box.y), Math.max(1, Math.floor(box.w)), Math.max(1, Math.floor(box.h))).data;
				// bright text over the dark plate: count light pixels
				let n = 0;
				for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && data[i] + data[i + 1] + data[i + 2] > 450) n++;
				return n;
			}
		};
	});
	const T = (fn, arg) => page.evaluate(fn, arg);

	console.log('\n=== 1. in play the band is up ===');
	const f1 = await T(() => window.__T.frame());
	h.check(f1.hud === true && f1.panel === null, '1.1 the playing screen is on the band, no board (' + JSON.stringify(f1) + ')');
	h.check(f1.strip === undefined && f1.stripLines === undefined, '1.2 the 30b strip is gone from the frame');
	const inScene = await T(() => {
		const s = window.__stores;
		let scene;
		s.globalScene.subscribe((v) => (scene = v))();
		return { band: !!scene.getObjectByName('vr-game-hud'), strip: !!scene.getObjectByName('vr-game-strip')?.visible };
	});
	h.check(inScene.band && !inScene.strip, '1.3 the band is a scene-root mesh, the old strip never shows');
	const probe = await T(() => window.__api.hud.vrHud());
	h.check(probe.placement === 'head' && probe.visible === true, '1.4 api.hud.vrHud() tells a module the band is up (' + JSON.stringify(probe) + ')');

	console.log('\n=== 2. the author\'s layout ===');
	const lay = await T(() => ({ score: window.__T.groupAngles('score'), time: window.__T.groupAngles('time'), hint: window.__T.groupAngles('hint'), aim: window.__T.groupAngles('aim'), d: window.__T.dbg() }));
	h.check(lay.score && lay.score.yaw < -15 && lay.score.pitch > 5, '2.1 the top-left card sits up and to the left (' + JSON.stringify(lay.score) + ')');
	h.check(lay.time && lay.time.yaw > 15 && lay.time.pitch > 5, '2.2 the top-right clock sits up and to the right (' + JSON.stringify(lay.time) + ')');
	h.check(lay.hint && Math.abs(lay.hint.yaw) < 3 && lay.hint.pitch < -10, '2.3 the bottom hint sits low in the middle (' + JSON.stringify(lay.hint) + ')');
	h.check(lay.aim === null, '2.4 the crosshair has no headset form (you aim with a controller)');
	h.check(lay.d.groups.length >= 3 && lay.d.groups.length <= 6, '2.5 a handful of groups (' + lay.d.groups.length + ')');
	h.check(lay.score.f > 1.1, '2.6 the score card is scaled up about its corner (f ' + lay.score.f + ')');

	console.log('\n=== 3. draw calls ===');
	const calls = await T(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		let r, scene;
		s.globalRenderer.subscribe((v) => (r = v))();
		s.globalScene.subscribe((v) => (scene = v))();
		window.__api.announce('Level up!', { ms: 60000 });
		window.__T.frame(); // wrist faces the head: band + wrist + banner up
		const cam = new THREE.PerspectiveCamera(100, 1, 0.05, 200);
		cam.position.set(0, 1.6, 0);
		cam.updateMatrixWorld(true);
		const rt = new THREE.WebGLRenderTarget(64, 64);
		const count = () => {
			r.setRenderTarget(rt);
			r.render(scene, cam);
			r.setRenderTarget(null);
			return r.info.render.calls;
		};
		const names = ['vr-game-hud', 'vr-game-wrist', 'vr-game-announce'];
		const meshes = names.map((n) => scene.getObjectByName(n));
		const up = meshes.map((m) => !!m?.visible);
		const all = count();
		const was = meshes.map((m) => m.visible);
		meshes.forEach((m) => (m.visible = false));
		const none = count();
		meshes[0].visible = true;
		const bandOnly = count();
		meshes.forEach((m, i) => (m.visible = was[i]));
		rt.dispose();
		return { up, all, none, bandOnly };
	});
	h.check(calls.up.every(Boolean), '3.0 premise: band, wrist card and banner are all up (' + JSON.stringify(calls.up) + ')');
	h.check(calls.bandOnly - calls.none === 1, '3.1 the band is ONE draw call (' + (calls.bandOnly - calls.none) + ')');
	h.check(calls.all - calls.none <= 3, '3.2 every HUD surface together is <= 3 draw calls (' + (calls.all - calls.none) + ')');
	await T(() => window.__stores.gameKit.gameAnnounce.clearAnnouncement());

	console.log('\n=== 4. crisp ===');
	const crisp = await T(() => {
		const d = window.__T.dbg();
		return { ratios: d.groups.map((g) => g.texelRatio), score: window.__T.inkIn('score'), time: window.__T.inkIn('time'), atlas: d.atlas, tex: (() => {
			const m = window.__T.band();
			const t = m.material.map;
			return { mip: t.generateMipmaps, min: t.minFilter, cs: t.colorSpace, aniso: t.anisotropy };
		})() };
	});
	h.check(crisp.ratios.length > 0 && crisp.ratios.every((r) => r >= 1 - 1e-9), '4.1 every group has >= 1 texel per Quest 3 pixel (' + crisp.ratios.map((r) => r.toFixed(2)) + ')');
	h.check(crisp.score > 150 && crisp.time > 80, '4.2 the score and the clock are drawn into the atlas (' + crisp.score + ', ' + crisp.time + ' text px)');
	h.check(crisp.tex.mip && crisp.tex.cs === 'srgb' && crisp.tex.aniso >= 4, '4.3 mipmapped, sRGB, anisotropic (' + JSON.stringify(crisp.tex) + ')');
	h.check(crisp.atlas.w <= 2048, '4.4 the atlas stays small (' + JSON.stringify(crisp.atlas) + ')');

	console.log('\n=== 5. comfort ===');
	const comfort = await T(() => {
		const T = window.__T;
		for (let i = 0; i < 72; i++) T.frame({ dt: 1 / 72 });
		const m = T.band();
		const p0 = m.position.toArray();
		const q0 = m.quaternion.toArray();
		let seed = 3;
		const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
		let maxMove = 0;
		let maxTurn = 0;
		for (let i = 0; i < 200; i++) {
			T.frame({ yaw: rnd() * 0.8, pitch: rnd() * 0.8, x: rnd() * 0.006, y: rnd() * 0.006, z: rnd() * 0.006 });
			maxMove = Math.max(maxMove, Math.hypot(m.position.x - p0[0], m.position.y - p0[1], m.position.z - p0[2]));
			maxTurn = Math.max(maxTurn, ...m.quaternion.toArray().map((v, j) => Math.abs(v - q0[j])));
		}
		// a turn
		T.frame({ yaw: 30 });
		const first = (T.dbg().pose.yaw * 180) / Math.PI;
		for (let i = 0; i < 72; i++) T.frame({ yaw: 30 });
		const after = (T.dbg().pose.yaw * 180) / Math.PI;
		// a head roll does not roll the band
		for (let i = 0; i < 30; i++) T.frame({ yaw: 30, roll: 25 });
		const e = new window.__stores.THREE.Euler().setFromQuaternion(m.quaternion, 'YXZ');
		return { maxMove, maxTurn, first, after, roll: (e.z * 180) / Math.PI };
	});
	h.check(comfort.maxMove === 0 && comfort.maxTurn === 0, '5.1 a head tremor (±0.8°, ±6 mm) moves the band not at all (' + comfort.maxMove + ', ' + comfort.maxTurn + ')');
	h.check(comfort.first > 0 && comfort.first < 5, '5.2 a 30° turn: one frame later the band lags behind (' + comfort.first.toFixed(2) + '°)');
	h.check(Math.abs(30 - comfort.after) < 1.8, '5.3 a second later it is in front again (' + comfort.after.toFixed(2) + '°)');
	h.check(Math.abs(comfort.roll) < 0.01, '5.4 it never rolls with the head (' + comfort.roll.toFixed(3) + '°)');

	console.log('\n=== 6. depth ===');
	const depth = await T(() => {
		const T = window.__T;
		for (let i = 0; i < 90; i++) T.frame();
		const before = T.dbg().radius;
		const s = window.__stores;
		const THREE = s.THREE;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 0.05), new THREE.MeshStandardMaterial({ color: '#d4d4d8' }));
		wall.name = 'hud-test-wall';
		wall.position.set(0, 1.5, -1.0);
		g.add(wall);
		wall.updateMatrixWorld(true);
		for (let i = 0; i < 60; i++) T.frame();
		const near = T.dbg().radius;
		return { before, near, distances: T.dbg().distances };
	});
	h.check(Math.abs(depth.before - 1.6) < 0.02, '6.1 with nothing near, the band rests at 1.6 m (' + depth.before.toFixed(3) + ')');
	h.check(depth.near < 0.95 && depth.near >= 0.75, '6.2 a wall 1 m ahead pulls the band in front of it (' + depth.near.toFixed(3) + ' m, hits ' + depth.distances.map((d) => (Number.isFinite(d) ? d.toFixed(2) : '-')) + ')');
	const seen = await eyes.visibility(page, 'vr-game-hud', { size: 256, head: { position: [0, 1.6, 0], yaw: 0, pitch: 0 } });
	h.check(seen.left?.fraction > 0.95 && seen.right?.fraction > 0.95, '6.3 both eyes see the whole band over the nearer wall (' + JSON.stringify({ l: seen.left, r: seen.right }) + ')');
	const out = await T(() => {
		const T = window.__T;
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		g.remove(g.getObjectByName('hud-test-wall'));
		T.frame();
		T.frame();
		const step = T.dbg().radius;
		for (let i = 0; i < 300; i++) T.frame();
		return { step, settled: T.dbg().radius };
	});
	h.check(out.step < 1.0, '6.4 the wall gone, it does not jump back out (' + out.step.toFixed(3) + ')');
	h.check(Math.abs(out.settled - 1.6) < 0.02, '6.5 …and eases back to rest (' + out.settled.toFixed(3) + ')');
	// the counterfactual for 6.2: the probe ignores what it cannot see (a hidden wall)
	const hidden = await T(() => {
		const T = window.__T;
		const s = window.__stores;
		const THREE = s.THREE;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 0.05), new THREE.MeshStandardMaterial());
		wall.position.set(0, 1.5, -1.0);
		wall.visible = false;
		g.add(wall);
		for (let i = 0; i < 60; i++) T.frame();
		const r = T.dbg().radius;
		g.remove(wall);
		return r;
	});
	h.check(Math.abs(hidden - 1.6) < 0.02, '6.6 a hidden object does not pull the band (' + hidden.toFixed(3) + ')');

	console.log('\n=== 7. fixed in the world ===');
	const world = await T(() => {
		const T = window.__T;
		window.__stores.gameKit.vrHudPrefs.setVrHudPlacement('world');
		T.frame({ yaw: 0 });
		const m = T.band();
		const p0 = m.position.toArray();
		for (let i = 0; i < 144; i++) T.frame({ yaw: 35 });
		const glance = (T.dbg().pose.yaw * 180) / Math.PI;
		for (let i = 0; i < 288; i++) T.frame({ yaw: 80 });
		const turned = (T.dbg().pose.yaw * 180) / Math.PI;
		const e = new window.__stores.THREE.Euler().setFromQuaternion(m.quaternion, 'YXZ');
		for (let i = 0; i < 30; i++) T.frame({ yaw: 80, pitch: 20 });
		const e2 = new window.__stores.THREE.Euler().setFromQuaternion(m.quaternion, 'YXZ');
		return { glance, turned, pitch: (e.x * 180) / Math.PI, pitchLook: (e2.x * 180) / Math.PI, p0 };
	});
	h.check(Math.abs(world.glance) < 0.01, '7.1 a 35° glance leaves the world band where it was (' + world.glance.toFixed(2) + ')');
	h.check(Math.abs(world.turned - 80) < 2, '7.2 an 80° turn re-places it in front (' + world.turned.toFixed(2) + ')');
	h.check(Math.abs(world.pitchLook) < 0.01, '7.3 it stays level when you look up (' + world.pitchLook.toFixed(3) + ')');

	console.log('\n=== 8. wrist only, and the footer button ===');
	const wrist = await T(() => {
		const T = window.__T;
		window.__stores.gameKit.vrHudPrefs.setVrHudPlacement('wrist');
		const f = T.frame();
		return { f, probe: window.__api.hud.vrHud() };
	});
	h.check(wrist.f.hud === false && wrist.f.wrist === true && wrist.f.lines.some((l) => /Score 120/.test(l)), '8.1 wrist only: no band, the wrist card reads the score (' + JSON.stringify(wrist.f) + ')');
	h.check(wrist.probe.placement === 'wrist' && wrist.probe.visible === false, '8.2 the probe says so');
	const cycle = await T(() => {
		const T = window.__T;
		const k = window.__stores.gameKit.vrGamePanel;
		T.frame();
		const hit = k.vrGamePanelDebug().hits['vr-game-wrist'].find((x) => x.id === 'footer:hud');
		const labels = [];
		const placements = [];
		for (let i = 0; i < 3; i++) {
			k.pressPanelTarget({ surface: 'vr-game-wrist', hit, point: null, distance: 0 });
			placements.push(window.__stores.gameKit.vrHudPrefs.vrHudState().placement);
			T.frame();
		}
		return { has: !!hit, placements, stored: localStorage.getItem('vr:hudPlacement') };
	});
	h.check(cycle.has, '8.3 the wrist card has a HUD button');
	h.check(JSON.stringify(cycle.placements) === JSON.stringify(['head', 'world', 'wrist']), '8.4 it cycles Head -> World -> Wrist (' + cycle.placements + ')');
	h.check(cycle.stored === 'wrist', '8.5 persisted locally');
	const legacy = await T(() => {
		window.__stores.gameKit.vrGamePanel.setVrStrip(true);
		const a = window.__stores.gameKit.vrHudPrefs.vrHudState().placement;
		window.__stores.gameKit.vrGamePanel.setVrStrip(false);
		const b = window.__stores.gameKit.vrHudPrefs.vrHudState().placement;
		window.__stores.gameKit.vrHudPrefs.setVrHudPlacement('head');
		return [a, b];
	});
	h.check(legacy[0] === 'head' && legacy[1] === 'wrist', '8.6 the old strip switch maps onto it (' + legacy + ')');

	console.log('\n=== 9. the game\'s input actions as headset controls (U8) ===');
	const hints = await T(async () => {
		const T = window.__T;
		const s = window.__stores;
		window.__api.input.actions(['jump', 'fire', 'crouch']);
		s.gameKit.gameShell.markShellGame(true);
		await new Promise((r) => setTimeout(r, 50));
		T.frame();
		const on = T.dbg().hints;
		s.gameKit.vrHudPrefs.setVrHudHints(false);
		T.frame();
		const off = T.dbg().hints;
		s.gameKit.vrHudPrefs.setVrHudHints(true);
		s.gameKit.gameShell.markShellGame(false);
		T.frame();
		return { on, off, ink: T.inkIn('__vrhints') };
	});
	h.check(typeof hints.on === 'string' && /Trigger\s+Fire/.test(hints.on) && /X\s+Menu/.test(hints.on), '9.1 Fire is the trigger and the pause menu is X (' + hints.on + ')');
	h.check(!/Jump|Crouch/.test(hints.on ?? ''), '9.2 no jump where the game gives none in VR, no crouch (no headset control) (' + hints.on + ')');
	h.check(hints.off === null, '9.3 Button hints off: no row');
	h.check(hints.ink > 40, '9.4 the row is drawn (' + hints.ink + ' text px)');

	console.log('\n=== 10. a module element kind reads in the headset (vrText) ===');
	const mod = await T(() => ({ clock: window.__T.inkIn('clock'), blank: window.__T.inkIn('blank') }));
	h.check(mod.clock > 60, '10.1 the module clock draws its vrText (' + mod.clock + ' text px)');
	h.check(mod.blank === 0, '10.2 a module kind without vrText draws nothing (' + mod.blank + ')');

	console.log('\n=== 11. size ===');
	const size = await T(() => {
		const T = window.__T;
		const before = T.groupAngles('time').yaw;
		const builds = T.dbg().builds;
		window.__stores.gameKit.vrHudPrefs.setVrHudSize('large');
		T.frame();
		const after = T.groupAngles('time').yaw;
		const rebuilt = T.dbg().builds > builds;
		const ratios = T.dbg().groups.map((g) => g.texelRatio);
		window.__stores.gameKit.vrHudPrefs.setVrHudSize('medium');
		T.frame();
		return { before, after, rebuilt, ratios };
	});
	h.check(size.rebuilt && size.after > size.before + 2, '11.1 Large spreads the band wider (' + size.before.toFixed(1) + '° -> ' + size.after.toFixed(1) + '°)');
	h.check(size.ratios.every((r) => r >= 1 - 1e-9), '11.2 and stays crisp (' + size.ratios.map((r) => r.toFixed(2)) + ')');

	console.log('\n=== 12. not in Edit, not without a headset ===');
	const off = await T(() => {
		const T = window.__T;
		const s = window.__stores;
		s.objectActions.setEditorMode('edit');
		const edit = T.frame();
		s.objectActions.setEditorMode('interact');
		const back = T.frame();
		const flat = T.frame({ head: null });
		return { edit: edit.hud, mesh: T.band().visible, back: back.hud, flat: flat.hud };
	});
	h.check(off.edit === false && off.back === true && off.flat === false, '12.1 Edit hides it, Interact brings it back, no headset = nothing (' + JSON.stringify(off) + ')');

	console.log('\n=== 13. the settings ===');
	const rows = await T(() => {
		const s = window.__stores;
		const table = s.vrSettingsSchema?.VR_SETTINGS ?? null;
		const ids = table ? table.filter((r) => r.id.startsWith('gameHud')).map((r) => r.id + ':' + r.page) : null;
		const row = table?.find((r) => r.id === 'gameHud');
		row?.set('world');
		const got = row?.get();
		row?.set('head');
		return { ids, got, stored: localStorage.getItem('vr:hudPlacement') };
	});
	h.check(rows.ids && rows.ids.join(',') === 'gameHud:display,gameHudSize:display,gameHudHints:display', '13.1 three rows on the Display page (' + rows.ids + ')');
	h.check(rows.got === 'world' && rows.stored === 'head', '13.2 a row writes the one store and persists (' + JSON.stringify(rows) + ')');

	await h.finish(browser);
});
