// 30b (vr-play) P4 — C3 HOLD THE TRIGGER AND SWEEP. The user, on a Quest 3: "I want to be able
// to hold trigger and automatically press the buttons where I move the controller around. So,
// for example, I can hit different keys on piano holding trigger and on the mixer
// enable/disable, toggle multiple knobs."
//
// Headless: controllers are posed by hand (matrixAutoUpdate on), the press goes through the
// REAL trigger hooks (vrModuleTriggerStart / End / SelectSwallowed) and each frame through the
// exported sweepFrame, with the tip / laser injected.
// 1 the tip clicks every key it ENTERS, once, the first as the 'trigger' press · 2 leaving
// re-arms · 3 a {sweep: false} handler hears the press and never a sweep · 4 the release is
// swallowed after a sweep, and only then · 5 the LASER sweeps what the tip cannot reach ·
// 6 a press another gesture CLAIMED is left alone · 7 Edit mode: no sweep, the old path ·
// 8 the game board's buttons sweep too · 9 an Interact release on a plain object CLICKS and
// never selects · 10 the REAL Jam Room: a sweep across piano keys plays each, across drum
// steps flips each.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const SCENES_REPO = [path.resolve(__dirname, '../../../theprototype.app-scenes'), path.resolve(__dirname, '../../../scenes')].find((p) =>
	fs.existsSync(p)
);
const JAM = process.env.JAM_ROOM_TPSCENE || (SCENES_REPO && path.join(SCENES_REPO, 'games/jam-room/scene.tpscene'));

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	await page.evaluate(async () => {
		const s = window.__stores;
		window.__log = [];
		await s.moduleSDK.initModules([
			{
				id: 'sweep30b',
				name: 'Sweep test',
				version: '1.0.0',
				description: 'the 30b sweep',
				register(api) {
					window.__api = api;
					// a keyboard of five keys: this handler plays them, sweeps included
					api.registerClickHandler((object, ctx) => {
						if (!object.userData?.sweepKey) return false;
						window.__log.push({ key: object.userData.sweepKey, source: ctx?.source, mode: ctx?.mode });
						return true;
					});
					// a dot you CARRY: it must hear the press and never a sweep
					api.registerClickHandler(
						(object, ctx) => {
							if (!object.userData?.dot) return false;
							window.__log.push({ key: 'dot', source: ctx?.source });
							return true;
						},
						{ sweep: false }
					);
				}
			}
		]);
		let r;
		s.globalRenderer.subscribe((v) => (r = v))();
		for (const i of [0, 1]) {
			const c = r.xr.getController(i);
			c.matrixAutoUpdate = true;
			c.userData.handedness = i === 0 ? 'left' : 'right';
		}
		// five keys in a row, 12 cm apart, marked clickable, at hand height
		const THREE = s.THREE;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const keys = [];
		for (let i = 0; i < 5; i++) {
			const [uuid] = await window.__api.create('/create box 0.08 0.04 0.2', { at: [-0.24 + i * 0.12, 1.0, -0.5] });
			keys.push(uuid);
		}
		const [dot] = await window.__api.create('/create box 0.08 0.08 0.08', { at: [0.5, 1.0, -0.5] });
		const [plain] = await window.__api.create('/create box 0.3 0.3 0.3', { at: [0, 1.2, -3] });
		await new Promise((res) => setTimeout(res, 600));
		keys.forEach((uuid, i) => {
			const o = g.getObjectByProperty('uuid', uuid);
			o.userData.clickable = true;
			o.traverse((n) => n.isMesh && (n.userData.sweepKey = 'k' + i));
			o.userData.physics = { mode: 'static' };
		});
		const d = g.getObjectByProperty('uuid', dot);
		d.userData.clickable = true;
		d.traverse((n) => n.isMesh && (n.userData.dot = true));
		g.updateMatrixWorld(true);
		window.__ids = { keys, dot, plain };
		s.objectActions.deselectObject?.();
		s.objectActions.setEditorMode('interact');
		window.__T = {
			keyAt: (i) => g.getObjectByProperty('uuid', keys[i]).getWorldPosition(new THREE.Vector3()),
			aim: (index, from, to) => {
				const c = r.xr.getController(index);
				c.position.copy(from);
				c.lookAt(from.clone().multiplyScalar(2).sub(to)); // a Group's +Z faces the target
				c.updateMatrixWorld(true);
			},
			// a sweep frame with the TIP at a point and no laser
			tipFrame: (index, point) => s.gameKit.vrGameInput.sweepFrame(index, { tip: point, ray: null }),
			press: (index) => s.vrControls.vrModuleTriggerStart(index),
			release: (index) => ({ swallowed: s.vrControls.vrModuleSelectSwallowed(), end: s.vrControls.vrModuleTriggerEnd(index) })
		};
	});
	const log = () => page.evaluate(() => window.__log.splice(0));

	console.log('\n=== 1. the tip clicks every key it enters, once ===');
	const run1 = await page.evaluate(() => {
		const T = window.__T;
		const THREE = window.__stores.THREE;
		const above = (i) => T.keyAt(i).add(new THREE.Vector3(0, 0.035, 0)); // just touching the top
		T.aim(1, above(0).add(new THREE.Vector3(0, 0.05, 0.2)), above(0));
		const consumed = T.press(1);
		const frames = [];
		frames.push(T.tipFrame(1, above(0))); // the press itself
		frames.push(T.tipFrame(1, above(0))); // still on k0
		frames.push(T.tipFrame(1, above(1)));
		frames.push(T.tipFrame(1, above(1)));
		frames.push(T.tipFrame(1, above(2)));
		frames.push(T.tipFrame(1, above(3)));
		return { consumed, frames };
	});
	const l1 = await log();
	h.check(run1.consumed === false, '1.1 the press is NOT consumed by the sweep (other gestures may still take it)');
	h.check(JSON.stringify(l1.map((e) => e.key)) === JSON.stringify(['k0', 'k1', 'k2', 'k3']), '1.2 four keys entered, four clicks, each once (' + JSON.stringify(l1.map((e) => e.key)) + ')');
	h.check(l1[0]?.source === 'trigger' && l1.slice(1).every((e) => e.source === 'sweep'), '1.3 the first is the press (trigger), the rest are sweeps (' + l1.map((e) => e.source) + ')');
	h.check(l1.every((e) => e.mode === 'interact'), '1.4 dispatched as Interact clicks');

	console.log('\n=== 2. leaving re-arms ===');
	const run2 = await page.evaluate(() => {
		const T = window.__T;
		const THREE = window.__stores.THREE;
		const above = (i) => T.keyAt(i).add(new THREE.Vector3(0, 0.035, 0));
		T.tipFrame(1, above(3).add(new THREE.Vector3(0, 0.3, 0))); // lift off
		T.tipFrame(1, above(3)); // back down on k3
		T.tipFrame(1, above(2)); // and k2 again
	});
	void run2;
	const l2 = await log();
	h.check(JSON.stringify(l2.map((e) => e.key)) === JSON.stringify(['k3', 'k2']), '2.1 lifting off and coming back plays the key again (' + JSON.stringify(l2.map((e) => e.key)) + ')');

	console.log('\n=== 3. {sweep: false} hears the press, never a sweep ===');
	const dotRun = await page.evaluate(() => {
		const s = window.__stores;
		const T = window.__T;
		const THREE = s.THREE;
		const dot = s.gameKit.vrGameInput;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const at = g.getObjectByProperty('uuid', window.__ids.dot).getWorldPosition(new THREE.Vector3());
		T.release(1);
		window.__log.splice(0);
		// a held press that starts on k4 (premise: it plays), then is swept INTO the dot
		const k4 = T.keyAt(4).add(new THREE.Vector3(0, 0.035, 0));
		T.aim(1, k4.clone().add(new THREE.Vector3(0, 0.05, 0.2)), k4);
		T.press(1);
		T.tipFrame(1, k4);
		T.tipFrame(1, at.clone());
		const swept = window.__log.splice(0);
		T.release(1);
		// pressed ON the dot: heard
		T.aim(1, at.clone().add(new THREE.Vector3(0, 0.05, 0.2)), at);
		T.press(1);
		T.tipFrame(1, at.clone());
		const pressed = window.__log.splice(0);
		T.release(1);
		return { swept, pressed, live: dot.sweepLive(1) };
	});
	h.check(
		dotRun.swept.length === 1 && dotRun.swept[0].key === 'k4',
		'3.1 a held sweep plays k4, then passes into the {sweep:false} dot without clicking it (' + JSON.stringify(dotRun.swept) + ')'
	);
	h.check(dotRun.pressed.length === 1 && dotRun.pressed[0].source === 'trigger', '3.2 a press ON it does (' + JSON.stringify(dotRun.pressed) + ')');
	h.check(dotRun.live === false, '3.3 the release ended the sweep');

	console.log('\n=== 4. the release is swallowed after a sweep, and only then ===');
	const sw = await page.evaluate(() => {
		const T = window.__T;
		const THREE = window.__stores.THREE;
		const above = (i) => T.keyAt(i).add(new THREE.Vector3(0, 0.035, 0));
		T.press(1);
		T.tipFrame(1, above(4));
		const after = T.release(1);
		window.__log.splice(0);
		T.press(1);
		T.tipFrame(1, new THREE.Vector3(3, 3, 3)); // nothing there
		const empty = T.release(1);
		return { after: after.swallowed, empty: empty.swallowed };
	});
	h.check(sw.after === true, '4.1 a press that swept something swallows its trailing select');
	h.check(sw.empty === false, '4.2 a press that clicked nothing lets its select through');

	console.log('\n=== 5. the laser sweeps what the tip cannot reach ===');
	const laser = await page.evaluate(() => {
		const s = window.__stores;
		const T = window.__T;
		const THREE = s.THREE;
		const k = s.gameKit.vrGameInput;
		const from = new THREE.Vector3(0, 1.6, 1.5);
		T.aim(1, from, T.keyAt(0));
		T.press(1);
		const hits = [];
		for (let i = 0; i < 5; i++) {
			T.aim(1, from, T.keyAt(i));
			hits.push(k.sweepFrame(1, { tip: from.clone() }));
			T.aim(1, from, T.keyAt(i)); // a second frame on the same key
			hits.push(k.sweepFrame(1, { tip: from.clone() }));
		}
		const r = T.release(1);
		return { hits, swallowed: r.swallowed, log: window.__log.splice(0) };
	});
	h.check(JSON.stringify(laser.log.map((e) => e.key)) === JSON.stringify(['k0', 'k1', 'k2', 'k3', 'k4']), '5.1 the laser, held and moved along the row from 2 m, clicks each key once (' + JSON.stringify(laser.log.map((e) => e.key)) + ')');
	h.check(laser.swallowed === true, '5.2 and swallows its release');

	console.log('\n=== 6. a press another gesture claimed is left alone ===');
	const claimed = await page.evaluate(() => {
		const s = window.__stores;
		const T = window.__T;
		const THREE = s.THREE;
		const above = (i) => T.keyAt(i).add(new THREE.Vector3(0, 0.035, 0));
		// a knob-drag-like hook registered AFTER ours: it takes this press
		const off = s.vrControls.registerVRTriggerHooks({ start: () => true });
		const consumed = T.press(1);
		const frame = T.tipFrame(1, above(1));
		const live = s.gameKit.vrGameInput.sweepLive(1);
		off();
		T.release(1);
		return { consumed, frame, live, log: window.__log.splice(0) };
	});
	h.check(claimed.consumed === true && claimed.log.length === 0 && claimed.live === false, '6.1 the sweep stands down under a claimed gesture (' + JSON.stringify(claimed) + ')');

	console.log('\n=== 7. Edit mode: no sweep ===');
	const edit = await page.evaluate(() => {
		const s = window.__stores;
		const T = window.__T;
		const THREE = s.THREE;
		const above = (i) => T.keyAt(i).add(new THREE.Vector3(0, 0.035, 0));
		s.objectActions.setEditorMode('edit');
		const consumed = T.press(1);
		const frame = T.tipFrame(1, above(0));
		const r = T.release(1);
		s.objectActions.setEditorMode('interact');
		return { consumed, frame, swallowed: r.swallowed, log: window.__log.splice(0) };
	});
	h.check(edit.consumed === false && edit.frame === null && edit.log.length === 0 && edit.swallowed === false, '7.1 in Edit a held trigger sweeps nothing and the select passes (' + JSON.stringify(edit) + ')');

	console.log('\n=== 8. the game board\'s buttons sweep too ===');
	const board = await page.evaluate(async () => {
		const s = window.__stores;
		const T = window.__T;
		const THREE = s.THREE;
		s.hudDocs.setHudDocFor('scene', {
			active: 'pads',
			screens: [
				{
					id: 'pads',
					name: 'Pads',
					input: 'menu',
					elements: [0, 1, 2].map((i) => ({ id: 'pad' + i, kind: 'toggle', anchor: 'center', x: -220 + i * 220, y: 0, w: 180, h: 80, label: 'Pad ' + (i + 1), value: false }))
				}
			]
		});
		const k = s.gameKit.vrGamePanel;
		const head = { position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion() };
		k.hideVrGamePanel();
		k.vrGamePanelFrame({ head, hands: [null, null] });
		const surf = k.vrGameSurface('vr-game-panel');
		const pt = (id) => {
			const rect = k.vrGamePanelDebug().hits['vr-game-panel'].find((x) => x.id === id);
			const g = surf.mesh.geometry.parameters;
			return surf.mesh.localToWorld(new THREE.Vector3(((rect.x + rect.w / 2) / surf.canvas.width - 0.5) * g.width, (0.5 - (rect.y + rect.h / 2) / surf.canvas.height) * g.height, 0));
		};
		const from = new THREE.Vector3(0.2, 1.3, -0.3);
		T.aim(1, from, pt('pad0'));
		const consumed = T.press(1);
		for (const id of ['pad0', 'pad1', 'pad1', 'pad2']) {
			T.aim(1, from, pt(id));
			s.gameKit.vrGameInput.sweepFrame(1, { tip: from.clone() });
		}
		const r = T.release(1);
		const values = [0, 1, 2].map((i) => s.hudDocs.hudValueOf('pad' + i, false));
		s.hudDocs.setHudDocFor('scene', null);
		k.hideVrGamePanel();
		return { consumed, values, swallowed: r.swallowed };
	});
	h.check(board.consumed === true && JSON.stringify(board.values) === '[true,true,true]', '8.1 one press swept across three board toggles flips each once (' + JSON.stringify(board) + ')');

	console.log('\n=== 9. an Interact release on a plain object clicks, never selects ===');
	const release = await page.evaluate(async () => {
		const s = window.__stores;
		const T = window.__T;
		const THREE = s.THREE;
		let r, g;
		s.globalRenderer.subscribe((v) => (r = v))();
		s.objectsGroup.subscribe((v) => (g = v))();
		const target = g.getObjectByProperty('uuid', window.__ids.plain).getWorldPosition(new THREE.Vector3());
		const c = r.xr.getController(1);
		T.aim(1, new THREE.Vector3(0, 1.4, 0), target);
		s.objectActions.deselectObject?.();
		const sel = () => {
			let v;
			s.selectedObjects.subscribe((x) => (v = x))();
			return [...v];
		};
		c.dispatchEvent({ type: 'select', target: c });
		const inInteract = sel();
		s.objectActions.setEditorMode('edit');
		c.dispatchEvent({ type: 'select', target: c });
		const inEdit = sel();
		s.objectActions.deselectObject?.();
		s.objectActions.setEditorMode('interact');
		return { inInteract, inEdit, plain: window.__ids.plain };
	});
	h.check(release.inInteract.length === 0, '9.1 in Interact the VR release selected nothing (' + JSON.stringify(release.inInteract) + ')');
	h.check(release.inEdit.includes(release.plain), '9.2 in Edit the same release selects it, as before');

	console.log('\n=== 11. a real-width keyboard: the tip plays the key it is NEAREST ===');
	const narrow = await page.evaluate(async () => {
		const s = window.__stores;
		const T = window.__T;
		const THREE = s.THREE;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		// seven keys 2.2 cm wide on a 2.4 cm pitch — narrower than the 6 cm tip, like a piano
		const keys = [];
		for (let i = 0; i < 7; i++) {
			const [uuid] = await window.__api.create('/create box 0.022 0.02 0.12', { at: [-0.072 + i * 0.024, 1.3, -0.8] });
			keys.push(uuid);
		}
		await new Promise((res) => setTimeout(res, 600));
		keys.forEach((uuid, i) => {
			const o = g.getObjectByProperty('uuid', uuid);
			o.userData.clickable = true;
			o.userData.physics = { mode: 'static' };
			o.traverse((n) => n.isMesh && (n.userData.sweepKey = 'n' + i));
		});
		g.updateMatrixWorld(true);
		window.__log.splice(0);
		const top = (i) => g.getObjectByProperty('uuid', keys[i]).getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.012, 0));
		T.aim(1, top(1).add(new THREE.Vector3(0, 0.05, 0.2)), top(1));
		T.press(1);
		// glide along the keys, several frames per key, centred over keys 1..5
		for (let i = 1; i <= 5; i++) for (let f = 0; f < 3; f++) T.tipFrame(1, top(i));
		T.release(1);
		return window.__log.splice(0).map((e) => e.key);
	});
	h.check(JSON.stringify(narrow) === JSON.stringify(['n1', 'n2', 'n3', 'n4', 'n5']), '11.1 gliding over five 2.2 cm keys plays those five, one each, no clusters (' + JSON.stringify(narrow) + ')');

	console.log('\n=== 10. the REAL Jam Room: piano keys and drum steps ===');
	const zip = (id) => h.installModule(A, id);
	if (!JAM || !fs.existsSync(JAM)) console.log('SKIP 10: no games/jam-room/scene.tpscene');
	else if (!(await zip('music-lab')) || !(await zip('music-fx'))) console.log('SKIP 10: no music-lab / music-fx zips');
	else {
		await page.evaluate(() => window.__stores.modulesOpen.set(false));
		const bytes = Array.from(fs.readFileSync(JAM));
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, bytes);
		await page.waitForTimeout(3000);
		const jam = await page.evaluate(async () => {
			const s = window.__stores;
			const THREE = s.THREE;
			s.objectActions.setEditorMode('interact');
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			g.updateMatrixWorld(true);
			// every piano key, in order of x; every drum STEP cell of the first row
			const keys = [];
			const steps = [];
			g.traverse((o) => {
				if (!o.isMesh) return;
				if (/^key-\d+$/.test(o.name) || typeof o.userData?.midi === 'number') keys.push(o);
				if (/step/i.test(o.name) && o.parent) steps.push(o);
			});
			keys.sort((a, b) => a.getWorldPosition(new THREE.Vector3()).x - b.getWorldPosition(new THREE.Vector3()).x);
			// spy the dispatch: which handler consumed which mesh, with which source
			const consumed = [];
			const handlers = s.moduleSDK.moduleClickHandlers;
			for (let i = 0; i < handlers.length; i++) {
				const fn = handlers[i];
				if (fn.__spied) continue;
				const wrapped = (o, ctx) => {
					const r = fn(o, ctx);
					if (r) consumed.push({ name: o.name, source: ctx?.source });
					return r;
				};
				wrapped.__spied = true;
				handlers[i] = wrapped;
			}
			const T = window.__T;
			const topOf = (o) => {
				const b = new THREE.Box3().setFromObject(o);
				return new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y + 0.01, (b.min.z + b.max.z) / 2);
			};
			// three neighbouring WHITE keys: the tip plays whichever it is nearest
			const white = keys.filter((k) => ![1, 3, 6, 8, 10].includes(((Number(k.userData?.midi ?? k.name.slice(4)) % 12) + 12) % 12));
			const pick = [white[2], white[3], white[4]].filter(Boolean);
			T.aim(1, topOf(pick[0]).add(new THREE.Vector3(0, 0.05, 0.2)), topOf(pick[0]));
			T.press(1);
			for (const key of pick) {
				T.tipFrame(1, topOf(key));
				T.tipFrame(1, topOf(key));
			}
			T.release(1);
			const keyClicks = consumed.splice(0);
			// the drum machine: the step cells of one row, swept left to right
			const drums = [];
			g.traverse((o) => {
				if (o.userData?.device?.kind && /drums/.test(o.userData.device.kind)) drums.push(o);
			});
			const drum = drums[0];
			const patternOf = () => String(drum?.userData?.device?.params?.pattern ?? '');
			const cells = [];
			drum?.traverse((o) => o.isMesh && /^step-\d+-\d+$/.test(o.name) && cells.push(o));
			// one row (pad 0), every other step, so the tip never sits on two cells at once
			const cellPick = cells
				.filter((c) => c.name.startsWith('step-0-'))
				.sort((a, b) => Number(a.name.split('-')[2]) - Number(b.name.split('-')[2]))
				.filter((c) => Number(c.name.split('-')[2]) % 2 === 0)
				.slice(0, 3);
			const before = patternOf();
			if (cellPick[0]) {
				T.aim(1, topOf(cellPick[0]).add(new THREE.Vector3(0, 0.05, 0.2)), topOf(cellPick[0]));
				T.press(1);
				for (const cell of cellPick) T.tipFrame(1, topOf(cell));
				T.release(1);
			}
			await new Promise((r) => setTimeout(r, 1500)); // the stroke commits after it idles
			const after = patternOf();
			let diff = 0;
			for (let i = 0; i < Math.max(before.length, after.length); i++) if (before[i] !== after[i]) diff++;
			return {
				keys: keys.length,
				picked: pick.map((k) => k.name),
				keyClicks,
				cells: cells.length,
				cellNames: cellPick.map((c) => c.name),
				stepClicks: consumed.splice(0),
				diff,
				before: before.slice(0, 20),
				after: after.slice(0, 20)
			};
		});
		h.check(jam.keys > 10, '10.1 premise: the Jam Room piano is there (' + jam.keys + ' keys)');
		h.check(
			jam.keyClicks.length === 3 && jam.keyClicks.every((c, i) => c.name === jam.picked[i]) && jam.keyClicks[0].source === 'trigger' && jam.keyClicks[2].source === 'sweep',
			'10.2 one held sweep across three piano keys plays each, once (' + JSON.stringify(jam.keyClicks) + ')'
		);
		h.check(jam.stepClicks.length === 3 && jam.diff >= 3, '10.3 a sweep across three drum steps flips each (' + JSON.stringify({ cells: jam.cellNames, clicks: jam.stepClicks.length, diff: jam.diff }) + ')');
	}

	await h.finish(browser);
});
