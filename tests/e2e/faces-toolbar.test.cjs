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

	// ---- 15-E (E10): Multi button retired; live counts segment ----
	h.check(
		await A.page.evaluate(() => !document.querySelector('#mesh-multi')),
		'the Multi button is retired (ctrl-click always adds)'
	);
	await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.setFaceGranularity('face');
		const faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		fe.pickFaceUnit(faces[xi].triIndices[0]);
	});
	await A.page.waitForTimeout(150);
	const counts1 = await A.page.evaluate(() =>
		document.querySelector('#mesh-sel-counts')?.textContent?.replace(/\s+/g, ' ').trim()
	);
	h.check(/1 face · 2 tris/.test(counts1 ?? ''), `counts show the picked face ("${counts1}")`);

	// two whole faces -> boundary-edge counts appear, equal = no red tint
	const counts2 = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		const faces = fe.currentFaces();
		const xn = faces.findIndex((f) => f.normal.x < -0.9);
		fe.toggleFaceSelection(faces[xn].triIndices[0]);
		return new Promise((r) =>
			setTimeout(() => {
				const el = document.querySelector('#mesh-sel-counts');
				r({
					text: el?.textContent?.replace(/\s+/g, ' ').trim(),
					red: !!el?.querySelector('.text-red-400')
				});
			}, 150)
		);
	});
	h.check(
		/2 faces · 4 tris/.test(counts2.text ?? '') && /4 ↔ 4 edges/.test(counts2.text ?? ''),
		`two faces show their boundary-edge counts ("${counts2.text}")`
	);
	h.check(!counts2.red, 'equal edge counts are not tinted red');

	// subdivide one face (8-edge boundary) -> mismatched counts tint red
	const mismatch = await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		let faces = fe.currentFaces();
		const xn = faces.findIndex((f) => f.normal.x < -0.9);
		fe.pickFaceUnit(faces[xn].triIndices[0]);
		fe.commitFaceOp('subdivide', 0); // topology op clears the selection
		faces = fe.currentFaces();
		const xi = faces.findIndex((f) => f.normal.x > 0.9);
		const xn2 = faces.findIndex((f) => f.normal.x < -0.9);
		fe.pickFaceUnit(faces[xi].triIndices[0]);
		fe.toggleFaceSelection(faces[xn2].triIndices[0]);
		return new Promise((r) =>
			setTimeout(() => {
				const el = document.querySelector('#mesh-sel-counts');
				r({
					text: el?.textContent?.replace(/\s+/g, ' ').trim(),
					red: !!el?.querySelector('.text-red-400')
				});
			}, 150)
		);
	});
	h.check(
		/(4 ↔ 8|8 ↔ 4) edges/.test(mismatch.text ?? '') && mismatch.red,
		`mismatched edge counts tint red ("${mismatch.text}")`
	);

	await h.finish(browser);
});
