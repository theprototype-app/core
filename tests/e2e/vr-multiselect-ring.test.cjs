// D4 (roadmap 13): the VR Edit ring is selection-aware — counted labels act
// on the SET (Duplicate/Delete/Save prefab), Make Group replaces Edit Mesh
// for a multi-selection (one-undo groupSelection, the U-2 op), Properties
// greys out (disabled predicate blocks activation). Single selection keeps
// the 137/216 ring exactly. In-headset sector styling is the user's manual
// check.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const res = await A.page.evaluate(async () => {
		const s = window.__stores;
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
		s.commandsHandler.sceneCommand('/create cylinder');
		const group = read(s.objectsGroup);
		const [a, b, c] = group.children.slice(-3);

		const ringIds = () => s.vrRadialMenu.ringEntries('object').map((e) => e.id);
		const label = (id) => {
			const entry = s.vrRadialMenu.findMenuEntry(id);
			return typeof entry.label === 'function' ? entry.label() : entry.label;
		};

		// --- single selection: the 137/216 ring, plain labels ---
		s.objectActions.selectObject(a.uuid);
		const singleIds = ringIds();
		const singleLabels = { dup: label('obj:duplicate'), prefab: label('obj:prefab') };
		const propsEnabledSingle = !s.vrRadialMenu.findMenuEntry('obj:props').disabled?.();

		// --- multi selection: counted labels, Make Group, Properties greyed ---
		s.objectActions.applySelectionSet([a.uuid, b.uuid]);
		const multiIds = ringIds();
		const multiLabels = {
			dup: label('obj:duplicate'),
			del: label('obj:delete'),
			prefab: label('obj:prefab'),
			group: label('obj:group')
		};
		const propsDisabledMulti = !!s.vrRadialMenu.findMenuEntry('obj:props').disabled?.();
		s.vrControls.executeVRMenuAction('obj:props');
		const propsPanelStaysClosed = read(s.vrPropsPanelOpen) === false;

		// duplicate acts on the SET
		const beforeDup = read(s.objectsGroup).children.length;
		s.vrControls.executeVRMenuAction('obj:duplicate');
		await new Promise((r) => setTimeout(r, 300));
		const afterDup = read(s.objectsGroup).children.length;

		// Make Group: ONE undo entry wrapping the whole op
		s.objectActions.applySelectionSet([a.uuid, b.uuid]);
		const undoBefore = read(s.history.undoStack).length;
		s.vrControls.executeVRMenuAction('obj:group');
		await new Promise((r) => setTimeout(r, 300));
		const undoAfter = read(s.history.undoStack).length;
		const grouped = read(s.objectsGroup)
			.children.filter((o) => o.type === 'Group')
			.some(
				(g) =>
					g.children.some((ch) => ch.uuid === a.uuid) &&
					g.children.some((ch) => ch.uuid === b.uuid)
			);

		// back to single: the ring reverts
		s.objectActions.selectObject(c.uuid);
		const revertIds = ringIds();

		return {
			singleIds,
			singleLabels,
			propsEnabledSingle,
			multiIds,
			multiLabels,
			propsDisabledMulti,
			propsPanelStaysClosed,
			beforeDup,
			afterDup,
			undoBefore,
			undoAfter,
			grouped,
			revertIds
		};
	});

	h.check(
		res.singleIds.includes('obj:editmesh') && !res.singleIds.includes('obj:group'),
		`single selection shows Edit Mesh, no Make Group (${res.singleIds.join(',')})`
	);
	h.check(
		res.singleLabels.dup === 'Duplicate' && res.singleLabels.prefab === 'Save prefab',
		`single labels stay uncounted (${res.singleLabels.dup} / ${res.singleLabels.prefab})`
	);
	h.check(res.propsEnabledSingle, 'Properties is enabled for a single selection');
	h.check(
		res.multiIds.includes('obj:group') &&
			!res.multiIds.includes('obj:editmesh') &&
			!res.multiIds.includes('obj:ungroup'),
		`multi selection swaps Edit Mesh for Make Group (${res.multiIds.join(',')})`
	);
	h.check(
		res.multiLabels.dup === 'Duplicate (2)' &&
			res.multiLabels.del === 'Delete (2)' &&
			res.multiLabels.prefab === 'Save prefab (2)' &&
			res.multiLabels.group === 'Make Group (2)',
		`multi labels carry the count (${Object.values(res.multiLabels).join(' / ')})`
	);
	h.check(
		res.propsDisabledMulti && res.propsPanelStaysClosed,
		'Properties greys out for a multi-selection and never opens'
	);
	h.check(
		res.afterDup === res.beforeDup + 2,
		`Duplicate acts on the whole set (${res.beforeDup} -> ${res.afterDup})`
	);
	h.check(
		res.grouped && res.undoAfter === res.undoBefore + 1,
		`Make Group groups both members with ONE undo entry (+${res.undoAfter - res.undoBefore})`
	);
	h.check(
		res.revertIds.includes('obj:editmesh') && !res.revertIds.includes('obj:group'),
		'ring reverts when the selection drops back to one'
	);

	await h.finish(browser);
});
