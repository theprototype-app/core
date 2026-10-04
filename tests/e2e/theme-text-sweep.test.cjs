// 36 U1 (the sweep) — THE SAME BUG CLASS ACROSS THE APP. The Profiler's numbers were black on the
// dark theme because its dock painted a background and never said what colour its text was. This
// suite opens every dock view, the floating object list, the Inspector, Settings, the burger menu
// and the notification centre in every built-in theme and measures every visible piece of text
// against what is painted behind it.
//
// It asserts the GROSS failure (< 3:1 — text you cannot read at all, the reported class) in every
// theme; the full AA list (< 4.5:1) is written to the evidence folder as the to-do for panels this
// lane did not own.
//
// Run: APP_URL=https://theprototype.app:5321/ npm run e2e -- theme-text-sweep
const h = require('./helpers.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { contrastRows } = require('./contrast.cjs');

const OUT = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-36/36-ui-polish';
const PHASE = process.env.BEFORE ? 'before' : 'after';
const GROSS = 3;

/** each surface: how to open it, how to close it, what to measure */
const SURFACES = [
	{ id: 'flow', open: (s) => s.flowGraphClose.set(false), close: (s) => s.flowGraphClose.set(true), root: 'body' },
	{ id: 'flowcode', open: (s) => s.flowCodeClose.set(false), close: (s) => s.flowCodeClose.set(true), root: 'body' },
	{ id: 'animation', open: (s) => s.animationClose.set(false), close: (s) => s.animationClose.set(true), root: 'body' },
	{ id: 'uv', open: (s) => s.uvEditorClose.set(false), close: (s) => s.uvEditorClose.set(true), root: 'body' },
	{ id: 'shader', open: (s) => s.shaderEditorClose.set(false), close: (s) => s.shaderEditorClose.set(true), root: 'body' },
	{ id: 'hud', open: (s) => s.hudEditorClose.set(false), close: (s) => s.hudEditorClose.set(true), root: 'body' },
	{ id: 'explorer', open: (s) => s.explorerClose.set(false), close: (s) => s.explorerClose.set(true), root: 'body' },
	{ id: 'objects', open: (s) => s.objectListClose.set(false), close: (s) => s.objectListClose.set(true), root: 'body' },
	{ id: 'inspector', open: (s) => s.showSidebar('scene'), close: (s) => s.inspectorClose.set(true), root: 'body' },
	{ id: 'settings', open: (s) => s.settingsOpen.set(true), close: (s) => s.settingsOpen.set(false), root: 'body' },
	{ id: 'menu', open: (s) => s.closeMenu.set(false), close: (s) => s.closeMenu.set(true), root: 'body' },
	{ id: 'notifications', open: (s) => s.notificationCenterOpen.set(true), close: (s) => s.notificationCenterOpen.set(false), root: 'body' }
];

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.selectedObjects?.set?.([]);
	});
	const themes = await page.evaluate(() => window.__stores.themes.THEMES.map((t) => t.id));
	/** @type {Map<string, any>} */
	const found = new Map();
	const report = [];
	for (const theme of themes) {
		await page.evaluate((t) => window.__stores.themes.theme.set(t), theme);
		for (const surf of SURFACES) {
			const ok = await page
				.evaluate(
					([src]) => {
						(0, eval)(src)(window.__stores);
						return true;
					},
					[surf.open.toString()]
				)
				.catch((e) => String(e));
			if (ok !== true) {
				console.log(`  (could not open ${surf.id}: ${ok})`);
				continue;
			}
			await page.waitForTimeout(700);
			const rows = (await contrastRows(page, surf.root)).filter((r) => r.text !== '[canvas ink]'); // a canvas's ink is its own suite's business
			for (const r of rows) {
				if (r.ratio >= 4.5) continue;
				const k = `${theme}|${r.path}|${r.fg}|${r.bg}`;
				if (!found.has(k)) found.set(k, { theme, surface: surf.id, ...r });
			}
			if (theme === 'dark' || theme === 'light')
				await page.screenshot({ path: path.join(OUT, `sweep-${PHASE}-${theme}-${surf.id}.png`) }).catch(() => {});
			await page
				.evaluate(([src]) => (0, eval)(src)(window.__stores), [surf.close.toString()])
				.catch(() => {});
			await page.waitForTimeout(200);
		}
	}
	const all = [...found.values()];
	const gross = all.filter((f) => f.ratio < GROSS);
	for (const theme of themes) {
		const g = gross.filter((f) => f.theme === theme);
		const a = all.filter((f) => f.theme === theme);
		report.push(`${theme}: ${a.length} text runs under 4.5:1, ${g.length} under ${GROSS}:1`);
	}
	const fmt = (f) => `  [${f.theme}/${f.surface}] ${f.ratio}:1 "${f.text}" fg=${f.fg} bg=${f.bg} @ ${f.path}`;
	fs.writeFileSync(
		path.join(OUT, `sweep-${PHASE}.txt`),
		report.join('\n') + `\n\nUNDER ${GROSS}:1\n` + gross.map(fmt).join('\n') + '\n\nUNDER 4.5:1\n' + all.filter((f) => f.ratio >= GROSS).map(fmt).join('\n') + '\n'
	);
	console.log(report.join('\n'));
	console.log(gross.slice(0, 120).map(fmt).join('\n'));
	if (!process.env.BEFORE)
		for (const theme of themes) {
			const g = gross.filter((f) => f.theme === theme);
			h.check(g.length === 0, `${theme}: no chrome text under ${GROSS}:1 (${g.length}${g[0] ? ', e.g. ' + fmt(g[0]).trim() : ''})`);
		}
	await page.evaluate(() => window.__stores.themes.theme.set('dark'));
	await h.finish(browser);
});
