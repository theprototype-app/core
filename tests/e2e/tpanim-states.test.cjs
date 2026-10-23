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
/** what a peer holds for a parts model — printed beside its checks so a red says which link broke */
const heliState = (page, uuid, hash) =>
	page.evaluate(
		({ uuid, hash }) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const root = g.getObjectByProperty('uuid', uuid);
			const item = s.explorer.itemByHash(hash);
			return {
				here: !!root,
				refs: root?.userData?.clipRefs ?? null,
				clipModel: s.animatedImports.hasClipModel(uuid),
				state: s.animatedImports.animationState(uuid),
				clips: s.animatedImports.clipInfo(uuid).map((c) => c.name + (c.asset ? '*' : '')),
				nodes: (() => {
					const n = [];
					root?.traverse((o) => n.push(o.name));
					return n;
				})(),
				item: item ? { id: item.id, share: item.share } : null,
				assets: s.clipAssets.clipAssetsDebug()
			};
		},
		{ uuid, hash }
	);

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
		nh.createFlowNode({ id: 'k-click', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 1 } }, uuid);
		nh.createFlowNode({ id: 'k-jump', type: 'setanimparam', position: { x: 220, y: 0 }, data: { type: 'setanimparam', name: 'jump', mode: 'trigger', value: 0 } }, uuid);
		nh.createFlowEdge({ id: 'e-k', source: 'k-click', target: 'k-jump', targetHandle: 'trigger' }, uuid);
		nh.createFlowNode({ id: 'k-onjump', type: 'onanimstate', position: { x: 0, y: 160 }, data: { type: 'onanimstate', state: 'Jump', pulse: 0.3 } }, uuid);
	}, uuid);
	// the graph reaches B by the node sync, not at once: click only when B's RUNTIME runs it (the On
	// Click card reads a value there), else the 1 s pulse is over before B has the nodes
	await h.eventually(
		() =>
			B.page.evaluate((uuid) => {
				const s = window.__stores;
				let v;
				let fg;
				s.flowValues.subscribe((x) => (v = x))();
				s.flowGraphs.subscribe((x) => (fg = x))();
				return v?.['k-click'] !== undefined && (fg?.[uuid]?.edges ?? []).some((e) => e.id === 'e-k');
			}, uuid),
		(ok) => ok,
		'M11: B runs the click graph',
		15000
	);
	await watchStates(A.page, uuid);
	await watchStates(B.page, uuid);
	// on a red: B's view of the click over time (stamp landing vs B's clock, the On Click output, the jump param)
	await B.page.evaluate((uuid) => {
		const s = window.__stores;
		const now = () => +((s.connectionState.sessionNow() % 86400000) / 1000).toFixed(3);
		const log = (window.__clk57 = []);
		let last = null;
		const stop = s.flowTriggers.subscribe((t) => {
			const e = t?.['k-click'];
			if (e && e.lastT !== last) log.push({ got: (last = e.lastT), now: now() });
		});
		const iv = setInterval(() => {
			let v;
			s.flowValues.subscribe((x) => (v = x))();
			const jump = s.animGraphRuntime.animGraphReading(uuid)?.params?.jump;
			if (log.length < 40) log.push({ now: now(), click: v?.['k-click'], jump: Number.isFinite(jump) ? jump : String(jump) });
		}, 100);
		setTimeout(() => (clearInterval(iv), stop()), 3000);
	}, uuid);
	const firedAt = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		s.flowRuntime.fireObjectClick(uuid);
		return (s.connectionState.sessionNow() % 86400000) / 1000;
	}, uuid);
	await A.page.waitForTimeout(600);
	h.check((await seenStates(A.page)).includes('jump'), 'M11: Set Animation Parameter fires the jump trigger on A');
	await h.eventually(() => seenStates(B.page), (l) => l.includes('jump'), 'M11: ...and on B (from the replicated click stamp)');
	// on a red: did B get the click stamp at all? (B reads the pulse as a window on the shared clock)
	console.log('  fired on A at', firedAt, '- B saw:', JSON.stringify(await B.page.evaluate(() => window.__clk57)));
	console.log(
		'  B trigger view:',
		JSON.stringify(
			await B.page.evaluate((uuid) => {
				const s = window.__stores;
				let t;
				let fg;
				let st;
				s.flowTriggers.subscribe((v) => (t = v))();
				s.flowGraphs.subscribe((v) => (fg = v))();
				s.animGraphRuntime.animStates.subscribe((v) => (st = v))();
				return {
					click: t?.['k-click'] ?? null,
					nodes: (fg?.[uuid]?.nodes ?? []).map((n) => n.id),
					edges: (fg?.[uuid]?.edges ?? []).map((e) => e.id),
					jump: st?.[uuid]?.params?.jump ?? null,
					state: st?.[uuid]?.state ?? null
				};
			}, uuid)
		)
	);
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
	console.log('  B heli:', JSON.stringify(await heliState(B.page, heli, res.hash)));
	// A clip message that lands BEFORE its object (still in the receiver's ingest queue — an agent
	// imports a model and animates it at once) is parked and applied when the object arrives.
	// Delivered on B by hand, in that order, so the race is not left to timing.
	const earlyOk = await B.page.evaluate(async (hash) => {
		const s = window.__stores;
		const T = s.THREE;
		const uuid = T.MathUtils.generateUUID();
		await s.commandsHandler.objectParameters({ type: 'objectParameters', parameter: 'clipRefs', uuid, clipRefs: [{ hash, name: 'Spin' }] });
		await s.commandsHandler.objectParameters({ type: 'objectParameters', parameter: 'animation', uuid, clip: 'Spin', playing: true, speed: 1, at: 0 });
		const root = new T.Group();
		root.uuid = uuid;
		root.name = 'Late heli';
		const rotor = new T.Object3D();
		rotor.name = 'rotor';
		root.add(rotor);
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		g.add(root);
		const yaw = () => new T.Euler().setFromQuaternion(rotor.quaternion, 'YXZ').y;
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 250));
			const a = yaw();
			await new Promise((r) => setTimeout(r, 170));
			if (Math.abs(yaw() - a) > 0.2) {
				g.remove(root);
				return true;
			}
		}
		g.remove(root);
		return false;
	}, res.hash);
	h.check(earlyOk, 'M12: clip refs + play that arrive before their object are applied when it lands (B)');
	const clipOnHeli = (page) => page.evaluate((heli) => window.__stores.animatedImports.clipInfo(heli).map((c) => c.name), heli);
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => clipOnHeli(B.page), (l) => !l.includes('Spin'), 'M12: one undo takes the clip off on B');
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => clipOnHeli(B.page), (l) => l.includes('Spin'), 'M12: redo puts it back');

	// ---------- M12: keys on a part in the Animation window -> one clip FILE on the model ----------
	const fromKeys = await A.page.evaluate(async (heli) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const model = g.getObjectByProperty('uuid', heli);
		const body = model.getObjectByName('body');
		const ap = s.animationPreview;
		ap.createClip(body.uuid, 'Bob');
		const track = ap.addTrack(body.uuid, 'pos.y', body);
		ap.updateKey(body.uuid, track, 0, { t: 0, v: 0 });
		ap.updateKey(body.uuid, track, 1, { t: 1, v: 0.5 });
		ap.updateAnim(body.uuid, { duration: 1 });
		const out = await s.clipEdit.partsKeysToClip(heli, 'Bob');
		return { out, clips: s.animatedImports.clipInfo(heli).map((c) => c.name) };
	}, heli);
	h.check(fromKeys.out?.parts === 1, `M12: a part's keys become a node-name clip file on the model (${JSON.stringify(fromKeys.out)})`);
	await h.eventually(() => clipOnHeli(A.page), (l) => l.includes('Bob'), 'M12: ...which the model plays as a clip on A (bound once the file decodes)');
	await h.eventually(() => clipOnHeli(B.page), (l) => l.includes('Bob'), 'M12: ...and reach B as a clip');

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
	await h.eventually(() => circles(A.page), (v) => v, 'M12: the attached box follows the spinning rotor on A', 10000);
	console.log('  A heli:', JSON.stringify(await heliState(A.page, heli, res.hash)), 'box', JSON.stringify(await boxAt(A.page)));
	await h.eventually(() => circles(B.page), (v) => v, 'M12: ...and on B (the attach replicated; each peer follows its own socket)', 15000);
	await A.page.evaluate((box) => window.__stores.animatedImports.attachToSocket(box, null, null), box);
	const s1 = await boxAt(A.page);
	await A.page.waitForTimeout(300);
	const s2 = await boxAt(A.page);
	h.check(s1 && s2 && Math.hypot(s1[0] - s2[0], s1[1] - s2[1]) < 1e-6, 'M12: detached, it stays where it was let go');

	await h.finish(browser);
});
