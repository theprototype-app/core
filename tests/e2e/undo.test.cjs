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
									parent: o.parent === group ? 'root' : o.parent?.uuid,
									pos: o.position.toArray().map((v) => Math.round(v * 1e3) / 1e3)
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

	// --- redo puts a PLACED object back where it was, not at the world centre ---
	// The Add menu runs the create command (which records the undo entry) and
	// THEN lands the object at the clicked point, so the recorded snapshot held
	// the default origin pose. The snapshot is refreshed at removal time now.
	const placed = await run(() => {
		window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [3, 0.5, -2]);
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) => {
				const o = g.children[g.children.length - 1];
				resolve({ uuid: o.uuid, pos: o.position.toArray() });
			})()
		);
	});
	const atPoint = (s) => s != null && s.pos[0] === 3 && s.pos[1] === 0.5 && s.pos[2] === -2;
	h.check(atPoint({ pos: placed.pos }), `the Add menu spawns at the clicked point (${placed.pos})`);
	await both(placed.uuid, atPoint, 'the placed position replicates');
	await run(() => window.__stores.history.undo());
	await both(placed.uuid, (s) => s == null, 'undo removes the placed box on both peers');
	await run(() => window.__stores.history.redo());
	await both(placed.uuid, atPoint, 'redo restores it AT ITS PLACED POSITION on both peers');

	// an edit made after creation also survives the create undo/redo round trip
	await A.page.evaluate((uuid) => window.__stores.objectActions.renameObject(uuid, 'Placed'), placed.uuid);
	await A.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		g.getObjectByProperty('uuid', uuid).position.set(-4, 2, 1);
	}, placed.uuid);
	await run(() => window.__stores.history.undo()); // the rename
	await run(() => window.__stores.history.undo()); // the create
	await both(placed.uuid, (s) => s == null, 'the placed box is gone again');
	await run(() => window.__stores.history.redo());
	await both(
		placed.uuid,
		(s) => s != null && s.pos[0] === -4 && s.pos[1] === 2 && s.pos[2] === 1,
		'redo restores the pose the object had when it left the scene'
	);
	// leave the scene as the rest of the suite expects it (just the first box):
	// undo the create again — no delete entry, and the next edit clears the redo
	await run(() => window.__stores.history.undo());
	await both(placed.uuid, (s) => s == null, 'placed box removed before the main sequence continues');

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
