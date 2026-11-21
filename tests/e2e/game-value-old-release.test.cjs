// 102b-hud — a scene SAVED BY THIS BUILD opens in the newest release (run against it: APP_URL = the
// release's Pages URL). It carries Game Value / Show-Hide / Camera Shake nodes, buttons with `sound` and
// `value`, and a text variable. The older app must load it with no page error, keep every new node and
// field verbatim (an unknown node renders as UnknownNode and is saved back unchanged), and show the HUD.
// Input: GAME_VALUE_SAVED=<lane-saved.tpscene> (written by game-value-hud §6), else test-results/102b-hud.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const FILE = process.env.GAME_VALUE_SAVED || path.resolve(__dirname, '../../test-results/102b-hud/lane-saved.tpscene');

h.run(async () => {
	if (!fs.existsSync(FILE)) {
		console.log('SKIP: no lane-saved.tpscene (run game-value-hud first)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e?.message ?? e)));
	const bytes = Array.from(fs.readFileSync(FILE));
	const r = await page.evaluate(async (arr) => {
		const s = window.__tp.test.v1;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
		await new Promise((res) => setTimeout(res, 1500));
		let nodes, docs;
		s.flowNodes.subscribe((v) => (nodes = v))();
		s.hudDocs.hudDocs.subscribe((v) => (docs = v))();
		const again = s.sessions.buildSessionPayload('again');
		const els = docs?.scene?.screens?.flatMap((sc) => sc.elements) ?? [];
		return {
			version: s.version ?? window.__tp?.version ?? null,
			types: nodes.map((n) => n.type),
			gv: nodes.find((n) => n.id === 'gvCoins')?.data ?? null,
			button: els.find((e) => e.id === 'lv2') ?? null,
			againJson: JSON.stringify(again).length,
			againHasGv: JSON.stringify(again).includes('"gamevalue"') && JSON.stringify(again).includes('"hudvisible"'),
			againHasFields: JSON.stringify(again).includes('"sound":"click"')
		};
	}, bytes);
	console.log('  app:', JSON.stringify(r.version));
	h.check(errors.length === 0, 'no page error loading the newer scene', errors.join(' | '));
	for (const t of ['gamevalue', 'hudvisible', 'screenflash', 'hitpause', 'setvariable', 'hudbutton'])
		h.check(r.types.includes(t), `the ${t} node is kept`);
	h.check(r.gv?.read === 'variable' && r.gv?.format === 'fraction' && r.gv?.prefix === 'Coins ', 'Game Value data kept verbatim', JSON.stringify(r.gv));
	h.check(r.button?.sound === 'click' && r.button?.value === '2', "the button's sound and value fields kept", JSON.stringify(r.button));
	h.check(r.againHasGv && r.againHasFields, 'saved back by the older app: the new nodes and fields are still there');
	await h.finish(browser);
});
