// A build meant to have roles, before its plugin has spoken, two real peers. The plugin here is a small stand-in
// behind a gate the test opens, so the window is as long as the test needs and not a race:
//   1. H waiting, G joins: the join goes through (the floor passes), G's edits do not apply;
//      the plugin arrives and says viewer: they are dropped for good;
//   2. the same with the plugin saying editor: they apply, in the order they were sent;
//   3. G waiting: the host's world is held, the plugin arrives, the world lands;
//   4. the plugin fails to load: G's edits stay out and the host reads G as a viewer;
//   5. the plugin takes too long: the same, and when it does arrive it takes over.
//
// Run: APP_URL='https://localhost:5990/' npm run e2e -- roles-wait
const h = require('./helpers.cjs');

const STUB = `
await globalThis.__pluginGate;
const VIEWER = new Set(['sent', 'info', 'ping', 'camera', 'specator', 'agentview']);
export function register(api) {
	globalThis.__pluginRegistered = true;
	api.setCapabilityProvider((id, type) => globalThis.__pluginSays === 'editor' || VIEWER.has(type));
}`;
const pluginUrl = 'data:text/javascript;base64,' + Buffer.from(STUB).toString('base64');
const init = (url, waitMs = 600000) => ({
	init: [
		([u, ms]) => {
			globalThis.__pluginGate = new Promise((r) => (globalThis.__openPlugin = r));
			localStorage.setItem('cloudPluginUrl', u);
			localStorage.setItem('cloudPluginWaitMs', String(ms));
		},
		[url, waitMs]
	]
});
const count = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.filter((c) => c.isMesh).length;
	});
const names = (p) =>
	p.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.filter((c) => c.isMesh).map((c) => c.name);
	});
const pending = (p) => p.page.evaluate(() => window.__stores.cloudHooks.rolesPending?.() ?? null);
const roster = (p, id) =>
	p.page.evaluate((x) => {
		let p;
		window.__stores.peers.subscribe((v) => (p = v))();
		return !!p?.openedPeers?.has(x);
	}, id);
const create = (p) => p.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
const ready = (p) => p.page.waitForFunction(() => !!window.__stores?.cloudHooks && !!window.__stores?.commandsHandler, null, { timeout: 90000 });
const opened = (p, says) =>
	p.page.evaluate((s) => {
		globalThis.__pluginSays = s;
		globalThis.__openPlugin();
	}, says);

h.run(async () => {
	const browser = await h.launch();

	// ---- 1. the host is waiting, the plugin says viewer ---------------------------------------------
	{
		const H = await h.setupPage(browser, 'H1', init(pluginUrl));
		const G = await h.setupPage(browser, 'G1');
		await Promise.all([ready(H), ready(G)]);
		h.check((await pending(H)) === true, 'premise: H is waiting for its plugin');
		await h.connect(G, H);
		await h.eventually(() => roster(H, G.id), (x) => x === true, 'the join goes through while H waits', 30000);
		await create(G);
		await create(G);
		await h.eventually(() => count(G), (n) => n === 2, 'premise: G made two boxes', 15000);
		await H.page.waitForTimeout(2500);
		h.check((await count(H)) === 0, "G's edits do not apply on H while nobody knows G's role");
		await opened(H, 'viewer');
		await h.eventually(() => pending(H), (x) => x === false, 'the plugin arrives and the wait ends', 15000);
		await H.page.waitForTimeout(1500);
		h.check((await count(H)) === 0, '…it says viewer: the held edits are dropped');
		await create(G);
		await H.page.waitForTimeout(1500);
		h.check((await count(H)) === 0, "…and G's next edit too");
		await H.page.context().close();
		await G.page.context().close();
	}

	// ---- 2. the host is waiting, the plugin says editor -----------------------------------------------
	{
		const H = await h.setupPage(browser, 'H2', init(pluginUrl));
		const G = await h.setupPage(browser, 'G2');
		await Promise.all([ready(H), ready(G)]);
		await h.connect(G, H);
		await h.eventually(() => roster(H, G.id), (x) => x === true, 'premise: joined', 30000);
		for (let i = 0; i < 3; i++) {
			await create(G);
			await G.page.waitForTimeout(150);
		}
		await h.eventually(() => count(G), (n) => n === 3, 'premise: G made three boxes', 15000);
		await H.page.waitForTimeout(2000);
		h.check((await count(H)) === 0, 'they wait on H');
		const order = await names(G);
		await opened(H, 'editor');
		await h.eventually(() => count(H), (n) => n === 3, 'the plugin says editor: the held edits apply', 15000);
		const got = await names(H);
		h.check(JSON.stringify(got) === JSON.stringify(order), `…in the order they were sent (${got} vs ${order})`);
		await H.page.context().close();
		await G.page.context().close();
	}

	// ---- 3. the joiner is waiting ---------------------------------------------------------------------
	{
		const H = await h.setupPage(browser, 'H3');
		const G = await h.setupPage(browser, 'G3', init(pluginUrl));
		await Promise.all([ready(H), ready(G)]);
		await create(H);
		await create(H);
		await h.eventually(() => count(H), (n) => n === 2, 'premise: H has a world', 15000);
		await h.connect(G, H);
		await h.eventually(() => roster(G, H.id), (x) => x === true, 'the joiner is in while its plugin loads', 30000);
		await G.page.waitForTimeout(1500);
		h.check((await count(G)) === 0, "the host's world waits on G");
		await opened(G, 'editor');
		await h.eventually(() => count(G), (n) => n === 2, "the plugin arrives: the host's world lands, nothing was lost", 20000);
		await H.page.context().close();
		await G.page.context().close();
	}

	// ---- 4. the plugin does not come ------------------------------------------------------------------
	{
		const broken = 'data:text/javascript;base64,' + Buffer.from('throw new Error("nope");').toString('base64');
		const H = await h.setupPage(browser, 'H4', init(broken));
		const G = await h.setupPage(browser, 'G4');
		await Promise.all([ready(H), ready(G)]);
		await h.eventually(() => pending(H), (x) => x === false, 'the failed load ends the wait', 30000);
		await h.connect(G, H);
		await h.eventually(() => roster(H, G.id), (x) => x === true, 'a join still goes through', 30000);
		await create(G);
		await h.eventually(() => count(G), (n) => n === 1, 'premise: G made a box', 15000);
		await H.page.waitForTimeout(2500);
		h.check((await count(H)) === 0, "G's edit does not apply on a host whose plugin failed");
		const role = await H.page.evaluate((id) => window.__stores.cloudHooks.knownRoleOf?.(id) ?? null, G.id);
		h.check(role === 'viewer', `…the host reads G as a viewer (${role})`);
		await H.page.context().close();
		await G.page.context().close();
	}

	// ---- 5. the plugin takes too long ------------------------------------------------------------------
	{
		const H = await h.setupPage(browser, 'H5', init(pluginUrl, 1000));
		const G = await h.setupPage(browser, 'G5');
		await Promise.all([ready(H), ready(G)]);
		await h.eventually(() => pending(H), (x) => x === false, 'the wait has an end', 30000);
		await h.connect(G, H);
		await h.eventually(() => roster(H, G.id), (x) => x === true, 'a join still goes through', 30000);
		await create(G);
		await h.eventually(() => count(G), (n) => n === 1, 'premise: G made a box', 15000);
		await H.page.waitForTimeout(2500);
		h.check((await count(H)) === 0, "G's edit does not apply on a host still without its plugin");
		await opened(H, 'editor');
		await h.eventually(() => H.page.evaluate(() => !!globalThis.__pluginRegistered), (x) => x === true, 'the plugin arrives late', 15000);
		await create(G);
		await h.eventually(() => count(H), (n) => n >= 1, "…and takes over: G's next edit applies", 15000);
		await H.page.context().close();
		await G.page.context().close();
	}

	await h.finish(browser);
});
