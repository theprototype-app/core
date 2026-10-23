// 57 M11 + M12 — the Animation states window + Locomotion preset under the Player controller
// (possess) on host AND peer; Set Animation Parameter / On Animation State nodes; animate_parts
// (the agent tool, through executeAiTool) on a plain model's named parts; Attach to Socket.
const h = require('./helpers.cjs');

const readingOf = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		const r = s.animGraphRuntime.animGraphReading(uuid);
		const w = s.animatedImports.poseDriverOf(uuid)?.weights ?? null;
		return r ? { state: r.state, params: r.params, weights: w } : null;
	}, uuid);

/** record every state the machine enters on a page, from now on */
const watchStates = (page, uuid) =>
	page.evaluate((uuid) => {
		window.__seen57 = [];
		window.__stores.animGraphRuntime.onAnimStateEnter((u, id) => u === uuid && window.__seen57.push(id));
	}, uuid);
const seenStates = (page) => page.evaluate(() => window.__seen57 ?? []);

/** a vertical hop on A, broadcasting moves the way a drag does (vy +4 m/s, then -4 back down) */
const hop = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				const s = window.__stores;
				let g;
				s.objectsGroup.subscribe((x) => (g = x))();
				const o = g.getObjectByProperty('uuid', uuid);
				let peer;
				s.peers.subscribe((p) => (peer = p))();
				const y0 = o.position.y;
				const t0 = performance.now();
				let last = 0;
				const step = () => {
					const t = (performance.now() - t0) / 1000;
					o.position.y = y0 + (t < 0.4 ? 4 * t : Math.max(0, 1.6 - 4 * (t - 0.4)));
					if (performance.now() - last > 100) {
						last = performance.now();
						peer.send({ type: 'move', uuid, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
					}
					if (t < 1.6) requestAnimationFrame(step);
					else {
						o.position.y = y0;
						peer.send({ type: 'move', uuid, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
						resolve(true);
					}
				};
				requestAnimationFrame(step);
			}),
		uuid
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		const knight = await (await fetch('/avatars/knight.glb')).arrayBuffer();
		const id = await s.fileHandler.importFile(new File([knight], 'knight.glb'), 'Knight');
		const clips = await (await fetch('/avatars/clips.glb')).arrayBuffer();
		const items = await s.explorer.importFiles([new File([clips], 'clips.glb')], null);
		for (const want of ['Idle', 'Walking_A', 'Running_A', 'Jump_Idle']) {
			const item = items.find((i) => i.name.endsWith(want + '.tpanim'));
			s.clipAssets.assignClipAsset(id, { hash: item.hash, name: want });
		}
		return id;
	});
	const bound = (page) => page.evaluate((uuid) => window.__stores.animatedImports.clipInfo(uuid).filter((c) => c.asset).length, uuid);
	await h.eventually(() => bound(A.page), (n) => n === 4, 'four clips bound on A', 20000);
	await h.eventually(() => bound(B.page), (n) => n === 4, '...and on B', 30000);

	// ---------- the window: one click builds the Locomotion preset ----------
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.objectActions.selectObject(uuid);
		s.animationClose.set(false);
	}, uuid);
	await A.page.locator('#anim-states-open').click({ timeout: 15000 });
	await A.page.locator('#anim-states-preset').click({ timeout: 10000 });
	const graphOn = (page) =>
		page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			return g.getObjectByProperty('uuid', uuid)?.userData?.animGraph ?? null;
		}, uuid);
	await h.eventually(() => graphOn(B.page), (g) => g?.states?.length === 3 && g.driver === 'motion', 'M11: the Locomotion preset replicated (Move / Jump / Fall, motion driver)');
	const g = await graphOn(A.page);
	h.check(g.states[0].blend?.walk === 'Walking_A' && g.states.find((s) => s.id === 'fall')?.clip === 'Jump_Idle', 'M11: the preset picked the character’s own clips');
	await A.page.locator('#anim-states [data-state="move"].as-live').waitFor({ timeout: 10000 }).then(
		() => h.check(true, 'M11: the window shows the live state (Move)'),
		() => h.check(false, 'M11: the window shows the live state (Move)')
	);
	await h.eventually(() => readingOf(A.page, uuid), (r) => r?.state === 'move' && r.weights?.Idle > 0.9, 'M11: standing, it idles on A');
	await h.eventually(() => readingOf(B.page, uuid), (r) => r?.state === 'move' && r.weights?.Idle > 0.9, 'M11: ...and on B');

	// ---------- walk + run under the Player controller (possess), host and peer ----------
	const drive = async (speed, label) => {
		await A.page.evaluate(({ uuid, speed }) => window.__stores.possess.possess(uuid, { speed, camera: 'none' }), { uuid, speed });
		await A.page.keyboard.down('W');
		await A.page.waitForTimeout(1600);
		const a = await readingOf(A.page, uuid);
		const b = await readingOf(B.page, uuid);
		await A.page.keyboard.up('W');
		await A.page.evaluate(() => window.__stores.possess.release());
		return { a, b };
	};
	const walk = await drive(1.4, 'walk');
	h.check(walk.a?.weights?.Walking_A > 0.7, `M11: possessed at 1.4 m/s it WALKS on A (speed ${walk.a?.params?.speed?.toFixed(2)}, ${JSON.stringify(walk.a?.weights)})`);
	h.check(walk.b?.weights?.Walking_A > 0.5, `M11: ...and on B from the replicated moves (${JSON.stringify(walk.b?.weights)})`);
	await A.page.waitForTimeout(800);
	const run = await drive(4, 'run');
	h.check(run.a?.weights?.Running_A > 0.7, `M11: at 4 m/s it RUNS on A (${JSON.stringify(run.a?.weights)})`);
	h.check(run.b?.weights?.Running_A > 0.5, `M11: ...and on B (${JSON.stringify(run.b?.weights)})`);

	// ---------- jump: a hop goes Jump -> Fall -> Move, on both peers ----------
	await A.page.waitForTimeout(800);
	await watchStates(A.page, uuid);
	await watchStates(B.page, uuid);
	await hop(A.page, uuid);
	await A.page.waitForTimeout(900);
	const seenA = await seenStates(A.page);
	const seenB = await seenStates(B.page);
	h.check(seenA.join() === 'jump,fall,move', `M11: a hop goes Jump → Fall → Move on A (${seenA.join(' → ')})`);
	h.check(seenB.join() === 'jump,fall,move', `M11: ...and on B (${seenB.join(' → ')})`);

	// ---------- the nodes: On Click -> Set Animation Parameter (jump trigger); On Animation State ----------
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.flowGraphsCtl.createObjectGraph(uuid);
		const nh = s.nodesHandler;
		nh.createFlowNode({ id: 'k-click', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } }, uuid);
		nh.createFlowNode({ id: 'k-jump', type: 'setanimparam', position: { x: 220, y: 0 }, data: { type: 'setanimparam', name: 'jump', mode: 'trigger', value: 0 } }, uuid);
		nh.createFlowEdge({ id: 'e-k', source: 'k-click', target: 'k-jump', targetHandle: 'trigger' }, uuid);
		nh.createFlowNode({ id: 'k-onjump', type: 'onanimstate', position: { x: 0, y: 160 }, data: { type: 'onanimstate', state: 'Jump', pulse: 0.3 } }, uuid);
	}, uuid);
	await B.page.waitForTimeout(1500);
	await watchStates(A.page, uuid);
	await watchStates(B.page, uuid);
	await A.page.evaluate((uuid) => window.__stores.flowRuntime.fireObjectClick(uuid), uuid);
	await A.page.waitForTimeout(600);
	h.check((await seenStates(A.page)).includes('jump'), 'M11: Set Animation Parameter fires the jump trigger on A');
	await h.eventually(() => seenStates(B.page), (l) => l.includes('jump'), 'M11: ...and on B (from the replicated click stamp)');
	const pulsed = await A.page.evaluate(() => {
		let t;
		window.__stores.flowTriggers.subscribe((v) => (t = v))();
		return !!t?.['k-onjump'];
	});
	h.check(pulsed, 'M11: On Animation State pulsed when the machine entered Jump');

	// ---------- M12: animate_parts (the agent tool) on a plain model's named parts ----------
	const heli = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const s = window.__stores;
				const T = s.THREE;
				const root = new T.Group();
				const body = new T.Mesh(new T.BoxGeometry(2, 1, 1), new T.MeshStandardMaterial());
				body.name = 'body';
				root.add(body);
				const rotor = new T.Mesh(new T.BoxGeometry(4, 0.05, 0.2), new T.MeshStandardMaterial());
				rotor.name = 'rotor';
				rotor.position.set(0, 0.8, 0);
				body.add(rotor);
				new s.GLTFExporterModule.GLTFExporter().parse(root, async (buf) => resolve(await s.fileHandler.importFile(new File([buf], 'heli.glb'), 'Heli')), () => resolve(null), { binary: true });
			})
	);
	h.check(!!heli && !(await A.page.evaluate((id) => window.__stores.animatedImports.hasAnimatedImport(id), heli)), 'M12: a plain model (no rig, no clips) placed');
	const res = await A.page.evaluate(
		(heli) => window.__stores.aiTools.executeAiTool('animate_parts', { object: heli, clip: 'Spin', tracks: [{ part: 'rotor', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 1, rot: [0, 360, 0] }] }], loop: true }),
		heli
	);
	h.check(res?.ok && res.parts?.[0] === 'rotor', `M12: animate_parts writes one clip on the named part (${JSON.stringify(res).slice(0, 120)})`);
	const rotorYaw = (page) =>
		page.evaluate((heli) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const r = g.getObjectByProperty('uuid', heli)?.getObjectByName('rotor');
			return r ? new s.THREE.Euler().setFromQuaternion(r.quaternion, 'YXZ').y : null;
		}, heli);
	const turns = async (page) => {
		const a = await rotorYaw(page);
		await page.waitForTimeout(170);
		const b = await rotorYaw(page);
		return a !== null && b !== null && Math.abs(a - b) > 0.2;
	};
	h.check(await turns(A.page), 'M12: the rotor spins on A');
	await h.eventually(() => turns(B.page), (v) => v, 'M12: ...and on B (the clip pulled, bound to its own copy by part name)', 20000);
	const clipOnHeli = (page) => page.evaluate((heli) => window.__stores.animatedImports.clipInfo(heli).map((c) => c.name), heli);
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => clipOnHeli(B.page), (l) => !l.includes('Spin'), 'M12: one undo takes the clip off on B');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => clipOnHeli(B.page), (l) => l.includes('Spin'), 'M12: redo puts it back');

	// ---------- M12: Attach to Socket — a box rides the rotor tip ----------
	const box = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 0.2 0.2 0.2');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const b = group.children[group.children.length - 1];
		b.position.set(1.8, 0.8, 0);
		return b.uuid;
	});
	await B.page.waitForTimeout(1200);
	await A.page.evaluate(({ box, heli }) => window.__stores.animatedImports.attachToSocket(box, heli, 'rotor', { snap: false }), { box, heli });
	const boxAt = (page) =>
		page.evaluate((box) => {
			let g;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			const o = g.getObjectByProperty('uuid', box);
			return o ? [o.position.x, o.position.z] : null;
		}, box);
	const circles = async (page) => {
		const a = await boxAt(page);
		await page.waitForTimeout(200);
		const b = await boxAt(page);
		return a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.2 && Math.abs(Math.hypot(b[0], b[1]) - 1.8) < 0.15;
	};
	h.check(await circles(A.page), 'M12: the attached box follows the spinning rotor on A');
	await h.eventually(() => circles(B.page), (v) => v, 'M12: ...and on B (the attach replicated; each peer follows its own socket)', 15000);
	await A.page.evaluate((box) => window.__stores.animatedImports.attachToSocket(box, null, null), box);
	const s1 = await boxAt(A.page);
	await A.page.waitForTimeout(300);
	const s2 = await boxAt(A.page);
	h.check(s1 && s2 && Math.hypot(s1[0] - s2[0], s1[1] - s2[1]) < 1e-6, 'M12: detached, it stays where it was let go');

	await h.finish(browser);
});
