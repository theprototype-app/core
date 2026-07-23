// D3 (roadmap 13): the VR radial obj:prefab action saves a MULTI-selection as
// ONE layout-preserving prefab (savePrefabSelection, parity with the desktop
// context menu) instead of snapshotting only the primary object. Single
// selection keeps the old single-object path.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
		const group = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const [a, b] = group.children.slice(-2);
		a.position.set(-1, 0.5, 0);
		b.position.set(1, 0.5, 0);

		const count = () => {
			let list;
			s.prefabs.prefabs.subscribe((v) => (list = v))();
			return list.length;
		};
		const last = () => {
			let list;
			s.prefabs.prefabs.subscribe((v) => (list = v))();
			return list[list.length - 1];
		};
		const entry = s.vrRadialMenu.findMenuEntry('obj:prefab');
		if (!entry) return { noEntry: true };

		// multi-selection -> ONE prefab holding both members
		const before = count();
		s.objectActions.applySelectionSet([a.uuid, b.uuid]);
		entry.action();
		await new Promise((r) => setTimeout(r, 800));
		const afterMulti = count();
		const multi = last();
		const multiChildren = multi?.element?.object?.children?.length ?? 0;

		// single selection -> the old single-object path
		s.objectActions.selectObject(a.uuid);
		entry.action();
		await new Promise((r) => setTimeout(r, 800));
		const afterSingle = count();
		const single = last();

		return {
			before,
			afterMulti,
			multiChildren,
			multiType: multi?.element?.object?.type,
			afterSingle,
			singleType: single?.element?.object?.type
		};
	});

	h.check(!res.noEntry, 'obj:prefab radial entry exists');
	h.check(
		res.afterMulti === res.before + 1,
		`multi-select saves exactly ONE prefab (${res.before} -> ${res.afterMulti})`
	);
	h.check(
		res.multiType === 'Group' && res.multiChildren === 2,
		`the multi prefab is a Group with both members (${res.multiType}, ${res.multiChildren} children)`
	);
	h.check(
		res.afterSingle === res.afterMulti + 1 && res.singleType === 'Mesh',
		`single selection keeps the single-object path (${res.singleType})`
	);

	await h.finish(browser);
});
