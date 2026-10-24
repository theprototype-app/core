// Roadmap 67 — AGENT PANELS, the release proof. A REAL MCP stdio client spawns `tools/agent/src/cli.js mcp
// <link> --machine e2e-deck --tools-dir <dir>` and plays a Pixling agent: it opens a panel for the person it
// works for, re-renders a preview when a slider moves, and imports the sheet when Render is pressed. Three
// people: A hosts (the owner), E edits, V views (roles through the bridge's TP_AGENT_INIT_SCRIPT seam).
//   1  the bridge declares Pixling (P6): A and E hear it, V does not; the panel tools are listed
//   2  open_panel for A ("Panel by … on e2e-deck"); E and V have no copy; a password field is refused
//   3  A moves the slider → a change event → the agent renders a PNG (node zlib) → update_panel preview
//   4  A presses Render → a press event → import_file (the Pixling fixture) → the card on every page;
//      the AI window's Undo removes it on every page
//   5  Share with editors: E gets a copy, V never does; E's change reaches the agent and A's copy; V's
//      forged event and tool request are dropped by the agent page
//   6  Save as .tppanel → Explorer ▸ Panels; close (E's copy goes too); reopen → the agent takes it back
//   7  P6: A asks for the declared tool's panel and the agent opens it
//   8  axe (serious/critical) on an open panel; the N6 folded width (390 px): the window fits, Render works
//   9  Close all
//
// Run: APP_URL='https://theprototype.app:5498/' npm run e2e -- agent-panels
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { AxeBuilder } = require('@axe-core/playwright');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const PIX = path.join(__dirname, 'fixtures', 'pixling');

/** the Pixling panel (what a real Pixling bridge tool would declare) */
const SPEC = {
	v: 1,
	title: 'Pixling',
	icon: 'image',
	toolId: 'pixling',
	sections: [
		{
			title: 'Sprite',
			controls: [
				{ type: 'select', id: 'clip', label: 'Clip', options: ['walk', 'idle'], value: 'walk' },
				{ type: 'slider', id: 'scale', label: 'Scale', min: 1, max: 8, step: 1, value: 2, unit: 'x' },
				{ type: 'image', id: 'preview', label: 'Preview', alt: 'Pixling preview', pixelated: true },
				{ type: 'button', id: 'render', label: 'Render', variant: 'primary' },
				{ type: 'status', id: 'status', text: 'Ready' }
			]
		}
	]
};

// ---------------------------------------------------------------- a PNG, the way a renderer makes one
const CRC = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return (buf) => {
		let c = 0xffffffff;
		for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
})();
const chunk = (type, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(CRC(body));
	return Buffer.concat([len, body, crc]);
};
/** an RGBA PNG of a `scale`-sized checker knight placeholder @param {number} scale */
function renderPng(scale) {
	const w = 8 * scale;
	const hgt = 8 * scale;
	const raw = Buffer.alloc((w * 4 + 1) * hgt);
	for (let y = 0; y < hgt; y++) {
		raw[y * (w * 4 + 1)] = 0;
		for (let x = 0; x < w; x++) {
			const on = (Math.floor(x / scale) + Math.floor(y / scale)) % 2 === 0;
			const o = y * (w * 4 + 1) + 1 + x * 4;
			raw[o] = on ? 220 : 40;
			raw[o + 1] = on ? 120 : 40;
			raw[o + 2] = on ? 40 : 90;
			raw[o + 3] = 255;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(hgt, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
	return { src: 'data:image/png;base64,' + png.toString('base64'), w, h: hgt };
}

// ---------------------------------------------------------------- page helpers
const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'arg', src)(window.__stores, pc, a);
		},
		[body, arg ?? null]
	);
/** the panels a page shows (agentPanels.js, a lazy debug row) */
const panelsOn = (peer) =>
	inPage(peer, `let v; s.agentPanels.agentPanels.subscribe((x) => (v = x))(); return JSON.parse(JSON.stringify(v ?? []));`).catch(() => []);
const toolsOn = (peer) => inPage(peer, `let v; s.agentTools.subscribe((x) => (v = x))(); return JSON.parse(JSON.stringify(v ?? {}));`).catch(() => ({}));
const sceneNames = (peer) => inPage(peer, `let g; s.objectsGroup.subscribe((v) => (g = v))(); return g ? g.children.map((c) => c.name) : [];`);
const library = (peer) =>
	inPage(
		peer,
		`let items, folders; s.explorer.explorerItems.subscribe((v) => (items = v))(); s.explorer.explorerFolders.subscribe((v) => (folders = v))();
		 const byId = new Map((folders ?? []).map((f) => [f.id, f]));
		 return (items ?? []).map((i) => ({ id: i.id, name: i.name, folder: byId.get(i.folderId)?.name ?? '' }));`
	);

/**
 * Click a control the way a person would — unless something else is on top of it (the loaded-box auto-quality
 * toast sits at y≈80-230, over the panel's default spot): then name the cover in the log and press the control
 * itself, so the suite tests the panel and not the toast.
 */
let starved = 0;
async function press(locator) {
	await locator.scrollIntoViewIfNeeded();
	const cover = await locator.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		return !top || el.contains(top) ? null : (top.id ? '#' + top.id : '') + '.' + String(top.className).split(' ').slice(0, 3).join('.') + ' ' + (top.textContent ?? '').trim().slice(0, 60);
	});
	if (!cover && starved) {
		console.log(`  [press] frames were starved (${starved} frames/s) — pressing the control directly`);
		return locator.dispatchEvent('click');
	}
	if (!cover) {
		const ok = await locator.click({ timeout: 10000 }).then(() => true, () => false);
		if (ok) return;
		// the pointer path needs frames, and a loaded box's software GL can starve them: measure, say so, press
		const fps = await locator.page().evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => (performance.now() - t0 < 1000 ? (n++, requestAnimationFrame(f)) : r(n)); requestAnimationFrame(f); setTimeout(() => r(n), 3000); }));
		starved = Math.max(1, fps);
		console.log(`  [press] the pointer click did not complete in 10 s (page at ${fps} frames/s) — pressing the control directly`);
		return locator.dispatchEvent('click');
	}
	console.log('  [press] covered by ' + cover + ' — pressing the control directly');
	return locator.dispatchEvent('click');
}

/** poll `fn` until `pred` holds or the time is up; returns the LAST value */
async function poll(fn, pred, timeout = 15000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (pred(last)) return last;
		await new Promise((r) => setTimeout(r, 400));
	}
	return last;
}

async function startMcp(link, env, extra = []) {
	const { Client } = await sdk('client/index.js');
	const { StdioClientTransport } = await sdk('client/stdio.js');
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(agentDir, 'src/cli.js'), 'mcp', link, '--verbose', ...extra],
		env: { ...process.env, ...env },
		stderr: 'pipe'
	});
	/** @type {string[]} */
	const log = [];
	const client = new Client({ name: 'claude-code', version: 'e2e' });
	transport.stderr.on('data', (d) => log.push(...String(d).split('\n').filter(Boolean)));
	await client.connect(transport);
	return { client, transport, log, pid: transport.pid };
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 700000 });
const text = (r) => r.content.find((c) => c.type === 'text')?.text ?? '';
const json = (r) => {
	try {
		return JSON.parse(text(r));
	} catch {
		return { __text: text(r) };
	}
};

h.run(async () => {
	const browser = await h.launch();

	const A = await h.setupPage(browser, 'host');
	const E = await h.setupPageQuiet(browser, 'editor', [A]);
	await h.connect(E, A);
	const V = await h.setupPageQuiet(browser, 'viewer', [A, E]);
	await h.connect(V, A);
	const link = BASE + '/#' + A.id;
	// four pages render software GL on one box (A, E, V and the agent's). This suite reads every page through its
	// stores and DOM, never its pixels, so their scene frames stop (the app's own overload pause): the box has
	// room for the mesh, and A's pointer path keeps its frames (at ~1 frame/s a Playwright click never lands)
	for (const P of [A, E, V]) await P.page.evaluate(() => window.__stores.overloadGuard.pauseRendering('e2e: agent-panels reads stores only'));
	// the pause brings up the guard's own "Rendering paused" card over the page; it is not what this suite tests,
	// and on A it would sit over every panel control the suite clicks
	await A.page.addStyleTag({ content: '#render-paused { display: none !important; }' });

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-panels-e2e-'));
	const initScript = path.join(tmp, 'roles.js');
	fs.writeFileSync(
		initScript,
		`localStorage.setItem('debugStores', 'true');
		 (function poll() {
		   const h = window.__stores && window.__stores.cloudHooks;
		   if (!h || !h.rolesInfo) return setTimeout(poll, 200);
		   const roles = ${JSON.stringify({ [V.id]: 'viewer', [V.id.toLowerCase()]: 'viewer' })};
		   h.rolesInfo.set({ myId: null, myRole: 'editor', amAdmin: false, order: [], roleOf: (id) => roles[id] || roles[String(id).toLowerCase()] || 'editor', setRole: () => {} });
		 })();`
	);
	const toolsDir = path.join(tmp, 'tools');
	fs.mkdirSync(toolsDir);
	// a manifest may carry a command for 66 S4b — it must never leave this machine
	fs.writeFileSync(path.join(toolsDir, 'pixling.json'), JSON.stringify({ id: 'pixling', name: 'Pixling', description: 'pixel sprites', command: 'pixling build --secret-flag', panel: SPEC }));

	const B = await startMcp(link, { TP_AGENT_INIT_SCRIPT: initScript }, ['--machine', 'e2e-deck', '--tools-dir', toolsDir]);
	/** panel events read past while waiting for another */
	const seenEvents = [];
	/** wait_for_message until a panel event matching `pred` (or null when the time is up) */
	async function nextPanel(pred, seconds = 30) {
		const until = Date.now() + seconds * 1000;
		while (Date.now() < until) {
			const left = Math.max(2, Math.round((until - Date.now()) / 1000));
			const r = await call(B.client, 'wait_for_message', { timeoutS: left });
			if (text(r) === 'null') return null;
			const m = json(r);
			seenEvents.push(m);
			if (m.kind === 'panel' && pred(m)) return m;
		}
		return null;
	}
	let agentId = '';
	try {
		// ---- 1. the bridge, the declared tool -------------------------------------------------------
		await h.approveButton(A.page).click({ timeout: 120000 });
		let st = null;
		for (let i = 0; i < 120 && !st?.joined; i++) {
			st = json(await call(B.client, 'status'));
			if (!st.joined) await new Promise((r) => setTimeout(r, 1000));
		}
		h.check(st?.joined === true, 'the agent joined after Approve');
		agentId = String(st?.session?.peerId ?? '').toLowerCase();
		h.check(/^1\.([2-9]|\d{2,})\./.test(st?.session?.version ?? ''), 'tpAgent 1.2+ (agent panels): ' + st?.session?.version);
		// the page's tools reach the bridge's list once it joined (tools.listChanged)
		const listed = await poll(async () => (await B.client.listTools()).tools.map((t) => t.name), (l) => l.includes('open_panel'), 30000);
		h.check(['open_panel', 'update_panel', 'close_panel', 'list_panels', 'import_file'].every((n) => listed.includes(n)), `the panel tools are listed by the bridge (${listed.filter((n) => /panel/.test(n)).join(', ')})`);
		// E and V hear the agent over their own connections: wait for the mesh before reading what they heard
		for (const [who, P] of [['E', E], ['V', V]])
			await h.eventually(() => inPage(P, `return [...(pc?.openedPeers ?? [])].map((x) => String(x).toLowerCase());`), (l) => l.includes(agentId), 'the agent is in the mesh with ' + who, 60000);
		const toolsA = await poll(() => toolsOn(A), (m) => (m[agentId] ?? []).some((t) => t.id === 'pixling'), 30000);
		h.check((toolsA[agentId] ?? []).some((t) => t.id === 'pixling' && t.name === 'Pixling' && t.panel === true), `A heard the declared Pixling tool, with a panel (${JSON.stringify(toolsA[agentId])})`);
		h.check(!JSON.stringify(toolsA).includes('secret-flag') && !JSON.stringify(toolsA).includes('command'), "the manifest's command never left the machine");
		h.check((await poll(() => toolsOn(E), (m) => !!m[agentId], 15000))[agentId]?.length === 1, 'E heard it too');
		h.check(!(await toolsOn(V))[agentId], 'the viewer was not told about it');

		// ---- 2. open_panel for the person the agent works for ----------------------------------------
		const chatId = 'chat-pix-' + Date.now().toString(36);
		let w = call(B.client, 'wait_for_message', { timeoutS: 60 });
		await inPage(A, `pc.send({ type: 'agentchat', from: pc.peer.id, id: 'q1', chatId: arg.chatId, to: arg.to, text: 'give me a Pixling panel for the knight' }); return true;`, { chatId, to: agentId });
		h.check(json(await w).id === 'q1', 'the request reached the agent');
		const bad = json(await call(B.client, 'open_panel', { spec: { v: 1, title: 'Login', controls: [{ type: 'text', id: 'password', label: 'Password' }] } }));
		h.check(bad.refused === true && /password/i.test(bad.error ?? ''), `a password field is refused with the reason (${(bad.error ?? '').slice(0, 100)})`);
		const opened = json(await call(B.client, 'open_panel', { spec: SPEC }));
		h.check(opened.ok === true && opened.owner === A.id.toLowerCase(), `open_panel: for the person asking (owner ${opened.owner})`);
		const panelId = opened.panelId;
		await call(B.client, 'reply', { text: 'Opened the Pixling panel.', final: true });
		const onA = await poll(() => panelsOn(A), (l) => l.some((p) => p.id === panelId && p.live), 20000);
		const pA = onA.find((p) => p.id === panelId);
		h.check(!!pA && pA.machine === 'e2e-deck' && pA.owner === A.id.toLowerCase(), `A shows the panel, live, from e2e-deck (${JSON.stringify(pA && { machine: pA.machine, agentName: pA.agentName })})`);
		const win = A.page.locator(`[data-agent-panel="${pA?.key}"]`);
		// the layer is a lazy {#await import()} in App.svelte: a cold dev-server compile on a loaded box takes a while
		const drawn = await win.waitFor({ timeout: 60000 }).then(() => true, () => false);
		if (!drawn)
			console.log(
				'  [diag] ' +
					JSON.stringify(
						await A.page.evaluate((key) => {
							const el = document.querySelector(`[data-agent-panel="${key}"]`);
							const r = el?.getBoundingClientRect();
							let live = -1;
							window.__stores.agentPanelsLive.subscribe((v) => (live = v))();
							return {
								live,
								bodies: document.querySelectorAll('[data-agent-panel]').length,
								toolboxes: [...document.querySelectorAll('.toolbox')].map((t) => t.id + ':' + getComputedStyle(t).display + ':' + getComputedStyle(t).visibility),
								rect: r ? [r.x, r.y, r.width, r.height] : null,
								locked: (() => { let v; window.__stores.isLocked.subscribe((x) => (v = x))(); return v; })()
							};
						}, pA?.key)
					)
			);
		h.check(drawn, 'A draws the panel window');
		const ownerText = await A.page.locator('[data-agent-panel-owner]').first().textContent();
		h.check(/^Panel by .+ on e2e-deck$/.test((ownerText ?? '').trim()), `the header says whose panel it is ("${ownerText?.trim()}")`);
		await new Promise((r) => setTimeout(r, 1500));
		h.check((await panelsOn(E)).length === 0 && (await panelsOn(V)).length === 0, 'E and V have no copy (owner only until shared)');

		// ---- 3. a slider → change event → re-render → preview --------------------------------------
		const slider = A.page.locator(`[data-agent-panel="${pA.key}"] [data-control="scale"] input[type=range]`);
		await slider.focus();
		await slider.press('ArrowRight');
		const ch = await nextPanel((m) => m.event === 'change' && m.control === 'scale');
		h.check(ch?.value === 3 && ch.from === A.id.toLowerCase() && ch.role === 'editor' && ch.values?.clip === 'walk', `the slider move reached the agent as a panel change (${JSON.stringify(ch && { value: ch.value, role: ch.role, values: ch.values })})`);
		h.check(typeof ch?.note === 'string' && /panel/.test(ch.note), 'with the MCP note telling the model what a panel event is');
		const img = renderPng(ch?.value ?? 3);
		const up = json(await call(B.client, 'update_panel', { panelId, controls: { preview: { src: img.src }, status: { text: 'Preview at 3x', tone: 'ok' } } }));
		h.check(up.ok === true && up.rev > 1, `update_panel took the new preview (rev ${up.rev})`);
		const shown = await poll(
			() => A.page.locator(`[data-agent-panel="${pA.key}"] img.ap-image`).evaluate((el) => ({ w: el.naturalWidth, src: el.getAttribute('src')?.slice(0, 30) })).catch(() => null),
			(x) => x?.w === img.w,
			15000
		);
		h.check(shown?.w === img.w, `A draws the re-rendered preview (${img.w} px wide: ${JSON.stringify(shown)})`);
		h.check(/Preview at 3x/.test((await win.textContent()) ?? ''), 'and the status line');

		// ---- 4. Render → import_file → the card everywhere; Undo on every page ----------------------
		await press(A.page.locator(`[data-agent-panel="${pA.key}"] [data-control="render"] button`));
		const pressed = await nextPanel((m) => m.event === 'press' && m.control === 'render');
		h.check(pressed?.values?.scale === 3, `Render arrived as a press, with the values (${JSON.stringify(pressed?.values)})`);
		await call(B.client, 'update_panel', { panelId, controls: { status: { text: 'Rendering…' } } });
		const imp = await call(B.client, 'import_file', { path: path.join(PIX, 'knight_walk.png'), spec_path: path.join(PIX, 'knight.pixling.json'), frame: { w: 64, h: 48, col: 0, row: 0 }, position: [4, 0.5, 0] });
		const impJ = json(imp);
		h.check(!imp.isError && !!impJ.uuid, `import_file placed the sheet (${text(imp).slice(0, 120)})`);
		await call(B.client, 'update_panel', { panelId, controls: { status: { text: 'Rendered knight_walk.png', tone: 'ok' } } });
		for (const [who, P] of [['A', A], ['E', E], ['V', V]]) await h.eventually(() => sceneNames(P), (n) => n.includes('knight_walk'), 'the card reached ' + who, 20000);
		await inPage(A, "s.aiAssistantHidden.set('')");
		const line = A.page.locator('#agent-log .alog-line', { hasText: 'imported knight_walk.png' });
		await line.first().waitFor({ timeout: 10000 }).catch(() => {});
		h.check((await line.count()) === 1, "A's AI window has ONE line for the import");
		await line.first().locator('.alog-undo').dispatchEvent('click');
		for (const [who, P] of [['A', A], ['E', E], ['V', V]]) await h.eventually(() => sceneNames(P), (n) => !n.includes('knight_walk'), 'Undo removed the card on ' + who, 20000);
		await inPage(A, "s.aiAssistantHidden.set('agent')").catch(() => {});

		// ---- 5. Share with editors; a viewer gets none and cannot act --------------------------------
		await press(A.page.locator('.ap-share').first());
		const shared = await nextPanel((m) => m.event === 'shared');
		h.check(!!shared && shared.from === A.id.toLowerCase(), 'Share reached the agent as a "shared" event');
		const onE = await poll(() => panelsOn(E), (l) => l.some((p) => p.id === panelId), 20000);
		const pE = onE.find((p) => p.id === panelId);
		h.check(!!pE && pE.shared === true && pE.values.scale === 3, `E holds a shared copy with the current values (${JSON.stringify(pE?.values)})`);
		h.check(!(await E.page.locator('.ap-share').count()), 'E is not the owner: no Share button');
		await new Promise((r) => setTimeout(r, 1500));
		h.check((await panelsOn(V)).length === 0, 'the viewer got no copy');
		await inPage(E, `return s.agentPanels.changeControl(arg, 'clip', 'idle');`, pE.key);
		const chE = await nextPanel((m) => m.event === 'change' && m.control === 'clip');
		h.check(chE?.value === 'idle' && chE.from === E.id.toLowerCase(), `E's change reached the agent, from E (${JSON.stringify(chE && { value: chE.value, from: chE.from })})`);
		await h.eventually(() => panelsOn(A), (l) => l.find((p) => p.id === panelId)?.values?.clip === 'idle', "A's copy shows E's change", 15000);
		// the viewer forges an event and a tool request straight at the agent: both dropped
		await inPage(V, `const c = Object.entries(pc.connections).find(([k]) => k.toLowerCase() === arg.agent)?.[1]; c.send({ type: 'agentpanel', op: 'event', panel: arg.panel, control: 'scale', kind: 'change', value: 7 }); c.send({ type: 'agentpanel', op: 'request', toolId: 'pixling' }); c.send({ type: 'agentpanel', op: 'event', panel: arg.panel, control: 'render', kind: 'press' }); return true;`, { agent: agentId, panel: panelId });
		const forged = await nextPanel(() => true, 5);
		h.check(forged === null, `nothing from the viewer reached the agent (${JSON.stringify(forged)?.slice(0, 160)})`);
		h.check(json(await call(B.client, 'list_panels')).panels.length === 1, 'and no panel was opened for the viewer');
		h.check((await panelsOn(A)).find((p) => p.id === panelId)?.values?.scale === 3, 'the forged value changed nothing');

		// ---- 6. Save as .tppanel, close, reopen ------------------------------------------------------
		await press(A.page.locator('.ap-save').first());
		const lib = await poll(() => library(A), (l) => l.some((i) => /\.tppanel$/.test(i.name)), 15000);
		const saved = lib.find((i) => /\.tppanel$/.test(i.name));
		h.check(saved?.name === 'Pixling.tppanel' && saved.folder === 'Panels', `saved as Explorer ▸ Panels/Pixling.tppanel (${JSON.stringify(saved)})`);
		await press(A.page.locator('.ap-close').first());
		const closed = await nextPanel((m) => m.event === 'closed');
		h.check(!!closed && closed.from === A.id.toLowerCase(), "the owner's close reached the agent");
		await h.eventually(() => panelsOn(E), (l) => !l.some((p) => p.id === panelId), "E's copy closed with it", 15000);
		h.check(json(await call(B.client, 'list_panels')).panels.length === 0, 'the agent holds no panel now');
		const key = await inPage(A, `return s.agentPanels.openSavedPanelItem(arg);`, saved);
		h.check(typeof key === 'string', 'the saved file opens (Explorer open = openSavedPanelItem)');
		const reopened = await nextPanel((m) => m.event === 'reopened');
		h.check(!!reopened && reopened.values?.scale === 3 && reopened.values?.clip === 'idle', `the agent took it back with the saved values (${JSON.stringify(reopened?.values)})`);
		const back = await poll(() => panelsOn(A), (l) => l.length === 1 && l[0].live && l[0].id === reopened?.panelId, 15000);
		h.check(back.length === 1 && back[0].live === true && !back[0].key.startsWith('saved:'), `the reopened panel is live again on A, in place of the waiting one (${JSON.stringify(back.map((p) => ({ key: p.key, live: p.live })))})`);

		// ---- 7. P6: ask for the declared tool's panel ------------------------------------------------
		await inPage(A, `return s.agentPanels.requestToolPanel(arg, 'pixling');`, agentId);
		const req = await nextPanel((m) => m.event === 'opened');
		h.check(req?.toolId === 'pixling' && req.from === A.id.toLowerCase(), `the agent opened Pixling's panel on request (${JSON.stringify(req && { toolId: req.toolId })})`);
		await h.eventually(() => panelsOn(A), (l) => l.length === 2, 'A shows both panels', 30000);

		// ---- 8. axe on an open panel; the N6 folded width -------------------------------------------
		await A.page.waitForTimeout(800);
		const axe = await new AxeBuilder({ page: A.page }).include('[role=region][id^="ap-"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
		for (const v of axe.violations) console.log(`  [axe] ${v.impact} ${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
		const gated = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
		h.check(gated.length === 0, `no serious/critical axe violations on the open panels (${gated.map((v) => v.id).join(', ') || 'none'})`);
		const desk = A.page.viewportSize();
		await A.page.setViewportSize({ width: 390, height: 896 });
		await A.page.waitForTimeout(1200);
		const box = await A.page.locator('[data-agent-panel]').last().boundingBox();
		h.check(!!box && box.x >= -1 && box.x + box.width <= 391, `at the N6 folded width the panel fits the screen (${JSON.stringify(box)})`);
		const overflow = await A.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		h.check(overflow <= 1, `no sideways page scroll (${overflow} px)`);
		const last = (await panelsOn(A)).at(-1);
		await press(A.page.locator(`[data-agent-panel="${last.key}"] [data-control="render"] button`));
		const pressPhone = await nextPanel((m) => m.event === 'press' && m.panelId === last.id);
		h.check(!!pressPhone, 'Render still works at the folded width');
		await A.page.setViewportSize(desk ?? { width: 1280, height: 720 });

		// ---- 9. Close all ---------------------------------------------------------------------------
		await press(A.page.locator('.ap-closeall').first());
		await h.eventually(() => panelsOn(A), (l) => l.length === 0, 'Close all closed every panel on A', 10000);
		h.check(!!(await nextPanel((m) => m.event === 'closed', 15)), 'the agent heard the closes');
		await h.eventually(async () => json(await call(B.client, 'list_panels')).panels.length, (n) => n === 0, 'the agent holds none', 15000);
	} catch (e) {
		console.log('--- bridge stderr ---\n' + B.log.slice(-60).join('\n'));
		console.log('--- events seen ---\n' + JSON.stringify(seenEvents.map((m) => ({ kind: m.kind, event: m.event, control: m.control, from: m.from })), null, 1));
		throw e;
	} finally {
		await B.client.close().catch(() => {});
		await new Promise((r) => setTimeout(r, 3000));
		try {
			process.kill(B.pid);
		} catch {}
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	for (const P of [A, E, V]) h.check(h.pageErrors(P).length === 0, `no page errors on ${P === A ? 'A' : P === E ? 'E' : 'V'} (${JSON.stringify(h.pageErrors(P))})`);
	await h.finish(browser);
});
