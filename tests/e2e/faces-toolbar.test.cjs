// Phase 174: the noVR Faces toolbar drops the "click a face" / "face selected"
// helper text, and Extrude/Inset/Move highlight as the active tool (one at a
// time); Delete never becomes active (stays red).
const h = require('./helpers.cjs');

const opStore = () =>
	(() => {
		let v;
		window.__stores.faceEdit.faceEditOp.subscribe((x) => (v = x))();
		return v;
	})();

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let grp;
		s.objectsGroup.subscribe((v) => (grp = v))();
		const box = grp.children[grp.children.length - 1];
		s.objectActions.selectObject(box.uuid);
		s.faceEdit.enterFaceEdit(box.uuid);
	});
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#mesh-edit-popup').isVisible(), 'faces toolbar is visible in face-edit');

	const text = await A.page.evaluate(() => document.querySelector('#mesh-edit-popup').innerText);
	h.check(!/click a face/i.test(text) && !/face selected/i.test(text), 'faces toolbar drops the click-a-face / face-selected helper');

	const active = (op) =>
		A.page.evaluate((o) => document.querySelector('#mesh-op-' + o).classList.contains('mesh-op-active'), op);

	// click Inset -> it becomes the active tool
	await A.page.locator('#mesh-op-inset').click();
	await A.page.waitForTimeout(100);
	h.check((await A.page.evaluate(opStore)) === 'inset' && (await active('inset')), 'clicking Inset activates + highlights it');
	h.check(!(await active('delete')), 'Delete never shows the active highlight (stays red)');

	// click Extrude -> switches; only one active at a time
	await A.page.locator('#mesh-op-extrude').click();
	await A.page.waitForTimeout(100);
	h.check((await A.page.evaluate(opStore)) === 'extrude' && (await active('extrude')), 'clicking Extrude switches the active tool');
	h.check(!(await active('inset')), 'only one op is active at a time');

	await h.finish(browser);
});
