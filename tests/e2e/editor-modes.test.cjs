// 30 P1 — EDIT and INTERACT, and P4 — api.pointerRay under a pointer lock.
//
// The user's report: "interact with objects" and "edit mesh/transform" were one mode, so
// some objects could not be moved or even SELECTED — the music modules' click handlers
// consumed every editor click on a piano, a drum machine or a sampler (measured on the
// Jam Room: never selectable). Now the editor has two modes, LOCAL per peer:
//   EDIT (default)  a click SELECTS; a module click handler runs only if it asked for
//                   {modes: ['edit']}; On Click nodes do not fire.
//   INTERACT        a click reaches module handlers + On Click nodes (+ a grab on a
//                   dynamic body while a sim runs); nothing is selected, no gizmo.
// Play is unchanged (play-interact is held).
//
// Every viewport click here is a REAL mouse click on a pixel verified to land on the
// intended mesh through the app's own pick (the premise checks), so no check can pass on
// a click that hit empty space.

const h = require('./helpers.cjs');

const read = (page, name) =>
	page.evaluate((n) => {
		let v;
		window.__stores[n].subscribe((x) => (v = x))();
		return v;
	}, name);
const mode = (page) => read(page, 'editorMode');
const selection = (page) => read(page, 'selectedObjects');

/** screen pixel over an object (its bounds centre, or a named descendant's), plus what
 * the app's OWN pick resolves at that pixel */
function aimAt(page, target) {
	return page.evaluate((t) => {
		const s = window.__stores;
		const THREE = s.THREE;
		let group, camera, renderer;
		s.objectsGroup.subscribe((v) => (group = v))();
		s.globalCamera.subscribe((v) => (camera = v))();
		s.globalRenderer.subscribe((v) => (renderer = v))();
		const object = t.uuid ? group.getObjectByProperty('uuid', t.uuid) : group.getObjectByName(t.name);
		if (!object) return null;
		object.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(object);
		const centre = box.getCenter(new THREE.Vector3());
		if (t.top) centre.y = box.max.y - 0.002;
		const rect = renderer.domElement.getBoundingClientRect();
		const v = centre.clone().project(camera);
		const x = rect.left + ((v.x + 1) / 2) * rect.width;
		const y = rect.top + ((1 - v.y) / 2) * rect.height;
		const ray = new THREE.Raycaster();
		ray.setFromCamera(new THREE.Vector2(v.x, v.y), camera);
		const hits = s.scenePick.sceneHits(ray);
		const under = document.elementFromPoint(x, y);
		return {
			x,
			y,
			uuid: object.uuid,
			first: hits[0]?.object?.name ?? null,
			firstUuid: hits[0]?.object?.uuid ?? null,
			hitsTarget: !!hits[0] && (hits[0].object === object || object.getObjectByProperty('uuid', hits[0].object.uuid) != null),
			onCanvas: under === renderer.domElement
		};
	}, target);
}

/** wrap the peer's send so a suite can see what left the machine */
async function spySends(page) {
	await page.evaluate(() => {
		let p;
		window.__stores.peers.subscribe((v) => (p = v))();
		if (p.__spied) return;
		const real = p.send.bind(p);
		window.__sent = [];
		p.send = (msg) => {
			window.__sent.push(msg?.type);
			return real(msg);
		};
		p.__spied = true;
	});
}
const sent = (page) => page.evaluate(() => window.__sent.slice());

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const page = A.page;
	await h.connect(A, B);
	await spySends(page);

	// ---------------------------------------------------------------- 1
	console.log('\n=== 1. the toggle, the key, the registry row ===');
	h.check((await mode(page)) === 'edit', '1.1 the editor starts in EDIT');
	const cell = page.locator('#editor-mode-toggle');
	h.check((await cell.count()) === 1, '1.2 the Controls bar has the mode toggle');
	h.check((await cell.getAttribute('aria-pressed')) === 'false', '1.3 ...not pressed in Edit');
	const title = (await cell.getAttribute('title')) ?? '';
	h.check(/\(I\)/.test(title), `1.4 ...and its tooltip names the key (${title})`);
	await cell.click();
	await page.waitForTimeout(200);
	h.check((await mode(page)) === 'interact', '1.5 clicking it switches to INTERACT');
	h.check((await cell.getAttribute('aria-pressed')) === 'true', '1.6 ...and it reads pressed');
	await page.mouse.move(5, 400);
	await page.evaluate(() => document.activeElement?.blur?.());
	await page.keyboard.press('i');
	await page.waitForTimeout(200);
	h.check((await mode(page)) === 'edit', '1.7 I switches back to EDIT');
	const row = await page.evaluate(() =>
		window.__stores.shortcutsRegistry.shortcuts.find((s) => s.id === 'editor.interact-mode')
	);
	h.check(row?.keys === 'I', `1.8 the shortcut registry lists it (${row?.keys} · ${row?.label})`);
	await page.locator('#object-search').evaluate((el) => {
		// the object list may be closed: the key test only needs a focused text field
		el.focus();
	}).catch(() => {});
	const typed = await page.evaluate(() => {
		const input = document.createElement('input');
		input.id = 'em-probe';
		document.body.appendChild(input);
		input.focus();
		return document.activeElement === input;
	});
	await page.keyboard.press('i');
	await page.waitForTimeout(150);
	h.check(typed && (await mode(page)) === 'edit', '1.9 I typed into a text field does not toggle');
	await page.evaluate(() => document.getElementById('em-probe')?.remove());

	// ---------------------------------------------------------------- fixtures
	const box = await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const o = group.children[group.children.length - 1];
		o.name = 'Target';
		o.position.set(2.5, 0.5, 0);
		delete o.userData.physics;
		o.updateMatrixWorld();
		s.objectsGroup.update((v) => v);
		return o.uuid;
	});
	await page.waitForTimeout(800);
	await page.evaluate((uuid) => {
		// re-seat after /create's own re-seat (the documented trap)
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group.getObjectByProperty('uuid', uuid);
		o.position.set(2.5, 0.5, 0);
		delete o.userData.physics;
		o.updateMatrixWorld();
		window.__stores.objectActions.deselectObject();
	}, box);

	// ---------------------------------------------------------------- 2
	console.log('\n=== 2. a module click handler: edit-only vs the default ===');
	await page.evaluate(async () => {
		window.__emCalls = { edit: 0, dflt: 0 };
		await window.__stores.moduleSDK.initModules([
			{
				id: 'emtest',
				name: 'Editor modes test',
				version: '1.0.0',
				description: 'click handlers with and without {modes}',
				register(api) {
					api.registerClickHandler((o) => {
						if (o?.name === 'Target') window.__emCalls.edit++;
						return false;
					}, { modes: ['edit'] });
					api.registerClickHandler((o) => {
						if (o?.name === 'Target') window.__emCalls.dflt++;
						return false;
					});
				}
			}
		]);
	});
	let aim = await aimAt(page, { uuid: box });
	h.check(aim?.hitsTarget && aim.onCanvas, `2.1 (premise) the pixel lands on the Target through the app's pick (${aim?.first})`);
	await page.mouse.click(aim.x, aim.y);
	await page.waitForTimeout(400);
	let calls = await page.evaluate(() => ({ ...window.__emCalls }));
	h.check(calls.edit === 1, `2.2 in EDIT a handler registered {modes:['edit']} runs (${calls.edit})`);
	h.check(calls.dflt === 0, `2.3 ...and a handler with no {modes} does NOT (${calls.dflt})`);
	h.check((await selection(page)).includes(box), '2.4 ...and the click selected the Target');
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(1700); // out of the double-click AND the cycle window
	await page.mouse.click(aim.x, aim.y);
	await page.waitForTimeout(400);
	calls = await page.evaluate(() => ({ ...window.__emCalls }));
	h.check(calls.dflt === 1, `2.5 in INTERACT the default handler runs (${calls.dflt})`);
	h.check(calls.edit === 1, `2.6 ...and the edit-only one does not (${calls.edit})`);
	h.check((await selection(page)).length === 0, '2.7 ...and nothing is selected');

	// ---------------------------------------------------------------- 3
	console.log('\n=== 3. an On Click node fires only in INTERACT (and replicates) ===');
	await page.evaluate((uuid) => {
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 'emclick', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } },
			{ id: 'emsel', type: 'objectselector', position: { x: 240, y: 0 }, data: { type: 'objectselector', label: 'Object Selector', selected: uuid } }
		]);
		s.flowEdges.set([{ id: 'e-emclick-emsel', source: 'emclick', target: 'emsel' }]);
	}, box);
	await page.waitForTimeout(900);
	await page.evaluate((peerId) => window.__stores.nodesHandler.sendNodes(peerId), B.id);
	await h.eventually(
		() => read(B.page, 'flowNodes'),
		(nodes) => nodes.some((n) => n.id === 'emclick'),
		'3.1 (premise) the peer holds the On Click graph'
	);
	await page.waitForTimeout(700); // the actionSeenAt settle (a peer's first tick)
	const stamp = (p) => p.page.evaluate(() => {
		let t;
		window.__stores.flowTriggers.subscribe((v) => (t = v))();
		return t?.emclick?.lastT ?? null;
	});
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await page.waitForTimeout(1700);
	const beforeEdit = await stamp(A);
	await page.mouse.click(aim.x, aim.y);
	await page.waitForTimeout(700);
	h.check((await stamp(A)) === beforeEdit, `3.2 an EDIT click does not fire the On Click node (${await stamp(A)})`);
	h.check((await selection(page)).includes(box), '3.3 ...it selects instead');
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await page.waitForTimeout(1700);
	await page.mouse.click(aim.x, aim.y);
	await page.waitForTimeout(500);
	const fired = await stamp(A);
	h.check(fired !== null && fired !== beforeEdit, `3.4 an INTERACT click fires it (${fired})`);
	await h.eventually(() => stamp(B), (t) => t !== null && Math.abs(t - fired) < 1e-6, '3.5 ...and the pulse reaches the peer');

	// ---------------------------------------------------------------- 4
	console.log('\n=== 4. entering INTERACT puts the gizmo away; EDIT brings it back ===');
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid), box);
	await page.waitForTimeout(300);
	const gizmoOn = await page.evaluate(() => {
		let c;
		window.__stores.TControls.subscribe((v) => (c = v))();
		return !!c?.object;
	});
	h.check(gizmoOn, '4.1 (premise) a selected object carries the gizmo in EDIT');
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	await page.waitForTimeout(200);
	const gizmoOff = await page.evaluate(() => {
		let c;
		window.__stores.TControls.subscribe((v) => (c = v))();
		return !!c?.object;
	});
	h.check(!gizmoOff, '4.2 INTERACT detaches it');
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
	await page.waitForTimeout(200);
	const gizmoBack = await page.evaluate(() => {
		let c;
		window.__stores.TControls.subscribe((v) => (c = v))();
		return !!c?.object;
	});
	h.check(gizmoBack, '4.3 ...and EDIT re-seats it on the selection');

	// ---------------------------------------------------------------- 5
	console.log('\n=== 5. the music-lab piano: EDIT selects it, INTERACT plays it ===');
	const installed = await h.installModule(A, 'music-lab');
	if (!installed) {
		console.log('SKIP music-lab zip not found at ' + h.moduleZipPath('music-lab'));
	} else {
		await page.evaluate(() => {
			const item = window.__stores.moduleSDK.moduleMenuItems;
			let list;
			item.subscribe((v) => (list = v))();
			list.find((m) => m.label === 'Music Lab: piano + speaker').action();
		});
		await h.eventually(
			() => page.evaluate(() => {
				let group;
				window.__stores.objectsGroup.subscribe((v) => (group = v))();
				return !!group.getObjectByName('key-60');
			}),
			(v) => v,
			'5.1 (premise) the piano is built, keys and all'
		);
		const piano = await page.evaluate(() => {
			let group;
			window.__stores.objectsGroup.subscribe((v) => (group = v))();
			let node = group.getObjectByName('key-60');
			while (node.parent && node.parent !== group) node = node.parent;
			window.__stores.objectActions.focusObject(node.uuid);
			return node.uuid;
		});
		await page.waitForTimeout(900);
		await page.evaluate(() => window.__stores.objectActions.deselectObject());
		aim = await aimAt(page, { name: 'key-60', top: true });
		h.check(aim?.first?.startsWith('key-') && aim.onCanvas, `5.2 (premise) the pixel lands on a piano KEY (${aim?.first})`);
		await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));
		await page.evaluate(() => (window.__sent.length = 0));
		await page.mouse.click(aim.x, aim.y);
		await page.waitForTimeout(500);
		let out = await sent(page);
		h.check((await selection(page)).includes(piano), '5.3 in EDIT a click on a piano key SELECTS the piano');
		h.check(!out.includes('devicenote'), `5.4 ...and plays nothing (${out.filter((t) => t === 'devicenote').length} notes)`);
		await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
		await page.evaluate(() => window.__stores.objectActions.deselectObject());
		await page.waitForTimeout(1700);
		await page.evaluate(() => (window.__sent.length = 0));
		await page.mouse.click(aim.x, aim.y);
		await page.waitForTimeout(500);
		out = await sent(page);
		h.check(out.includes('devicenote'), `5.5 in INTERACT the same click plays a note (${out.filter((t) => t === 'devicenote').length})`);
		h.check((await selection(page)).length === 0, '5.6 ...and selects nothing');
	}

	// ---------------------------------------------------------------- 6
	console.log('\n=== 6. INTERACT grabs a dynamic body with the CURSOR while a sim runs ===');
	await page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
	await page.waitForTimeout(2500);
	const crate = await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const o = group.children[group.children.length - 1];
		o.name = 'Crate';
		return o.uuid;
	});
	await page.waitForTimeout(800);
	await page.evaluate((uuid) => {
		const s = window.__stores;
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const o = group.getObjectByProperty('uuid', uuid);
		o.position.set(-2, 0.5, 1);
		o.userData.physics = { mode: 'dynamic', mass: 1 };
		o.updateMatrixWorld();
		s.scenePhysics.setScenePhysics({ ground: { enabled: true, height: 0 } });
		s.objectActions.deselectObject();
		s.objectActions.focusObject(uuid);
	}, crate);
	await page.waitForTimeout(900);
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(() => page.evaluate(() => window.__stores.physics.physicsDebug().length), (n) => n > 0, '6.1 (premise) the simulation runs');
	await page.waitForTimeout(800);
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('interact'));
	aim = await aimAt(page, { uuid: crate });
	h.check(aim?.hitsTarget && aim.onCanvas, `6.2 (premise) the pixel lands on the crate (${aim?.first})`);
	const camBefore = await page.evaluate(() => {
		let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		return c.position.toArray();
	});
	const start = await page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return group.getObjectByProperty('uuid', uuid).position.toArray();
	}, crate);
	await page.mouse.move(aim.x, aim.y);
	await page.mouse.down();
	await page.waitForTimeout(250);
	const dbg = await page.evaluate(() => window.__stores.playInteract.playInteractDebug());
	h.check(dbg.carrying === crate, `6.3 pressing on the crate GRABS it (${dbg.carrying})`);
	for (let i = 1; i <= 12; i++) {
		await page.mouse.move(aim.x + i * 12, aim.y - i * 8);
		await page.waitForTimeout(40);
	}
	await page.waitForTimeout(700);
	const carried = await page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return group.getObjectByProperty('uuid', uuid).position.toArray();
	}, crate);
	await page.mouse.up();
	await page.waitForTimeout(300);
	const moved = Math.hypot(carried[0] - start[0], carried[1] - start[1], carried[2] - start[2]);
	h.check(moved > 0.3, `6.4 ...and it follows the CURSOR (moved ${moved.toFixed(2)} m)`);
	h.check(carried[1] > start[1] + 0.1, `6.5 ...up the screen means up in the world (${start[1].toFixed(2)} -> ${carried[1].toFixed(2)})`);
	const camAfter = await page.evaluate(() => {
		let c;
		window.__stores.globalCamera.subscribe((v) => (c = v))();
		return c.position.toArray();
	});
	const camMoved = Math.hypot(camAfter[0] - camBefore[0], camAfter[1] - camBefore[1], camAfter[2] - camBefore[2]);
	h.check(camMoved < 0.05, `6.6 the drag carried the crate and did NOT orbit the camera (${camMoved.toFixed(3)})`);
	const after = await page.evaluate(() => window.__stores.playInteract.playInteractDebug());
	h.check(after.carrying === null, '6.7 releasing lets go');
	h.check((await selection(page)).length === 0, '6.8 ...and nothing was selected');
	const orbitOn = await page.evaluate(() => {
		let oc;
		window.__stores.orbitControls.subscribe((v) => (oc = v))();
		return oc?.enabled;
	});
	h.check(orbitOn === true, '6.9 the camera controls are back after the carry');
	await page.evaluate(() => window.__stores.physics.stopSimulation());
	await page.evaluate(() => window.__stores.objectActions.setEditorMode('edit'));

	h.check(h.pageErrors(A).filter((m) => /setPointerCapture/.test(m)).length === 0, 'no pointer-capture errors in the run');
	await h.finish(browser);
});
