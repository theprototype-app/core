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
	const settled = await poll(() => B.page.evaluate(() => window.tpAgent.status()), (x) => x?.loading === false, 'status().loading settles', 30000);
	h.check(settled?.loading === false && settled.objects === undefined, `status() reports loading (1.2) and it settles to false once the snapshot landed (${JSON.stringify({ loading: settled?.loading, objects: settled?.objects })})`);

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
	// (a cloud build also holds the roles plugin's own view-only notice: only the answered offer must go)
	h.check(!(await B.page.evaluate(() => window.tpAgent.pendingOffers())).some((o) => o.id === admin?.id), 'and the offer is gone');

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

	// ---- A5. eyes: a clean PNG from a temporary camera, nobody's view moved ----------------------
	/** decode a data URL in the page: size, distinct colours, mean luminance */
	const probe = (url) =>
		B.page.evaluate(async (u) => {
			if (typeof u !== 'string' || !u.startsWith('data:image/png;base64,')) return { bad: String(u).slice(0, 40) };
			const img = new Image();
			img.src = u;
			await img.decode();
			const c = document.createElement('canvas');
			c.width = img.width;
			c.height = img.height;
			const ctx = c.getContext('2d');
			ctx.drawImage(img, 0, 0);
			const d = ctx.getImageData(0, 0, c.width, c.height).data;
			const colours = new Set();
			let lum = 0;
			for (let i = 0; i < d.length; i += 16) {
				colours.add((d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3));
				lum += d[i] + d[i + 1] + d[i + 2];
			}
			return { w: img.width, h: img.height, colours: colours.size, lum: lum / (d.length / 16) / 3 };
		}, url);
	/** fraction of pixels differing by > 24 in any channel */
	const diff = (a, b) =>
		B.page.evaluate(async ([x, y]) => {
			const read = async (u) => {
				const img = new Image();
				img.src = u;
				await img.decode();
				const c = document.createElement('canvas');
				c.width = img.width;
				c.height = img.height;
				c.getContext('2d').drawImage(img, 0, 0);
				return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
			};
			const [p, q] = [await read(x), await read(y)];
			if (p.length !== q.length) return 1;
			let n = 0;
			for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) > 24 || Math.abs(p[i + 1] - q[i + 1]) > 24 || Math.abs(p[i + 2] - q[i + 2]) > 24) n++;
			return n / (p.length / 4);
		}, [a, b]);
	const camBefore = await B.page.evaluate(() => { let c; window.__stores.globalCamera.subscribe((v) => (c = v))(); return [...c.position.toArray(), ...c.quaternion.toArray()].map((v) => v.toFixed(5)).join(); });
	const iso = await B.page.evaluate(() => window.tpAgent.screenshot());
	const isoP = await probe(iso);
	const canvasAspect = await B.page.evaluate(() => { let r; window.__stores.globalRenderer.subscribe((v) => (r = v))(); return r.domElement.width / r.domElement.height; });
	h.check(isoP.w === 768 || isoP.h === 768, `default PNG, longest side 768 (${JSON.stringify(isoP)})`);
	h.check(Math.abs(isoP.w / isoP.h - canvasAspect) < 0.02, `in the canvas aspect (${(isoP.w / isoP.h).toFixed(3)} vs ${canvasAspect.toFixed(3)})`);
	h.check(isoP.colours > 20, `and it shows something, not a flat fill (${isoP.colours} colours, mean ${isoP.lum?.toFixed(1)})`);
	const small = await probe(await B.page.evaluate(() => window.tpAgent.screenshot({ view: 'top', size: 300 })));
	h.check(Math.max(small.w, small.h) === 300, `size caps the longest side (${small.w}x${small.h})`);
	const top = await B.page.evaluate(() => window.tpAgent.screenshot({ view: 'top' }));
	const front = await B.page.evaluate(() => window.tpAgent.screenshot({ view: 'front' }));
	const current = await B.page.evaluate(() => window.tpAgent.screenshot({ view: 'current' }));
	const dTF = await diff(top, front);
	const dIT = await diff(iso, top);
	h.check(dTF > 0.05 && dIT > 0.05, `top, front and iso are different pictures (top/front ${dTF.toFixed(3)}, iso/top ${dIT.toFixed(3)})`);
	h.check((await probe(current)).colours > 5, 'current renders from the viewer camera');
	const focus = await B.page.evaluate((id) => window.tpAgent.screenshot({ view: 'focus', uuid: id }), uuids[0]);
	h.check((await probe(focus)).colours > 5 && (await diff(focus, iso)) > 0.05, 'focus(uuid) frames one object');
	h.check((await B.page.evaluate(() => window.tpAgent.screenshot({ view: 'focus', uuid: 'nope' }))) === null, 'focus on an unknown uuid is null, never a throw');
	const camAfter = await B.page.evaluate(() => { let c; window.__stores.globalCamera.subscribe((v) => (c = v))(); return [...c.position.toArray(), ...c.quaternion.toArray()].map((v) => v.toFixed(5)).join(); });
	h.check(camAfter === camBefore, 'the viewer camera never moved');
	// clean: the transform gizmo on a selected object does not reach the picture
	const clean0 = await B.page.evaluate(() => window.tpAgent.screenshot({ view: 'iso' }));
	const gizmoOn = await B.page.evaluate((id) => {
		let g, tc;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		window.__stores.TControls.subscribe((v) => (tc = v))();
		const o = g.getObjectByProperty('uuid', id);
		if (!tc || !o) return false;
		tc.attach(o);
		const helper = tc.getHelper?.() ?? tc;
		return !!helper.visible;
	}, uuids[0]);
	const clean1 = await B.page.evaluate(() => window.tpAgent.screenshot({ view: 'iso' }));
	await B.page.evaluate(() => { let tc; window.__stores.TControls.subscribe((v) => (tc = v))(); tc?.detach(); });
	const dGizmo = await diff(clean0, clean1);
	h.check(!gizmoOn || dGizmo < 0.002, `a gizmo on screen is not in the screenshot (gizmo ${gizmoOn}, ${(dGizmo * 100).toFixed(2)}% pixels differ)`);
	const withGrid = await B.page.evaluate(() => window.tpAgent.screenshot({ view: 'iso', grid: true }));
	h.check((await diff(withGrid, clean0)) > 0.001, 'grid: true draws the editor grid, the default leaves it out');

	// ---- A6. the full tool set ------------------------------------------------------------------
	const names = (await B.page.evaluate(() => window.tpAgent.tools())).map((t) => t.function?.name);
	const providers = await B.page.evaluate(() => { let l; window.__stores.aiProviders.aiProviders?.subscribe?.((v) => (l = v))(); return l?.length ?? 0; });
	h.check(['set_physics', 'create_joints', 'control_simulation'].every((n) => names.includes(n)), `physics tools are offered with no AI provider at all (${providers} providers)`);
	const phys = await B.page.evaluate((id) => window.tpAgent.exec('set_physics', { updates: [{ uuid: id, mode: 'static' }] }), uuids[0]);
	h.check(!phys.error, `and set_physics runs (${JSON.stringify(phys).slice(0, 100)})`);
	const gap = (await B.page.evaluate(() => window.tpAgent.status())).missingTools;
	h.check(!names.includes('generate_mesh') && gap.some((g) => g.name === 'generate_mesh' && /host/.test(g.reason)), `generate_mesh is missing WITH the reason (${JSON.stringify(gap)})`);
	// the host sets up a provider (a fake endpoint: the job starts and then fails, which is fine here)
	await A.page.evaluate(() => {
		const m = window.__stores.meshProviders;
		m.addMeshProvider({ kind: 'meshy', label: 'e2e fake', baseUrl: 'https://127.0.0.1:9', apiKey: 'k' });
		m.setMeshGenEnabled(true);
	});
	const offered = await poll(() => B.page.evaluate(() => window.tpAgent.tools().some((t) => t.function?.name === 'generate_mesh')), (x) => x, 'host provider seen', 25000);
	h.check(offered === true, 'once the HOST has a provider, the agent is offered generate_mesh');
	h.check(!(await B.page.evaluate(() => window.tpAgent.status())).missingTools.some((g) => g.name === 'generate_mesh'), 'and it leaves missingTools');
	const gen = await B.page.evaluate(() => window.tpAgent.exec('generate_mesh', { prompt: 'an e2e test rock' }));
	h.check(gen.started === true && gen.onHost === true, `the call is relayed to the host (${JSON.stringify(gen).slice(0, 120)})`);
	const job = await poll(() => A.page.evaluate(() => { let l; window.__stores.meshJobs.meshJobs.subscribe((v) => (l = v))(); return l.map((j) => j.prompt); }), (l) => l.includes('an e2e test rock'), 'host job', 10000);
	h.check(job?.includes('an e2e test rock'), `the HOST runs the job on its own provider (${JSON.stringify(job)})`);
	const told = await A.page.evaluate(() => { let l; window.__stores.notifications.subscribe((v) => (l = v))(); return l.some((n) => /asked for a mesh/.test(n.text)); });
	h.check(told, 'and the host is told who asked');
	await A.page.evaluate(() => { let l; window.__stores.meshJobs.meshJobs.subscribe((v) => (l = v))(); for (const j of l) window.__stores.meshJobs.cancelMeshJob(j.id); });
	await A.page.waitForTimeout(500);
	await A.page.evaluate((agentId) => window.__stores.cloudHooks.rolesInfo.set({ myId: 'x', myRole: 'admin', amAdmin: true, order: [], roleOf: (id) => (id === agentId ? 'viewer' : 'admin'), setRole() {} }), B.id);
	const asViewer = await B.page.evaluate(() => window.tpAgent.exec('generate_mesh', { prompt: 'a second rock' }));
	h.check(/host refused: view-only/.test(asViewer.error ?? ''), `the HOST refuses a viewer's request itself (${asViewer.error})`);
	if (!/host refused: view-only/.test(asViewer.error ?? ''))
		console.log('  relay A: ' + JSON.stringify(await A.page.evaluate(() => window.__stores.meshRelay?.relayLog)) + '\n  relay B: ' + JSON.stringify(await B.page.evaluate(() => window.__stores.meshRelay?.relayLog)));
	await A.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));

	// ---- 8b. 41's gem test: the kit authority is the PERSON, and a behaviour that throws says so ------
	const auth = await Promise.all([A, B].map((p) => p.page.evaluate(() => window.__stores.kit.kitAuthorityId())));
	h.check(auth[0] === A.id && auth[1] === A.id, `both pages name the host as the kit authority, never the agent (A ${auth[0]}, B ${auth[1]}; ids A ${A.id} B ${B.id})`);
	// the ids are random, so the case that matters (the AGENT's id sorts lowest — 41's '1e16b' < 'ff637') is
	// forced: each page's LIVE facts, with the agent renamed '00000', through the same pick
	const lowest = await Promise.all(
		[A, B].map((p) =>
			p.page.evaluate((agentId) => {
				const f = window.__stores.kit.kitAuthorityFacts();
				const ren = (id) => (id === agentId ? '00000' : id);
				const facts = { ...f, me: ren(f.me), peers: f.peers.map(ren), agents: f.agents.map(ren) };
				return { knowsAgent: f.agents.includes(agentId), pick: window.__stores.kitAuthority.pickAuthority(facts) };
			}, B.id)
		)
	);
	h.check(lowest.every((x) => x.knowsAgent && x.pick === A.id), `with the agent's id sorting LOWEST both pages still pick the host (${JSON.stringify(lowest)})`);
	const broken = await B.page.evaluate(() =>
		window.tpAgent.exec('create_behaviour', {
			name: 'BrokenGems',
			source: "export default behaviour({ name: 'BrokenGems', state: { n: 0 }, on: { start() { const g = this.findAll('NoSuchGem*'); this.state.n = g[0].name.length; } } });"
		})
	);
	h.check(!!broken?.created, 'create_behaviour applied it: ' + JSON.stringify(broken).slice(0, 200));
	console.log('  create result errors: ' + JSON.stringify(broken?.errors ?? null).slice(0, 160));
	const failing = await poll(() => B.page.evaluate(() => window.tpAgent.status().behaviourErrors ?? null), (x) => Array.isArray(x) && x.length > 0, 'status().behaviourErrors', 60000);
	if (!(Array.isArray(failing) && failing.length)) {
		const diag = await Promise.all([A, B].map((p) => p.page.evaluate((id) => { const d = window.__stores.behaviours.behavioursDebug(); const l = id ? d.live(id) : null; return { me: d.me, authority: d.authority, stats: d.stats, status: id ? d.status[id] : Object.keys(d.status), live: l && { started: l.started, rev: l.rev, synced: l.synced, authority: l.authority, errors: l.errors, fired: l.fired } }; }, broken?.created?.[0]?.id ?? null)));
		console.log('  DIAG behaviour errors: ' + JSON.stringify(diag).slice(0, 2400));
	}
	h.check(Array.isArray(failing) && failing.some((e) => e.name === 'BrokenGems' && /name/.test(e.message)), `status().behaviourErrors names the failing behaviour on the AGENT page (it runs on the host): ${JSON.stringify(failing).slice(0, 200)}`);
	const listed = await B.page.evaluate(() => window.tpAgent.exec('list_scene', {}));
	const row = (listed?.behaviours ?? []).find((b) => b.name === 'BrokenGems');
	h.check(!!row && /error/.test(row.summary) && row.errors?.length > 0, `list_scene says it is failing, not just running (${JSON.stringify(row).slice(0, 200)})`);
	const bare = await B.page.evaluate(() => window.tpAgent.exec('create_behaviour', { name: 'BareFind', source: "export default behaviour({ name: 'BareFind', on: { start() { findAll('Gem*'); } } });" }));
	h.check(!bare?.created && /this\.findAll/.test(JSON.stringify(bare)), 'a bare findAll() is refused with the fix (this.findAll): ' + JSON.stringify(bare).slice(0, 160));

	// ---- 8c. 41's physics research: the agent's control_simulation runs on the HOST ------------------
	// (a headless page stepping the world ran the whole session 4-6x slow: a ball took 4.5 s to fall 3 m)
	const ball = await B.page.evaluate(() => window.tpAgent.exec('create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'DropBall', position: [6, 3.5, 0] }] }));
	const ballId = ball?.created?.[0]?.uuid;
	await B.page.evaluate((id) => window.tpAgent.exec('set_physics', { updates: [{ uuid: id, mode: 'dynamic', mass: 1 }] }), ballId);
	await poll(() => A.page.evaluate((id) => !!window.__stores.objectsGroup && (() => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return g?.getObjectByProperty('uuid', id)?.userData?.physics?.mode === 'dynamic'; })(), ballId), (x) => x, 'ball on host', 15000);
	// the host times the fall in-page (50 ms resolution), from the moment the ball starts to move
	const fall = A.page.evaluate((id) => new Promise((resolve) => {
		let g, t0 = 0, frames = 0, counting = true;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const end = Date.now() + 60000;
		// the page's own frame rate while it falls: physics feeds at most 0.25 s of sim time per frame
		const count = () => { if (t0) frames++; if (counting) requestAnimationFrame(count); };
		requestAnimationFrame(count);
		const tick = setInterval(() => {
			let on = false;
			window.__stores.physics.simulating.subscribe((v) => (on = v))();
			const y = g?.getObjectByProperty('uuid', id)?.position.y ?? 99;
			// from the first MOTION (the engine's start-up — a wasm load on a cold server — is not the fall)
			if (on && !t0 && y < 3.45) t0 = Date.now();
			if ((t0 && y < 1.2) || Date.now() > end) { clearInterval(tick); counting = false; const ms = Date.now() - t0; resolve(t0 ? { ms, y, fps: +((frames * 1000) / Math.max(1, ms)).toFixed(1) } : null); }
		}, 50);
	}), ballId);
	const started = await B.page.evaluate(() => window.tpAgent.exec('control_simulation', { action: 'start' }));
	h.check(started?.simulating === true && started?.onHost === true, `control_simulation start is relayed to the host (${JSON.stringify(started).slice(0, 140)})`);
	const sims = await poll(
		() => Promise.all([A, B].map((p) => p.page.evaluate(() => { const s = {}; window.__stores.physics.simulating.subscribe((v) => (s.on = v))(); window.__stores.physics.remoteSimulating.subscribe((v) => (s.remote = v))(); return s; }))),
		([a, b]) => a.on === true && b.remote === A.id,
		'host simulates',
		15000
	);
	h.check(sims[0].on === true && sims[1].on !== true && sims[1].remote === A.id, `the HOST steps the world, the agent page never does (${JSON.stringify(sims)})`);
	const fell = await fall;
	console.log('  fall 3.5 m → 1.2 m on the host: ' + JSON.stringify(fell) + ' (real time ~0.7 s; the bug measured 4.5 s)');
	// real time is ~0.7 s (a radius-1 sphere rests at y 1); a page drawing f fps advances at most 0.25·f s of sim per second, so the bound
	// is the slower of real time and that cap (+ headroom) — a 60 fps host must be real time, a 1 fps
	// headless one cannot be
	const bound = fell ? Math.max(2500, (0.8 / Math.min(1, 0.25 * Math.max(0.2, fell.fps))) * 1000 * 2.5) : 0;
	h.check(!!fell && fell.ms < bound, `the ball falls in about real time for the host's frame rate (${fell?.ms} ms at ${fell?.fps} fps, bound ${Math.round(bound)} ms)`);
	const kitNow = await Promise.all([A, B].map((p) => p.page.evaluate(() => window.__stores.kit.kitAuthorityId())));
	h.check(kitNow.every((x) => x === A.id), `while it runs the kit authority is still the host (${JSON.stringify(kitNow)})`);
	const stopped = await B.page.evaluate(() => window.tpAgent.exec('control_simulation', { action: 'stop' }));
	const offA = await poll(() => A.page.evaluate(() => { let on; window.__stores.physics.simulating.subscribe((v) => (on = v))(); return on; }), (x) => x === false, 'host stopped', 10000);
	h.check(!stopped?.error && offA === false, `and stop is relayed too (${JSON.stringify(stopped).slice(0, 100)})`);
	await B.page.evaluate(() => window.__stores.physics.toggleSimulation());
	const selfOn = await B.page.evaluate(() => { let on; window.__stores.physics.simulating.subscribe((v) => (on = v))(); return on; });
	h.check(selfOn === false, 'the agent page refuses to simulate by itself (sim-on-load, play, the P key)');
	const wrongKey = await B.page.evaluate((id) => window.tpAgent.exec('set_physics', { objects: [{ uuid: id, mode: 'static' }] }), ballId);
	h.check(/takes "updates", not "objects"/.test(wrongKey?.error ?? ''), `set_physics names the right key (${wrongKey?.error})`);

	// ---- 8d. 41's API research: material parameters, lights, group names, sizes -----------------------
	const bad = await B.page.evaluate((id) => window.tpAgent.exec('update_objects', { updates: [{ uuid: id, materialParams: { map: 'https://example.com/x.png', roughness: '0.3', bogus: 1 } }] }), uuids[0]);
	const row0 = bad?.updated?.[0];
	h.check(row0?.ok === false && (row0.errors ?? []).some((e) => /map/.test(e)) && (row0.errors ?? []).some((e) => /bogus/.test(e)), `a texture slot given a URL and an unknown key are errors per key (${JSON.stringify(row0).slice(0, 200)})`);
	const mats = await Promise.all([A, B].map((p) => p.page.evaluate((id) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); const m = g.getObjectByProperty('uuid', id)?.material; return { map: m?.map === null ? null : typeof m?.map, rough: m?.roughness }; }, uuids[0])));
	h.check(mats.every((m) => m.map === null) && mats[1].rough === 0.3, `nothing bad was written, the good key was (${JSON.stringify(mats)})`);
	const rendered = await A.page.evaluate(() => window.__stores.globalRenderer && true);
	h.check(rendered && (await h.pageErrors(A)).length === 0, 'the host keeps rendering, no page errors');
	const forged = await B.page.evaluate((id) => { let pc; window.__stores.peers.subscribe((v) => (pc = v))(); pc.send({ type: 'objectParameters', parameter: 'materialParam', uuid: id, key: 'map', value: 'https://example.com/x.png' }); return true; }, uuids[0]);
	await A.page.waitForTimeout(800);
	const afterForged = await A.page.evaluate((id) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return typeof g.getObjectByProperty('uuid', id)?.material?.map; }, uuids[0]);
	h.check(forged && afterForged === 'object', `a bad material message from a peer is dropped on receive (map is ${afterForged})`);
	const lit = await B.page.evaluate(() => window.tpAgent.exec('create_objects', { objects: [{ kind: 'light', light: 'spot', name: 'Lamp', position: [0, 4, 0], color: '#ff8800', intensity: 7, angle: 0.4, penumbra: 0.3, aim: [0, 0, 0] }] }));
	const lampId = lit?.created?.[0]?.uuid;
	const lampA = await poll(() => A.page.evaluate((id) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); const l = g.getObjectByProperty('uuid', id); return l ? { color: '#' + l.color.getHexString(), intensity: l.intensity, angle: Math.round(l.angle * 100) / 100, name: l.name } : null; }, lampId), (l) => l && l.intensity === 7, 'lamp on host', 15000);
	h.check(lampA?.color === '#ff8800' && lampA.intensity === 7 && lampA.angle === 0.4, `a light takes its fields on create, and the host sees them (${JSON.stringify(lampA)})`);
	const dim = await B.page.evaluate((id) => window.tpAgent.exec('update_objects', { updates: [{ uuid: id, intensity: 2, color: '#0088ff' }] }), lampId);
	const lampA2 = await poll(() => A.page.evaluate((id) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); const l = g.getObjectByProperty('uuid', id); return { color: '#' + l.color.getHexString(), intensity: l.intensity }; }, lampId), (l) => l.intensity === 2, 'lamp updated', 15000);
	h.check(dim?.updated?.[0]?.ok === true && lampA2.intensity === 2 && lampA2.color === '#0088ff', `update_objects on a light changes it (${JSON.stringify(lampA2)})`);
	const wrong = await B.page.evaluate((id) => window.tpAgent.exec('update_objects', { updates: [{ uuid: id, angle: 0.5 }] }), uuids[0]);
	h.check(wrong?.updated?.[0]?.ok === false && /only a light/.test(JSON.stringify(wrong)), `a light field on a box is an error, not ok:true (${JSON.stringify(wrong).slice(0, 160)})`);
	const grouped = await B.page.evaluate((ids) => window.tpAgent.exec('group_objects', { name: 'G group', memberUuids: ids }), [lampId]);
	const gName = await B.page.evaluate((id) => { let g; window.__stores.objectsGroup.subscribe((x) => (g = x))(); return g.getObjectByProperty('uuid', id)?.name; }, grouped?.groupUuid ?? grouped?.uuid ?? '');
	h.check(gName === 'G group', `group_objects keeps the given name (${gName}; ${JSON.stringify(grouped).slice(0, 120)})`);
	const badBox = await B.page.evaluate(() => window.tpAgent.exec('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params: [-1, 0, 'a'] }] }));
	const badHex = await B.page.evaluate(() => window.tpAgent.exec('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'HexBox', color: '#40ff4060' }] }));
	h.check(/hex colour/.test(JSON.stringify(badHex?.created?.[0]?.warnings ?? '')), `an 8-digit hex colour is refused with a warning (${JSON.stringify(badHex).slice(0, 160)})`);
	h.check(!!badBox?.error && /positive/.test(JSON.stringify(badBox)), `a Box of [-1, 0, 'a'] is refused (${JSON.stringify(badBox).slice(0, 160)})`);
	// 41's voice-Claude finding: a wire to a socket the node does not have was accepted ("edges": N) and did nothing
	const wired = await B.page.evaluate(() =>
		window.tpAgent.exec('create_flow_nodes', {
			graph: 'scene',
			nodes: [{ ref: 'c', type: 'onclick' }, { ref: 'l', type: 'latch' }, { ref: 'n', type: 'counter' }],
			edges: [{ from: 'c', to: 'l', toHandle: 'sett' }, { from: 'c', to: 'n', toHandle: 'pulse' }]
		})
	);
	h.check(
		wired?.edges === 1 && wired?.partial === true && /toHandle "sett".*set, reset, toggle|toHandle "sett".*set,.*reset/.test(JSON.stringify(wired?.errors ?? [])),
		`a wrong toHandle is refused naming the latch's real inputs; the good wire is made (${JSON.stringify(wired).slice(0, 260)})`
	);

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
