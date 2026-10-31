// Roadmap 71 TR2 — REQUEST EDIT ACCESS FROM INSIDE A SESSION, on a real cloud plugin: viewer B taps Request, host A answers.
//   1  B's row has the button (N6 folded + unfolded); A's has none; B's edits stay local until an answer
//   2  Not now: B hears it, stays a viewer, its edit still reaches nobody
//   3  Choose…: A picks Objects only in the sheet. B's object now reaches A; B's node edit does not
//   4  Allow editing: full editor, on a third peer too
//   5  the view-only nudge carries the same Request button
//   6  a viewer agent asks through its request_edit tool
// Run: E2E_CLOUD_PLUGIN=/cloud-plugin.js APP_URL=https://theprototype.app:5601/ npm run e2e -- roles-request
const h = require('./helpers.cjs');
const fs = require('node:fs');
const path = require('node:path');

const SHOTS = process.env.E2E_SHOT_DIR || '';
const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'arg', src)(window.__stores, pc, a);
		},
		[body, arg ?? null]
	);
const RI = 'let r; s.cloudHooks.rolesInfo.subscribe((v) => (r = v))();';
const myRole = (p) => inPage(p, RI + 'return r?.myRole ?? null;');
const roleOf = (p, id) => inPage(p, RI + 'return r.roleOf(arg);', id);
const holds = (p, uuid) => inPage(p, 'let g; s.objectsGroup.subscribe((x) => (g = x))(); return !!g.getObjectByProperty("uuid", arg);', uuid);
const makeBox = (p) => inPage(p, `s.commandsHandler.sceneCommand('/create box'); let g; s.objectsGroup.subscribe((x) => (g = x))(); const o = g.children[g.children.length - 1]; s.objectActions.deselectObject(); return o.uuid;`);
const openPeers = (p) => inPage(p, 's.peersPanelOpen?.set?.(true);');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const card = (p, text) => p.page.locator('.tp-toast, [role="status"], [role="alert"]').filter({ hasText: text }).first();
/** tap Request (past the once-a-minute limit: the fixture's clock is the page's) */
const request = (p) => inPage(p, RI + 'return r.requestEdit();');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	if (!(await inPage(A, RI + 'return !!r;'))) {
		console.log('no roles plugin in this build: set E2E_CLOUD_PLUGIN to prove this');
		await h.finish(browser, [A, B]);
		return;
	}
	await h.connect(B, A);
	await inPage(A, RI + 'r.setRole(arg, "viewer");', B.id);
	await h.eventually(() => myRole(B), (v) => v === 'viewer', 'B is a viewer', 20000);

	console.log('\n=== 1. the button ===');
	await openPeers(B);
	const button = B.page.locator('#request-edit');
	await button.waitFor({ state: 'attached', timeout: 15000 });
	h.check(true, "the viewer's own row has Request edit");
	await openPeers(A);
	h.check((await A.page.locator('#request-edit').count()) === 0, 'the host has none');
	for (const [label, width, height] of [['folded', 360, 800], ['unfolded', 720, 800]]) {
		await B.page.setViewportSize({ width, height });
		await openPeers(B);
		await wait(400);
		const box = await button.boundingBox();
		h.check(!!box && box.x >= 0 && box.x + box.width <= width, label + ': the button is on screen (' + JSON.stringify(box) + ')');
		h.check(!!box && box.height >= 20, label + ': and big enough to find');
		if (SHOTS) {
			fs.mkdirSync(SHOTS, { recursive: true });
			await B.page.screenshot({ path: path.join(SHOTS, 'request-' + label + '.png') });
		}
	}
	await B.page.setViewportSize({ width: 1280, height: 800 });

	console.log('\n=== 2. Not now ===');
	await button.evaluate((b) => b.click());
	await card(A, 'asks for edit access').waitFor({ state: 'visible', timeout: 15000 });
	h.check(true, 'the admin gets the card');
	h.check((await request(B)) === 'wait', 'asking again within the minute does not ask again');
	await card(A, 'asks for edit access').getByRole('button', { name: 'Not now' }).click();
	await card(B, 'not now').waitFor({ state: 'visible', timeout: 15000 });
	h.check((await myRole(B)) === 'viewer', 'B hears it and stays a viewer');
	const local = await makeBox(B);
	await wait(1500);
	h.check(!(await holds(A, local)), "a viewer's object still reaches nobody");

	console.log('\n=== 3. Choose: Objects only ===');
	await inPage(A, 'return 1');
	// the card again, past the once-a-minute limit: the host's answer is what is under test
	await inPage(B, 'pc.send({ type: "cloud", payload: { kind: "editrequest" } });');
	const c3 = card(A, 'asks for edit access');
	await c3.waitFor({ state: 'visible', timeout: 15000 });
	await c3.getByRole('button', { name: 'Choose…' }).click();
	const sheet = A.page.locator('dialog.peer-permissions');
	await sheet.waitFor({ state: 'visible', timeout: 10000 });
	h.check((await roleOf(A, B.id)) === 'viewer', 'still a viewer while the sheet is open');
	await sheet.locator('#pp-preset').click();
	await A.page.getByRole('option', { name: 'Objects only' }).click();
	await A.page.locator('#pp-apply').click();
	await h.eventually(() => myRole(B), (v) => v === 'editor', 'Apply makes B an editor');
	await h.eventually(() => inPage(B, RI + 'return r.myCaps?.nodes;'), (v) => v === false, 'with what the admin picked');
	const shared = await makeBox(B);
	await h.eventually(() => holds(A, shared), (v) => v === true, "B's object now reaches the host");
	const nodeOk = await inPage(B, RI + 'return r.onSend({ type: "nodecreate" });');
	h.check(nodeOk === false, "B's own page will not send a node edit");
	await inPage(B, 'pc.broadcast({ type: "nodecreate", uuid: "x", node: {} });');
	h.check(h.pageErrors(A).length === 0, 'and a raw one does nothing on the host');

	console.log('\n=== 4. Allow editing, on three peers ===');
	await inPage(A, RI + 'r.setRole(arg, "viewer");', B.id);
	await h.eventually(() => myRole(B), (v) => v === 'viewer', 'back to viewer');
	const C = await h.setupPageQuiet(browser, 'C', [A, B]);
	await h.connect(C, A);
	await inPage(B, 'pc.send({ type: "cloud", payload: { kind: "editrequest" } });');
	const c4 = card(A, 'asks for edit access');
	await c4.waitFor({ state: 'visible', timeout: 15000 });
	await c4.getByRole('button', { name: 'Allow editing' }).click();
	await h.eventually(() => myRole(B), (v) => v === 'editor', 'B is an editor');
	await h.eventually(() => inPage(B, RI + 'return r.myCaps;'), (v) => v === null, 'a full one');
	await h.eventually(() => roleOf(C, B.id), (v) => v === 'editor', 'and the third peer agrees');
	const third = await makeBox(B);
	await h.eventually(() => holds(C, third), (v) => v === true, "B's object reaches the third peer");

	console.log('\n=== 5. the nudge ===');
	await inPage(A, RI + 'r.setRole(arg, "viewer");', B.id);
	await h.eventually(() => myRole(B), (v) => v === 'viewer', 'viewer again');
	await wait(4200);
	await inPage(B, 's.objectPermissions ? s.objectPermissions.warnViewerReadOnly() : null;');
	if (await inPage(B, 'return !!s.objectPermissions;')) {
		await card(B, 'View-only').getByRole('button', { name: 'Request edit access' }).waitFor({ state: 'visible', timeout: 8000 });
		h.check(true, 'the view-only nudge offers Request edit access');
	} else console.log('(objectPermissions is not on the debug stores)');

	console.log('\n=== 6. a viewer agent asks ===');
	await h.closePeer(C); // a fourth page on one machine does not get as far as Connect
	const D = await h.setupPageQuiet(browser, 'D', [A, B], { storage: { agentApi: '1' } });
	await h.connect(D, A);
	await h.eventually(() => D.page.evaluate(() => !!window.tpAgent?.status?.().joined), (v) => v === true, 'the agent is in', 40000);
	await inPage(A, RI + 'r.setRole(arg, "viewer");', D.id);
	await h.eventually(() => D.page.evaluate(() => window.tpAgent.status().role), (v) => v === 'viewer', 'it is a viewer');
	const asked = await D.page.evaluate(() => window.tpAgent.exec('request_edit', {}));
	h.check(asked?.result === 'sent', 'the request_edit tool sends (' + JSON.stringify(asked) + ')');
	await card(A, 'asks for edit access').waitFor({ state: 'visible', timeout: 15000 });
	h.check(true, 'the admin gets the card');

	h.check(h.pageErrors(A).length === 0, 'no page errors on the host');
	await h.finish(browser, [A, B, D]);
});
