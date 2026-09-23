// 30b (vr-play) P3 — C2 THE GAME UI IN VR. The user, on a Quest 3: "in VR I should be able to
// see the game menu and interact with it", "I also should see the score in the VR", "there
// should be an option available to go into the edit mode".
//
// No headset runs headless: the suite drives vrGamePanelFrame with a SYNTHETIC head pose and
// posed controllers (matrixAutoUpdate on — the documented XR-controller trap), and reads
// what a player would see: which surfaces are visible, where they sit, and what their
// canvases hold.
// 1 a menu screen becomes the world panel, 1.2 m ahead at chest height, drawn · 2 its
// buttons are hit rects, ours included · 3 the LASER + trigger presses Start through the
// real trigger hook: the game starts, the press is consumed and its trailing select
// swallowed · 4 in play the score becomes the wrist card + the top strip · 5 the wrist
// shows only when turned toward the face · 6 a POKE presses once and re-arms on retreat ·
// 7 the strip toggles · 8 Edit mode leaves Interact and every surface goes · 9 the panel
// follows the head LAZILY · 10 the announce banner in VR · 11 not presenting = nothing ·
// 12 a toggle flips its value · 13 the REAL Towers template: its menu in VR, Start pressed.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) =>
	fs.existsSync(p)
);
const TOWERS = process.env.TOWERS_TPSCENE || (SCENES_REPO && path.join(SCENES_REPO, 'games/towers/scene.tpscene'));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	await page.evaluate(async () => {
		const s = window.__stores;
		await s.moduleSDK.initModules([
			{ id: 'panel30b', name: 'Panel test', version: '1.0.0', description: 'the 30b VR panel', register(api) { window.__api = api; } }
		]);
		localStorage.removeItem('vr:gameStrip');
		// a game: a menu screen bound to 'menu' with Start + a music toggle, and a play HUD
		s.hudDocs.setHudDocFor('scene', {
			active: '',
			screens: [
				{
					id: 'menu',
					name: 'Menu',
					showWhile: 'menu',
					input: 'menu',
					elements: [
						{ id: 'title', kind: 'text', anchor: 'top-center', x: 0, y: 80, w: 600, h: 90, label: 'TOWERS', style: { size: 64, align: 'center', weight: '800' } },
						{ id: 'start', kind: 'button', anchor: 'center', x: 0, y: 0, w: 320, h: 80, label: 'Start', style: { bg: '#2563eb', size: 32 } },
						{ id: 'music', kind: 'toggle', anchor: 'center', x: 0, y: 120, w: 320, h: 56, label: 'Music', value: false }
					]
				},
				{
					id: 'hud',
					name: 'HUD',
					showWhile: 'playing',
					elements: [
						{ id: 'score', kind: 'text', anchor: 'top-left', x: 24, y: 24, w: 240, h: 40, label: 'Height: 0 m' },
						{ id: 'time', kind: 'timer', anchor: 'top-right', x: 24, y: 24, w: 160, h: 40, label: '1:30' }
					]
				}
			]
		});
		s.gameState.setGameState('menu');
		s.hudActions.addBinding('start', 'start');
		s.objectActions.setEditorMode('interact');
		// posed controllers: three writes their matrices per XR frame, so a test must switch
		// that back on before posing them by hand
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		for (const i of [0, 1]) {
			const c = r.xr.getController(i);
			c.matrixAutoUpdate = true;
			c.userData.handedness = i === 0 ? 'left' : 'right';
		}
		window.__T = {
			head: (yawDeg = 0) => {
				const THREE = s.THREE;
				return {
					position: new THREE.Vector3(0, 1.6, 0),
					quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (yawDeg * Math.PI) / 180, 0, 'YXZ'))
				};
			},
			// the left hand held up, palm-side card facing the eyes (or turned away)
			leftHand: (facing = true) => {
				const THREE = s.THREE;
				const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(facing ? 0.9 : -2.2, 0, 0, 'YXZ'));
				return { position: new THREE.Vector3(-0.1, 1.2, -0.35), quaternion: q };
			},
			// the world point of a hit rect's centre on a surface
			rectPoint: (surfaceName, id) => {
				const k = s.gameKit.vrGamePanel;
				const surf = k.vrGameSurface(surfaceName);
				const rect = k.vrGamePanelDebug().hits[surfaceName].find((x) => x.id === id);
				if (!surf || !rect) return null;
				const g = surf.mesh.geometry.parameters;
				const cx = (rect.x + rect.w / 2) / surf.canvas.width;
				const cy = (rect.y + rect.h / 2) / surf.canvas.height;
				return surf.mesh.localToWorld(new s.THREE.Vector3((cx - 0.5) * g.width, (0.5 - cy) * g.height, 0));
			},
			aim: (index, from, to) => {
				const c = r.xr.getController(index);
				c.position.copy(from);
				// Object3D.lookAt turns a plain object's +Z toward the target, and a controller's
				// ray is its -Z: look at the point MIRRORED through the controller instead
				c.lookAt(from.clone().multiplyScalar(2).sub(to));
				c.updateMatrixWorld(true);
			}
		};
	});
	const frame = (opts = '{}') =>
		page.evaluate((o) => {
			const T = window.__T;
			const k = window.__stores.gameKit.vrGamePanel;
			return k.vrGamePanelFrame({ head: T.head(o.yaw ?? 0), hands: [o.hand === false ? null : T.leftHand(o.facing !== false), null], dt: o.dt ?? 1 / 72 });
		}, JSON.parse(opts));

	console.log('\n=== 1. the menu screen becomes the world panel ===');
	const f1 = await frame();
	const panel = await page.evaluate(() => {
		const k = window.__stores.gameKit.vrGamePanel;
		const surf = k.vrGameSurface('vr-game-panel');
		const g = surf.canvas.getContext('2d');
		const data = g.getImageData(0, 0, surf.canvas.width, surf.canvas.height).data;
		let ink = 0;
		for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && data[i] + data[i + 1] + data[i + 2] > 600) ink++;
		const start = k.vrGamePanelDebug().hits['vr-game-panel'].find((x) => x.id === 'start');
		const px = g.getImageData(Math.round(start.x + 8), Math.round(start.y + start.h / 2), 1, 1).data;
		let scene;
		window.__stores.globalScene.subscribe((v) => (scene = v))();
		return {
			pos: surf.mesh.position.toArray(),
			visible: surf.mesh.visible,
			parentIsScene: surf.mesh.parent === scene,
			layer0: surf.mesh.layers.test(new window.__stores.THREE.Layers()),
			ink,
			width: surf.mesh.geometry.parameters.width,
			startPx: Array.from(px)
		};
	});
	h.check(f1.panel === 'menu' && panel.visible, '1.1 the menu screen is on the panel (' + JSON.stringify(f1) + ')');
	h.check(Math.abs(panel.pos[2] + 1.2) < 0.05 && panel.pos[1] < 1.6 && panel.pos[1] > 1.2, '1.2 ~1.2 m ahead, below the eyes (' + panel.pos.map((n) => n.toFixed(2)) + ')');
	h.check(panel.parentIsScene && panel.layer0, '1.3 a scene-root mesh on the default layer (both eyes)');
	h.check(panel.ink > 1500, '1.4 the canvas holds drawn text (' + panel.ink + ' white px)');
	h.check(panel.width > 0.6 && panel.width < 1.3, '1.6 the board is sized to the menu it shows, not the whole stage (' + panel.width.toFixed(2) + ' m wide)');
	h.check(panel.startPx[2] > 200 && panel.startPx[0] < 80, '1.5 the Start button is drawn in its authored blue (' + panel.startPx + ')');

	console.log('\n=== 2. the buttons are hit rects, ours included ===');
	const ids = await page.evaluate(() => window.__stores.gameKit.vrGamePanel.vrGamePanelDebug().hits['vr-game-panel'].map((x) => x.id));
	h.check(ids.includes('start') && ids.includes('music') && !ids.includes('title'), '2.1 Start and the toggle press, the title does not (' + ids + ')');
	h.check(ids.includes('footer:edit') && ids.includes('footer:strip'), '2.2 our Edit mode and Top strip buttons are on the footer');

	console.log('\n=== 3. laser + trigger presses Start through the real trigger hook ===');
	await page.waitForTimeout(700); // a fresh binding must be seen by a tick before its first press (actionSeenAt)
	const press = await page.evaluate(async () => {
		const s = window.__stores;
		const T = window.__T;
		const target = T.rectPoint('vr-game-panel', 'start');
		T.aim(1, new s.THREE.Vector3(0.25, 1.3, -0.3), target);
		const hover = s.gameKit.vrGamePanel.panelHover(1, s.gameKit.vrGameInput.controllerRayOf(1))?.hit.id ?? null;
		const consumed = s.vrControls.vrModuleTriggerStart(1);
		await new Promise((r) => setTimeout(r, 500)); // the Set Game State node acts on the next tick
		let state;
		s.gameState.gameState.subscribe((v) => (state = v.state))();
		const swallow1 = s.vrControls.vrModuleSelectSwallowed();
		const swallow2 = s.vrControls.vrModuleSelectSwallowed();
		s.vrControls.vrModuleTriggerEnd(1);
		return { hover, consumed, state, swallow1, swallow2 };
	});
	h.check(press.hover === 'start', '3.1 the laser hovers Start (' + press.hover + ')');
	h.check(press.consumed === true && press.state === 'playing', '3.2 the trigger pressed it: the game is playing (' + JSON.stringify(press) + ')');
	h.check(press.swallow1 === true && press.swallow2 === false, '3.3 the trailing select is swallowed once, not forever');

	console.log('\n=== 4. in play the score is on the wrist and the strip ===');
	const f4 = await frame();
	h.check(f4.panel === null, '4.1 the panel goes when the menu does');
	h.check(JSON.stringify(f4.lines) === JSON.stringify(['Height: 0 m', '1:30']), '4.2 the overlay reads as lines (' + JSON.stringify(f4.lines) + ')');
	h.check(f4.wrist && f4.strip, '4.3 the wrist card and the top strip are up');
	const stripPose = await page.evaluate(() => window.__stores.gameKit.vrGamePanel.vrGameSurface('vr-game-strip').mesh.position.toArray());
	h.check(stripPose[1] > 1.8 && stripPose[2] < -1, '4.4 the strip rides high in front of the eyes (' + stripPose.map((n) => n.toFixed(2)) + ')');

	console.log('\n=== 5. the wrist shows only when turned to the face ===');
	const away = await frame('{"facing": false}');
	h.check(away.wrist === false && away.strip === true, '5.1 turned away: no wrist card (the strip stays)');
	const noHand = await frame('{"hand": false}');
	h.check(noHand.wrist === false, '5.2 no tracked left hand: no card');

	console.log('\n=== 6. a POKE presses once and re-arms on retreat ===');
	await frame();
	const poke = await page.evaluate(() => {
		const s = window.__stores;
		const T = window.__T;
		const k = s.gameKit.vrGamePanel;
		const at = T.rectPoint('vr-game-wrist', 'footer:strip');
		const surf = k.vrGameSurface('vr-game-wrist');
		const normal = new s.THREE.Vector3(0, 0, 1).applyQuaternion(surf.mesh.quaternion);
		const before = k.vrGamePanelDebug().strip;
		const first = k.pokeFrame(0, at.clone().addScaledVector(normal, 0.005))?.hit.id ?? null;
		const afterFirst = k.vrGamePanelDebug().strip;
		const held = k.pokeFrame(0, at.clone().addScaledVector(normal, -0.004))?.hit.id ?? null;
		k.pokeFrame(0, at.clone().addScaledVector(normal, 0.1)); // pull back
		const again = k.pokeFrame(0, at.clone().addScaledVector(normal, 0.003))?.hit.id ?? null;
		return { before, first, afterFirst, held, again, after: k.vrGamePanelDebug().strip };
	});
	h.check(poke.first === 'footer:strip' && poke.before === true && poke.afterFirst === false, '6.1 pushing the tip into "Strip on" presses it (' + JSON.stringify(poke) + ')');
	h.check(poke.held === null, '6.2 holding the tip in the button does not press again');
	h.check(poke.again === 'footer:strip' && poke.after === true, '6.3 pulling back re-arms it: the next push presses');

	console.log('\n=== 7. the strip toggles ===');
	await page.evaluate(() => window.__stores.gameKit.vrGamePanel.setVrStrip(false));
	const off = await frame();
	h.check(off.strip === false && off.wrist === true, '7.1 strip off: gone, the wrist stays');
	h.check((await page.evaluate(() => localStorage.getItem('vr:gameStrip'))) === 'false', '7.2 persisted locally');
	await page.evaluate(() => window.__stores.gameKit.vrGamePanel.setVrStrip(true));

	console.log('\n=== 8. Edit mode leaves Interact, and everything goes ===');
	await frame();
	const edit = await page.evaluate(() => {
		const s = window.__stores;
		const T = window.__T;
		const at = T.rectPoint('vr-game-wrist', 'footer:edit');
		T.aim(1, at.clone().add(new s.THREE.Vector3(0.1, 0.25, 0.1)), at);
		const consumed = s.vrControls.vrModuleTriggerStart(1);
		s.vrControls.vrModuleSelectSwallowed();
		s.vrControls.vrModuleTriggerEnd(1);
		let mode;
		s.editorMode.subscribe((v) => (mode = v))();
		return { consumed, mode };
	});
	h.check(edit.consumed && edit.mode === 'edit', '8.1 "Edit" on the wrist switched to Edit (' + JSON.stringify(edit) + ')');
	const f8 = await frame();
	h.check(!f8.panel && !f8.wrist && !f8.strip, '8.2 in Edit no game surface shows (' + JSON.stringify(f8) + ')');
	await page.evaluate(() => {
		window.__stores.objectActions.setEditorMode('interact');
		window.__stores.gameState.setGameState('menu');
	});

	console.log('\n=== 9. the panel follows the head LAZILY ===');
	await page.evaluate(() => window.__stores.gameKit.vrGamePanel.hideVrGamePanel());
	await frame('{"yaw": 0}');
	const yaws = await page.evaluate(() => {
		const k = window.__stores.gameKit.vrGamePanel;
		const T = window.__T;
		const pos = () => k.vrGameSurface('vr-game-panel').mesh.position.clone();
		const at0 = pos();
		k.vrGamePanelFrame({ head: T.head(20), hands: [null, null], dt: 0.5 });
		const at20 = pos();
		for (let i = 0; i < 30; i++) k.vrGamePanelFrame({ head: T.head(80), hands: [null, null], dt: 0.1 });
		const at80 = pos();
		const bearing = (p) => (Math.atan2(-p.x, -p.z) * 180) / Math.PI;
		return { b0: bearing(at0), b20: bearing(at20), b80: bearing(at80) };
	});
	h.check(Math.abs(yaws.b20 - yaws.b0) < 0.5, '9.1 a 20 degree glance leaves it where it is (' + yaws.b0.toFixed(1) + ' -> ' + yaws.b20.toFixed(1) + ')');
	h.check(yaws.b80 > 40, '9.2 turning 80 degrees brings it round (' + yaws.b80.toFixed(1) + ' degrees)');
	h.check(yaws.b80 > 75, '9.3 ...all the way back in front, not parked at the edge of the band (' + yaws.b80.toFixed(1) + ')');

	console.log('\n=== 10. the announce banner, head-locked ===');
	const ann = await page.evaluate(async () => {
		const k = window.__stores.gameKit.vrGamePanel;
		const T = window.__T;
		window.__api.announce('Ring 2 reached', { sub: '+50', ms: 500 });
		const on = k.vrGamePanelFrame({ head: T.head(0), hands: [null, null] }).banner;
		const pos = k.vrGameSurface('vr-game-announce').mesh.position.toArray();
		await new Promise((r) => setTimeout(r, 700));
		const later = k.vrGamePanelFrame({ head: T.head(0), hands: [null, null] }).banner;
		return { on, pos, later };
	});
	h.check(ann.on && Math.abs(ann.pos[0]) < 0.01 && ann.pos[2] < -1.4, '10.1 api.announce shows a banner straight ahead (' + ann.pos.map((n) => n.toFixed(2)) + ')');
	h.check(ann.later === false, '10.2 and it goes after its ms');

	console.log('\n=== 11. not presenting: nothing ===');
	const flat = await page.evaluate(() => window.__stores.gameKit.vrGamePanel.vrGamePanelFrame({ hands: [null, null] }));
	h.check(!flat.panel && !flat.wrist && !flat.strip && !flat.banner, '11.1 with no headset session nothing is drawn (' + JSON.stringify(flat) + ')');

	console.log('\n=== 12. a toggle flips its value ===');
	await frame();
	const tog = await page.evaluate(() => {
		const s = window.__stores;
		const T = window.__T;
		const at = T.rectPoint('vr-game-panel', 'music');
		T.aim(1, new s.THREE.Vector3(0.2, 1.3, -0.2), at);
		const before = s.hudDocs.hudValueOf('music', false);
		s.vrControls.vrModuleTriggerStart(1);
		s.vrControls.vrModuleSelectSwallowed();
		s.vrControls.vrModuleTriggerEnd(1);
		return { before, after: s.hudDocs.hudValueOf('music', false) };
	});
	h.check(tog.before === false && tog.after === true, '12.1 the Music toggle flipped through the laser (' + JSON.stringify(tog) + ')');

	console.log('\n=== 13. the REAL Towers template ===');
	if (!TOWERS || !fs.existsSync(TOWERS)) console.log('SKIP 13: no games/towers/scene.tpscene');
	else {
		const bytes = Array.from(fs.readFileSync(TOWERS));
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, bytes);
		await page.waitForTimeout(2500);
		const towers = await page.evaluate(() => {
			const s = window.__stores;
			s.gameState.setGameState('menu');
			s.objectActions.setEditorMode('interact');
			const k = s.gameKit.vrGamePanel;
			const T = window.__T;
			k.hideVrGamePanel();
			const f = k.vrGamePanelFrame({ head: T.head(0), hands: [T.leftHand(true), null] });
			const hits = k.vrGamePanelDebug().hits['vr-game-panel'].filter((x) => x.kind !== 'footer');
			const labels = [];
			for (const { screen } of k.vrScreens().panel) for (const el of screen.elements) if (hits.some((x) => x.id === el.id)) labels.push(el.label);
			return { panel: f.panel, labels, hits: hits.map((x) => x.id) };
		});
		h.check(!!towers.panel && towers.hits.length > 0, '13.1 the Towers menu is on the VR panel with pressable controls (' + JSON.stringify(towers) + ')');
		const startId = towers.hits.find((id, i) => /start|play/i.test(towers.labels[i] ?? '')) ?? towers.hits[0];
		const started = await page.evaluate(async (id) => {
			const s = window.__stores;
			const T = window.__T;
			const at = T.rectPoint('vr-game-panel', id);
			T.aim(1, new s.THREE.Vector3(0.2, 1.3, -0.2), at);
			s.vrControls.vrModuleTriggerStart(1);
			s.vrControls.vrModuleSelectSwallowed();
			s.vrControls.vrModuleTriggerEnd(1);
			await new Promise((r) => setTimeout(r, 400));
			let state;
			s.gameState.gameState.subscribe((v) => (state = v.state))();
			const f = s.gameKit.vrGamePanel.vrGamePanelFrame({ head: T.head(0), hands: [T.leftHand(true), null] });
			return { state, f };
		}, startId);
		h.check(started.state === 'playing', '13.2 pressing its Start in VR starts the round (' + JSON.stringify(started) + ')');
		h.check(started.f.lines.length > 0, '13.3 the round\'s HUD reads on the wrist/strip (' + JSON.stringify(started.f.lines) + ')');
		h.check(
			started.f.stripLines.length > 0 && started.f.stripLines.every((l) => l.length <= 28) && started.f.stripLines.length < started.f.lines.length,
			'13.4 the strip keeps the short readouts and leaves the sentence-long hint to the wrist (' + JSON.stringify(started.f.stripLines) + ')'
		);
	}

	await h.finish(browser);
});
