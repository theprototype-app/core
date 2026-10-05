// 36-sim U2b: the Fluid tank (worker PBF + screen-space / points rendering) and the Jiggle
// node in the real app. Screenshots to SIM_SHOTS when set.
const h = require('./helpers.cjs');
const path = require('path');

const SHOTS = process.env.SIM_SHOTS || '';
/** @param {any} page @param {string} name */
async function shot(page, name) {
	if (!SHOTS) return;
	await page.screenshot({ path: path.join(SHOTS, name) });
}

/** @param {any} page */
const fluid = (page) => page.evaluate(() => window.__stores.sim.fluidDebug()[0] ?? null);

/** @param {any} page @param {number[]} pos @param {number[]} target */
async function look(page, pos, target) {
	await page.evaluate(
		([p, t]) => {
			let cam, orbit;
			window.__stores.editorCam.subscribe((v) => (cam = v))();
			window.__stores.orbitControls.subscribe((v) => (orbit = v))();
			cam.position.set(p[0], p[1], p[2]);
			if (orbit?.target) {
				orbit.target.set(t[0], t[1], t[2]);
				orbit.update?.();
			}
			cam.lookAt(t[0], t[1], t[2]);
			cam.updateMatrixWorld(true);
		},
		[pos, target]
	);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });

	// ---------- Create > Simulation > Fluid tank ----------
	const catalog = await A.page.evaluate(() =>
		import('/src/lib/primitivesCatalog.js').then((m) => m.primitivesCatalog.find((g) => g.group === 'Simulation')?.items.map((i) => i.label))
	);
	h.check(Array.isArray(catalog) && catalog.includes('Fluid tank'), `the Add menu lists Simulation > Fluid tank (${JSON.stringify(catalog)})`);
	const tankUuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create FluidTank 2.4 1.4 1.4');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const tank = g.children[g.children.length - 1];
		// OFF the world origin on purpose: a depth pass drawn in the wrong frame (at the origin)
		// still overlapped a tank at the origin enough to look right
		tank.position.set(-1.2, 0.7, 0);
		tank.updateMatrixWorld(true);
		window.__tank = tank;
		return tank.uuid;
	});
	const stamped = await A.page.evaluate(() => ({
		fluid: !!window.__tank.userData.fluid,
		name: window.__tank.name,
		collider: window.__tank.userData.physics?.collider,
		pieces: window.__tank.userData.physics?.colliderPieces?.length
	}));
	h.check(stamped.fluid && stamped.name === 'Fluid tank', `the tank carries userData.fluid (${JSON.stringify(stamped)})`);
	h.check(stamped.collider === 'custom' && stamped.pieces === 5, 'the tank is a 5-slab compound collider (a toy lands INSIDE)');
	await look(A.page, [-1.2, 2.6, 4.2], [-1.2, 0.5, 0]);

	await h.eventually(() => fluid(A.page), (f) => !!f && f.count > 1000 && f.steps > 30, 'the tank fills and steps', 20000);
	const f1 = await fluid(A.page);
	h.check(f1.worker === 'worker', `the solver runs in a Web Worker (${f1.worker})`);
	h.check(f1.mode === 'ssf' && f1.ssfRuns > 10, `desktop draws screen-space fluid (${f1.mode}, passes ran ${f1.ssfRuns}x)`);
	console.log('fluid', JSON.stringify(f1));
	// the composite really DRAWS: the frame with the fluid visual differs from one without it
	await A.page.waitForTimeout(800);
	const withFluid = await h.grabFrame(A);
	const setVis = (on) =>
		A.page.evaluate((v) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			g.parent.children.filter((c) => c.userData?.__fluidVisual).forEach((c) => (c.visible = v));
		}, on);
	await setVis(false);
	await A.page.waitForTimeout(300);
	const without = await h.grabFrame(A);
	await setVis(true);
	const drawn = await h.frameDelta(A.page, without, withFluid, 30);
	h.check(drawn.changed > 15000, `the screen-space fluid covers the tank on screen (${drawn.changed} px differ)`);
	await A.page.waitForTimeout(1500);
	await shot(A.page, '03-fluid-tank-ssf.png');

	// slosh: move the tank sideways quickly, the fluid lags (centre of mass shifts)
	// (visual check only — screenshots; the solver's slosh is unit-tested)

	// ---------- a toy dropped in: the fluid flows around it; on the initiator it is pushed ----------
	await A.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
	await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Sphere 0.22');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const ball = g.children[g.children.length - 1];
		ball.position.set(-0.9, 2.2, 0);
		ball.userData.physics = { mode: 'dynamic', mass: 0.5, collider: 'sphere' };
		ball.updateMatrixWorld(true);
		window.__ball = ball;
	});
	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => window.__ball.position.y),
		(y) => y < 1.4,
		'the ball drops into the open tank (no lid collider)',
		8000
	);
	await A.page.waitForTimeout(2500);
	const ballY = await A.page.evaluate(() => window.__ball.position.y);
	h.check(ballY > 0.05 + 0.2 && ballY < 1.5, `the ball floats INSIDE the tank — pushed up by the fluid, never launched (y ${ballY.toFixed(2)})`);
	await shot(A.page, '04-fluid-tank-ball.png');
	await A.page.evaluate(() => window.__stores.physics.stopSimulation());

	// ---------- pause when off-screen ----------
	await look(A.page, [-1.2, 2.6, 4.2], [-1.2, 2.6, 40]); // look away
	await A.page.waitForTimeout(600);
	const s0 = (await fluid(A.page)).steps;
	await A.page.waitForTimeout(1500);
	const off = await fluid(A.page);
	h.check(!off.visible && off.steps - s0 <= 1, `off-screen the tank is paused (steps +${off.steps - s0}, visible ${off.visible})`);
	await look(A.page, [-1.2, 2.6, 4.2], [-1.2, 0.5, 0]);
	await h.eventually(() => fluid(A.page), (f) => f.visible && f.steps > off.steps + 10, 'back on screen it resumes', 8000);

	// ---------- settings replicate through the write path; points tier; drain ----------
	await A.page.evaluate((uuid) => window.__stores.sim.setFluidFor(uuid, { quality: 'points', color: '#d0402a' }), tankUuid);
	await h.eventually(() => fluid(A.page), (f) => f.mode === 'points', 'quality Drops switches to the points tier', 5000);
	await A.page.waitForTimeout(800);
	await shot(A.page, '05-fluid-tank-points.png');
	const before = (await fluid(A.page)).count;
	await A.page.evaluate((uuid) => window.__stores.sim.setFluidFor(uuid, { drain: { on: true, rate: 2000, at: [0.5, 0, 0.5], radius: 0.5 } }), tankUuid);
	await h.eventually(() => fluid(A.page), (f) => f.count < before * 0.6, `the drain empties the tank (from ${before})`, 12000);
	const undo = await A.page.evaluate(async () => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 200));
		return window.__tank.userData.fluid.drain.on;
	});
	h.check(undo === false, 'one undo turns the drain off again (props undo kind)');
	await A.page.evaluate((uuid) => window.__stores.sim.setFluidFor(uuid, { emitter: { on: true, rate: 1500 } }), tankUuid);
	await h.eventually(() => fluid(A.page), (f) => f.count > before * 0.8, 'the emitter pours it back up', 12000);
	await A.page.waitForTimeout(300);
	await shot(A.page, '06-fluid-tank-pour.png');

	// ---------- Inspector section ----------
	await A.page.evaluate((uuid) => {
		localStorage.setItem('inspector:sec:Fluid tank', 'open');
		window.__stores.objectActions.selectObject(uuid, true);
		window.__stores.showSidebar('selection');
	}, tankUuid);
	const ui = await A.page.waitForSelector('#fluid-count', { timeout: 8000 }).then(() => true).catch(() => false);
	h.check(ui, 'Inspector shows the Fluid tank section');
	if (ui) await shot(A.page, '07-fluid-inspector.png');

	// ---------- removing the tank frees its visual ----------
	await A.page.evaluate(() => window.__stores.objectActions.selectObject(null));
	await A.page.evaluate((uuid) => window.__stores.objectActions.deleteObjectsByUuid([uuid]), tankUuid);
	await h.eventually(() => A.page.evaluate(() => window.__stores.sim.fluidDebug().length), (n) => n === 0, 'a deleted tank is dropped (visual + worker state)', 5000);

	// ---------- JIGGLE ----------
	const jig = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create Box 1 1.6 1');
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const box = g.children[g.children.length - 1];
		box.position.set(0, 0.8, 0);
		box.updateMatrixWorld(true);
		window.__jelly = box;
		window.__jellyMat = box.material;
		window.__stores.flowGraphs.update((graphs) => ({
			...graphs,
			[box.uuid]: {
				nodes: [{ id: 'jig1', type: 'jiggle', position: { x: 20, y: 20 }, data: { stiffness: 80, damping: 0.1, amplitude: 0.15, frequency: 3 } }],
				edges: []
			}
		}));
		return box.uuid;
	});
	await h.eventually(() => A.page.evaluate(() => window.__stores.sim.jiggleDebug().length), (n) => n === 1, 'a Jiggle node in an object graph jiggles its owner', 5000);
	const pre = await A.page.evaluate(() => window.__stores.sim.jiggleDebug()[0]);
	h.check(pre.meshes === 1 && pre.cloned, `the jiggling mesh got its own material clone (${JSON.stringify(pre)})`);
	// drag it sideways for half a second, then stop: it lags then wobbles
	const motion = await A.page.evaluate(async () => {
		const box = window.__jelly;
		let maxLag = 0;
		for (let i = 0; i < 20; i++) {
			box.position.x += 0.08;
			box.updateMatrixWorld(true);
			await new Promise((r) => requestAnimationFrame(r));
			const d = window.__stores.sim.jiggleDebug()[0];
			maxLag = Math.min(maxLag, d.offset[0]);
		}
		let maxWobble = 0;
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => requestAnimationFrame(r));
			maxWobble = Math.max(maxWobble, Math.abs(window.__stores.sim.jiggleDebug()[0].wobble));
		}
		return { maxLag, maxWobble, pose: box.position.x };
	});
	h.check(motion.maxLag < -0.005, `moving the object leaves the jiggle behind (lag ${motion.maxLag.toFixed(3)} m)`);
	h.check(motion.maxWobble > 0.005, `stopping excites the soft-body wobble (${motion.maxWobble.toFixed(3)})`);
	const pose = await A.page.evaluate(() => window.__jelly.position.x);
	h.check(Math.abs(pose - 1.6) < 1e-6, `jiggle never wrote the transform (x ${pose})`);
	// the uniform really drives the shader (the program compiled with the injection)
	const shaderOk = await A.page.evaluate(() => {
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		const progs = r.info.programs ?? [];
		return progs.some((p) => (p.cacheKey ?? '').includes('jiggle1'));
	});
	h.check(shaderOk, 'a jiggle shader program is compiled (customProgramCacheKey)');
	await look(A.page, [0, 1.6, 3.5], [1.6, 0.8, 0]);
	await A.page.evaluate(async () => {
		// a hit: kick + capture mid-wobble
		window.__stores.sim.kickJiggle(window.__jelly.uuid, [2.5, 0, 0]);
		await new Promise((r) => setTimeout(r, 120));
	});
	await shot(A.page, '08-jiggle-wobble.png');
	// remove the node: the original material comes back
	await A.page.evaluate((uuid) => window.__stores.flowGraphs.update((graphs) => ({ ...graphs, [uuid]: { nodes: [], edges: [] } })), jig);
	await h.eventually(() => A.page.evaluate(() => window.__jelly.material === window.__jellyMat), (v) => v === true, 'removing the Jiggle node restores the original material', 5000);

	// ---------- JIGGLE on a skinned bone chain (a tail), parked for serializers ----------
	const bones = await A.page.evaluate(async () => {
		const THREE = window.__stores.THREE;
		const b0 = new THREE.Bone();
		const b1 = new THREE.Bone();
		const b2 = new THREE.Bone();
		b1.position.y = 0.5;
		b2.position.y = 0.5;
		b0.add(b1);
		b1.add(b2);
		const geo = new THREE.CylinderGeometry(0.08, 0.08, 1, 6, 4).translate(0, 0.5, 0);
		const n = geo.attributes.position.count;
		const si = new Uint16Array(n * 4);
		const sw = new Float32Array(n * 4);
		for (let i = 0; i < n; i++) {
			const y = geo.attributes.position.getY(i);
			si[i * 4] = y < 0.33 ? 0 : y < 0.66 ? 1 : 2;
			sw[i * 4] = 1;
		}
		geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
		geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
		const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color: '#c08040' }));
		const tail = new THREE.Group();
		tail.name = 'Tail';
		tail.add(b0);
		tail.add(mesh);
		mesh.bind(new THREE.Skeleton([b0, b1, b2]));
		tail.position.set(-1.5, 0.5, 0);
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		g.add(tail);
		window.__tail = { tail, b1, b2, rest1: b1.quaternion.clone(), rest2: b2.quaternion.clone() };
		window.__stores.flowGraphs.update((graphs) => ({
			...graphs,
			[tail.uuid]: { nodes: [{ id: 'jigT', type: 'jiggle', position: { x: 0, y: 0 }, data: { stiffness: 60, damping: 0.1 } }], edges: [] }
		}));
		for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r));
		const dbg = window.__stores.sim.jiggleDebug().find((d) => d.uuid === tail.uuid);
		let swing = 0;
		for (let i = 0; i < 20; i++) {
			tail.position.x += 0.1;
			tail.updateMatrixWorld(true);
			await new Promise((r) => requestAnimationFrame(r));
			swing = Math.max(swing, window.__tail.b2.quaternion.angleTo(window.__tail.rest2));
		}
		// a serializer parks the chain at rest, then puts the swing back
		const restore = window.__stores.flowRuntime.parkAnimatedAtBase();
		const parked = window.__tail.b2.quaternion.angleTo(window.__tail.rest2);
		restore();
		const after = window.__tail.b2.quaternion.angleTo(window.__tail.rest2);
		return { bones: dbg?.bones ?? 0, swing, parked, after };
	});
	h.check(bones.bones === 2, `a skinned chain gets bone springs on its tail end (${bones.bones} bones)`);
	h.check(bones.swing > 0.05, `moving it swings the tail bones (${bones.swing.toFixed(3)} rad)`);
	h.check(bones.parked < 1e-6 && bones.after > 1e-4, `parkAnimatedAtBase puts the bones at rest for a save, then back (${bones.parked.toExponential(1)} / ${bones.after.toFixed(3)})`);

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A).slice(0, 2))})`);
	await browser.close();
});
