// Phase 72 + 64: Configure Scene / Library sidebar items toggle; the unified
// inspector keeps open-only semantics for selection targets.
const h = require('./helpers.cjs');

const inspector = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				let open, kind;
				window.__stores.inspectorClose.subscribe((v) => (open = v === false))();
				window.__stores.inspectorKind.subscribe((v) => (kind = v))();
				resolve({ open, kind });
			})
	);

const isOpen = (page, store) =>
	page.evaluate(
		(store) => new Promise((r) => window.__stores[store].subscribe((v) => r(v === false))()),
		store
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// 94: the LOGO is the menu button now (no hamburger, no overlap)
	h.check(
		(await A.page.locator('.hamburger-inner').count()) === 0,
		'the squeeze hamburger is gone'
	);
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(400);
	let menuOpen = await A.page.evaluate(
		() => new Promise((r) => window.__stores.closeMenu.subscribe((v) => r(v === false))())
	);
	h.check(menuOpen, 'clicking the logo opens the sidebar');
	// 38 NOTES-38 #24: the ring is the accent `.logo-open` state now (was Tailwind ring-2 in the
	// orange primary) — assert what is DRAWN, not a class string
	const ringed = await A.page.evaluate(() => {
		const el = document.querySelector('#logo-menu');
		return !!el && el.classList.contains('logo-open') && getComputedStyle(el).boxShadow !== 'none';
	});
	h.check(!!ringed, 'open state shows the accent ring on the logo');
	await A.page.locator('#logo-menu').click();
	await A.page.waitForTimeout(400);
	menuOpen = await A.page.evaluate(
		() => new Promise((r) => window.__stores.closeMenu.subscribe((v) => r(v === false))())
	);
	h.check(!menuOpen, 'clicking the logo again closes the sidebar');

	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(400);

	// Configure Scene: click opens, click again closes
	await A.page.getByText('Configure Scene', { exact: true }).click();
	await A.page.waitForTimeout(300);
	let state = await inspector(A.page);
	h.check(state.open && state.kind === 'scene', 'Configure Scene opens the scene inspector');
	// 15-O replaced the "● " text prefix with an `active` row highlight
	h.check(
		await A.page.evaluate(() => !!document.querySelector('.side-row.active')),
		'active row highlight shown'
	);
	await A.page.getByText('Configure Scene', { exact: true }).click();
	await A.page.waitForTimeout(300);
	state = await inspector(A.page);
	h.check(!state.open, 'second click closes it');

	// 126: Library left the sidebar (its packs open from the Explorer now) — the
	// sidebar no longer carries a Library item
	const noLibrary = await A.page.getByText('Library', { exact: true }).count();
	h.check(noLibrary === 0, 'the sidebar no longer has a Library item (126)');

	// selection stays open-only: repeated showSidebar('properties') never closes
	await A.page.evaluate(() => {
		window.__stores.showSidebar('properties');
		window.__stores.showSidebar('properties');
	});
	await A.page.waitForTimeout(300);
	state = await inspector(A.page);
	h.check(state.open && state.kind === 'selection', 'selection inspector keeps open-only semantics');

	// switching scene -> selection retargets the same drawer
	await A.page.evaluate(() => window.__stores.showSidebar('scene'));
	await A.page.waitForTimeout(300);
	state = await inspector(A.page);
	h.check(state.open && state.kind === 'scene', 'showSidebar retargets to scene');

	await h.finish(browser);
});
