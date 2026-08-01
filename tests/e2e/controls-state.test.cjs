// Phase 132: controls state colors + boot gizmo — O/N/Explorer icons tint
// when their panel is open; Move/Rotate/Scale only tint with a selection; a
// fresh reload shows no transform gizmo until something is selected.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// icons are lucide <svg>s now; svg.className is an SVGAnimatedString — read the attribute
	const iconClass = (title) =>
		A.page.evaluate((t) => document.querySelector(`p[title="${t}"] svg`)?.getAttribute('class') ?? '', title);

	// --- O/N/Explorer tint when their panel opens ---
	await A.page.evaluate(() => {
		window.__stores.objectListClose.set(true);
		window.__stores.flowGraphClose.set(true);
		window.__stores.explorerClose.set(true);
	});
	await A.page.waitForTimeout(200);
	const off = await iconClass('Object list (O)');
	h.check(!off.includes('text-primary-500'), 'object-list icon is idle when closed');

	await A.page.evaluate(() => window.__stores.objectListClose.set(false));
	await A.page.waitForTimeout(200);
	const on = await iconClass('Object list (O)');
	h.check(on.includes('text-primary-500'), 'object-list icon tints when open');

	await A.page.evaluate(() => window.__stores.explorerClose.set(false));
	await A.page.waitForTimeout(200);
	const explorerOn = await iconClass('Explorer');
	h.check(explorerOn.includes('text-primary-500'), 'Explorer icon tints when open');
	await A.page.evaluate(() => { window.__stores.objectListClose.set(true); window.__stores.explorerClose.set(true); });

	// --- Move/Rotate/Scale stay idle with no selection ---
	const moveIdle = await iconClass('Move (1)');
	h.check(!moveIdle.includes('text-primary-500'), 'Move icon is idle with no selection');

	// --- boot gizmo: not visible on a fresh scene with no selection ---
	const gizmoBoot = await A.page.evaluate(
		() =>
			new Promise((r) => {
				let tc;
				window.__stores.TControls.subscribe((v) => (tc = v))();
				r(tc ? tc.visible === false : true);
			})
	);
	h.check(gizmoBoot, 'the transform gizmo is hidden on boot with no selection');

	// --- selecting an object shows the gizmo + tints the active mode ---
	const afterSelect = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = group.children[group.children.length - 1];
		window.__stores.objectActions.selectObject(box.uuid);
		await new Promise((r) => setTimeout(r, 200));
		let tc;
		window.__stores.TControls.subscribe((v) => (tc = v))();
		return { visible: tc?.visible, attached: tc?.object?.uuid === box.uuid };
	});
	h.check(afterSelect.visible && afterSelect.attached, 'selecting an object shows + attaches the gizmo');
	await A.page.waitForTimeout(150);
	const moveActive = await iconClass('Move (1)');
	h.check(moveActive.includes('text-primary-500'), 'Move tints as the active mode once selected');

	// --- deselect hides the gizmo again ---
	const afterDeselect = await A.page.evaluate(async () => {
		window.__stores.objectActions.deselectObject?.();
		window.__stores.selectedObject.set([]);
		await new Promise((r) => setTimeout(r, 200));
		let tc;
		window.__stores.TControls.subscribe((v) => (tc = v))();
		return tc?.visible === false;
	});
	h.check(afterDeselect, 'deselecting hides the gizmo');

	await h.finish(browser);
});
