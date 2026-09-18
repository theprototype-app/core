// D2 — SHARED MATERIALS: "by default copy, add an option to share".
//
// The feature is one line locally (skip the material clone) and everything hard about it
// is REPLICATION and PERSISTENCE, so that is what this measures: two peers agreeing after
// an edit to either object, a late joiner inheriting the share, and a `.tpscene` round
// trip keeping ONE material rather than two that look alike.
//
// The metric throughout is material IDENTITY (`===`), never the material's type or its
// colour. Two objects can hold two separate materials that are identical in every
// property — that is exactly what a COPY is — so a value check cannot tell copy from
// share, and would pass against the feature being absent.

const h = require('./helpers.cjs');

/** Are these two objects wearing the SAME material instance, and what ids do they hold? */
const shareState = (page, a, b) =>
	page.evaluate(
		({ a, b }) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((g) => (group = g))();
			const oa = group?.getObjectByProperty('uuid', a);
			const ob = group?.getObjectByProperty('uuid', b);
			return {
				found: !!oa && !!ob,
				same: !!oa && !!ob && oa.material === ob.material,
				idA: oa?.userData?.materialId ?? '',
				idB: ob?.userData?.materialId ?? '',
				colourA: oa?.material?.color?.getHexString?.() ?? '',
				colourB: ob?.material?.color?.getHexString?.() ?? ''
			};
		},
		{ a, b }
	);

const colours = (page, list) =>
	page.evaluate((uuids) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return uuids.map((u) => group?.getObjectByProperty('uuid', u)?.material?.color?.getHexString?.() ?? '');
	}, list);

/** duplicate the selected object and return the new uuid */
const duplicate = async (page, uuid) => {
	const before = await page.evaluate(() => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const out = [];
		group.traverse((n) => n.isMesh && out.push(n.uuid));
		return out;
	});
	await page.evaluate((u) => window.__stores.objectActions.duplicateObject(u), uuid);
	await page.waitForTimeout(900);
	const after = await page.evaluate(() => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const out = [];
		group.traverse((n) => n.isMesh && out.push(n.uuid));
		return out;
	});
	return after.find((u) => !before.includes(u)) ?? '';
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---------------------------------------------------------------- section 1
	console.log('\n=== 1. COPY is still the default ===');
	const boxU = await page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 900));
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		let found = '';
		group.traverse((n) => {
			if (n.isMesh && !found) found = n.uuid;
		});
		return found;
	});
	h.check(!!boxU, '1.1 premise: a box exists');
	h.check(
		!(await page.evaluate(() => {
			let on = null;
			window.__stores.materialSharing.shareDuplicatedMaterials.subscribe((v) => (on = v))();
			return on;
		})),
		'1.2 the setting is OFF out of the box — a duplicate is a working copy'
	);
	const copyU = await duplicate(page, boxU);
	const copied = await shareState(page, boxU, copyU);
	h.check(copied.found && !copied.same, '1.3 the copy gets its OWN material instance');
	h.check(!copied.idA && !copied.idB, '1.4 ...and neither object carries a material id');
	// prove it by EDITING: this is the behaviour sharing is the opposite of
	await page.evaluate((u) => window.__stores.materialsHandler.setObjectColor(u, '#ff0000'), copyU);
	await page.waitForTimeout(600);
	const afterCopyEdit = await shareState(page, boxU, copyU);
	h.check(
		afterCopyEdit.colourB === 'ff0000' && afterCopyEdit.colourA !== 'ff0000',
		'1.5 editing the copy leaves the original alone: ' + afterCopyEdit.colourA + ' / ' + afterCopyEdit.colourB
	);

	// ---------------------------------------------------------------- section 2
	console.log('\n=== 2. sharing ON: one material, two objects ===');
	await page.evaluate(() =>
		window.__stores.materialSharing.shareDuplicatedMaterials.set(true)
	);
	const sharedU = await duplicate(page, boxU);
	const shared = await shareState(page, boxU, sharedU);
	h.check(shared.same, '2.1 the copy wears the SAME material instance');
	h.check(
		!!shared.idA && shared.idA === shared.idB,
		'2.2 ...and both carry the same material id: ' + shared.idA + ' / ' + shared.idB
	);
	h.check(
		await page.evaluate((u) => window.__stores.materialSharing.isSharedMaterial(u), boxU),
		'2.3 the source knows it is shared now too (sharing is symmetric, not a property of the copy)'
	);
	// GEOMETRY is still copied — the two questions are separate and only one has a setting
	const geometrySeparate = await page.evaluate(
		({ a, b }) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((g) => (group = g))();
			return (
				group.getObjectByProperty('uuid', a).geometry !== group.getObjectByProperty('uuid', b).geometry
			);
		},
		{ a: boxU, b: sharedU }
	);
	h.check(geometrySeparate, '2.4 geometry is still its OWN — a vertex edit must not deform the original');

	await page.evaluate((u) => window.__stores.materialsHandler.setObjectColor(u, '#2244ff'), sharedU);
	await page.waitForTimeout(700);
	const afterShareEdit = await shareState(page, boxU, sharedU);
	h.check(
		afterShareEdit.colourA === '2244ff' && afterShareEdit.colourB === '2244ff',
		'2.5 editing either changes both: ' + afterShareEdit.colourA + ' / ' + afterShareEdit.colourB
	);

	// ---------------------------------------------------------------- section 3
	console.log('\n=== 3. Unlink gives one object its material back ===');
	await page.evaluate((u) => window.__stores.materialSharing.unlinkMaterial(u), sharedU);
	await page.waitForTimeout(700);
	const unlinked = await shareState(page, boxU, sharedU);
	h.check(!unlinked.same, '3.1 the unlinked object has its own instance again');
	h.check(unlinked.idB === '', '3.2 ...and dropped the id');
	h.check(
		unlinked.colourA === unlinked.colourB,
		'3.3 ...keeping the material it was WEARING (unlink is not a revert): ' + unlinked.colourB
	);
	await page.evaluate((u) => window.__stores.materialsHandler.setObjectColor(u, '#00cc44'), sharedU);
	await page.waitForTimeout(600);
	const afterUnlinkEdit = await shareState(page, boxU, sharedU);
	h.check(
		afterUnlinkEdit.colourB === '00cc44' && afterUnlinkEdit.colourA === '2244ff',
		'3.4 and an edit no longer crosses: ' + afterUnlinkEdit.colourA + ' / ' + afterUnlinkEdit.colourB
	);

	// ---------------------------------------------------------------- section 4
	console.log('\n=== 4. the reconcile: the ID is the truth, the instance is an optimisation ===');
	// re-share, then SPLIT the instances behind the app's back — which is exactly what
	// GLTF, a peer's per-object messages and undo each do on their own path
	const pairU = await duplicate(page, boxU);
	h.check((await shareState(page, boxU, pairU)).same, '4.1 premise: a fresh shared pair');
	const split = await page.evaluate(
		({ a, b }) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((g) => (group = g))();
			const ob = group.getObjectByProperty('uuid', b);
			ob.material = ob.material.clone(); // the id stays; the instance does not
			const oa = group.getObjectByProperty('uuid', a);
			return { same: oa.material === ob.material, idsMatch: oa.userData.materialId === ob.userData.materialId };
		},
		{ a: boxU, b: pairU }
	);
	h.check(!split.same && split.idsMatch, '4.2 premise: instances split, ids still equal');
	const repointed = await page.evaluate(() =>
		window.__stores.materialSharing.reconcileSharedMaterials()
	);
	const healed = await shareState(page, boxU, pairU);
	h.check(
		repointed >= 1 && healed.same,
		'4.3 the reconcile re-unifies them by id (' + repointed + ' re-pointed)'
	);
	h.check(
		(await page.evaluate(() => window.__stores.materialSharing.reconcileSharedMaterials())) === 0,
		'4.4 ...and is a no-op the second time (it only assigns where they differ)'
	);

	// ---------------------------------------------------------------- section 5
	console.log('\n=== 5. a .tpscene round trip keeps ONE material ===');
	const roundTrip = await page.evaluate(() => {
		const payload = window.__stores.sessions.buildSessionPayload('material-sharing');
		if (!payload) return { skipped: true };
		// `objects` is an ARRAY of per-child toJSON results, each `{geometries, materials,
		// object}` — the shape cost this check one red run, so it is walked explicitly
		// AND counted shape-independently below.
		const ids = [];
		const walk = (node) => {
			if (node?.userData?.materialId) ids.push([node.uuid, node.userData.materialId]);
			(node?.children ?? []).forEach(walk);
		};
		for (const entry of payload.objects ?? []) walk(entry?.object ?? entry);
		return { skipped: false, ids, text: JSON.stringify(payload) };
	});
	if (roundTrip.skipped) {
		console.log('SKIP: no session payload builder on this build');
	} else {
		const pair = roundTrip.ids.filter(([uuid]) => uuid === boxU || uuid === pairU);
		h.check(
			pair.length === 2 && pair[0][1] === pair[1][1],
			'5.1 the material id rides the SAVE for BOTH objects: ' + JSON.stringify(pair)
		);
		const id = pair[0]?.[1] ?? '';
		const occurrences = id ? roundTrip.text.split('"materialId":"' + id + '"').length - 1 : 0;
		h.check(
			occurrences === 2,
			'5.2 ...exactly twice in the saved bytes, wherever the shape puts it: ' + occurrences
		);
		// and THAT is all the save needs to carry: the instance is re-unified on load by
		// the reconcile, which section 4 measures on its own
		h.check(
			(await page.evaluate(() => window.__stores.materialSharing.reconcileSharedMaterials())) === 0,
			'5.3 ...because the instance is the reconcile\'s job, not the file\'s'
		);
	}

	// ---------------------------------------------------------------- section 6
	console.log('\n=== 6. two peers ===');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	await h.eventually(
		() => shareState(B.page, boxU, pairU),
		(s) => s.found,
		'6.1 B receives both objects',
		30000
	);
	await h.eventually(
		() => shareState(B.page, boxU, pairU),
		(s) => s.idA && s.idA === s.idB,
		'6.2 ...carrying the same material id (it rides userData through the object sync)',
		20000
	);
	await h.eventually(
		() => shareState(B.page, boxU, pairU),
		(s) => s.same,
		'6.3 ...and B\'s reconcile puts them on ONE material instance',
		20000
	);

	// the edit crosses — the send-side fan is the whole mechanism
	await page.evaluate((u) => window.__stores.materialsHandler.setObjectColor(u, '#ffaa00'), boxU);
	await h.eventually(
		() => colours(B.page, [boxU, pairU]),
		(c) => c[0] === 'ffaa00' && c[1] === 'ffaa00',
		'6.4 an edit to ONE object on A reaches BOTH objects on B (the sender fans)',
		20000
	);
	// and in the other direction, from the object that was not edited
	await B.page.evaluate((u) => window.__stores.materialsHandler.setObjectColor(u, '#8800ff'), pairU);
	await h.eventually(
		() => colours(page, [boxU, pairU]),
		(c) => c[0] === '8800ff' && c[1] === '8800ff',
		'6.5 ...and back the other way, edited from the copy',
		20000
	);

	// ---------------------------------------------------------------- section 6b
	// A FIRST SHARE MADE WHILE CONNECTED is the path that needs the applier, and it has to
	// be a FRESH object: `linkMaterials` mints the id on the SOURCE, and nothing re-sends a
	// source's userData afterwards, so a peer cloning its own copy of an object it received
	// BEFORE the id existed would produce two unshared objects. Everything above connected
	// B after the sharing, so the id simply rode the full-state sync and the applier's link
	// could be deleted with the suite still green — measured, then fixed by this section.
	console.log('\n=== 6b. a FIRST share made while connected ===');
	const freshU = await page.evaluate(async () => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const before = [];
		group.traverse((n) => n.isMesh && before.push(n.uuid));
		window.__stores.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 1200));
		let found = '';
		group.traverse((n) => {
			if (n.isMesh && !before.includes(n.uuid) && !found) found = n.uuid;
		});
		return found;
	});
	await h.eventually(
		() => shareState(B.page, freshU, freshU),
		(s) => s.found,
		'6b.0 premise: a brand-new object, never shared, has reached B',
		25000
	);
	h.check(
		(await shareState(page, freshU, freshU)).idA === '',
		'6b.0b ...carrying no material id on either side yet'
	);
	const liveCopyU = await duplicate(page, freshU);
	h.check(!!liveCopyU, '6b.1 premise: A duplicated it while connected, minting the id now');
	await h.eventually(
		() => shareState(B.page, freshU, liveCopyU),
		(s) => s.found,
		'6b.2 B built the copy',
		20000
	);
	await h.eventually(
		() => shareState(B.page, freshU, liveCopyU),
		(s) => !!s.idB && s.idA === s.idB && s.same,
		'6b.3 ...with the same material id AND the same instance — the applier links it too',
		20000
	);
	await page.evaluate((u) => window.__stores.materialsHandler.setObjectColor(u, '#44ff88'), liveCopyU);
	await h.eventually(
		() => colours(B.page, [freshU, liveCopyU]),
		(c) => c[0] === '44ff88' && c[1] === '44ff88',
		'6b.4 ...and edits cross on B',
		20000
	);

	// ---------------------------------------------------------------- section 6c
	// THE MATERIAL TYPE is the one op that REPLACES the instance instead of writing into
	// it, which makes it the one place the send-side fan is load-bearing: without it the
	// peer switches ONE object, and its reconcile then lends whichever material it meets
	// first — which can put the OLD type back and diverge the two sides for good.
	console.log('\n=== 6c. a material TYPE switch, the instance-replacing op ===');
	const typeOf = (p, list) =>
		p.evaluate((uuids) => {
			let group = null;
			window.__stores.objectsGroup.subscribe((g) => (group = g))();
			return uuids.map((u) => group?.getObjectByProperty('uuid', u)?.material?.type ?? '');
		}, list);
	const beforeTypes = await typeOf(B.page, [freshU, liveCopyU]);
	h.check(
		beforeTypes[0] === beforeTypes[1] && beforeTypes[0] === 'MeshStandardMaterial',
		'6c.1 premise: both are MeshStandardMaterial on B: ' + JSON.stringify(beforeTypes)
	);
	await page.evaluate((u) =>
		window.__stores.materialsHandler.switchMaterialType(u, 'MeshPhongMaterial'), freshU);
	await page.waitForTimeout(900);
	const aTypes = await typeOf(page, [freshU, liveCopyU]);
	h.check(
		aTypes.every((t) => t === 'MeshPhongMaterial'),
		'6c.2 A switches BOTH objects (the local relink, since the old instance is gone): ' + JSON.stringify(aTypes)
	);
	await h.eventually(
		() => typeOf(B.page, [freshU, liveCopyU]),
		(t) => t[0] === 'MeshPhongMaterial' && t[1] === 'MeshPhongMaterial',
		'6c.3 ...and B agrees about both',
		20000
	);

	// ---------------------------------------------------------------- section 6d
	// THE FAN, ISOLATED. On a receiver whose objects already SHARE one instance, a single
	// per-object message reaches both for free — which is why the fan looked unnecessary
	// until it was measured against a receiver whose instances are still SPLIT. That is a
	// real window (right after the objects arrive, right after a duplicate, and for the
	// whole life of a peer on an older build with no reconcile at all), so it is staged
	// here deliberately: B's reconcile is stopped and its instances separated by hand.
	console.log('\n=== 6d. the fan, isolated: a receiver whose instances are still split ===');
	const staged = await B.page.evaluate(
		({ a, b }) => {
			window.__stores.materialSharing.stopMaterialSharing();
			let group = null;
			window.__stores.objectsGroup.subscribe((g) => (group = g))();
			const ob = group.getObjectByProperty('uuid', b);
			ob.material = ob.material.clone();
			const oa = group.getObjectByProperty('uuid', a);
			return {
				split: oa.material !== ob.material,
				idsMatch: oa.userData.materialId === ob.userData.materialId
			};
		},
		{ a: freshU, b: liveCopyU }
	);
	h.check(
		staged.split && staged.idsMatch,
		'6d.1 premise: B holds two instances with one id, and its reconcile is stopped'
	);
	await page.evaluate((u) => window.__stores.materialsHandler.setObjectColor(u, '#ff00aa'), freshU);
	await h.eventually(
		() => colours(B.page, [freshU, liveCopyU]),
		(c) => c[0] === 'ff00aa' && c[1] === 'ff00aa',
		'6d.2 the edit still reaches BOTH — because the sender fanned it',
		20000
	);
	await B.page.evaluate(() => {
		window.__stores.materialSharing.startMaterialSharing();
		window.__stores.materialSharing.reconcileSharedMaterials();
	});
	await B.page.waitForTimeout(600);
	h.check(
		(await shareState(B.page, freshU, liveCopyU)).same,
		'6d.3 ...and B re-unifies once its reconcile is running again'
	);

	// ---------------------------------------------------------------- section 7
	console.log('\n=== 7. a late joiner ===');
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(
		() => shareState(C.page, freshU, liveCopyU),
		(s) => s.found && s.idA && s.idA === s.idB && s.same,
		'7.1 a late joiner receives the share, not two materials that happen to match',
		35000
	);
	await page.evaluate((u) => window.__stores.materialsHandler.setObjectColor(u, '#11ddcc'), freshU);
	await h.eventually(
		() => colours(C.page, [freshU, liveCopyU]),
		(c) => c[0] === '11ddcc' && c[1] === '11ddcc',
		'7.2 ...and edits reach both objects on it too',
		20000
	);

	h.check(h.pageErrors(A).length === 0, '7.3 no page errors on A (' + JSON.stringify(h.pageErrors(A)) + ')');
	h.check(h.pageErrors(B).length === 0, '7.4 no page errors on B (' + JSON.stringify(h.pageErrors(B)) + ')');

	await h.finish(browser);
});
