// U-1: ping v2 object highlights — an object ping carries a uuid so peers flash
// a highlight box around it; positional pings carry no uuid; the VR radial
// exposes a Ping entry; the highlight clears after the ping TTL.
const h = require('./helpers.cjs');

const pingsOn = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.ping.pings.subscribe((p) => r(p))()));

const highlightChildren = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const grp = scene?.getObjectByName('ping-highlights');
					resolve(grp ? grp.children.length : -1);
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// VR radial exposes a Ping entry under Tools
	const toolIds = await A.page.evaluate(() =>
		window.__stores.vrRadialMenu.ringEntries('tools').map((e) => e.id)
	);
	h.check(toolIds.includes('ping'), `VR Tools ring has a Ping entry (${toolIds.join(',')})`);

	// A pings an OBJECT: the message carries the uuid, B highlights it
	const boxUuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		let uuid = null;
		window.__stores.objectsGroup.subscribe((g) => g?.children.forEach((c) => { if (c.name === 'Box') uuid = c.uuid; }))();
		return uuid;
	});
	await B.page.waitForTimeout(900);

	await A.page.evaluate((uuid) => window.__stores.ping.pingObject(uuid), boxUuid);
	await B.page.waitForTimeout(700);

	const bPings = await pingsOn(B.page);
	h.check(!!bPings.find((p) => p.uuid === boxUuid), 'object ping replicated to B with the uuid');

	const bHighlights = await highlightChildren(B.page);
	h.check(bHighlights >= 1, `B renders a ping highlight box for the object (${bHighlights})`);

	// a positional ping (Alt+click / Ping here) carries NO uuid → no highlight
	await A.page.evaluate(() => window.__stores.ping.sendPing([2, 0, 2]));
	await B.page.waitForTimeout(500);
	const bPings2 = await pingsOn(B.page);
	h.check(!!bPings2.find((p) => !p.uuid && p.pos[0] === 2), 'positional ping replicated without a uuid');

	// after the TTL the object highlight clears
	await B.page.waitForTimeout(4300);
	const cleared = await highlightChildren(B.page);
	h.check(cleared === 0, `highlight clears after the ping TTL (${cleared})`);

	await h.finish(browser);
});
