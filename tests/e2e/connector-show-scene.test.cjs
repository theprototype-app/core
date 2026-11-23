// 104 C2 + C3 — `show` and `scene` through a real connector tab, against the fake relay.
//   show 1. the first panel call asks (Always / This time / No); This time opens the Explorer, a line with Back, back closes it
//        2. rule 2: Settings / Sign in / Publish are refused without asking
//        3. camera: Always is stored on this device; frame moves the view; a second move inside 2 s waits;
//           refused in a headset, while the person types, while they play
//        4. code: opens a file at a line with lines 2..3 selected; find selects the match
//        5. No: refused for the rest of the page; rule 7's 6 a minute
//   scene 6. list: the scenes + which is open + unsaved
//         7. unsaved + nothing said -> the person's dialog; Cancel = nothing changed (counterfactual for the guard)
//         8. unsaved: "save" -> no dialog, saved through the normal save path, opened; the connector still answers,
//            list_scene sees the new scene, undo_last has nothing from before the switch
//         9. new: makes and opens an empty scene; a taken name is refused
//        10. a guest and a viewer are refused; list still reads
//        11. hosting with someone connected: the dialog shows even with unsaved: "discard"
// Run: APP_URL='https://theprototype.app:7176/' npm run e2e -- connector-show-scene
const h = require('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.evaluate(() => window.__tp.test.v1.aiAssistantHidden.set(''));
	const relay = await fakeRelay(page);
	await installProvider(page);
	await page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 15000);
	let seq = 0;
	const call = async (tool, args = {}, scope = 'edit', timeout = 60000) => {
		const id = 's' + ++seq;
		relay.call(id, tool, args, scope);
		return relay.answer(id, timeout);
	};
	const short = (x) => JSON.stringify(x).slice(0, 280);
	const press = async (label) => {
		const btn = page.locator('button', { hasText: new RegExp('^\\s*' + label + '\\s*$') }).last();
		if (await btn.isVisible().catch(() => false)) {
			await btn.click();
			return 'clicked';
		}
		return (await page.evaluate((l) => window.__tp.test.v1.personAsk.answerNewestAsk(l), label)) ? 'hook' : 'none';
	};
	/** ask, answer with `label`, return the answer of the confirmed call */
	const asked = async (tool, args, label) => {
		const first = await call(tool, args);
		if (!first?.result?.needsConfirm) return { first, final: first };
		await press(label);
		const final = await call(tool, { ...args, confirmId: first.result.confirmId, wait: 10 });
		return { first, final };
	};
	const toasts = () => page.evaluate(() => { let t = []; window.__tp.test.v1.toastStore.subscribe((v) => (t = v))(); return t.map((e) => (typeof e === 'string' ? e : e.text)); });
	const where = (key) => page.evaluate((k) => window.__tp.test.v1.dockMenu.windowWhere(k), key);
	const camPos = () => page.evaluate(() => { let c; window.__tp.test.v1.globalCamera.subscribe((v) => (c = v))(); return c ? c.position.toArray().map((n) => +n.toFixed(2)) : null; });
	const reset = () => page.evaluate(() => window.__tp.test.v1.showTool.showToolResetForTest());

	const hello = relay.frames.find((x) => x.f.type === 'hello')?.f;
	h.check(['files', 'show', 'scene'].every((n) => hello?.tools?.includes(n)), 'the connector tab advertises files, show and scene');

	// ---- 1 ----------------------------------------------------------------------------------------------------
	await page.evaluate(() => { const s = window.__tp.test.v1; s.explorerClose?.set?.(true); for (const k of ['panel', 'camera', 'code']) s.safeStorage.removeItem('show:allow:' + k); });
	await h.eventually(() => where('explorer'), (w) => w === null, 'Explorer closed to start', 5000);
	const p1 = await call('show', { action: 'panel', name: 'Explorer' });
	h.check(p1?.result?.needsConfirm === true && /Always \/ This time \/ No/.test(p1.result.note ?? ''), `the first panel call asks (${short(p1)})`);
	h.check((await where('explorer')) === null, 'nothing opened while it asks');
	await press('This time');
	const p1b = await call('show', { action: 'panel', name: 'Explorer', confirmId: p1?.result?.confirmId, wait: 10 });
	h.check(p1b?.result?.panel === 'Explorer' && p1b.result.changed === true, `This time: the Explorer opens (${short(p1b)})`);
	await h.eventually(() => where('explorer'), (w) => w !== null, 'the Explorer is open', 5000);
	h.check((await toasts()).some((t) => /^Claude opened Explorer\./.test(t)), 'the person sees "Claude opened Explorer." with Back');
	const p2 = await call('show', { action: 'panel', name: 'Explorer', state: 'close' });
	h.check(p2?.result?.state === 'closed', `asked once per kind: the next panel call runs (${short(p2)})`);
	const bk = await call('show', { action: 'back' });
	h.check(bk?.result?.back === true, `back undoes the close (${short(bk)})`);
	await h.eventually(() => where('explorer'), (w) => w !== null, 'the Explorer is back', 5000);
	h.check((await page.evaluate(() => window.__tp.test.v1.safeStorage.getItem('show:allow:panel'))) !== 'always', '"This time" is not stored on the device');

	// ---- 2 ----------------------------------------------------------------------------------------------------
	for (const name of ['Settings', 'Sign in', 'Publish', 'Connected apps']) {
		const r = await call('show', { action: 'panel', name });
		h.check(r?.type === 'error' && /not something show opens/.test(r.error?.message ?? ''), `rule 2: "${name}" is refused without asking (${short(r)})`);
	}

	// ---- 3 ----------------------------------------------------------------------------------------------------
	await reset();
	const made = await call('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Far box', position: [30, 0, -30] }] });
	const boxId = made?.result?.created?.[0]?.uuid;
	h.check(!!boxId, `a box to look at (${short(made)})`);
	const before = await camPos();
	const c1 = await asked('show', { action: 'camera', frame: [boxId] }, 'Always');
	h.check(c1.first?.result?.needsConfirm === true, 'the first camera call asks');
	h.check(c1.final?.result?.moved === true, `Always: the view frames the box (${short(c1.final)})`);
	// straight after the first move (any check in between can pass 2 s on a slow slot)
	const c2 = await call('show', { action: 'camera', position: [5, 5, 5], target: [0, 0, 0] });
	await page.waitForTimeout(900);
	const after = await camPos();
	h.check(before && after && Math.hypot(after[0] - before[0], after[2] - before[2]) > 5, `the camera moved (${before} -> ${after})`);
	h.check((await page.evaluate(() => window.__tp.test.v1.safeStorage.getItem('show:allow:camera'))) === 'always', 'Always is stored on this device');
	h.check(c2?.type === 'error' && /one camera move at a time/.test(c2.error?.message ?? ''), `a second move inside 2 s waits (${short(c2)})`);
	await page.waitForTimeout(2100);
	await page.evaluate(() => window.__tp.test.v1.isVRMode.set(true));
	const vr = await call('show', { action: 'camera', position: [5, 5, 5], target: [0, 0, 0] });
	await page.evaluate(() => window.__tp.test.v1.isVRMode.set(false));
	h.check(vr?.type === 'error' && /VR headset/.test(vr.error?.message ?? ''), `no camera move in a headset (${short(vr)})`);
	await page.evaluate(() => { const i = document.createElement('input'); i.id = 'show-e2e-typing'; i.type = 'text'; document.body.appendChild(i); i.focus(); });
	await page.keyboard.type('ab');
	const typing = await call('show', { action: 'camera', position: [5, 5, 5], target: [0, 0, 0] });
	await page.evaluate(() => document.getElementById('show-e2e-typing')?.remove());
	h.check(typing?.type === 'error' && /typing/.test(typing.error?.message ?? ''), `refused while the person types (${short(typing)})`);
	await page.waitForTimeout(3100);
	const c3 = await call('show', { action: 'camera', position: [6, 4, 6], target: [0, 0, 0] });
	h.check(c3?.result?.moved === true, `counterfactual: with nobody typing and 2 s passed, the same move runs (${short(c3)})`);

	// ---- 4 ----------------------------------------------------------------------------------------------------
	await reset();
	await call('files', { action: 'create', path: 'Scripts/door.js', text: 'let a = 1;\nfunction open() {\n  door.open();\n}' });
	const k1 = await asked('show', { action: 'code', path: 'Scripts/door.js', line: 2, to: 3 }, 'This time');
	h.check(k1.final?.result?.opened === 'door.js' && k1.final.result.line === 2, `code: door.js opens at line 2 (${short(k1.final)})`);
	h.check(JSON.stringify(k1.final?.result?.selected) === JSON.stringify({ from: [2, 0], to: [3, 14] }), `lines 2..3 are selected (${JSON.stringify(k1.final?.result?.selected)})`);
	const rev = await page.evaluate(() => { let r; window.__tp.test.v1.codeWorkspace.codeRevealLine.subscribe((v) => (r = v))(); return r; });
	h.check(rev?.line === 2 && rev?.select?.to?.[0] === 3, `the editor got the range (${JSON.stringify(rev)})`);
	const k2 = await call('show', { action: 'code', path: 'door.js', find: 'door.open' });
	h.check(JSON.stringify(k2?.result?.selected) === JSON.stringify({ from: [3, 2], to: [3, 11] }), `find selects the match (${short(k2)})`);
	const k3 = await call('show', { action: 'code', path: 'door.js', text: 'x' });
	h.check(k3?.type === 'result' && !k3.result?.written, `show has no way to write text (an extra argument does nothing) (${short(k3)})`);
	const focused = await page.evaluate(() => !!document.activeElement?.closest?.('.cm-editor'));
	await page.evaluate(() => window.__tp.test.v1.safeStorage.setItem('show:allow:panel', 'always'));
	const k4 = await call('show', { action: 'panel', name: 'Explorer', state: 'open' });
	await page.evaluate(() => window.__tp.test.v1.safeStorage.removeItem('show:allow:panel'));
	h.check(k4?.type === 'result' && !k4.result?.needsConfirm, `an editor show opened is not typing: the next show runs (focused ${focused}, ${short(k4)})`);

	// ---- 5 ----------------------------------------------------------------------------------------------------
	await reset();
	await page.evaluate(() => window.__tp.test.v1.safeStorage.removeItem('show:allow:camera'));
	const no = await asked('show', { action: 'camera', position: [5, 5, 5], target: [0, 0, 0] }, 'No');
	h.check(no.final?.result?.cancelled === true, `No: nothing moves (${short(no.final)})`);
	const no2 = await call('show', { action: 'camera', position: [5, 5, 5], target: [0, 0, 0] });
	h.check(no2?.type === 'error' && /said no/.test(no2.error?.message ?? ''), `after No it is refused without asking again (${short(no2)})`);
	await reset();
	await page.evaluate(() => window.__tp.test.v1.safeStorage.setItem('show:allow:panel', 'always'));
	let paced = 0;
	let lastPaced;
	for (let i = 0; i < 7; i++) {
		const r = await call('show', { action: 'panel', name: 'Objects', state: i % 2 ? 'close' : 'open' });
		lastPaced = r;
		if (r?.type === 'error' && /6 a minute/.test(r.error?.message ?? '')) paced = i + 1;
	}
	h.check(paced === 7, `rule 7: the 7th call in a minute waits (${paced}${paced ? '' : ', last: ' + short(lastPaced)})`);
	await page.evaluate(() => window.__tp.test.v1.safeStorage.removeItem('show:allow:panel'));

	// ---- 6 ----------------------------------------------------------------------------------------------------
	await page.evaluate(async () => {
		const L = window.__tp.test.v1.levels;
		await L.saveSceneAsLevel('Island', null);
		await L.newLevel('Harbour', null);
	});
	const ls = await call('scene', { action: 'list' }, 'read');
	h.check(ls?.result?.current?.name === 'Island' && ls.result.scenes?.some((s) => s.name === 'Harbour') && ls.result.scenes?.find((s) => s.name === 'Island')?.open === true, `list: Island open, Harbour there (${short(ls)})`);
	const roOpen = await call('scene', { action: 'open', name: 'Harbour' }, 'read');
	h.check(roOpen?.type === 'error' && roOpen.error?.code === 'refused', 'a look-only grant cannot open a scene');

	// ---- 7 ----------------------------------------------------------------------------------------------------
	await call('create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'Unsaved ball', position: [0, 1, 0] }] });
	h.check((await call('scene', { action: 'list' }))?.result?.current?.unsaved === true, 'Island has unsaved changes now');
	const o1 = await call('scene', { action: 'open', name: 'Harbour' });
	h.check(o1?.result?.needsConfirm === true && /Save and open \/ Open without saving \/ Cancel/.test(o1.result.note ?? ''), `nothing said: the person is asked (${short(o1)})`);
	await press('Cancel');
	const o1b = await call('scene', { action: 'open', name: 'Harbour', confirmId: o1?.result?.confirmId, wait: 10 });
	h.check(o1b?.result?.cancelled === true, `Cancel: cancelled (${short(o1b)})`);
	h.check((await call('scene', { action: 'list' }))?.result?.current?.name === 'Island', 'still in Island, ball and all');

	// ---- 8 ----------------------------------------------------------------------------------------------------
	const o2 = await call('scene', { action: 'open', name: 'Harbour', unsaved: 'save' });
	h.check(o2?.result?.opened === 'Harbour' && o2.result.saved === 'Island', `unsaved: "save" opens with no dialog and says what it saved (${short(o2)})`);
	h.check(/list_scene/.test(o2?.result?.note ?? ''), 'the answer says to call list_scene again');
	h.check((await toasts()).some((t) => /^Claude saved Island and opened Harbour\./.test(t)), 'the person sees "Claude saved Island and opened Harbour." with Back');
	const st = await call('status', {}, 'read');
	h.check(st?.type === 'result', `the connector survives the switch: status answers (${short(st).slice(0, 120)})`);
	const lsc = await call('list_scene', {}, 'read');
	h.check(!JSON.stringify(lsc?.result ?? {}).includes('Unsaved ball'), 'list_scene sees Harbour, not Island');
	const un = await call('undo_last', {});
	h.check(/nothing of yours left/i.test(JSON.stringify(un)), `undo_last ends at the switch (${short(un)})`);
	await page.evaluate(() => window.__tp.test.v1.sceneTool.sceneToolResetForTest());
	const isl = await page.evaluate(() => window.__tp.test.v1.projectManifest.manifestSceneNames());
	h.check(isl.includes('Island'), `Island was saved into the project (${JSON.stringify(isl)})`);

	// ---- 9 ----------------------------------------------------------------------------------------------------
	// (a scene made by New scene is a loose file until its first save, and reads as unsaved: say what to do)
	const n1 = await call('scene', { action: 'new', name: 'Cove', unsaved: 'discard' });
	h.check(n1?.result?.created === 'Cove' && n1.result.opened === 'Cove', `new makes and opens Cove (${short(n1)})`);
	const n2 = await call('scene', { action: 'new', name: 'Harbour' });
	h.check(n2?.type === 'error' && /already a scene called/.test(n2.error?.message ?? ''), `a taken name is refused (${short(n2)})`);
	const already = await call('scene', { action: 'open', name: 'Cove' });
	h.check(already?.result?.already === true, 'opening the open scene changes nothing');

	// ---- 10 ---------------------------------------------------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.connectionState.sessionHost.set('someone-else'));
	const guest = await call('scene', { action: 'open', name: 'Harbour', unsaved: 'save' });
	const guestList = await call('scene', { action: 'list' });
	await page.evaluate(() => window.__tp.test.v1.connectionState.sessionHost.set(null));
	h.check(guest?.type === 'error' && /only the host can change the scene here/.test(guest.error?.message ?? ''), `a guest is refused (${short(guest)})`);
	h.check(guestList?.type === 'result' && /guest/.test(guestList.result?.note ?? ''), 'a guest can still list');
	await page.evaluate(() => window.__tp.test.v1.cloudHooks.rolesInfo.set({ myId: 'x', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole() {}, synced: () => true }));
	const viewer = await call('scene', { action: 'open', name: 'Harbour' });
	await page.evaluate(() => window.__tp.test.v1.cloudHooks.rolesInfo.set(null));
	h.check(viewer?.type === 'error' && /View only/.test(viewer.error?.message ?? ''), `a viewer is refused (${short(viewer)})`);

	// ---- 11 ---------------------------------------------------------------------------------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await page.waitForTimeout(1500);
	await call('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Cove rock', position: [2, 0, 2] }] });
	const crowd = await call('scene', { action: 'open', name: 'Harbour', unsaved: 'discard' });
	h.check(crowd?.result?.needsConfirm === true, `hosting with someone here: the dialog shows even with unsaved: "discard" (${short(crowd)})`);
	h.check((await toasts()).some((t) => /1 other person is in this session/.test(t)), 'the question says who else is here');
	await press('Cancel');
	const crowdB = await call('scene', { action: 'open', name: 'Harbour', confirmId: crowd?.result?.confirmId, wait: 10 });
	h.check(crowdB?.result?.cancelled === true, 'Cancel: nothing changed');

	await h.finish(browser);
});
