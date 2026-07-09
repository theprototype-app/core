// Phase 23: full undo/redo across create/material/rename/visibility/group/delete, replicated.
const h = require('./helpers.cjs');

const stateOf = (page, uuid) =>
	page.evaluate(
		(uuid) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((group) => {
					const o = group?.getObjectByProperty('uuid', uuid);
					resolve(
						o
							? {
									name: o.name,
									visible: o.visible,
									mat: o.material?.type ?? null,
									parent: o.parent === group ? 'root' : o.parent?.uuid
								}
							: null
					);
				})();
			}),
		uuid
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const pages = [A.page, B.page];
	const both = (uuid, predicate, label, timeout) =>
		h.eventually(
			() => Promise.all(pages.map((p) => stateOf(p, uuid))),
			(states) => states.every(predicate),
			label,
			timeout ?? 8000
		);
	const run = (code) => A.page.evaluate(code);

	const uuid = await run(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) => resolve(g.children[g.children.length - 1].uuid))()
		);
	});
	await both(uuid, (s) => s != null, 'box created on both peers');

	await run(() => window.__stores.history.undo());
	await both(uuid, (s) => s == null, 'undo create removes it on both peers');
	await run(() => window.__stores.history.redo());
	await both(uuid, (s) => s != null, 'redo restores it on both peers (same uuid)');

	await A.page.evaluate((uuid) => window.__stores.materialsHandler.switchMaterialType(uuid, 'MeshPhongMaterial'), uuid);
	await both(uuid, (s) => s?.mat === 'MeshPhongMaterial', 'material switch replicates');
	await run(() => window.__stores.history.undo());
	await both(uuid, (s) => s?.mat === 'MeshStandardMaterial', 'undo material switch on both peers');

	await A.page.evaluate((uuid) => window.__stores.objectActions.renameObject(uuid, 'Renamed'), uuid);
	await both(uuid, (s) => s?.name === 'Renamed', 'rename replicates');
	await run(() => window.__stores.history.undo());
	await both(uuid, (s) => s?.name === 'Box', 'undo rename on both peers');

	await A.page.evaluate((uuid) => window.__stores.objectActions.toggleObjectVisibility(uuid), uuid);
	await both(uuid, (s) => s?.visible === false, 'hide replicates');
	await run(() => window.__stores.history.undo());
	await both(uuid, (s) => s?.visible === true, 'undo hide on both peers');

	const groupUuid = await run(() => {
		window.__stores.commandsHandler.sceneCommand('/group testg');
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) => resolve(g.children.find((c) => c.type === 'Group')?.uuid))()
		);
	});
	await A.page.evaluate(({ uuid, groupUuid }) => window.__stores.objectActions.moveObjectToGroup(uuid, groupUuid), { uuid, groupUuid });
	await both(uuid, (s) => s?.parent === groupUuid, 'move into group replicates');
	await run(() => window.__stores.history.undo());
	await both(uuid, (s) => s?.parent === 'root', 'undo group move on both peers');

	await A.page.evaluate((uuid) => window.__stores.commandsHandler.sceneCommand('/clear ' + uuid), uuid);
	await both(uuid, (s) => s == null, 'delete replicates');
	await run(() => window.__stores.history.undo());
	await both(
		uuid,
		(s) => s != null && s.name === 'Box' && s.mat === 'MeshStandardMaterial' && s.visible === true,
		'undo delete restores the object intact on both peers'
	);

	await run(async () => {
		for (let i = 0; i < 20; i++) {
			const has = await new Promise((r) => window.__stores.history.canUndo.subscribe(r)());
			if (!has) break;
			window.__stores.history.undo();
			await new Promise((r) => setTimeout(r, 400));
		}
	});
	await both(uuid, (s) => s == null, 'full unwind removes the box on both peers');
	await both(groupUuid, (s) => s == null, 'full unwind removes the group on both peers');
	const counts = await Promise.all(
		pages.map((p) =>
			p.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.children.length))()))
		)
	);
	h.check(counts[0] === 0 && counts[1] === 0, `scenes empty after unwind (A ${counts[0]}, B ${counts[1]})`);

	await h.finish(browser);
});
