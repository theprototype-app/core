// 37-fx (R12): how particles are DRAWN — velocity-stretched sparks, per-particle trails, a
// ribbon through the emitter's path — and inherit velocity. Every mode is the same analytic
// simulation (particleShader.js simPos) sampled at a few ages, so the checks are: the right
// geometry per mode, no shader compile error, real pixels on screen, the emitter-velocity
// stamp, the burst-ribbon fallback and the VR cap. Screenshots land in FX_SHOTS (evidence).
//
// Counterfactuals (run by hand, recorded in the lane handover): uInherit forced to 0 →
// check 5 (inherit moves the cloud) fails; the ribbon seam test (older >= younger) removed →
// check 6 (no band across the emitter) fails.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SHOTS = process.env.FX_SHOTS || '';

const entriesOn = (page) => page.evaluate(() => window.__stores.particleRuntime.particleEntries());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const glErrors = [];
	page.on('console', (msg) => {
		if (/WebGLProgram|THREE\.WebGLShader|ERROR: 0:/i.test(msg.text())) glErrors.push(msg.text());
	});

	// a box 4 m in front of the camera, at the camera's height
	const place = async () =>
		page.evaluate(() => {
			const s = window.__stores;
			let cam;
			s.globalCamera.subscribe((c) => (cam = c))();
			s.commandsHandler.sceneCommand('/create box');
			let group;
			s.objectsGroup.subscribe((g) => (group = g))();
			const box = group.children[group.children.length - 1];
			const fwd = cam.getWorldDirection(cam.position.clone());
			box.position.copy(cam.position).addScaledVector(fwd, 4);
			box.scale.setScalar(0.3);
			delete box.userData.physics;
			window.__fx = box;
			window.__fxHome = box.position.clone();
			window.__fxRight = fwd.clone().cross(cam.up).normalize();
			return box.uuid;
		});
	const shot = async (name) => {
		if (!SHOTS) return;
		fs.mkdirSync(SHOTS, { recursive: true });
		await page.screenshot({ path: path.join(SHOTS, name) });
	};
	// sweep the box side to side (local only — the runtime reads the object's pose)
	const sweep = (on, speed = 2.5) =>
		page.evaluate(
			({ on, speed }) => {
				cancelAnimationFrame(window.__fxRaf);
				if (!on) {
					window.__fx.position.copy(window.__fxHome);
					return;
				}
				const t0 = performance.now();
				const loop = () => {
					const t = (performance.now() - t0) / 1000;
					window.__fx.position.copy(window.__fxHome).addScaledVector(window.__fxRight, Math.sin(t * speed) * 1.4);
					window.__fx.position.y = window.__fxHome.y + Math.sin(t * speed * 2) * 0.35;
					window.__fxRaf = requestAnimationFrame(loop);
				};
				loop();
			},
			{ on, speed }
		);
	// lit pixels inside the box's screen neighbourhood (the canvas only; UI chrome excluded)
	const litPixels = () =>
		page.evaluate(async () => {
			const s = window.__stores;
			let renderer;
			s.globalRenderer.subscribe((r) => (renderer = r))();
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			const src = renderer.domElement;
			const c = document.createElement('canvas');
			c.width = 320;
			c.height = 180;
			const g = c.getContext('2d');
			g.drawImage(src, 0, 0, 320, 180);
			const d = g.getImageData(0, 0, 320, 180).data;
			let lit = 0;
			for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 600) lit++;
			return lit;
		});

	const uuid = await place();
	const set = (cfg) =>
		page.evaluate(([u, c]) => window.__stores.particleActions.updateObjectParticles(u, c), [uuid, cfg]);
	const preset = (key) => page.evaluate(([u, k]) => window.__stores.particleActions.addParticlesPreset(u, k), [uuid, key]);

	// 1) Sparks is stretched along its motion now
	await preset('sparks');
	const sparks = await page.evaluate(() => window.__fx.userData.particles);
	h.check(sparks.render === 'stretch' && sparks.stretch > 0, `Sparks preset draws stretched quads (${sparks.render}, ${sparks.stretch} s)`);
	await h.eventually(() => entriesOn(page), (e) => e[0]?.render === 'stretch', 'runtime builds a stretch entry');
	const st = (await entriesOn(page))[0];
	h.check(st.verts === st.count * 4, `stretch = one quad per slot (${st.verts} verts / ${st.count})`);
	for (let i = 0; i < 6; i++) {
		await page.evaluate((u) => window.__stores.particleActions.burstObjectParticles(u), uuid);
		await page.waitForTimeout(250);
		if (i === 1) await shot('01-sparks-stretched.png');
	}

	// 2) every mode builds its geometry and compiles
	const modes = [
		['points', (n) => n],
		['stretch', (n) => n * 4],
		['trails', (n) => n * 9 * 2],
		['ribbon', (n) => n * 4]
	];
	for (const [render, verts] of modes) {
		await set({ mode: 'continuous', render, trailSegments: 8, count: 60, space: 'world' });
		await h.eventually(
			() => entriesOn(page),
			(e) => e[0]?.render === render && e[0]?.verts === verts(60),
			`${render}: ${verts(60)} vertices for 60 particles`
		);
	}

	// 3) a ribbon on a burst emitter is drawn as trails (a burst has no birth order)
	await set({ mode: 'burst', render: 'ribbon' });
	await h.eventually(() => entriesOn(page), (e) => e[0]?.render === 'trails', 'burst + ribbon falls back to trails');

	// 4) the ribbon trail preset behind a moving object — pixels on screen
	await preset('trail');
	await sweep(true);
	await page.waitForTimeout(1200);
	const ribbonLit = await litPixels();
	h.check(ribbonLit > 150, `ribbon trail draws a band behind the moving box (${ribbonLit} lit px of 57600)`);
	await shot('02-ribbon-trail.png');
	const ent = (await entriesOn(page))[0];
	h.check(ent.render === 'ribbon' && Math.hypot(...ent.vel) > 0.3, `the emitter's velocity is tracked while it moves (|v| = ${Math.hypot(...ent.vel).toFixed(2)} m/s)`);

	// 5) inherit velocity: a still cloud vs one that keeps the box's motion. Same seed, same
	// clock — only uInherit differs, so the particles' screen spread is the measurement.
	const spread = () =>
		page.evaluate(async () => {
			const s = window.__stores;
			let renderer;
			s.globalRenderer.subscribe((r) => (renderer = r))();
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			const c = document.createElement('canvas');
			c.width = 320;
			c.height = 180;
			const g = c.getContext('2d');
			g.drawImage(renderer.domElement, 0, 0, 320, 180);
			const d = g.getImageData(0, 0, 320, 180).data;
			let minX = 1e9;
			let maxX = -1;
			for (let y = 0; y < 180; y++)
				for (let x = 0; x < 320; x++) {
					const i = (y * 320 + x) * 4;
					if (d[i] + d[i + 1] + d[i + 2] > 600) {
						minX = Math.min(minX, x);
						maxX = Math.max(maxX, x);
					}
				}
			return maxX < 0 ? 0 : maxX - minX;
		});
	await preset('wisps');
	await set({ render: 'points', inherit: 0, count: 200, lifetime: 2.5, speed: 0.1, drag: 0, turbulence: 0, gravity: 0, sizeStart: 0.06, sizeEnd: 0.06, colorStart: '#ffffff', colorEnd: '#ffffff' });
	await page.waitForTimeout(2600);
	const still = await spread();
	await set({ inherit: 1 });
	await page.waitForTimeout(2600);
	const carried = await spread();
	await shot('03-inherit-velocity.png');
	h.check(carried > still * 1.15, `inherit 1 carries the particles on past the sweep (x-spread ${still} → ${carried} px)`);
	await set({ render: 'trails', inherit: 0.3, trail: 0.6, colorStart: '#e9d7ff', colorEnd: '#8a5cff', count: 40, speed: 0.6, turbulence: 0.9 });
	await page.waitForTimeout(1500);
	await shot('04-wisps-trails.png');

	// 6) the ribbon never draws a band across the seam (where a slot is reborn at the head):
	// a STILL emitter with speed 0 has every slot at one point — a ribbon of zero area
	await sweep(false);
	await preset('trail');
	await page.waitForTimeout(1500); // every slot reborn at the still position
	const stillRibbon = await litPixels();
	h.check(stillRibbon < 60, `a still ribbon collapses to nothing (${stillRibbon} lit px)`);

	// 7) the VR cap trims the strip modes by whole particles
	await set({ render: 'trails', mode: 'continuous', count: 400, trailSegments: 8 });
	await page.evaluate(() => window.__stores.isVRMode.set(true));
	await h.eventually(
		() => entriesOn(page),
		(e) => e[0]?.drawRange === 200 * 8 * 6,
		'VR caps a trail emitter at 200 particles (drawRange in indices)'
	);
	await page.evaluate(() => window.__stores.isVRMode.set(false));

	// 8) inherit/stretch/trail ride the replicated config like every other field
	const sent = await page.evaluate((u) => {
		const captured = [];
		let peer;
		window.__stores.peers.subscribe((p) => (peer = p))();
		peer.send = (m) => captured.push(m);
		window.__stores.particleActions.updateObjectParticles(u, { inherit: 0.7, render: 'stretch', stretch: 0.08 });
		delete peer.send;
		return captured.find((m) => m.parameter === 'particles')?.particles ?? null;
	}, uuid);
	h.check(sent?.inherit === 0.7 && sent?.render === 'stretch' && sent?.stretch === 0.08, 'render / stretch / inherit replicate with the config');

	h.check(glErrors.length === 0, `no shader compile errors (${glErrors.slice(0, 2).join(' | ')})`);
	await h.finish(browser, [A]);
});
