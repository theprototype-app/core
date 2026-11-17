// 42 I2 — a desktop sidebar can run FULL HEIGHT, by a per-sidebar pin in its header.
//
// The user: "left/right side bars should be possible to extend to whole height taking space above
// (where profile button and burger menu) and below (even if docked windows opened, they just
// become shorter) … when left sidebar sticked and I open burger menu it should be on top".
// Decision: a "Full height" pin in each sidebar's header; pinned = top edge to bottom edge, that
// side's top-bar buttons slide inward, the bottom dock gets narrower (never under it), the burger
// menu always opens ABOVE sidebars. Desktop 1440x900 and a narrow 1024 window.
//
// Counterfactual (base = 1.32.0): there is no pin (premise red); the Inspector stops at the dock's
// top and starts under the chrome, and the dock spans the whole width under it.
const h = require('./helpers.cjs');

const VW = 1440;
const VH = 900;

function rect(page, sel) {
	return page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom), shown: cs.display !== 'none' && r.width > 0, z: cs.zIndex };
	}, sel);
}
/** the effective stacking z of an element: its own, or the nearest positioned ancestor's */
function zOf(page, sel) {
	return page.evaluate((sel) => {
		let el = document.querySelector(sel);
		while (el && el !== document.body) {
			const z = getComputedStyle(el).zIndex;
			if (z !== 'auto') return parseInt(z);
			el = el.parentElement;
		}
		return 0;
	}, sel);
}
const overlap = (a, b) => !!a && !!b && a.x < b.right - 1 && b.x < a.right - 1 && a.y < b.bottom - 1 && b.y < a.bottom - 1;

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: VW, height: VH } } });
	const page = A.page;

	// open Configure Scene (right sidebar) + the docked Node editor (bottom dock)
	await page.evaluate(() => {
		window.__tp.test.v1.showSidebar('scene');
		window.__tp.test.v1.flowGraphClose.set(false);
	});
	await page.waitForTimeout(900);
	const pin = page.locator('#sidebar-full-right');
	h.check((await pin.count()) === 1, 'premise: the right sidebar header carries a Full height pin');
	let ins = await rect(page, '#inspector');
	let dock = await rect(page, '#flow-list');
	const cluster0 = await rect(page, '#notes-toggle');
	h.check(!!dock?.shown && ins.bottom <= dock.y + 1 && ins.y >= 64, `premise (unpinned): the sidebar sits under the chrome and above the dock (${ins.y}..${ins.bottom}, dock top ${dock?.y})`);
	h.check(dock && Math.abs(dock.right - VW) < 2 && dock.x < 2, `premise (unpinned): the dock spans the whole width (${dock?.x}..${dock?.right})`);
	h.check((await pin.getAttribute('aria-pressed')) === 'false', 'premise: the pin starts off');

	// ---------- 1. pin the right sidebar ----------
	await pin.click();
	await page.waitForTimeout(500);
	const stripR = await rect(page, '#sidebar-strip-right');
	ins = await rect(page, '#inspector');
	dock = await rect(page, '#flow-list');
	const cluster = await rect(page, '#notes-toggle');
	const avatar = await rect(page, '#avatar-menu');
	h.check((await pin.getAttribute('aria-pressed')) === 'true', 'the pin reads pressed');
	h.check(stripR.y === 0 && ins.bottom === VH, `pinned: the sidebar runs from the top edge (${stripR.y}) to the bottom edge (${ins.bottom})`);
	h.check(Math.abs(dock.right - ins.x) < 2 && !overlap(dock, ins) && dock.y > 64, `the dock gets narrower and sits BESIDE it, not under (dock ..${dock.right}, sidebar ${ins.x}..)`);
	h.check(cluster.right <= ins.x && cluster0.right - cluster.right > ins.w - 4, `the top-right buttons slid inward by the sidebar width (${cluster0.right} -> ${cluster.right}, sidebar ${ins.w})`);
	h.check(!overlap(avatar, stripR) && !overlap(avatar, ins), 'the profile button is clear of the sidebar');
	const logo1 = await rect(page, '#logo-menu');
	h.check(logo1.x < 20, `the LEFT side's logo did not move (${logo1.x})`);
	// 42-int (preview-1-33 proof): the cloud build's Connect pill is ~480 px wide (Rooms + menu). Centred on
	// the WINDOW it lost its right-hand gap to the slid corner buttons and docked as a 44 px strip — and the
	// "full height" column then started under it. It centres in the span between pinned columns instead.
	const wide = await page.addStyleTag({ content: '.connect-pill { min-width: 480px !important; }' });
	await page.evaluate(() => window.dispatchEvent(new Event('resize')));
	await page.waitForTimeout(600);
	const pillW = await rect(page, '.connect-pill');
	const dockedW = await page.evaluate(() => new Promise((r) => window.__tp.test.v1.connectDocked.subscribe(r)()));
	const freeMid = (logo1.right + cluster.x) / 2;
	h.check(dockedW === false && pillW.w >= 478 && Math.abs(pillW.x + pillW.w / 2 - freeMid) < 4 && pillW.right < cluster.x, `a 480 px Connect pill stays a pill, centred between the logo and the slid corner buttons (docked ${dockedW}, pill ${pillW.x}..${pillW.right}, gap centre ${freeMid}, corner buttons from ${cluster.x})`);
	await wide.evaluate((el) => el.remove());
	await page.evaluate(() => window.dispatchEvent(new Event('resize')));
	await page.waitForTimeout(400);
	const saved = await page.evaluate(() => localStorage.getItem('sidebar:full:right'));
	h.check(saved === 'true', 'the pin persisted');

	// ---------- 2. pin a LEFT sidebar (the Objects list docked left) + the burger menu ----------
	await page.locator('p[title="Object list (O)"]').click();
	await page.waitForTimeout(400);
	const list0 = await rect(page, '#object-list');
	await page.mouse.move(list0.x + 24, list0.y + 14);
	await page.mouse.down();
	await page.mouse.move(12, 400, { steps: 10 });
	await page.mouse.up();
	await page.waitForTimeout(400);
	h.check((await page.locator('#sidebar-full-left').count()) === 1, 'premise: the list docked left has its own header + pin');
	await page.locator('#sidebar-full-left').click();
	await page.waitForTimeout(500);
	const list = await rect(page, '#object-list');
	const stripL = await rect(page, '#sidebar-strip-left');
	const logo = await rect(page, '#logo-menu');
	dock = await rect(page, '#flow-list');
	h.check(stripL.y === 0 && list.bottom === VH && list.x === 0, `pinned left: top edge to bottom edge (${stripL.y}..${list.bottom})`);
	h.check(logo.x >= list.right && logo.x - list.right < 20, `the logo slid inward past the left sidebar (logo ${logo.x}, sidebar ..${list.right})`);
	h.check(Math.abs(dock.x - list.right) < 2 && Math.abs(dock.right - ins.x) < 2, `the dock sits between the two full-height sidebars (${dock.x}..${dock.right})`);
	// 42-int: BOTH columns pinned with the cloud build's 480 px pill — still a pill, in the gap between the
	// slid logo and the slid corner buttons, and both columns still start at the top edge
	{
		const wide2 = await page.addStyleTag({ content: '.connect-pill { min-width: 480px !important; }' });
		await page.evaluate(() => window.dispatchEvent(new Event('resize')));
		await page.waitForTimeout(600);
		const p2 = await rect(page, '.connect-pill');
		const c2 = await rect(page, '#notes-toggle');
		const d2 = await page.evaluate(() => new Promise((r) => window.__tp.test.v1.connectDocked.subscribe(r)()));
		const sL = await rect(page, '#sidebar-strip-left');
		const sR = await rect(page, '#sidebar-strip-right');
		h.check(d2 === false && p2.x > logo.right && p2.right < c2.x && sL.y === 0 && sR.y === 0, `both pinned: a 480 px pill fits between the logo and the corner buttons and both columns start at the top (docked ${d2}, pill ${p2.x}..${p2.right}, logo ..${logo.right}, buttons ${c2.x}, strips ${sL.y}/${sR.y})`);
		await wide2.evaluate((el) => el.remove());
		await page.evaluate(() => window.dispatchEvent(new Event('resize')));
		await page.waitForTimeout(400);
	}
	// the burger menu opens from the logo, above every sidebar
	await page.locator('#logo-menu').click();
	await page.waitForTimeout(400);
	const menu = await rect(page, '#sidebar70');
	const zMenu = await zOf(page, '#sidebar70');
	const zSide = Math.max(await zOf(page, '#sidebar-strip-left'), await zOf(page, '#object-list'), await zOf(page, '#inspector'), await zOf(page, '#sidebar-strip-right'));
	h.check(!!menu?.shown && menu.x >= list.right && !overlap(menu, list), `the menu opens beside the pinned sidebar, from the logo (${menu?.x})`);
	h.check(zMenu > zSide, `the menu stacks ABOVE every sidebar (z ${zMenu} > ${zSide})`);
	const hit = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('#sidebar70'), { x: menu.x + menu.w / 2, y: menu.y + 40 });
	h.check(hit, 'a press on the menu lands on the menu');
	const listUnmoved = await rect(page, '#object-list');
	h.check(listUnmoved.x === 0, `a pinned sidebar is not pushed aside by the menu (x ${listUnmoved.x})`);
	await page.locator('#logo-menu').click();
	await page.waitForTimeout(300);

	// ---------- 3. a reload keeps both pins ----------
	await h.freshReload(A);
	await page.locator('#restore-session-dismiss').click({ timeout: 6000 }).catch(() => {});
	await page.waitForTimeout(800);
	await page.evaluate(() => {
		window.__tp.test.v1.showSidebar('scene');
		window.__tp.test.v1.objectListClose.set(false);
		window.__tp.test.v1.flowGraphClose.set(false);
	});
	await page.waitForTimeout(1000);
	const sR = await rect(page, '#sidebar-strip-right');
	const sL = await rect(page, '#sidebar-strip-left');
	h.check(sR?.y === 0 && sL?.y === 0, `both pins survive a reload (${sR?.y}, ${sL?.y})`);
	h.check((await page.locator('#sidebar-full-left').getAttribute('aria-pressed')) === 'true', '...and read pressed');

	// ---------- 4. the narrow 1024 window ----------
	await page.setViewportSize({ width: 1024, height: 768 });
	await page.waitForTimeout(1200);
	const docked = await page.evaluate(() => new Promise((r) => window.__tp.test.v1.connectDocked.subscribe(r)()));
	const barH = await page.evaluate(() => new Promise((r) => window.__tp.test.v1.connectBarHeight.subscribe(r)()));
	const sR2 = await rect(page, '#sidebar-strip-right');
	const notes2 = await rect(page, '#notes-toggle');
	const pill = await rect(page, '.connect-wrap');
	const ins2 = await rect(page, '#inspector');
	// 44 M14 (decision): a FLOATING pill with no room goes COMPACT instead of docking to its own row; pinned to the
	// top row it docks as before and the pinned sidebars start under it
	const cdock = await page.evaluate(() => window.__connectDock);
	h.check((docked === true && sR2.y >= barH - 1) || (cdock?.squeezed === true && !docked && sR2.y === 0), `1024: the Connect bar goes compact (floating) or docks to its strip with the pinned sidebars under it (bar ${barH}, sidebar ${sR2.y}, squeezed ${cdock?.squeezed})`);
	h.check(!overlap(notes2, pill) && notes2.right <= ins2.x, `1024: the moved corner buttons do not collide with the Connect bar (${JSON.stringify(notes2)})`);
	h.check(ins2.bottom === 768, `1024: still bottom edge (${ins2.bottom})`);

	// ---------- 5. unpin: everything goes back ----------
	await page.setViewportSize({ width: VW, height: VH });
	await page.waitForTimeout(800);
	await page.locator('#sidebar-full-right').click();
	await page.locator('#sidebar-full-left').click();
	await page.waitForTimeout(600);
	const sR3 = await rect(page, '#sidebar-strip-right');
	const notes3 = await rect(page, '#notes-toggle');
	const logo3 = await rect(page, '#logo-menu');
	dock = await rect(page, '#flow-list');
	ins = await rect(page, '#inspector');
	h.check(sR3.y === 64 && ins.bottom <= dock.y + 1, `unpinned: under the chrome and above the dock again (${sR3.y}, ${ins.bottom} vs ${dock.y})`);
	h.check(Math.abs(notes3.right - cluster0.right) < 2 && logo3.x < 20, `unpinned: the corner buttons are back (${notes3.right}, logo ${logo3.x})`);
	h.check(dock.x < 2 && Math.abs(dock.right - VW) < 2, `unpinned: the dock spans the width again (${dock.x}..${dock.right})`);

	await h.finish(browser);
});
