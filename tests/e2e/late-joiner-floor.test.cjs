// 49 J1 — a late joiner the host still reads as a VIEWER gets the room's older domains.
//
// A cloud build installs the roles capability provider, and a just-approved joiner reads as a
// viewer until its role grant lands — so the host's receive gate dropped the joiner's handshake
// REQUESTS for every domain whose `get*` was off cloudHooks' ALWAYS_ALLOWED floor (1.38/1.39:
// gethuds, gethudvalues, getshadergraphs, getanim, getscenepost, getroomanchor). The joiner sat
// without the host's HUD, shader graph, animation and look; 1.39 fixed the same hole for getseqs.
//
// On a dev server (no cloud plugin) the host installs a provider that refuses EVERYTHING from
// every peer — a viewer whose grant never lands, the strict form of the cloud race. On a deployed
// (cloud) build the plugin's own provider is used as is (E2E_CLOUD_PLUGIN=<url> loads one into a
// dev server - see helpers). On a cloud build the host approves the joiner "View only".
//
// Counterfactual: v1.39.0 (dev server, or its Pages build) — the six domain checks are red.
// Run: e2e-slot --dev <lane> 5484 -- env APP_URL=https://localhost:5484/ npm run e2e -- late-joiner-floor
//      (+ E2E_CLOUD_PLUGIN=https://theprototype.pages.dev/cloud-plugin.js for the cloud roles)
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	// a deployed cloud build registers its plugin after boot — give it the time to install its gate
	if (/pages\.dev/.test(h.URL))
		await A.page
			.waitForFunction(() => window.__stores.cloudHooks.hasCapabilityProvider(), null, { timeout: 20000 })
			.catch(() => console.log('  (no capability provider registered within 20 s)'));

	// ---------- the host authors every domain before anyone joins ----------
	const authored = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 500));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		// HUD + a shared HUD value
		s.hudDocs.setHudDocFor('scene', { screens: [{ id: 'main', name: 'Main', elements: [] }], active: 'main' });
		s.hudDocs.addHudElement('scene', 'main', { kind: 'text', label: 'Floor 49', anchor: 'top-right', x: 20, y: 20 });
		s.hudDocs.setHudValue('j1-volume', 7, { shared: true });
		// a shader graph on the object
		s.shaderGraph.setShaderGraphFor(obj.uuid, {
			nodes: [
				{ id: 'c1', type: 'color', data: { value: '#e62610' } },
				{ id: 's1', type: 'surface', data: {} }
			],
			edges: [{ id: 'e1', source: 'c1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }]
		});
		// an authored animation
		const ap = s.animationPreview;
		const track = ap.addTrack(obj.uuid, 'pos.y', obj);
		ap.updateKey(obj.uuid, track, 1, { t: 2, v: 4 });
		ap.updateAnim(obj.uuid, { duration: 2, loop: 'loop' });
		// the scene look + a room anchor
		s.scenePost.addPostEffect('huesaturation');
		s.colocation.setRoomAnchor({ pos: [1.5, 0, -2] });
		return { uuid: obj.uuid, cloud: s.cloudHooks.hasCapabilityProvider() };
	});
	console.log(`  (host build: ${authored.cloud ? 'cloud — the plugin gates' : 'plain — the suite gates every peer as a viewer'})`);

	if (!authored.cloud)
		await A.page.evaluate(() => window.__stores.cloudHooks.setCapabilityProvider(() => false));
	const C = await h.setupPage(browser, 'C');
	// premise: the host's gate refuses this joiner's CONTENT (it is a viewer to the host)
	const gate = await A.page.evaluate((cid) => {
		const k = window.__stores.cloudHooks;
		return { huds: k.canApply(cid, 'huds'), hud: k.canApply(cid, 'hud') };
	}, C.id);
	if (!authored.cloud) h.check(gate.huds === false && gate.hud === false, `premise: the host gates the joiner's content (${JSON.stringify(gate)})`);

	if (authored.cloud) {
		// a cloud build: the host approves the joiner VIEW ONLY, so it stays a viewer for the whole
		// session ("Editor access" is granted on the host before the requests arrive, which hides
		// the gap — measured green on 1.39.0 that way)
		await (await h.openDial(C.page)).fill(A.id);
		await C.page.getByRole('button', { name: 'Connect', exact: true }).click();
		await A.page.getByRole('button', { name: 'View only' }).first().click({ timeout: 30000 });
		await C.page.waitForTimeout(9000);
		const role = await A.page.evaluate((cid) => {
			let ri;
			window.__stores.cloudHooks.rolesInfo.subscribe((v) => (ri = v))();
			return ri?.roleOf?.(cid) ?? null;
		}, C.id);
		h.check(role === 'viewer', `premise: the host reads the joiner as a viewer (${role})`);
	} else await h.connect(C, A);

	const read = (uuid) =>
		C.page.evaluate((u) => {
			const s = window.__stores;
			const doc = s.hudDocs.hudDocOf('scene');
			let anim;
			s.animationPreview.animations.subscribe((v) => (anim = v))();
			let post;
			s.scenePost.scenePost.subscribe((v) => (post = v))();
			const anchor = s.colocation.roomAnchorState?.() ?? null;
			return {
				hud: doc ? doc.screens.flatMap((sc) => sc.elements.map((e) => e.label)) : null,
				value: s.hudDocs.hudValueOf('j1-volume', null),
				shader: s.shaderGraph.shaderGraphOf(u)?.nodes?.length ?? 0,
				anim: !!anim?.[u],
				post: (post?.effects ?? []).map((e) => e.kind),
				anchor: anchor?.pos ?? null
			};
		}, uuid);

	await h.eventually(() => read(authored.uuid), (r) => r.hud?.includes('Floor 49'), "the joiner gets the host's HUD (gethuds)", 20000);
	await h.eventually(() => read(authored.uuid), (r) => r.value === 7, 'and its shared HUD value (gethudvalues)', 10000);
	await h.eventually(() => read(authored.uuid), (r) => r.shader === 2, "and the object's shader graph (getshadergraphs)", 10000);
	await h.eventually(() => read(authored.uuid), (r) => r.anim, "and the object's authored animation (getanim)", 10000);
	await h.eventually(() => read(authored.uuid), (r) => r.post.includes('huesaturation'), 'and the scene look (getscenepost)', 10000);
	await h.eventually(() => read(authored.uuid), (r) => Math.abs((r.anchor?.[0] ?? 0) - 1.5) < 1e-6, 'and the room anchor (getroomanchor)', 10000);
	console.log(`  joiner state: ${JSON.stringify(await read(authored.uuid))}`);

	await h.finish(browser);
});
