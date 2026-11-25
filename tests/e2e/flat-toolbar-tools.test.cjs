// 64-int (release brief row): "the 2D toolbar in the flat view shows pen, shapes, text, extrude, layers and EACH ONE
// WORKS THERE". sprite2d-flat checks the list and order (1.5), Text (2) and Layers (3); this suite drives the three
// tools the other lanes dropped into the toolbar, in the union, with real mouse input in the flat view:
//   1 Shapes: the button arms the rectangle; a drag draws one ON a 2D layer's plane, facing the view; ONE undo
//   2 Pen: three clicks + a click on the first point close a path on the same plane; ONE undo
//   3 Extrude: with the rectangle selected, the button makes it a 10 cm solid (one undo step) and a second press
//     makes it flat again; with nothing selectable it says so and changes nothing
//   4 no page error
// Run: APP_URL=https://theprototype.app:7229/ node tests/e2e/flat-toolbar-tools.test.cjs
const h = require('./helpers.cjs');

const undoDepth = (page) => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))()));
const view = (page) =>
	page.evaluate(() => ({
		view: window.__view2dDebug?.() ?? null,
		tools: [...document.querySelectorAll('#toolbar-2d [id^="tool2d-"]')].map((b) => b.id.replace('tool2d-', '')),
		armed: (() => {
			let t = null;
			window.__stores.vectorGate?.vectorTool?.subscribe((v) => (t = v))();
			return t;
		})()
	}));
/** every object: uuid, world z, its +Z axis in world, layer / vector facts */
const scene = (page) =>
	page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const T = window.__stores.THREE;
		const out = [];
		g.traverse((o) => {
			if (o === g) return;
			o.updateWorldMatrix(true, false);
			const e = o.matrixWorld.elements;
			const zAxis = T ? new T.Vector3(e[8], e[9], e[10]).normalize().toArray() : [e[8], e[9], e[10]];
			const p = o.userData?.geometryParams?.gtype === 'Vector' ? o.userData.geometryParams.params : null;
			let zext = 0;
			if (p && o.geometry?.attributes?.position) {
				o.geometry.computeBoundingBox();
				zext = o.geometry.boundingBox.max.z - o.geometry.boundingBox.min.z;
			}
			out.push({
				uuid: o.uuid,
				z: +e[14].toFixed(4),
				zAxis: zAxis.map((v) => +v.toFixed(3)),
				layer: o.userData?.layer2d ? true : false,
				kind: p?.kind ?? null,
				closed: p?.paths?.[0]?.closed ?? null,
				nodes: p?.paths?.reduce?.((n, s) => n + s.nodes.length, 0) ?? 0,
				depth: p?.depth ?? null,
				zext: +zext.toFixed(4)
			});
		});
		return out;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await A.page.evaluate(() => import('/src/lib/sprite2d/template2d.js').then((m) => m.open2dTemplate()));
	await h.eventually(() => view(A.page), (v) => !!v.view?.active && v.view.ortho && v.tools.includes('pen') && v.tools.includes('shapes') && v.tools.includes('extrude'), '0. the 2D template opened flat with pen, shapes and extrude in its toolbar', 90000);
	const v0 = (await view(A.page)).view;
	const base = await scene(A.page);
	const layerZ = base.filter((o) => o.layer).map((o) => o.z);
	const cx = v0.pos[0];
	const cy = v0.pos[1];
	const onALayer = (z) => layerZ.some((lz) => Math.abs(z - lz) < 0.05);
	const facesView = (a) => a[2] > 0.999;
	console.log(`  layers at z ${JSON.stringify(layerZ)}, view centre ${cx.toFixed(2)}, ${cy.toFixed(2)}`);
	// a screen point on the plane of the layers under the centre (the ortho view looks straight down -Z, so any z maps the same)
	const at = (dx, dy) => h.projectPoint(A.page, [cx + dx, cy + dy, layerZ[0] ?? 0]);

	// ---- 1 Shapes --------------------------------------------------------------------------------------
	await A.page.click('#tool2d-shapes');
	await h.eventually(() => view(A.page), (v) => v.armed === 'rect', '1.0 Shapes arms the rectangle', 15000);
	let depth = await undoDepth(A.page);
	const p0 = await at(-1.2, 0.6);
	const p1 = await at(-0.2, -0.4);
	await A.page.mouse.move(p0.x, p0.y);
	await A.page.mouse.down();
	await A.page.mouse.move(p1.x, p1.y, { steps: 8 });
	await A.page.mouse.up();
	await h.eventually(() => scene(A.page), (l) => l.some((o) => o.kind === 'rect'), '1.1 a drag draws a rectangle', 15000);
	let now = await scene(A.page);
	const rect = now.find((o) => o.kind === 'rect');
	h.check(onALayer(rect.z), `1.2 ...on a 2D layer's plane (z ${rect.z}; layers ${JSON.stringify(layerZ)})`);
	h.check(facesView(rect.zAxis), `1.3 ...facing the view (+Z ${JSON.stringify(rect.zAxis)})`);
	h.check((await undoDepth(A.page)) === depth + 1, '1.4 ...as ONE undo entry');
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => scene(A.page), (l) => !l.some((o) => o.uuid === rect.uuid), '1.5 one undo removes it', 8000);
	await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => scene(A.page), (l) => l.some((o) => o.uuid === rect.uuid), '1.6 redo brings it back', 8000);
	await A.page.keyboard.press('Escape');
	await A.page.keyboard.press('Escape');

	// ---- 2 Pen -------------------------------------------------------------------------------------------
	await A.page.click('#tool2d-pen');
	await h.eventually(() => view(A.page), (v) => v.armed === 'pen', '2.0 Pen arms the pen', 15000);
	depth = await undoDepth(A.page);
	const q = [await at(0.4, 0.4), await at(1.4, 0.5), await at(0.9, -0.5)];
	for (const p of q) {
		await A.page.mouse.click(p.x, p.y);
		await A.page.waitForTimeout(350);
	}
	await A.page.mouse.click(q[0].x, q[0].y);
	await h.eventually(() => scene(A.page), (l) => l.some((o) => o.kind === 'path' && o.closed), '2.1 three clicks and the first point again close a path', 15000);
	now = await scene(A.page);
	const pen = now.find((o) => o.kind === 'path' && o.closed);
	h.check(pen.nodes === 3, `2.2 ...with its three points (${pen.nodes})`);
	h.check(onALayer(pen.z) && facesView(pen.zAxis), `2.3 ...on a layer's plane, facing the view (z ${pen.z}, +Z ${JSON.stringify(pen.zAxis)})`);
	h.check((await undoDepth(A.page)) === depth + 1, '2.4 ...as ONE undo entry');
	await A.page.keyboard.press('Escape');
	await A.page.keyboard.press('Escape');

	// ---- 3 Extrude -----------------------------------------------------------------------------------------
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(300);
	const before = JSON.stringify((await scene(A.page)).map((o) => [o.uuid, o.depth]));
	await A.page.click('#tool2d-extrude');
	await h.eventually(() => A.page.evaluate(() => document.body.textContent ?? ''), (t) => /Select a shape or a text first/.test(t), '3.0 with nothing selected, Extrude says what to select', 8000);
	h.check(JSON.stringify((await scene(A.page)).map((o) => [o.uuid, o.depth])) === before, '3.0b ...and changes nothing');
	await A.page.evaluate((uuid) => window.__stores.objectActions.selectObject(uuid, true), rect.uuid);
	await A.page.waitForTimeout(400);
	depth = await undoDepth(A.page);
	await A.page.click('#tool2d-extrude');
	await h.eventually(() => scene(A.page), (l) => Math.abs((l.find((o) => o.uuid === rect.uuid)?.depth ?? 0) - 0.1) < 1e-6, '3.1 Extrude makes the selected rectangle 10 cm deep', 15000);
	await h.eventually(() => scene(A.page), (l) => Math.abs((l.find((o) => o.uuid === rect.uuid)?.zext ?? 0) - 0.1) < 0.005, '3.2 ...a real solid (z extent 0.1)', 15000);
	h.check((await undoDepth(A.page)) === depth + 1, '3.3 ...as ONE undo entry');
	await A.page.click('#tool2d-extrude');
	await h.eventually(() => scene(A.page), (l) => (l.find((o) => o.uuid === rect.uuid)?.depth ?? -1) === 0, '3.4 a second press makes it flat again', 15000);
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => scene(A.page), (l) => Math.abs((l.find((o) => o.uuid === rect.uuid)?.depth ?? 0) - 0.1) < 1e-6, '3.5 undo goes back to the solid', 8000);

	// ---- 4 --------------------------------------------------------------------------------------------------
	h.check(!(A.page.__errors ?? []).length, `4. no page error (${(A.page.__errors ?? []).join(' | ') || 'none'})`);
	await h.finish(browser);
});
