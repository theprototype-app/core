// 31 G5 — SEE WHERE THE RAY POINTS. The user, on a Quest 3: "i want to be able to see from
// controller ray where i point in menu (now its hard to navigate)".
//
// Driven through fakeXR (a fake session: updateVRControls' real beam/reticle pass runs every
// frame) with the VR game board drawn by vrGamePanelFrame from a synthetic head, on the REAL
// Towers, Stars Room and Jam Room templates (their own menu screens). Per game:
// the beam ends ON the hovered button (its length = the hit distance), the reticle AND its
// solid dot sit on the button's centre (< 1 cm), the button under the ray is FILLED (a pixel
// inside it changes, not just a ring outside it) and the board's hover id is that button.
// Then: the beam is NORMAL-blended (the additive glow vanished against a bright sky); a
// module's INTERACTIVE group (re-homed under module-world-root since 30b P5) ends the beam and
// resolves to a click target; the radial ring takes the reticle too.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const fs = require('fs');
const path = require('path');

const SCENES = process.env.SCENES_DIR || path.resolve(__dirname, '../../../scenes/games');
const GAMES = ['towers', 'stars-room', 'jam-room'];

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await xr.install(page);
	await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const r = window.__fakeXR.renderer;
		window.__L = {
			head: () => ({ position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion() }),
			// point controller `i` from `from` at world point `to` (a controller's ray is its -Z)
			aim: (i, from, to) => {
				const c = r.xr.getController(i);
				const m = new THREE.Matrix4().lookAt(from, to, new THREE.Vector3(0, 1, 0));
				const q = new THREE.Quaternion().setFromRotationMatrix(m);
				c.matrix.compose(from, q, new THREE.Vector3(1, 1, 1));
				c.matrixWorld.copy(c.matrix);
				c.updateMatrixWorld(true);
			},
			ray: (i) => {
				const c = r.xr.getController(i);
				const ray = new THREE.Raycaster();
				const m = new THREE.Matrix4().extractRotation(c.matrixWorld);
				ray.ray.origin.setFromMatrixPosition(c.matrixWorld);
				ray.ray.direction.set(0, 0, -1).applyMatrix4(m);
				return ray;
			},
			rectPoint: (id) => {
				const k = s.gameKit.vrGamePanel;
				const surf = k.vrGameSurface('vr-game-panel');
				const rect = k.vrGamePanelDebug().hits['vr-game-panel'].find((x) => x.id === id);
				if (!surf || !rect) return null;
				const g = surf.mesh.geometry.parameters;
				const cx = (rect.x + rect.w / 2) / surf.canvas.width;
				const cy = (rect.y + rect.h / 2) / surf.canvas.height;
				return surf.mesh.localToWorld(new THREE.Vector3((cx - 0.5) * g.width, (0.5 - cy) * g.height, 0));
			},
			beam: (i) => {
				let found = { beam: null, reticle: null, dot: null };
				r.xr.getController(i).traverse((o) => {
					if (o.name === 'vr-ray') found.beam = o;
					if (o.name === 'vr-ray-reticle') found.reticle = o;
					if (o.name === 'vr-ray-dot') found.dot = o;
				});
				const wp = (o) => (o ? o.getWorldPosition(new THREE.Vector3()) : null);
				return {
					length: found.beam?.scale.z ?? null,
					blending: found.beam?.material.blending ?? null,
					reticle: found.reticle?.visible ? wp(found.reticle).toArray() : null,
					dot: found.dot && found.reticle?.visible && found.dot.visible ? wp(found.dot).toArray() : null
				};
			}
		};
	});
	const frames = (n = 4) => page.waitForTimeout(n * 40);

	for (const game of GAMES) {
		const file = path.join(SCENES, game, 'scene.tpscene');
		if (!fs.existsSync(file)) {
			console.log('SKIP ' + game + ': no ' + file);
			continue;
		}
		console.log('\n=== ' + game + ' ===');
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, Array.from(fs.readFileSync(file)));
		await page.waitForTimeout(2000);
		const menu = await page.evaluate(() => {
			const s = window.__stores;
			s.gameState.setGameState('menu');
			s.objectActions.setEditorMode('interact');
			const k = s.gameKit.vrGamePanel;
			k.hideVrGamePanel();
			const f = k.vrGamePanelFrame({ head: window.__L.head(), hands: [null, null] });
			const hits = k.vrGamePanelDebug().hits['vr-game-panel'].filter((x) => x.kind !== 'footer');
			return { panel: f.panel, ids: hits.map((x) => x.id) };
		});
		h.check(!!menu.panel && menu.ids.length > 0, `${game}: its menu is on the VR board with pressable controls (${menu.ids.join(',')})`);
		if (!menu.ids.length) continue;
		const id = menu.ids[0];
		// the pixel at the button's centre BEFORE the ray is on it
		const px = (id) =>
			page.evaluate((id) => {
				const k = window.__stores.gameKit.vrGamePanel;
				const surf = k.vrGameSurface('vr-game-panel');
				const rect = k.vrGamePanelDebug().hits['vr-game-panel'].find((x) => x.id === id);
				const g = surf.canvas.getContext('2d');
				// sample a quarter in from the left edge (text sits in the middle)
				return Array.from(g.getImageData(Math.round(rect.x + rect.w * 0.12), Math.round(rect.y + rect.h * 0.2), 1, 1).data);
			}, id);
		const before = await px(id);
		const at = await page.evaluate((id) => {
			const s = window.__stores;
			const L = window.__L;
			const to = L.rectPoint(id);
			L.aim(1, new s.THREE.Vector3(0.25, 1.3, -0.1), to);
			return to.toArray();
		}, id);
		await frames();
		const beam = await page.evaluate(() => window.__L.beam(1));
		const d = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);
		const dist = d([0.25, 1.3, -0.1], at);
		h.check(Math.abs(beam.length - dist) < 0.02, `${game}: the beam ends on the button (${beam.length?.toFixed(3)} vs ${dist.toFixed(3)} m)`);
		h.check(d(beam.reticle, at) < 0.01, `${game}: the reticle sits on it (${d(beam.reticle, at).toFixed(4)} m)`);
		h.check(d(beam.dot, at) < 0.01, `${game}: the solid hit DOT sits on it (${d(beam.dot, at).toFixed(4)} m)`);
		// the hover: the board's own hover id + the button's fill
		const hov = await page.evaluate(() => {
			const s = window.__stores;
			const k = s.gameKit.vrGamePanel;
			k.panelHover(1, window.__L.ray(1));
			k.vrGamePanelFrame({ head: window.__L.head(), hands: [null, null] });
			return k.vrGamePanelDebug().hover;
		});
		const after = await px(id);
		h.check(hov[1] === id, `${game}: the board's hover is the pointed button (${hov[1]})`);
		const delta = Math.abs(after[0] - before[0]) + Math.abs(after[1] - before[1]) + Math.abs(after[2] - before[2]);
		h.check(delta > 30, `${game}: the hovered button is FILLED, not just ringed (rgb ${before.slice(0, 3)} -> ${after.slice(0, 3)})`);
		await page.evaluate(() => {
			const k = window.__stores.gameKit.vrGamePanel;
			k.panelHover(1, null);
			k.hideVrGamePanel();
		});
	}

	console.log('\n=== the beam material ===');
	const blending = await page.evaluate(() => [window.__L.beam(1).blending, window.__stores.THREE.NormalBlending]);
	h.check(blending[0] === blending[1], `the beam is normal-blended, visible against a bright sky (${blending[0]})`);

	console.log('\n=== a module interactive group ends the beam ===');
	await page.evaluate(async () => {
		const s = window.__stores;
		s.objectActions.setEditorMode('edit');
		s.sessions.clearScene?.();
		await s.moduleSDK.initModules([
			{
				id: 'laser31',
				name: 'Laser test',
				version: '1.0.0',
				description: '31 G5',
				register(api) {
					const THREE = api.THREE;
					const g = new THREE.Group();
					g.name = 'laser31-board';
					const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.02), new THREE.MeshBasicMaterial({ color: 0x3366ff }));
					m.name = 'laser31-button';
					g.add(m);
					g.position.set(0, 1.4, -1.5);
					api.scene().add(g);
					api.registerInteractiveGroup('laser31-board');
					api.registerClickHandler(() => false);
				}
			}
		]);
	});
	await frames(6);
	const mod = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const L = window.__L;
		L.aim(1, new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(0, 1.4, -1.5));
		const board = s.globalScene && (() => { let sc; s.globalScene.subscribe((v) => (sc = v))(); return sc.getObjectByName('laser31-board'); })();
		const target = s.gameKit.vrGameInput.clickTargetAlong(L.ray(1));
		return { parent: board?.parent?.name, group: target?.group ?? null };
	});
	await frames();
	const modBeam = await page.evaluate(() => window.__L.beam(1));
	h.check(mod.parent === 'module-world-root', `premise: the module group is re-homed under the world rig (${mod.parent})`);
	h.check(modBeam.reticle && Math.abs(modBeam.length - 1.49) < 0.02, `the beam ends ON the module's board (${modBeam.length?.toFixed(3)} m, reticle ${!!modBeam.reticle})`);
	h.check(mod.group === 'laser31-board', `the laser resolves the module mesh to its interactive group (${mod.group})`);

	console.log('\n=== the radial ring takes the reticle ===');
	const ring = await page.evaluate(() => {
		const s = window.__stores;
		s.vrMenuOpen.set(true);
		return null;
	});
	await frames(4);
	const aimRing = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const l = s.vrRadialMenu.sectorLayout(0, 8);
		const to = new THREE.Vector3(l.labelX, l.labelY, 0);
		window.__L.aim(1, new THREE.Vector3(l.labelX, l.labelY, 0.35), to);
		return to.toArray();
	});
	await frames();
	const ringBeam = await page.evaluate(() => window.__L.beam(1));
	h.check(
		ringBeam.reticle && Math.hypot(ringBeam.reticle[0] - aimRing[0], ringBeam.reticle[1] - aimRing[1], ringBeam.reticle[2] - aimRing[2]) < 0.01,
		`the reticle sits on the radial sector (${JSON.stringify(ringBeam.reticle)})`
	);
	await page.evaluate(() => window.__stores.vrMenuOpen.set(false));
	void ring;

	await xr.uninstall(page);
	await h.finish(browser);
});
