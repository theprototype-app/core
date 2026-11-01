// mcp-fix (owner's connector test report, app 1.52.0) — through a real tab, against the fake relay.
//   5. a fixed joint holds: static box + spin node, ball made dynamic AFTER the joint, no anchor; a flow-moved body.
//   6. control_simulation: pause / resume while stopped is an error.
//   1. what_can_you_do answers in a real connector tab. 2. the import tools are neither advertised nor reachable.
//   3 + 4. join_session to a session that is not there fails, says so, and status never contradicts itself.
//   9. a script's pose restarts from the base: the warning, the documented form. 10. a Spin stays inside a turn; list_scene
//   and update_objects work on the authored pose.
//   7. a particle node in world space on a turned object: world axes, and pixels that go up. 8. script reach + warnings.
//   s. save_scene saves the open scene.
// Run: APP_URL='https://theprototype.app:5491/' npm run e2e -- connector-fixes
const h = require('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

/** world position of one object @returns {Promise<number[]|null>} */
const worldOf = (peer, id) =>
	peer.page.evaluate((id) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', id);
		if (!o) return null;
		o.updateWorldMatrix(true, false);
		return [o.matrixWorld.elements[12], o.matrixWorld.elements[13], o.matrixWorld.elements[14]];
	}, id);
const gap = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => window.__stores.aiAssistantHidden.set(''));
	const relay = await fakeRelay(A.page);
	await installProvider(A.page);
	await A.page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 15000);
	let seq = 0;
	const call = async (tool, args = {}, scope = 'edit', timeout = 60000) => {
		const id = 'c' + ++seq;
		relay.call(id, tool, args, scope);
		return relay.answer(id, timeout);
	};
	const sim = (action) => call('control_simulation', { action });
	const mk = async (name, primitive, position) => (await call('create_objects', { objects: [{ kind: 'primitive', primitive, name, position }] }))?.result?.created?.[0]?.uuid;
	const wait = (ms) => A.page.waitForTimeout(ms);

	// ---- 1 + 2 ------------------------------------------------------------------------------------------------
	const hello = relay.frames.find((x) => x.f.type === 'hello')?.f;
	h.check(hello?.tools?.includes('what_can_you_do') && hello.tools.includes('save_scene'), `the tab advertises what_can_you_do and save_scene (${hello?.tools?.length} tools)`);
	h.check(!hello?.tools?.includes('import_model') && !hello?.tools?.includes('import_file'), 'the tab does not advertise the import tools');
	const help = await call('what_can_you_do', {}, 'read');
	h.check(help?.type === 'result' && /build/.test(help.result?.say ?? ''), `what_can_you_do answers in a real tab (${JSON.stringify(help).slice(0, 220)})`);
	h.check(help?.result?.can?.includes('save this scene to your library') && !/save/.test(help?.result?.cannot ?? ''), 'it knows about saving');
	h.check(!help?.result?.can?.some((c) => /in-tab|install/.test(c)), 'and nothing about agent-page tools');
	const imp = await call('import_model', { data: 'AAAA' });
	h.check(imp?.type === 'error' && imp.error?.code === 'unknown_tool', `import_model is refused (${JSON.stringify(imp).slice(0, 160)})`);
	const mesh = await call('generate_mesh', { prompt: 'a chair' });
	h.check(mesh?.type === 'error' && mesh.error?.code === 'refused' && /no mesh-generation provider/.test(mesh.error?.message ?? ''), `generate_mesh with no provider says why (${JSON.stringify(mesh).slice(0, 220)})`);

	// ---- 4: alone in its own session --------------------------------------------------------------------------
	const st0 = (await call('status', {}, 'read'))?.result;
	h.check(st0?.joined === true && st0?.waiting === false && st0?.host === null, `alone: joined, not waiting, no host (${JSON.stringify({ j: st0?.joined, w: st0?.waiting, h: st0?.host })})`);
	const meshGap = (st0?.missingTools ?? []).find((m) => m.name === 'generate_mesh');
	h.check(!!meshGap && !/not joined/.test(meshGap.reason), `generate_mesh's gap does not contradict joined (${meshGap?.reason})`);

	// ---- 3: a session that is not there -----------------------------------------------------------------------
	const origin = new URL(A.page.url()).origin;
	const answerJoin = (async () => {
		relay.call('jz', 'join_session', { link: origin + '/#ZZZ99' });
		return relay.answer('jz', 60000);
	})();
	const card = A.page.locator('#confirm-connector-join');
	await card.waitFor({ state: 'visible', timeout: 10000 });
	await wait(1500);
	h.check(!relay.frames.some((x) => x.f.id === 'jz' && x.f.type !== 'call'), 'nothing answers before the person presses Join');
	h.check((await A.page.evaluate(() => { let w; window.__stores.waitingForApproval.subscribe((v) => (w = v))(); return w.length; })) === 0, 'and nothing was dialled');
	await A.page.locator('#confirm-dialog-join').click();
	const midway = [];
	for (let i = 0; i < 6; i++) {
		const s = (await call('status', {}, 'read'))?.result;
		midway.push({ j: s?.joined, w: s?.waiting });
		await wait(150);
	}
	h.check(midway.every((m) => !(m.j && m.w)), `joined and waiting are never both true during the dial (${JSON.stringify(midway)})`);
	const jz = await answerJoin;
	h.check(jz?.type === 'error' && /No session ZZZ99 is online/.test(jz.error?.message ?? ''), `a session that is not there is an error (${JSON.stringify(jz).slice(0, 200)})`);
	const st1 = (await call('status', {}, 'read'))?.result;
	h.check(st1?.lastJoinResult?.state === 'failed' && st1.lastJoinResult.session === 'ZZZ99', `status.lastJoinResult says so (${JSON.stringify(st1?.lastJoinResult)})`);
	h.check(st1?.joined === true && st1?.waiting === false, `the tab is back in its own session, not waiting (${st1?.joined}, ${st1?.waiting})`);

	// ---- s: save_scene ----------------------------------------------------------------------------------------
	const toSave = await mk('SaveMe', 'Box', [0, 1, 6]);
	h.check(!!toSave, 'something to save');
	await A.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set({ myId: 'x', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole() {}, synced: () => true }));
	const asViewer = await call('save_scene', { name: 'connector-fixes-viewer' });
	await A.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));
	h.check(asViewer?.type === 'error' && asViewer.error?.code === 'refused' && /View-only/i.test(asViewer.error.message ?? ''), `a viewer's save is refused with the reason (${JSON.stringify(asViewer).slice(0, 160)})`);
	const saved = await call('save_scene', { name: 'connector-fixes-save' });
	h.check(saved?.type === 'result' && saved.result?.saved === true && saved.result?.name === 'connector-fixes-save', `save_scene saves (${JSON.stringify(saved).slice(0, 200)})`);
	const again = await call('save_scene', {});
	h.check(again?.type === 'error' && /wait a few seconds/.test(again.error?.message ?? ''), `saves are paced (${JSON.stringify(again).slice(0, 160)})`);
	const lookOnly = await call('save_scene', {}, 'read');
	h.check(lookOnly?.type === 'error' && lookOnly.error?.code === 'refused', 'a look-only grant cannot save');
	// an AI's save may not write over another scene: its newest version would become this one, for everyone
	await wait(5500);
	const second = await call('save_scene', { name: 'connector-fixes-other' });
	h.check(second?.result?.saved === true, 'a new name saves');
	await wait(5500);
	const over = await call('save_scene', { name: 'Connector-Fixes-Save' });
	h.check(over?.type === 'error' && /different scene is already called/.test(over.error?.message ?? ''), `a save cannot take another scene's name (${JSON.stringify(over).slice(0, 160)})`);
	await call('delete_objects', { uuids: [toSave] });

	// ---- 5 ----------------------------------------------------------------------------------------------------
	const scenario = async (label, { anchor, spin, dynamicFirst }) => {
		const box = await mk(label + '_Box', 'Box', [0, 3, 0]);
		const ball = await mk(label + '_Ball', 'Sphere', [2.5, 3, 0]);
		await call('set_physics', { updates: [{ uuid: box, mode: 'static' }] });
		if (dynamicFirst) await call('set_physics', { updates: [{ uuid: ball, mode: 'dynamic', mass: 1 }] });
		if (spin) {
			const f = await call('create_flow_nodes', { graph: box, nodes: [{ type: 'spin', data: { speed: 1 } }] });
			h.check(f?.type === 'result' && !f.result?.error, `${label}: spin node (${JSON.stringify(f).slice(0, 120)})`);
		}
		const j = await call('create_joints', { joints: [{ kind: 'fixed', a: box, b: ball, ...(anchor ? { anchor } : {}) }] });
		h.check(j?.type === 'result' && !j.result?.error, `${label}: joint made (${JSON.stringify(j).slice(0, 140)})`);
		if (!dynamicFirst) await call('set_physics', { updates: [{ uuid: ball, mode: 'dynamic', mass: 1 }] });
		await wait(1500);
		const before = await worldOf(A, ball);
		const boxAt = await worldOf(A, box);
		const go = await sim('start');
		h.check(go?.result?.simulating === true, `${label}: sim started`);
		await wait(4000);
		const after = await worldOf(A, ball);
		const liveIds = await A.page.evaluate(() => window.__stores.physics.liveJointIds?.() ?? null);
		await sim('stop');
		await wait(500);
		const dist0 = gap(before, boxAt);
		const dist1 = gap(after, boxAt);
		console.log('MEASURE ' + JSON.stringify({ label, before, after, boxAt, dist0, dist1, liveIds }));
		h.check(Math.abs(dist1 - dist0) < 0.3 && after[1] > 1.5, `${label}: the ball held its distance from the box (${dist0.toFixed(2)} → ${dist1.toFixed(2)}, y ${after[1].toFixed(2)})`);
		await call('delete_objects', { uuids: [box, ball] });
		await wait(300);
	};
	await scenario('static, then dynamic, no anchor', {});
	await scenario('spin, then dynamic, no anchor', { spin: true });
	await scenario('spin, dynamic first, no anchor', { spin: true, dynamicFirst: true });
	await scenario('spin, then dynamic, anchor', { spin: true, anchor: [1, 3, 0] });

	// a joint with no possible body errors at once
	const lamp = (await call('create_objects', { objects: [{ kind: 'light', light: 'point', name: 'Lamp', position: [0, 4, 0] }] }))?.result?.created?.[0]?.uuid;
	const solo = await mk('Solo', 'Box', [4, 3, 0]);
	const noBody = await call('create_joints', { joints: [{ kind: 'fixed', a: lamp, b: solo }] });
	h.check(noBody?.type === 'error' && /cannot hold/.test(noBody.error?.message ?? ''), `a joint to a light is an error (${JSON.stringify(noBody).slice(0, 180)})`);

	// a mode change during a run says when it applies
	await call('set_physics', { updates: [{ uuid: solo, mode: 'dynamic', mass: 1 }] });
	await sim('start');
	const midRun = await call('set_physics', { updates: [{ uuid: solo, mode: 'static' }] });
	h.check(/next start/.test(midRun?.result?.updated?.[0]?.note ?? ''), `set_physics during a run says when it applies (${JSON.stringify(midRun).slice(0, 180)})`);

	// ---- 6 ----------------------------------------------------------------------------------------------------
	const paused = await sim('pause');
	h.check(paused?.result?.simulating === true && paused.result.paused === true, `pause while running (${JSON.stringify(paused).slice(0, 120)})`);
	const resumed = await sim('resume');
	h.check(resumed?.result?.paused === false, 'resume while paused');
	await sim('stop');
	await h.eventually(() => A.page.evaluate(() => new Promise((r) => window.__stores.physics.simulating.subscribe((v) => r(v))())), (x) => x === false, 'stopped', 10000);
	for (const action of ['pause', 'resume']) {
		const r = await sim(action);
		h.check(r?.type === 'error' && /not running/.test(r.error?.message ?? ''), `${action} while stopped is an error (${JSON.stringify(r).slice(0, 180)})`);
	}

	// ---- 7 ----------------------------------------------------------------------------------------------------
	// Where particles really go: the render path's own vertex math is the GPU's, so read the frame from above + the side.
	const emitter = await mk('Emitter', 'Circle', [0, 2, -8]);
	await call('update_objects', { updates: [{ uuid: emitter, rotation: [-Math.PI / 2, 0, 0] }] });
	const fx = await call('create_flow_nodes', { graph: emitter, nodes: [{ type: 'particle', data: { space: 'world', mode: 'continuous', gravity: -2, speed: 2, spread: 5 } }] });
	const nodeId = fx?.result?.created?.[0]?.id;
	h.check(fx?.type === 'result' && !!nodeId, `particle node on a turned Circle (${JSON.stringify(fx).slice(0, 180)})`);
	const entries = () => A.page.evaluate(() => window.__stores.particleRuntime.particleEntries());
	await h.eventually(entries, (e) => e.some((x) => x.uuid === emitter), 'the emitter is live', 15000);
	const e0 = (await entries()).find((e) => e.uuid === emitter) ?? null;
	h.check(e0?.space === 'world' && e0?.aimWorld === 1, `world space through the tool aims with world axes (${JSON.stringify(e0).slice(0, 200)})`);

	await call('delete_objects', { uuids: [emitter] });

	// The pixels: a tight bright cone on a Circle turned -90 about Z, so its local up is the world's +X (sideways on any
	// camera that looks along the ground; turning about X would aim it away from the camera, which perspective shows as up).
	const sparks = async (name, data) => {
		const id = await mk(name, 'Circle', [20, 3, 0]);
		await call('update_objects', { updates: [{ uuid: id, rotation: [0, 0, -Math.PI / 2], scale: [0.05, 0.05, 0.05] }] });
		await call('create_flow_nodes', { graph: id, nodes: [{ type: 'particle', data: { space: 'world', mode: 'continuous', shape: 'cone', angle: 4, radius: 0.01, count: 200, lifetime: 2, size: 0.3, sizeStart: 0.3, sizeEnd: 0.3, drag: 0, turbulence: 0, blending: 'normal', colorStart: '#00ff00', colorEnd: '#00ff00', ...data } }] });
		await wait(5000);
		const shot = await call('screenshot', { view: 'focus', uuid: id, size: 512 });
		const r = await A.page.evaluate(async (b64) => {
			const img = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob());
			const c = new OffscreenCanvas(img.width, img.height).getContext('2d');
			c.drawImage(img, 0, 0);
			const d = c.getImageData(0, 0, img.width, img.height).data;
			let n = 0, sx = 0, sy = 0;
			for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
				const i = (y * img.width + x) * 4;
				if (d[i + 1] > 150 && d[i] < 110 && d[i + 2] < 110) { n++; sx += x; sy += y; }
			}
			return { n, x: n ? sx / n / img.width : null, y: n ? sy / n / img.height : null };
		}, shot?.result?.image?.data ?? '');
		await call('delete_objects', { uuids: [id] });
		await wait(300);
		return r;
	};
	const up = await sparks('AimWorld', { speed: 2, gravity: 0 });
	const away = await sparks('AimEmitter', { speed: 2, gravity: 0, aim: 'emitter' });
	const down = await sparks('Fall', { speed: 0.01, gravity: -2, aim: 'emitter' });
	console.log('MEASURE ' + JSON.stringify({ particles: { up, away, down } }));
	h.check(up.n > 0 && up.y < 0.45 && Math.abs(up.x - 0.5) < 0.1, `aim world: the sparks go straight UP on screen (${JSON.stringify(up)})`);
	h.check(away.n > 0 && Math.abs(away.x - 0.5) > 0.1 && away.y > up.y + 0.05, `aim emitter: they follow the turned object sideways instead (${JSON.stringify(away)})`);
	h.check(down.n > 0 && down.y > 0.55 && Math.abs(down.x - 0.5) < 0.1, `gravity pulls DOWN on screen whatever the emitter's turn (${JSON.stringify(down)})`);

	// ---- 8 ----------------------------------------------------------------------------------------------------
	const scripted = await mk('Scripted', 'Box', [6, 1, 0]);
	const sc = await call('create_flow_nodes', { graph: scripted, nodes: [{ type: 'script', data: { code: 'object.rotation.y = 1.25; object.material.color.setRGB(1, 0, 0); object.material.roughness = 0.11;' } }] });
	h.check(sc?.type === 'result' && !!sc.result?.created?.[0]?.id, `script node made (${JSON.stringify(sc).slice(0, 240)})`);
	const look = () => A.page.evaluate((id) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', id);
		return { ry: o.rotation.y, color: o.material?.color?.getHexString?.(), rough: o.material?.roughness };
	}, scripted);
	for (let i = 0; i < 30 && Math.abs((await look()).ry - 1.25) > 0.01; i++) await wait(1000);
	const seen = await look();
	console.log('MEASURE ' + JSON.stringify({ script: seen, errors: await A.page.evaluate(() => new Promise((r) => window.__stores.scriptErrors.subscribe((v) => r(v))())) }));
	h.check(Math.abs(seen.ry - 1.25) < 0.01, `a script sets object.rotation (${seen.ry})`);
	h.check(seen.color === 'ff0000' && Math.abs(seen.rough - 0.11) < 0.01, `a script sets object.material (${seen.color}, ${seen.rough})`);

	const unwired = await call('create_flow_nodes', { graph: 'scene', nodes: [{ type: 'script', data: { code: 'object.rotation.y = 1;' } }] });
	h.check(/drives nothing/.test(unwired?.result?.warning ?? ''), `a script wired to nothing warns (${JSON.stringify(unwired?.result?.warning).slice(0, 160)})`);
	const replacing = await call('create_flow_nodes', { graph: scripted, nodes: [{ type: 'script', data: { code: 'object.material = null;' } }] });
	h.check(/object\.material cannot be replaced/.test(replacing?.result?.warning ?? ''), 'a script replacing the material warns');
	const failing = await call('create_flow_nodes', { graph: scripted, nodes: [{ type: 'script', data: { code: 'throw new Error("boom");' } }] });
	h.check(!!failing?.result?.created?.[0]?.id, 'a failing script');
	await h.eventually(async () => (await call('status', {}, 'read'))?.result?.scriptErrors ?? [], (r) => r.some((e) => /boom/.test(e.message)), 'status.scriptErrors names the failing script', 30000);

	// ---- 9: a script's pose restarts from the base every frame -------------------------------------------------
	const poseOf = (id) => A.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', uuid);
		return { y: o.position.y, ry: o.rotation.y };
	}, id);
	const listed = async (id) => (await call('list_scene', { name: '*' }, 'read'))?.result?.objects?.find((o) => o.uuid === id);
	const moved = async (id, read, tries = 40) => {
		const first = await read(id);
		for (let i = 0; i < tries; i++) {
			await wait(500);
			const now = await read(id);
			if (JSON.stringify(now) !== JSON.stringify(first)) return { first, now };
		}
		return { first, now: first };
	};
	const stepper = await mk('Stepper', 'Box', [8, 1, 0]);
	const stepping = await call('create_flow_nodes', { graph: stepper, nodes: [{ type: 'script', data: { code: 'object.rotation.y += 0.02;' } }] });
	h.check(/will not build up/.test(stepping?.result?.warning ?? '') && /base\.rot\[1\] \+ time/.test(stepping?.result?.warning ?? ''), `a += script says why it stays put (${JSON.stringify(stepping?.result?.warning).slice(0, 200)})`);
	await h.eventually(() => poseOf(stepper), (p) => Math.abs(p.ry - 0.02) < 0.001, 'a += script lands at base + 0.02', 30000);
	await wait(1500);
	const steps = [];
	for (let i = 0; i < 12; i++) {
		steps.push((await poseOf(stepper)).ry);
		await wait(250);
	}
	h.check(steps.every((ry) => Math.abs(ry - 0.02) < 0.001), `and stays there: this is the behaviour the warning describes (${steps.map((ry) => ry.toFixed(3)).join(' ')})`);
	const turner = await mk('Turner', 'Box', [10, 1, 0]);
	const turning = await call('create_flow_nodes', { graph: turner, nodes: [{ type: 'script', data: { code: 'object.rotation.y = base.rot[1] + time * 2;' } }] });
	h.check(!!turning?.result?.created?.[0]?.id && !turning?.result?.warning, `the documented form does not warn (${JSON.stringify(turning?.result?.warning)})`);
	const turned = await moved(turner, poseOf);
	h.check(turned.now.ry !== turned.first.ry, `the documented form keeps turning (${turned.first.ry} -> ${turned.now.ry})`);
	const docs = await call('describe_node_types', { types: ['script'] }, 'read');
	h.check(/base\.rot\[1\] \+ time \* speed/.test(JSON.stringify(docs?.result ?? '')), 'describe_node_types gives the form');
	const scriptErrs = await A.page.evaluate(() => new Promise((r) => window.__stores.scriptErrors.subscribe((v) => r(v))()));
	h.check(!scriptErrs[turning?.result?.created?.[0]?.id], `the documented form runs without an error (${JSON.stringify(scriptErrs).slice(0, 160)})`);

	// ---- 10: a Spin stays inside a turn; list_scene and update_objects work on the authored pose ----------------
	const spinner = await mk('Spinner', 'Box', [12, 2, 0]);
	await call('update_objects', { updates: [{ uuid: spinner, rotation: [0, 0.5, 0] }] });
	await call('create_flow_nodes', { graph: spinner, nodes: [{ type: 'spin', data: { axis: 'y', speed: 40 } }] });
	const spun = await moved(spinner, poseOf);
	h.check(spun.now.ry !== spun.first.ry, `the spin runs (${spun.first.ry} -> ${spun.now.ry})`);
	let widest = 0;
	for (let i = 0; i < 10; i++) {
		widest = Math.max(widest, Math.abs((await poseOf(spinner)).ry - 0.5));
		await wait(150);
	}
	console.log('MEASURE ' + JSON.stringify({ spinWidest: widest }));
	h.check(widest < Math.PI * 2, `the angle a spin adds stays inside one turn (${widest})`);
	const spinRow = await listed(spinner);
	h.check(spinRow?.animated === true && spinRow.rotation[1] === 0.5, `list_scene gives a spinning object's authored rotation (${JSON.stringify(spinRow?.rotation)}, animated ${spinRow?.animated})`);
	h.check(typeof spinRow?.live?.rotation?.[1] === 'number', `and this frame beside it (${JSON.stringify(spinRow?.live?.rotation)})`);

	const bouncer = await mk('Bouncer', 'Box', [14, 3, 0]);
	const bounceMade = await call('create_flow_nodes', { graph: bouncer, nodes: [{ type: 'bounce', data: { amplitude: 1, speed: 3 } }] });
	const bounceId = bounceMade?.result?.created?.[0]?.id;
	const bounced = await moved(bouncer, poseOf);
	h.check(bounced.now.y !== bounced.first.y, `the bounce runs (${bounced.first.y} -> ${bounced.now.y})`);
	await h.eventually(() => poseOf(bouncer), (p) => Math.abs(p.y - 3) > 0.05, 'caught off its base', 30000);
	const rotated = await call('update_objects', { updates: [{ uuid: bouncer, rotation: [0, 1, 0] }] });
	h.check(rotated?.type === 'result' && !rotated.result?.error, 'a rotation-only update of a bouncing object');
	const bounceRow = await listed(bouncer);
	h.check(bounceRow?.position?.[1] === 3 && bounceRow.rotation[1] === 1, `it keeps its authored height: nothing baked (${JSON.stringify(bounceRow?.position)}, ${JSON.stringify(bounceRow?.rotation)})`);
	const placed = await call('update_objects', { updates: [{ uuid: bouncer, position: [14, 5, 0] }] });
	h.check(placed?.type === 'result', 'a position update of a bouncing object');
	h.check((await listed(bouncer))?.position?.[1] === 5, 'it lands in the authored pose');
	await h.eventually(() => poseOf(bouncer), (p) => Math.abs(p.y - 5) <= 1.01 && Math.abs(p.y - 5) > 0.05, 'and the bounce carries on around it', 30000);
	await call('update_flow_nodes', { graph: bouncer, remove: [bounceId] });
	await h.eventually(() => poseOf(bouncer), (p) => p.y === 5 && p.ry === 1, 'with the effect gone it stands exactly at the authored pose', 30000);
	h.check((await listed(bouncer))?.animated === undefined, 'and no longer reads as animated');

	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).slice(0, 3)})`);
	await h.finish(browser);
});
