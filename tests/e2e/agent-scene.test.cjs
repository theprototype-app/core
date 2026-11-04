// Roadmap 85 (85-scene) H1-H7 END TO END through the agent bridge: a REAL MCP stdio client spawns
// `tools/agent/src/cli.js mcp <link>`, the host approves, and every result is read back on the HOST page:
//   1  the HUD and scene-setup tools are listed
//   2  race HUD: create_hud + hud_panel reach the host's HUD document; ids come back
//   3  night scene with fog: set_sky asks the HOST (its real toast), Allow applies it; set_light adds a light
//   4  third-person spawn: place_spawn + an opening view reach the host's scene settings; first person = a
//      Character Controller node on the host; third person says it is unavailable
//   5  the host's A8 log has one line per writer; per-line Undo takes each back on the host
//   6  a viewer's page refuses every writer and may read
// Run: e2e-slot --dev <tree> 5871 -- node tests/e2e/agent-scene.test.cjs
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const TOOLS = ['create_hud', 'edit_hud', 'list_hud', 'hud_panel', 'set_sky', 'set_light', 'get_environment', 'place_spawn', 'set_play_camera'];
const WRITERS = ['create_hud', 'edit_hud', 'hud_panel', 'set_sky', 'set_light', 'place_spawn', 'set_play_camera'];

const read = (page, expr) =>
	page.evaluate(
		(e) => new Promise((r) => e.split('.').reduce((o, k) => o[k], window.__stores).subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))()),
		expr
	);
const hudOnHost = async (page) => (await read(page, 'hudDocs.hudDocs'))?.scene ?? null;
const hudElements = async (page) => ((await hudOnHost(page))?.screens ?? []).flatMap((s) => s.elements);
const envOnHost = (page) => read(page, 'environment.environment');
const playOnHost = async (page) => {
	const s = await read(page, 'scenePhysics.scenePhysicsState_');
	return { spawn: s?.play?.spawn ?? null, startView: s?.startView ?? null };
};
const controllersOnHost = async (page) => ((await read(page, 'flowGraphs'))?.scene?.nodes ?? []).filter((n) => n.type === 'charcontroller');

async function answer(page, text, word) {
	const toast = page.locator('.tp-toast').filter({ hasText: text }).last();
	await toast.waitFor({ timeout: 30000 });
	await toast.getByRole('button', { name: word, exact: true }).click({ timeout: 30000 });
}

async function startBridge(args, onChanged) {
	const { Client } = await sdk('client/index.js');
	const { StdioClientTransport } = await sdk('client/stdio.js');
	const { ToolListChangedNotificationSchema } = await sdk('types.js');
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(agentDir, 'src/cli.js'), 'mcp', ...args, '--verbose'],
		env: { ...process.env },
		stderr: 'pipe'
	});
	const client = new Client({ name: 'claude-code', version: 'e2e' });
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => onChanged && onChanged());
	await client.connect(transport);
	return { client, transport };
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
const json = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
const short = (v) => JSON.stringify(v ?? null).slice(0, 220);

const CAP_MS = 12 * 60 * 1000;
setTimeout(() => {
	console.error('SCRIPT FAILED: agent-scene passed its ' + CAP_MS / 60000 + ' min cap');
	process.exit(2);
}, CAP_MS).unref();
const bounded = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms).unref())]);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	let changed = 0;
	const B = await startBridge([BASE + '/#' + A.id], () => changed++);
	try {
		await h.approveButton(A.page).click({ timeout: 120000 });
		await h.eventually(async () => changed, (n) => n > 0, 'the host tools arrived (tools/list_changed)', 60000);
		const tools = (await B.client.listTools()).tools;
		h.check(TOOLS.every((n) => tools.some((t) => t.name === n)), '1. every HUD + scene-setup tool is listed');
		let st = null;
		for (let i = 0; i < 90 && !(st?.joined && !st.loading); i++) {
			st = json(await call(B.client, 'status'));
			if (!(st.joined && !st.loading)) await new Promise((r) => setTimeout(r, 1000));
		}
		h.check(st?.joined === true, 'premise: the agent joined');
		if (st?.joined !== true) throw new Error('the agent never joined: ' + short(st));

		console.log('\n=== 2. race HUD ===');
		const race = json(await call(B.client, 'create_hud', { screens: [{ name: 'Race', showWhile: 'playing', elements: [{ kind: 'text', text: 'Lap 1/3', anchor: 'top-left', x: 16, y: 16 }, { kind: 'timer', anchor: 'top-right', duration: 90, countDown: true }, { kind: 'bar', anchor: 'bottom', max: 100, value: 100 }] }] }));
		const ids = (race.elements || []).map((e) => e.id);
		h.check(ids.length === 3 && ids.every(Boolean), '2. create_hud returns three element ids: ' + short(race.elements));
		await h.eventually(() => hudOnHost(A.page), (d) => d?.screens?.some((s) => s.name === 'Race' && s.showWhile === 'playing' && ids.every((id) => s.elements.some((e) => e.id === id))), '2. the host has the Race screen with all three', 20000);
		const pause = json(await call(B.client, 'hud_panel', { screen: 'Paused', showWhile: 'paused', title: 'Paused', rows: [{ kind: 'button', text: 'Resume' }, { kind: 'button', text: 'Quit' }] }));
		h.check(!!pause.panel && pause.rows?.length === 3, '2. hud_panel returns the panel and its rows: ' + short(pause));
		await h.eventually(() => hudElements(A.page), (els) => els.filter((e) => e.panel === pause.panel).length === 3, '2. the host has the panel rows', 20000);
		const moved = json(await call(B.client, 'edit_hud', { updates: [{ id: ids[0], text: 'Lap 2/3' }] }));
		h.check(!moved.error, '2. edit_hud changes the lap text: ' + short(moved));
		await h.eventually(() => hudElements(A.page), (els) => els.some((e) => e.id === ids[0] && e.label === 'Lap 2/3'), '2. the host reads Lap 2/3', 20000);
		const listed = json(await call(B.client, 'list_hud'));
		h.check(listed.huds?.[0]?.screens?.some((s) => s.name === 'Race'), '2. list_hud reads it back');

		console.log('\n=== 3. night scene with fog ===');
		const asked = json(await call(B.client, 'set_sky', { background: '#05070f', fog: { color: '#05070f', density: 0.05 }, exposure: 0.5 }));
		h.check(asked.needsConfirm === true && !!asked.confirmId, '3. set_sky asks the host first: ' + short(asked));
		h.check((await envOnHost(A.page))?.preset !== 'custom', '3. nothing changed on the host yet');
		await answer(A.page, /the sky/, 'Allow');
		const sky = json(await call(B.client, 'set_sky', { confirmId: asked.confirmId, wait: 30 }));
		h.check(!sky.error && !sky.needsConfirm, '3. Allow: the re-call applied it: ' + short(sky));
		await h.eventually(() => envOnHost(A.page), (e) => e?.preset === 'custom' && e.exposure === 0.5 && e.customPreset?.fog?.far === 40, '3. the host is dark with fog (far 40 m)', 20000);
		const askedL = json(await call(B.client, 'set_light', { sun: { intensity: 0.15, color: '#8899ff' }, add: [{ kind: 'point', color: '#ffaa55', intensity: 2, position: [0, 2, 0] }] }));
		await answer(A.page, /the scene light/, 'Allow');
		const lit = json(await call(B.client, 'set_light', { confirmId: askedL.confirmId, wait: 30 }));
		const lampId = lit.created?.[0]?.envLight;
		h.check(!!lampId, '3. set_light returns the new light id: ' + short(lit));
		await h.eventually(() => envOnHost(A.page), (e) => (e?.lights || []).some((l) => l.id === lampId) && e.customPreset?.sun?.intensity === 0.15, '3. the host has the lamp and a dim moon', 20000);
		const envRead = json(await call(B.client, 'get_environment'));
		h.check(envRead.fog?.far === 40 && envRead.envLights?.some((l) => l.id === lampId), '3. get_environment reads it back: ' + short({ fog: envRead.fog, envLights: envRead.envLights }));

		console.log('\n=== 4. spawn + play camera ===');
		const spawn = json(await call(B.client, 'place_spawn', { position: [0, 0, 6], facing: [0, 0, 0] }));
		h.check(spawn.spawn?.position?.[2] === 6, '4. place_spawn answers the spawn: ' + short(spawn));
		await h.eventually(() => playOnHost(A.page), (p) => p.spawn?.position?.[2] === 6 && p.spawn.yaw === 0, '4. the host\'s scene settings have the spawn', 20000);
		const cam = json(await call(B.client, 'set_play_camera', { mode: 'first', openingView: 'spawn' }));
		h.check(!cam.error && !!cam.playCamera, '4. set_play_camera first + opening view: ' + short(cam));
		await h.eventually(() => controllersOnHost(A.page), (n) => n.length === 1, '4. the host has one Character Controller node', 20000);
		await h.eventually(() => playOnHost(A.page), (p) => Array.isArray(p.startView?.position), '4. the host has the opening view', 20000);
		const third = json(await call(B.client, 'set_play_camera', { mode: 'third' }));
		h.check(third.unavailable === true && /Possess Object/.test(third.error || ''), '4. third person is said to be unavailable, with the route: ' + String(third.error).slice(0, 80));

		console.log('\n=== 5. the A8 log + Undo from the host ===');
		await h.eventually(() => read(A.page, 'agentLog.agentLog'), (l) => WRITERS.every((t) => (l || []).some((e) => e.tool === t && e.ok !== false)), '5. the host\'s A8 log has a line for each writer', 20000);
		const log = await read(A.page, 'agentLog.agentLog');
		for (const e of (log || []).filter((x) => TOOLS.includes(x.tool))) console.log('   · ' + e.tool + ': ' + e.text);
		h.check((log || []).filter((e) => e.tool === 'set_sky' && e.ok !== false).length === 1, '5. one set_sky line: the question wrote none');
		h.check(!(log || []).some((e) => ['list_hud', 'get_environment'].includes(e.tool)), '5. a read writes no line');
		const lineOf = (tool) => {
			const line = (log || []).find((e) => e.tool === tool && e.ok !== false);
			if (!line) throw new Error('no A8 line for ' + tool);
			return line;
		};
		const undo = (tool) => A.page.evaluate((e) => window.__stores.agentLog.requestAgentUndo(e), lineOf(tool));
		await undo('hud_panel');
		await h.eventually(() => hudElements(A.page), (els) => !els.some((e) => e.panel === pause.panel), '5. Undo hud_panel: the pause panel is gone', 20000);
		await undo('set_light');
		await h.eventually(() => envOnHost(A.page), (e) => !(e?.lights || []).some((l) => l.id === lampId), '5. Undo set_light: the lamp is gone', 20000);
		await undo('set_sky');
		await h.eventually(() => envOnHost(A.page), (e) => e?.preset !== 'custom' && (e?.exposure ?? 1) === 1, '5. Undo set_sky: the host\'s look is back', 20000);
		await undo('set_play_camera');
		await h.eventually(() => playOnHost(A.page), (p) => !p.startView, '5. Undo set_play_camera: no opening view', 20000);
		await undo('place_spawn');
		await h.eventually(() => playOnHost(A.page), (p) => !p.spawn, '5. Undo place_spawn: no spawn', 20000);
	} finally {
		await bounded(B.client.close().catch(() => {}), 10000);
		try {
			if (B.transport.pid) process.kill(B.transport.pid);
		} catch {}
	}

	console.log('\n=== 6. a viewer ===');
	const V = await h.setupPage(browser, 'V', { storage: { agentApi: '1' } });
	await V.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(V, A);
	await V.page.evaluate(() =>
		window.__stores.cloudHooks.rolesInfo.set({ myId: '', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole: () => {}, synced: () => true })
	);
	const exec = (page, t, a) => page.evaluate(([x, y]) => window.tpAgent.exec(x, y), [t, a]);
	const hud0 = JSON.stringify(await hudOnHost(A.page));
	const env0 = JSON.stringify(await envOnHost(A.page));
	for (const [tool, args] of [
		['create_hud', { screens: [{ name: 'X', elements: [{ kind: 'text', text: 'hi' }] }] }],
		['edit_hud', { remove: ['x'] }],
		['hud_panel', { rows: [{ kind: 'text' }] }],
		['set_sky', { preset: 'night' }],
		['set_light', { sun: null }],
		['place_spawn', { position: [1, 0, 1] }],
		['set_play_camera', { mode: 'first' }]
	]) {
		const r = await exec(V.page, tool, args);
		h.check(r?.refused === true || r?.viewOnly === true, '6. a viewer\'s ' + tool + ' is refused: ' + String(r?.error).slice(0, 70));
	}
	const vr = await exec(V.page, 'get_environment', {});
	h.check(typeof vr?.preset === 'string', '6. a viewer may read get_environment');
	const vh = await exec(V.page, 'list_hud', {});
	h.check(Array.isArray(vh?.huds), '6. a viewer may read list_hud');
	await new Promise((r) => setTimeout(r, 1500));
	h.check(JSON.stringify(await hudOnHost(A.page)) === hud0 && JSON.stringify(await envOnHost(A.page)) === env0, '6. nothing reached the host from the viewer');

	await bounded(h.finish(browser), 30000);
	process.exit(2);
});
