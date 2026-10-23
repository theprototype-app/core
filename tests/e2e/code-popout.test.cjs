// 50-window (C1): THE CODE EDITOR IN ITS OWN BROWSER WINDOW.
//   1 "Pop out" opens a real popup holding the workspace; the main window's workspace steps aside
//   2 the popup wears the app's theme (mirrored stylesheets + <html> attributes), and follows a switch
//   3 edits are live both ways (popup typing -> the shared stores; a store write -> the popup's editor)
//   4 run: Ctrl+S in the popup applies the script (the box moves); errors show in the popup
//   5 svelte's delegated clicks, the tab strip and a portaled menu all work inside the popup
//   6 openCode while popped keeps the main window clear; "Dock back" / closing the popup docks it back
//   7 a blocked popup says so with Try again, which then opens it
//   8 phone shell: no button; closing the MAIN tab closes the popup
const h = require('./helpers.cjs');

const S = (page, fn, arg) => page.evaluate(fn, arg);
const SHOTS = process.env.CP_SHOTS || '';
const shot = async (page, name) => SHOTS && page.screenshot({ path: SHOTS + '/' + name });

const read = (page, path) =>
	page.evaluate(
		(path) =>
			new Promise((r) => {
				let obj = window.__stores;
				for (const p of path.split('.')) obj = obj[p];
				obj.subscribe((v) => r(JSON.parse(JSON.stringify(v ?? null))))();
			}),
		path
	);

const nodeCode = (page, id) =>
	page.evaluate(
		(id) =>
			new Promise((r) =>
				window.__stores.flowGraphs.subscribe((all) => {
					for (const g of Object.values(all)) {
						const n = g.nodes.find((x) => x.id === id);
						if (n) return r(n.data.code);
					}
					r(null);
				})()
			),
		id
	);

const objX = (page, uuid) =>
	page.evaluate(
		(uuid) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.getObjectByProperty('uuid', uuid)?.position.x ?? null))()),
		uuid
	);

const mainWorkspaceShown = (page) => page.locator('#code-ws-dock:visible, #code-ws-window:visible').count();

/** write a tab's text the way the app does: a tab bound to a shared document (50 Y1, 1.42) is the
 *  document's to change (sharedText.replaceText — a store write no longer reaches its editor), any
 *  other tab takes codeWorkspace.setTabCode */
const writeTab = (page, id, code) =>
	page.evaluate(
		({ id, code }) =>
			new Promise((r) =>
				window.__stores.codeWorkspace.codeTabs.subscribe((tabs) => {
					const s = window.__stores;
					const t = tabs.find((x) => x.id === id);
					const key = t && (t.kind === 'node' || t.kind === 'behaviour') && t.nodeId ? 'n:' + (t.graphId || 'scene') + ':' + t.nodeId : null;
					if (key && s.sharedText?.holds(key)) s.sharedText.replaceText(key, code);
					else s.codeWorkspace.setTabCode(id, code);
					r(null);
				})()
			),
		{ id, code }
	);

async function popOut(page) {
	const [pop] = await Promise.all([page.context().waitForEvent('page', { timeout: 20000 }), page.locator('#code-ws-popout').first().click()]);
	await pop.waitForSelector('#code-ws-popped .cm-content', { timeout: 30000 });
	return pop;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { storage: { 'shared:shareNewFiles': 'never' } });
	const page = A.page;

	// a box driven by a Script node — "run" is visible as the box's x
	const uuid = await S(page, () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children[g.children.length - 1].uuid))());
	});
	await page.waitForTimeout(800);
	await S(page, async (uuid) => {
		window.__stores.objectActions.deselectObject();
		const nodes = [
			{ id: 'pop1', type: 'script', position: { x: 0, y: 0 }, data: { type: 'script', code: 'object.position.x = 1;' }, class: 'w-[150px]' },
			{ id: 'popsel', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: uuid }, class: 'w-[150px]' }
		];
		window.__stores.flowNodes.update((n) => [...n, ...nodes]);
		window.__stores.flowEdges.update((e) => [...e, { id: 'e-pop1-popsel', source: 'pop1', target: 'popsel' }]);
	}, uuid);
	await page.waitForTimeout(1500);
	h.check(Math.abs((await objX(page, uuid)) - 1) < 0.01, 'premise: the inline script runs (x = 1)');
	await S(page, () => window.__stores.codeWorkspace.openCode({ source: 'script', ref: { nodeId: 'pop1', graphId: 'scene' } }));
	await page.waitForSelector('[data-pane] .cm-content', { timeout: 45000 });
	h.check((await mainWorkspaceShown(page)) === 1, 'premise: the workspace is open in the main window');
	h.check(await page.locator('#code-ws-popout').first().isVisible(), 'a Pop out button sits in the workspace header (desktop)');

	// ---------------------------------------------------------------- 1 pop out
	const pop = await popOut(page);
	h.check(!!pop, 'Pop out opens a real browser window');
	h.check((await pop.title()).startsWith('Code'), 'the window is titled "Code — ThePrototype"');
	h.check((await read(page, 'codePopout.codePoppedOut')) === true, 'codePoppedOut is true');
	await page.waitForTimeout(500);
	h.check((await mainWorkspaceShown(page)) === 0, 'the main window frees its dock/window (the workspace closed there)');
	h.check((await pop.locator('#code-ws-popped .cm-content').count()) === 1, 'the popup holds the editor (one CodeMirror)');
	h.check(await pop.locator('#code-ws-popped .code-tab[data-tab-id]').count() >= 1, 'and the tab strip');
	await shot(pop, '01-popout-window.png');

	// ---------------------------------------------------------------- 2 theme
	const themeOf = (p) =>
		p.evaluate(() => {
			const el = document.getElementById('code-ws-popped');
			const probe = document.createElement('div');
			probe.style.background = 'var(--surface-1)';
			document.body.appendChild(probe);
			const surface = getComputedStyle(probe).backgroundColor;
			probe.remove();
			return { surface, root: el ? getComputedStyle(el).backgroundColor : null, mirrored: document.querySelectorAll('[data-tp-mirror]').length, theme: document.documentElement.getAttribute('data-theme') };
		});
	const mainTheme = await themeOf(page);
	let popTheme = await themeOf(pop);
	h.check(popTheme.mirrored > 0, 'the main stylesheets are mirrored into the popup (' + popTheme.mirrored + ')');
	h.check(popTheme.surface === mainTheme.surface && popTheme.root === mainTheme.surface && mainTheme.surface !== 'rgba(0, 0, 0, 0)', 'the popup resolves the same --surface-1 (window surface) token as the app (' + popTheme.root + ')');
	const otherTheme = mainTheme.theme === 'light' ? 'dark' : 'light';
	await S(page, (t) => document.documentElement.setAttribute('data-theme', t), otherTheme);
	await pop.waitForTimeout(300);
	popTheme = await themeOf(pop);
	h.check(popTheme.theme === otherTheme, 'a theme switch in the app reaches the popup (data-theme ' + popTheme.theme + ')');
	h.check(popTheme.root === (await themeOf(page)).surface, 'and repaints it with the new surface');
	await S(page, (t) => (t ? document.documentElement.setAttribute('data-theme', t) : document.documentElement.removeAttribute('data-theme')), mainTheme.theme);

	// ---------------------------------------------------------------- 3 live both ways
	const activeId = await read(page, 'codeWorkspace.activeCodeTab');
	await pop.locator(`[data-pane="${activeId}"] .cm-content`).click();
	await pop.keyboard.press('Control+A');
	await pop.keyboard.insertText('object.position.x = 3;');
	await pop.waitForTimeout(400);
	let tabs = await read(page, 'codeWorkspace.codeTabs');
	h.check(tabs.find((t) => t.id === activeId)?.code === 'object.position.x = 3;', 'typing in the popup lands in the shared code tab store');
	h.check(await pop.locator('.code-tab[data-dirty="true"]').count() === 1, 'the popup tab shows the unsaved ● marker');
	await writeTab(page, activeId, 'object.position.x = 4;');
	await pop.waitForTimeout(400);
	h.check((await pop.locator(`[data-pane="${activeId}"] .cm-content`).innerText()).includes('x = 4'), 'a write from the main window shows in the popup editor');

	// ---------------------------------------------------------------- 4 run + errors
	await pop.locator(`[data-pane="${activeId}"] .cm-content`).click();
	await pop.keyboard.press('Control+S');
	await page.waitForTimeout(1500);
	h.check((await nodeCode(page, 'pop1')) === 'object.position.x = 4;', 'Ctrl+S in the popup saves the node');
	h.check(Math.abs((await objX(page, uuid)) - 4) < 0.01, 'and the scene runs it (x = 4)');
	await pop.keyboard.press('Control+A');
	await pop.keyboard.insertText('object.position.x = ;');
	await pop.keyboard.press('Control+S');
	await pop.waitForTimeout(1200);
	h.check(await pop.locator('#code-ws-error').isVisible(), 'a parse error shows its banner IN the popup');
	h.check((await nodeCode(page, 'pop1')) === 'object.position.x = 4;', 'and nothing broken applies (the node keeps x = 4)');
	await shot(pop, '02-popout-error.png');
	await writeTab(page, activeId, 'object.position.x = 4;');

	// ---------------------------------------------------------------- 5 delegated events, tabs, menus
	await pop.locator('#code-ws-open-graph').click();
	tabs = await read(page, 'codeWorkspace.codeTabs');
	await pop.waitForTimeout(600);
	h.check(tabs.length === 2 && (await read(page, 'codeWorkspace.activeCodeTab')) === tabs[1].id, 'a button click in the popup works (Graph JSON opened a second tab)');
	await pop.locator(`.code-tab[data-tab-id="${activeId}"]`).click();
	await pop.waitForTimeout(300);
	h.check((await read(page, 'codeWorkspace.activeCodeTab')) === activeId, 'clicking a tab in the popup switches tabs (delegated onclick reaches the popup)');
	await pop.locator('#code-ws-bind').click();
	await pop.waitForTimeout(400);
	h.check((await pop.locator('[role="menu"]').count()) === 1 && (await page.locator('[role="menu"]').count()) === 0, 'a context menu opened in the popup is portaled into the POPUP, not the app');
	await pop.keyboard.press('Escape');
	await pop.mouse.click(5, 5);
	await pop.waitForTimeout(300);
	h.check((await pop.locator('[role="menu"]').count()) === 0, 'and closes there');
	const leftBefore = await read(page, 'codeSidebars.codeLeftOpen');
	await pop.locator(`.code-tab[data-tab-id="${activeId}"]`).focus();
	await pop.keyboard.press('Control+b');
	await pop.waitForTimeout(300);
	h.check((await read(page, 'codeSidebars.codeLeftOpen')) === !leftBefore, "the workspace's own keys work in the popup (Ctrl+B toggles the files sidebar)");
	await pop.keyboard.press('Control+b');

	// ---------------------------------------------------------------- 6 openCode while popped, dock back
	await S(page, () => window.__stores.codeWorkspace.openCode({ source: 'script', ref: { nodeId: 'pop1', graphId: 'scene' } }));
	await page.waitForTimeout(1500);
	h.check((await mainWorkspaceShown(page)) === 0 && !pop.isClosed(), 'opening code while popped goes to the popup; the main window stays clear');
	await pop.locator('#code-ws-dock-back').click();
	await h.eventually(() => Promise.resolve(pop.isClosed()), (v) => v === true, 'Dock back closes the code window', 10000);
	await h.eventually(() => mainWorkspaceShown(page), (n) => n === 1, 'and the workspace is back in the app', 15000);
	h.check((await read(page, 'codePopout.codePoppedOut')) === false, 'codePoppedOut is false again');
	h.check((await read(page, 'codeWorkspace.codeTabs')).length === 2, 'both tabs came back with it');
	h.check(await page.locator('[data-pane] .cm-content').first().isVisible(), 'and the main editor shows again');

	const pop2 = await popOut(page);
	await pop2.close();
	await h.eventually(() => mainWorkspaceShown(page), (n) => n === 1, "closing the code window with the OS's ✕ docks the editor back too", 15000);
	const rect = await S(page, () => JSON.parse(localStorage.getItem('code:popoutRect') || 'null'));
	h.check(rect && rect.width > 200 && rect.height > 150, 'the window remembers its size and place for next time (' + JSON.stringify(rect) + ')');

	// ---------------------------------------------------------------- 7 popup blocked
	await S(page, () => {
		window.__realOpen = window.open;
		window.open = () => null;
	});
	await page.locator('#code-ws-popout').first().click();
	await page.waitForTimeout(500);
	const tryAgain = page.locator('button', { hasText: 'Try again' }).first();
	h.check(await tryAgain.isVisible(), 'a blocked popup shows a notice with a Try again button');
	h.check((await read(page, 'codePopout.codePoppedOut')) === false && (await mainWorkspaceShown(page)) === 1, 'and the editor stays in the app');
	await S(page, () => (window.open = window.__realOpen));
	const [pop3] = await Promise.all([page.context().waitForEvent('page', { timeout: 20000 }), tryAgain.click()]);
	await pop3.waitForSelector('#code-ws-popped .cm-content', { timeout: 30000 });
	h.check((await read(page, 'codePopout.codePoppedOut')) === true, 'Try again opens the window');

	// ---------------------------------------------------------------- 8 phone + main tab closing
	await pop3.locator('#code-ws-dock-back').click();
	await h.eventually(() => mainWorkspaceShown(page), (n) => n === 1, 'premise: docked back', 15000);
	await S(page, () => window.__stores.phoneShell.phoneShellActive.set(true));
	await page.waitForTimeout(300);
	h.check((await page.locator('#code-ws-popout').count()) === 0, 'on a phone shell there is no Pop out button');
	await S(page, () => window.__stores.phoneShell.phoneShellActive.set(false));
	await page.waitForTimeout(300);
	const pop4 = await popOut(page);
	h.check(h.pageErrors(A).length === 0, 'no page errors through all of it (' + h.pageErrors(A).slice(0, 2).join(' | ') + ')');
	await page.close({ runBeforeUnload: true });
	await h.eventually(() => Promise.resolve(pop4.isClosed()), (v) => v === true, 'closing the main tab closes the code window', 10000);

	await h.finish(browser);
});
