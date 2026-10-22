// 55 A2 — `window.tpAgent`, the supported in-page agent API, on two real peers: A is a person's page,
// B is an agent's (safeStorage `agentApi`, what the bridge's init script sets). The page-side half of
// test flight 2: three calls from a link to a build (status, tools, exec), a viewer refused instead
// of a silent local-only create (T1), offers kept until answered (T2), quiet mode (T7), the
// missing-module report (T6), a graceful leave (T5), and nothing at all on a page that did not ask.
//
// Run: APP_URL='https://theprototype.app:5455/' npm run e2e -- agent-api
const h = require('./helpers.cjs');

/** poll `fn` until `pred` holds or the time is up; returns the LAST value (h.eventually returns nothing) */
async function poll(fn, pred, _label, timeout = 10000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (pred(last)) return last;
		await new Promise((r) => setTimeout(r, 400));
	}
	return last;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B', { storage: { agentApi: '1' } });
	await B.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });

	// ---- 1. only where asked, and never in the boot graph --------------------------------------
	const onA = await A.page.evaluate(() => ({
		api: typeof window.tpAgent,
		loaded: performance.getEntriesByType('resource').some((r) => /agent\/tpAgent/.test(r.name)),
		leaf: performance.getEntriesByType('resource').some((r) => /agent\/agentMode/.test(r.name))
	}));
	h.check(onA.api === 'undefined', 'a page that did not ask has no window.tpAgent');
	h.check(!onA.loaded, 'and never fetched the API module (only the agentMode leaf is in the boot graph)');
	h.check(onA.leaf || process.env.APP_URL?.includes('pages.dev'), 'the leaf itself is the one boot-graph addition (dev server lists it)');
	const shape = await B.page.evaluate(() => ({
		version: window.tpAgent.version,
		frozen: Object.isFrozen(window.tpAgent),
		methods: Object.keys(window.tpAgent).sort(),
		onStores: !!window.__stores?.tpAgent
	}));
	h.check(/^\d+\.\d+\.\d+$/.test(shape.version), `tpAgent.version is semver (${shape.version})`);
	h.check(shape.frozen && !shape.onStores, 'frozen, and not reached through window.__stores');
	h.check(
		['accept', 'exec', 'leave', 'pendingOffers', 'screenshot', 'snapshot', 'status', 'systemPrompt', 'tools', 'version', 'waitForEdit'].every((m) => shape.methods.includes(m)),
		`every contract method is there (${shape.methods.join(',')})`
	);
	const tools = await B.page.evaluate(() => window.tpAgent.tools());
	const create = tools.find((t) => t.function?.name === 'create_objects');
	h.check(!!create && create.function.parameters?.properties?.objects?.items?.properties?.primitive?.enum?.length > 5, 'tools() carries FULL JSON schemas (T10: create_objects.objects.items.primitive enum)');
	h.check(['install_modules', 'pending_offers', 'accept_offer'].every((n) => tools.some((t) => t.function?.name === n)), 'plus the agent-only tools');
	h.check((await B.page.evaluate(() => window.tpAgent.systemPrompt())).includes('create_objects'), 'systemPrompt() is the assistant guidance');

	// ---- 2. status before and after joining -------------------------------------------------------
	const before = await B.page.evaluate(() => window.tpAgent.status());
	h.check(before.peerId === B.id && before.joined === false && before.host === null, `status() before a join: own id, not joined (${JSON.stringify({ id: before.peerId, joined: before.joined })})`);
	await h.connect(B, A);
	const s = await poll(() => B.page.evaluate(() => window.tpAgent.status()), (x) => x.joined, 'B reports joined', 20000);
	h.check(s?.joined === true && s.host === A.id && s.peers.some((p) => p.id === A.id) && s.canEdit === true, `status() after Approve: joined, host = A, can edit (${JSON.stringify({ host: s?.host, canEdit: s?.canEdit })})`);

	// ---- 3. exec builds on the host, as ONE undo step --------------------------------------------
	const depth0 = await B.page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));
	const made = await B.page.evaluate(() =>
		window.tpAgent.exec('create_objects', {
			objects: [
				{ kind: 'primitive', primitive: 'Box', name: 'Rock_1', position: [1, 0.5, 0] },
				{ kind: 'primitive', primitive: 'Sphere', name: 'Rock_2', position: [-1, 0.5, 0] },
				{ kind: 'light', light: 'point', name: 'Flame', position: [0, 1, 0] }
			]
		})
	);
	const uuids = (made.created ?? []).map((c) => c.uuid).filter(Boolean);
	h.check(uuids.length === 3, `exec(create_objects) created 3 (${JSON.stringify(made).slice(0, 120)})`);
	const depth1 = await B.page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));
	h.check(depth1 === depth0 + 1, `ONE undo entry for the whole call (${depth0} -> ${depth1})`);
	const onHost = await poll(
		() => A.page.evaluate((ids) => ids.filter((id) => window.__stores.objectsGroup && (() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return !!g?.getObjectByProperty('uuid', id); })()).length, uuids),
		(n) => n === 3,
		'the host holds all three by uuid',
		15000
	);
	h.check(onHost === 3, `the HOST holds the agent's objects by uuid (${onHost}/3)`);
	const snap = await B.page.evaluate(() => window.tpAgent.snapshot());
	h.check(uuids.every((id) => snap.objects.some((o) => o.uuid === id)), 'snapshot() lists them');
	await B.page.evaluate(() => window.__stores.history.undo());
	const afterUndo = await poll(
		() => A.page.evaluate((ids) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return ids.filter((id) => !!g?.getObjectByProperty('uuid', id)).length; }, uuids),
		(n) => n === 0,
		'one undo removes all three on the host',
		15000
	);
	h.check(afterUndo === 0, `ONE undo on the agent removes all three, on the host too (${afterUndo} left)`);
	await B.page.evaluate(() => window.__stores.history.redo());

	// ---- 4. T1: a viewer is refused, and nothing is created anywhere -----------------------------
	const countB0 = await B.page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.children.length; });
	await B.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set({ myId: 'x', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole() {} }));
	const refused = await B.page.evaluate(() => window.tpAgent.exec('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box' }] }));
	const countB1 = await B.page.evaluate(() => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.children.length; });
	h.check(refused.refused === true && /View-only/.test(refused.error ?? ''), `a viewer's exec is REFUSED with a reason (${(refused.error ?? '').slice(0, 60)}…)`);
	h.check(countB1 === countB0, 'and nothing was created, not even locally');
	h.check((await B.page.evaluate(() => window.tpAgent.status())).canEdit === false, 'status().canEdit says so');
	const viewerRead = await B.page.evaluate(() => window.tpAgent.exec('list_scene', {}));
	h.check(Array.isArray(viewerRead.objects), 'a viewer still READS (list_scene)');
	await B.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));

	// ---- 5. waitForEdit wakes on someone else's edit ---------------------------------------------
	await B.page.evaluate(() => {
		window.__wait = window.tpAgent.waitForEdit(15000);
	});
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => window.__stores.aiTools.executeAiTool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Cone', name: 'FromHost' }] }));
	const woke = await B.page.evaluate(() => window.__wait);
	h.check(woke?.changed === true, `waitForEdit resolves on the host's edit (${JSON.stringify(woke)})`);
	// the host's edit arrives as several messages (create, name, colour…); let the tail land, then
	// a quiet scene must STAY quiet — a periodic poke would make waitForEdit useless
	await B.page.waitForTimeout(3000);
	const pulses = await B.page.evaluate(
		() => new Promise((r) => { let n = -1; const off = window.__stores.autosave.dirtyPulse.subscribe(() => n++); setTimeout(() => { off(); r(n); }, 4000); })
	);
	h.check(pulses === 0, `an idle joined page raises no scene-change pulse (${pulses} in 4 s)`);
	const quiet = await B.page.evaluate(() => window.tpAgent.waitForEdit(1500));
	h.check(quiet?.timedOut === true, `and waitForEdit times out cleanly when nothing happens (${JSON.stringify(quiet)})`);

	// ---- 6. T2: a question with buttons is kept until answered ---------------------------------
	await B.page.evaluate(() => {
		window.__answered = [];
		window.__stores.showToast('You have been offered the ADMIN role by HOST. Accept?', [{ label: 'Accept', action: () => window.__answered.push('accept') }]);
	});
	await B.page.waitForTimeout(200);
	// the toast expires (or is closed) — the offer must outlive it
	await B.page.evaluate(() => window.__stores.toastStore.set([]));
	const offers = await B.page.evaluate(() => window.tpAgent.pendingOffers());
	const admin = offers.find((o) => /ADMIN/.test(o.text));
	h.check(!!admin && admin.actions.join() === 'Accept', `the admin offer is a pending offer after its toast is gone (${JSON.stringify(offers).slice(0, 120)})`);
	const viaTool = await B.page.evaluate((id) => window.tpAgent.exec('accept_offer', { id, action: 'Accept' }), admin?.id);
	h.check(viaTool.ok === true && (await B.page.evaluate(() => window.__answered.join())) === 'accept', 'accept_offer presses its button');
	h.check((await B.page.evaluate(() => window.tpAgent.pendingOffers())).length === 0, 'and the offer is gone');

	// ---- 7. T7: the human prompts stay out of an agent page -------------------------------------
	await B.page.evaluate(() => {
		window.__nudged = 0;
		window.__stores.whatsNew.welcomeOpen.set(true);
		window.__stores.showInfoToast('shared-library-offer', 'this scene has never been saved.', [{ label: 'Not now', action: () => {} }], () => window.__nudged++);
	});
	await B.page.waitForTimeout(300);
	const quietState = await B.page.evaluate(() => ({
		welcome: (() => { let v; window.__stores.whatsNew.welcomeOpen.subscribe((x) => (v = x))(); return v; })(),
		nudge: (() => { let l; window.__stores.toastStore.subscribe((x) => (l = x))(); return l.some((e) => e?.id === 'shared-library-offer'); })(),
		dismissed: window.__nudged
	}));
	h.check(quietState.welcome === false, 'the welcome overlay closes itself on an agent page');
	h.check(!quietState.nudge && quietState.dismissed === 1, `the "never been saved" nudge is answered Not now, once (${JSON.stringify(quietState)})`);

	// ---- 8. T6: modules the host runs that this page lacks -------------------------------------
	await B.page.evaluate((hostId) => window.__stores.moduleSDK.peerModuleVersions.update((m) => ({ ...m, [hostId]: [...(m[hostId] ?? []), { id: 'zz-not-a-module', version: '9.9.9' }] })), A.id);
	const missing = await B.page.evaluate(() => window.tpAgent.status().missingModules);
	h.check(missing.some((m) => m.id === 'zz-not-a-module' && m.version === '9.9.9'), `status().missingModules names it (${JSON.stringify(missing)})`);
	const real = await A.page.evaluate(() => window.__stores.moduleSDK.moduleVersions().map((m) => m.id));
	h.check(!missing.some((m) => real.includes(m.id)), 'and only what is really missing (both pages run the same core modules)');
	const inst = await B.page.evaluate(() => window.tpAgent.exec('install_modules', { ids: ['zz-not-a-module'] }));
	h.check(inst.installed?.[0]?.ok === false && /gallery/.test(inst.installed[0].error ?? ''), `install_modules explains what it cannot fetch (${JSON.stringify(inst)})`);

	// ---- 9. T5: leave() is a goodbye, not a dropped link ----------------------------------------
	const toastsA0 = await A.page.evaluate(() => { let l; window.__stores.toastStore.subscribe((x) => (l = x))(); return l.length; });
	await B.page.evaluate(() => window.tpAgent.leave());
	const gone = await poll(
		() => A.page.evaluate((id) => !window.__stores.peers ? false : (() => { let p; window.__stores.peers.subscribe((v) => (p = v))(); return !p.openedPeers.has(id); })(), B.id),
		(x) => x,
		'the host drops the agent',
		15000
	);
	h.check(gone === true, 'after leave() the host no longer has the agent open');
	const errToast = await A.page.evaluate(() => { let l; window.__stores.toastStore.subscribe((x) => (l = x))(); return l.some((e) => /Connection error/.test(typeof e === 'string' ? e : e?.text ?? '')); });
	h.check(!errToast, `and shows no "Connection error" toast (toasts ${toastsA0} -> …)`);

	h.check((await h.pageErrors(A)).length === 0 && (await h.pageErrors(B)).length === 0, `no page errors (${JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)])})`);
	await h.finish(browser);
});
