// 34 D4 — THE FLOW CODE VIEW EDITS THE COMPACT GRAPH TEXT, on two real peers.
//
//   1. the view opens in Text, seeded with `id = type "label" {params} @x,y` / `a -> b.h`
//   2. editing a param in the text + Apply changes the graph on A and B (the existing
//      replace-and-broadcast path, now fed by the text parser)
//   3. a NEW node line with no @x,y lands with a position (xyflow dereferences it)
//   4. a bad line is reported with its LINE NUMBER and the graph is left alone
//   5. the Text/JSON choice is a local pref that survives a reload
//
// Run: APP_URL=https://theprototype.app:5298/ npm run e2e -- flow-code-text
const h = require('./helpers.cjs');

// one CodeMirror line per .cm-line div — textContent of the whole editor has no newlines
const cmText = (peer) =>
	peer.page.evaluate(() => [...document.querySelectorAll('#flow-code-window .cm-line')].map((l) => l.textContent).join('\n'));
/** replace the editor's whole text the way a person pasting would */
async function setEditor(peer, text) {
	await peer.page.locator('#flow-code-window .cm-content').click();
	await peer.page.keyboard.press('Control+A');
	await peer.page.keyboard.insertText(text);
	await peer.page.waitForTimeout(300);
}
const apply = (peer) => peer.page.locator('#flow-code-window button', { hasText: 'Apply' }).click();
const graph = (peer) =>
	peer.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.flowNodes.subscribe((nodes) =>
					window.__stores.flowEdges.subscribe((edges) => r({ nodes, edges }))()
				)()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	await A.page.evaluate(() => {
		const nodes = [
			{ id: 'n1', type: 'number', position: { x: 10, y: 20 }, data: { label: 'Number', type: 'number', value: 3 }, class: 'w-[150px]' },
			{ id: 'vis', type: 'visibility', position: { x: 240, y: 20 }, data: { label: 'Visibility', type: 'visibility', on: true }, class: 'w-[150px]' }
		];
		const edges = [{ id: 'e-n1-vis.on', source: 'n1', target: 'vis', targetHandle: 'on' }];
		window.__stores.flowNodes.set(nodes);
		window.__stores.flowEdges.set(edges);
		window.__stores.peers.subscribe((p) => {
			nodes.forEach((node) => p.send({ type: 'nodecreate', node }));
			edges.forEach((edge) => p.send({ type: 'edgecreate', edge }));
		})();
		// a FLOATING window is the simplest thing to drive (the docked one depends on dock
		// state); the dock-mode arm is the seam the tab strip's own Undock uses
		window.__stores.bottomDock.dockModeArm.set({ key: 'flowcode', docked: false });
	});
	await A.page.waitForSelector('#flow-code-window .cm-content', { timeout: 15000 });
	await A.page.waitForTimeout(600);

	// --- 1 ---
	const seeded = await cmText(A);
	h.check(seeded.includes('n1 = number+ "Number" {value: 3} @10,20') && seeded.includes('n1 -> vis.on'), 'the view opens in Text: ' + JSON.stringify(seeded.slice(0, 120)));
	h.check(await A.page.locator('#flow-code-format-text').getAttribute('aria-pressed') === 'true', 'the Text button is the pressed one');

	// --- 2 + 3 ---
	const edited = seeded.replace('{value: 3}', '{value: 7}') + 'n2 = number "Two" {value: 2}\n';
	await setEditor(A, edited);
	await apply(A);
	await h.eventually(() => graph(A), (g) => g.nodes.find((n) => n.id === 'n1')?.data.value === 7, 'Apply: A holds the edited param (value 7)');
	await h.eventually(() => graph(B), (g) => g.nodes.find((n) => n.id === 'n1')?.data.value === 7, 'and B received it');
	const n2 = (await graph(A)).nodes.find((n) => n.id === 'n2');
	h.check(!!n2 && Number.isFinite(n2.position?.x) && Number.isFinite(n2.position?.y) && n2.position.y > 20, 'a new line with no @x,y got a position below the graph: ' + JSON.stringify(n2?.position));
	h.check(n2?.class === 'w-[150px]' && n2?.data.label === 'Two', 'with the default class and its label');
	await h.eventually(() => graph(B), (g) => g.nodes.some((n) => n.id === 'n2'), 'B received the new node');
	const errA = await A.page.locator('#flow-code-window .bg-ink-bad\\/15').count();
	h.check(errA === 0, 'no error banner after a good apply');

	// --- 4 ---
	const before = JSON.stringify(await graph(A));
	await setEditor(A, 'n1 = number "Number" {value: 3}\nbroken = spin {speed: }\n');
	await apply(A);
	await A.page.waitForTimeout(300);
	const banner = await A.page.evaluate(() => document.querySelector('#flow-code-window .bg-ink-bad\\/15')?.textContent ?? '');
	h.check(/line 2/.test(banner), 'a bad line is reported with its line number: ' + JSON.stringify(banner));
	h.check(JSON.stringify(await graph(A)) === before, 'and the graph is left untouched');

	// --- 5 ---
	await A.page.locator('#flow-code-format-json').click();
	await A.page.waitForTimeout(400);
	h.check((await cmText(A)).includes('"nodes"'), 'JSON shows the graph as JSON');
	h.check(await A.page.evaluate(() => localStorage.getItem('flowCodeFormat')) === 'json', 'the format choice is stored locally');
	await A.page.locator('#flow-code-format-text').click();
	await A.page.waitForTimeout(300);
	h.check(await A.page.evaluate(() => localStorage.getItem('flowCodeFormat')) === 'text', 'and back to text');

	h.check(h.pageErrors(A).length === 0, 'no page errors on A: ' + JSON.stringify(h.pageErrors(A).slice(0, 2)));
	await h.finish(browser);
});
