// Roadmap 71 TR1 — THE TRUSTED AGENT, on a real cloud plugin (E2E_CLOUD_PLUGIN): two peers + a late joiner.
//   1  an AI agent given edit access lands on the Trusted agent preset, and knows it (status().capabilities)
//   2  it creates, edits and deletes its OWN work, on every peer
//   3  clear_scene is refused, and nothing changes anywhere
//   4  deleting somebody else's object asks the host per batch: Refuse keeps it, Allow removes it everywhere
//   5  COUNTERFACTUALS: the agent's raw messages (no tool check) are dropped by every peer's gate
//   6  a late joiner enforces "own" from the map: the agent's old object deletes there too; a raw delete of a host's doesn't
//   7  the Permissions sheet: the switches, phone widths, Allow everything really is everything
//   8  undo per line still works on a limited agent
// A build with no roles plugin has nothing to prove: it says so and passes.
// Run: E2E_CLOUD_PLUGIN=/cloud-plugin.js APP_URL=https://theprototype.app:5601/ npm run e2e -- roles-capabilities
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
const exec = (p, name, args) => p.page.evaluate(([n, a]) => window.tpAgent.exec(n, a), [name, args]);
const names = (p) => inPage(p, 'let g; s.objectsGroup.subscribe((x) => (g = x))(); return (g?.children ?? []).map((o) => o.name);');
const uuidOf = (p, name) => inPage(p, 'let g; s.objectsGroup.subscribe((x) => (g = x))(); return (g?.children ?? []).find((o) => o.name === arg)?.uuid ?? null;', name);
const hostBox = (p, name) =>
	inPage(p, `s.commandsHandler.sceneCommand('/create box'); let g; s.objectsGroup.subscribe((x) => (g = x))(); const o = g.children[g.children.length - 1]; o.name = arg; s.objectActions.deselectObject(); return o.uuid;`, name);
const holds = (p, uuid) => inPage(p, 'let g; s.objectsGroup.subscribe((x) => (g = x))(); return !!g.getObjectByProperty("uuid", arg);', uuid);
const has = (name) => (list) => (list ?? []).includes(name);
const hasNot = (name) => (list) => !!list && !list.includes(name);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const madeUuid = (made) => made?.created?.[0]?.uuid ?? made?.results?.[0]?.uuid ?? made?.uuids?.[0] ?? made?.objects?.[0]?.uuid ?? null;

h.run(async () => {
	const browser = await h.launch();
	const parked = { 'win:aiAssistant': JSON.stringify({ left: 380, top: 140 }) };
	const A = await h.setupPage(browser, 'A', { storage: parked });
	const B = await h.setupPage(browser, 'B', { storage: { agentApi: '1' } });
	if (!(await inPage(A, RI + 'return !!r;'))) {
		console.log('no roles plugin in this build: set E2E_CLOUD_PLUGIN to prove this');
		await h.finish(browser, [A, B]);
		return;
	}
	await h.connect(B, A);
	await h.eventually(() => B.page.evaluate(() => !!window.tpAgent?.status?.().joined), (v) => v === true, 'the agent is in', 40000);

	console.log('\n=== 1. the agent lands on the Trusted agent preset ===');
	await inPage(A, RI + 'r.setRole(arg, "viewer"); r.setRole(arg, "editor");', B.id);
	const preset = await inPage(A, RI + 'return r.presetOf(arg);', B.id);
	if (preset !== 'trusted-agent') await inPage(A, RI + 'r.setCaps(arg, r.capCatalog().presets.find((p) => p.id === "trusted-agent").caps);', B.id);
	await h.eventually(() => inPage(A, RI + 'return r.presetOf(arg);', B.id), (v) => v === 'trusted-agent', 'the host reads it as Trusted agent');
	await h.eventually(() => B.page.evaluate(() => window.tpAgent.status().capabilities), (c) => c?.deleteOthers === 'ask', 'the agent knows what it may do');
	const seen = await B.page.evaluate(() => window.tpAgent.status().capabilities);
	h.check(seen?.clearScene === false && seen?.create === true, 'status().capabilities says create yes, clear no');

	console.log('\n=== 2. its own work ===');
	const made = await exec(B, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'box', name: 'AgentOwn' }, { kind: 'primitive', primitive: 'box', name: 'AgentTwo' }] });
	h.check(!made?.error, 'create_objects is allowed (' + JSON.stringify(made).slice(0, 90) + ')');
	await h.eventually(() => names(A), has('AgentOwn'), 'its object reaches the host');
	const own = await uuidOf(B, 'AgentOwn');
	const edited = await exec(B, 'update_objects', { updates: [{ uuid: own, position: [2, 1, 0] }] });
	h.check(!edited?.error, 'update_objects on its own object is allowed');
	await h.eventually(() => inPage(A, 'let g; s.objectsGroup.subscribe((x) => (g = x))(); return g.getObjectByProperty("uuid", arg)?.position?.x;', own), (x) => x === 2, 'and the edit lands on the host');
	const two = await uuidOf(B, 'AgentTwo');
	const gone = await exec(B, 'delete_objects', { uuids: [two] });
	h.check(gone?.deleted === 1, 'delete_objects on its own object is allowed with no card');
	await h.eventually(() => names(A), hasNot('AgentTwo'), 'and it is gone from the host');

	console.log('\n=== 3. clear_scene is off ===');
	const cleared = await exec(B, 'clear_scene', {});
	h.check(cleared?.refused === true && cleared?.capability === 'clearScene', 'clear_scene is refused, and says which switch');
	h.check((await names(A)).includes('AgentOwn'), 'nothing was cleared on the host');
	h.check((await names(B)).includes('AgentOwn'), 'nothing was cleared on the agent');

	console.log("\n=== 4. somebody else's object: asks first, per batch ===");
	const target = await hostBox(A, 'HostBox');
	await h.eventually(() => holds(B, target), (v) => v === true, "the host's box reaches the agent");
	const first = exec(B, 'delete_objects', { uuids: [target] });
	const card = A.page.locator('.tp-toast, [role="status"], [role="alert"]').filter({ hasText: 'wants to delete 1 object' }).first();
	await card.waitFor({ state: 'visible', timeout: 15000 });
	h.check(/HostBox/.test((await card.textContent()) ?? ''), 'the card names the object in the host\'s own words');
	await card.getByRole('button', { name: 'Refuse' }).click();
	const refused = await first;
	h.check(refused?.refused === true && /did not allow/.test(refused?.error ?? ''), 'Refuse reaches the agent as a refusal');
	h.check((await holds(A, target)) && (await holds(B, target)), 'the box is still there everywhere');
	const second = exec(B, 'delete_objects', { uuids: [target] });
	const card2 = A.page.locator('.tp-toast, [role="status"], [role="alert"]').filter({ hasText: 'wants to delete 1 object' }).first();
	await card2.waitFor({ state: 'visible', timeout: 15000 });
	await card2.getByRole('button', { name: 'Allow', exact: true }).click();
	const allowed = await second;
	h.check(allowed?.deleted === 1, 'Allow lets that batch through (' + JSON.stringify(allowed).slice(0, 200) + ')');
	await h.eventually(() => holds(A, target), (v) => v === false, 'and it is gone from the host');

	console.log('\n=== 5. counterfactuals: raw messages, past the tool check ===');
	const kept = await hostBox(A, 'KeptBox');
	await h.eventually(() => holds(B, kept), (v) => v === true, 'the second box reaches the agent');
	const raw = (msg) => inPage(B, 'pc.broadcast(arg);', msg);
	await raw({ type: 'delete', uuid: kept, peerId: B.id });
	await raw({ type: 'clearscene' });
	await raw({ type: 'move', uuid: kept, pos: [9, 9, 9], rot: [0, 0, 0], scale: [1, 1, 1] });
	await raw({ type: 'batch', items: [{ type: 'delete', uuid: kept, peerId: B.id }] });
	await wait(2500);
	h.check(await holds(A, kept), 'a raw delete, clear and batch are dropped by the host');
	h.check((await inPage(A, 'let g; s.objectsGroup.subscribe((x) => (g = x))(); return g.getObjectByProperty("uuid", arg)?.position?.x;', kept)) !== 9, 'and a raw move of its box too');
	const send = await inPage(B, 'let g; s.objectsGroup.subscribe((x) => (g = x))(); const before = g.getObjectByProperty("uuid", arg); pc.send({ type: "delete", uuid: arg, peerId: pc.peer.id }); return !!before;', kept);
	h.check(send === true, 'send() on the agent page is gated too (no throw)');

	console.log('\n=== 6. a late joiner enforces the same rules ===');
	const C = await h.setupPageQuiet(browser, 'C', [A, B], { storage: parked });
	await h.connect(C, A);
	await h.eventually(() => names(C), has('AgentOwn'), 'the late joiner has the scene');
	await h.eventually(() => inPage(C, RI + 'return r.presetOf(arg) || (r.capsOf(arg) ? "custom" : "");', B.id), (v) => v === 'trusted-agent', 'it knows the agent is narrowed');
	const lateOwn = await exec(B, 'delete_objects', { uuids: [own] });
	h.check(lateOwn?.deleted === 1, 'the agent deletes its old object (' + JSON.stringify(lateOwn).slice(0, 200) + ')');
	await h.eventually(() => names(C), hasNot('AgentOwn'), 'and the late joiner applies it: the map said who made it');
	await raw({ type: 'delete', uuid: kept, peerId: B.id });
	await wait(2000);
	h.check(await holds(C, kept), "a raw delete of the host's box is dropped there too");

	console.log('\n=== 7. the Permissions sheet ===');
	await inPage(A, 's.cloudHooks.permissionsFor.set(arg);', B.id);
	const sheet = A.page.locator('dialog.peer-permissions');
	await sheet.waitFor({ state: 'visible', timeout: 10000 });
	h.check((await sheet.locator('[data-cap="deleteOthers"]').count()) === 1, 'it lists the switches');
	for (const [label, width, height] of [['folded', 360, 800], ['unfolded', 720, 800], ['desktop', 1280, 800]]) {
		await A.page.setViewportSize({ width, height });
		await wait(300);
		const over = await A.page.evaluate(() => {
			const d = document.querySelector('dialog.peer-permissions .pp');
			return d ? d.scrollWidth - d.clientWidth : -1;
		});
		h.check(over <= 1, label + ' (' + width + ' wide): no sideways scroll in the sheet (' + over + ')');
		if (SHOTS) {
			fs.mkdirSync(SHOTS, { recursive: true });
			await A.page.screenshot({ path: path.join(SHOTS, 'permissions-' + label + '.png') });
		}
	}
	await A.page.setViewportSize({ width: 1280, height: 800 });
	await A.page.locator('#pp-save-name').fill('Just nodes');
	await A.page.locator('#pp-save').click();
	await h.eventually(() => inPage(A, RI + 'return r.capCatalog().presets.some((p) => p.label === "Just nodes" && p.custom);'), (v) => v === true, 'Save keeps a custom preset on this device');
	await sheet.locator('[data-cap="clearScene"] button').click();
	await A.page.locator('#pp-apply').click();
	await h.eventually(() => B.page.evaluate(() => window.tpAgent.status().capabilities?.clearScene), (v) => v === true, 'a switch reaches the agent');
	await inPage(A, RI + 'r.setCaps(arg, r.capCatalog().presets.find((p) => p.id === "everything").caps);', B.id);
	await h.eventually(() => inPage(B, RI + 'return r.amAdmin;'), (v) => v === true, 'Allow everything = the same controls an admin has');
	await h.eventually(() => inPage(A, RI + 'return r.roleOf(arg);', B.id), (v) => v === 'editor', 'and no admin handover happened');

	console.log('\n=== 8. undo per line ===');
	await inPage(A, RI + 'r.setCaps(arg, r.capCatalog().presets.find((p) => p.id === "trusted-agent").caps);', B.id);
	await h.eventually(() => B.page.evaluate(() => window.tpAgent.status().capabilities?.clearScene), (v) => v === false, 'back on Trusted agent');
	const again = await exec(B, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'box', name: 'UndoMe' }] });
	h.check(!again?.error, 'it builds again');
	await h.eventually(() => names(A), has('UndoMe'), 'the box lands');
	await inPage(A, 's.aiAssistantHidden.set("");');
	const line = A.page.locator('.alog-line', { hasText: /box|object|create/i }).last();
	await line.waitFor({ state: 'attached', timeout: 15000 });
	await line.locator('.alog-undo').evaluate((b) => b.click());
	await h.eventually(() => names(A), hasNot('UndoMe'), 'Undo on its log line removes it on the host');

	h.check(h.pageErrors(A).length === 0, 'no page errors on the host (' + h.pageErrors(A).slice(0, 2).join(' | ').slice(0, 200) + ')');
	await h.finish(browser, [A, B, C]);
});
