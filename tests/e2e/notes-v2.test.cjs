// 15-H (scene notes v2): the name/description/color/label model, the near-pin
// view+edit popover, and the drawer's label groups / traversal / pins toggle.
//
// Replication is asserted BOTH ways without the signaling cloud: a send spy for
// the outgoing `{type:'annotation'}` payload and the real applier
// (annotationsHandler.applyAnnotation / applyAnnotationsSnapshot) for the receive
// path. A true two-peer pass runs with TWO_PEER=1 (the hosts mapping is commented
// out locally, so it is env-gated like connect-states).
const h = require('./helpers.cjs');

const store = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.annotationsHandler.annotations.subscribe(r)())
	);

const active = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.annotationsHandler.activeAnnotation.subscribe(r)())
	);

// commit a note on `uuid` with v2 fields; returns its id
const addNote = (page, uuid, offset, fields) =>
	page.evaluate(
		({ uuid, offset, fields }) => {
			const ah = window.__stores.annotationsHandler;
			ah.addAnnotation(uuid, offset);
			let cur = null;
			ah.activeAnnotation.subscribe((a) => (cur = a))();
			if (!cur?.draft) return null;
			ah.setAnnotation({ ...cur.draft, ...fields });
			ah.activeAnnotation.set(null);
			return cur.draft.id;
		},
		{ uuid, offset, fields }
	);

// screen pixel of a pin (or draft) right now
const pinPixel = (page, idOrDraft) =>
	page.evaluate(
		(anchor) =>
			new Promise((resolve) => {
				const ah = window.__stores.annotationsHandler;
				window.__stores.globalCamera.subscribe((camera) => {
					window.__stores.globalRenderer.subscribe((renderer) => {
						const world = ah.annotationWorldPosition(anchor);
						if (!world || !camera || !renderer?.domElement) return resolve(null);
						const v = world.clone().project(camera);
						const rect = renderer.domElement.getBoundingClientRect();
						resolve({
							x: rect.left + ((v.x + 1) / 2) * rect.width,
							y: rect.top + ((1 - v.y) / 2) * rect.height,
							behind: v.z >= 1
						});
					})();
				})();
			}),
		idOrDraft
	);

const pinColor = (page, id) =>
	page.evaluate(
		(id) =>
			new Promise((resolve) => {
				window.__stores.annotationsHandler.pinsGroup.subscribe((group) => {
					const pin = group?.getObjectByName('pin-' + id);
					if (!pin) return resolve(null);
					let hex = null;
					pin.traverse((node) => {
						if (!hex && node.isMesh && node.material?.color)
							hex = '#' + node.material.color.getHexString();
					});
					resolve(hex);
				})();
			}),
		id
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });

	// --- H1: legacy payloads normalize at the store boundary -----------------
	const legacy = await A.page.evaluate(() => {
		const ah = window.__stores.annotationsHandler;
		ah.applyAnnotationsSnapshot([
			{
				id: 'legacy-note',
				objectUuid: 'nobody',
				offset: [0, 0, 0],
				text: 'from an old autosave',
				author: 'old peer',
				ts: 1
			}
		]);
		let list = [];
		ah.annotations.subscribe((l) => (list = l))();
		const a = list.find((x) => x.id === 'legacy-note');
		return a ? { name: a.name, color: a.color, label: a.label, text: a.text } : null;
	});
	h.check(
		legacy &&
			legacy.name === '' &&
			legacy.label === '' &&
			legacy.color === '#f59e0b' &&
			legacy.text === 'from an old autosave',
		'H1: an old-shape note loads with name/label defaults + the amber default color'
	);
	// the orphan prune drops it (no such object) — clear explicitly so numbering is clean
	await A.page.evaluate(() => window.__stores.annotationsHandler.annotations.set([]));

	// --- scene: one box, three notes -----------------------------------------
	const boxUuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const box = g.children[g.children.length - 1];
		box.position.set(0, 0.5, 0);
		box.updateMatrixWorld(true);
		return box.uuid;
	});
	const id1 = await addNote(A.page, boxUuid, [0.6, 1.2, 0], {
		name: 'Hinge',
		text: 'this corner needs a hinge',
		label: 'mechanics',
		color: '#22c55e'
	});
	const id2 = await addNote(A.page, boxUuid, [-0.6, 1.2, 0], { text: 'unlabeled thought' });
	const id3 = await addNote(A.page, boxUuid, [0, 1.6, 0.5], {
		name: 'Motor',
		text: 'motor mounts here',
		label: 'mechanics'
	});
	h.check(!!(id1 && id2 && id3), 'setup: three notes committed');

	// --- H4: the pin takes the note color -------------------------------------
	await A.page.waitForTimeout(400);
	h.check((await pinColor(A.page, id1)) === '#22c55e', 'H4: pin material uses the note color');
	h.check(
		(await pinColor(A.page, id2)) === '#f59e0b',
		'H4: a note with no explicit color keeps the amber default pin'
	);

	// --- H2/H5: the popover opens ANCHORED near its pin, in VIEW mode ---------
	await A.page.evaluate((id) => window.__stores.annotationsHandler.openAnnotation(id), id1);
	await A.page.waitForTimeout(900); // let the 400ms fly settle
	const viewCard = A.page.locator('[role="dialog"][aria-label="Note"]');
	h.check(await viewCard.first().isVisible(), 'H2: pin open lands on the VIEW face');
	const box1 = await viewCard.first().boundingBox();
	const pix1 = await pinPixel(A.page, id1);
	// the card sits beside the pin on whichever side fits (it flips near an edge)
	const gap = (b, p) => Math.min(Math.abs(b.x - p.x), Math.abs(b.x + b.width - p.x));
	h.check(
		!!box1 && !!pix1 && gap(box1, pix1) < 60 && Math.abs(box1.y - pix1.y) < 140,
		`H5: the card sits next to the projected pin (card ${box1 && Math.round(box1.x)},${
			box1 && Math.round(box1.y)
		} vs pin ${pix1 && Math.round(pix1.x)},${pix1 && Math.round(pix1.y)})`
	);
	h.check(
		!!box1 && box1.x + box1.width < 1280 - 4 && box1.y > 4,
		'H5: the card stays inside the viewport'
	);
	// it RIDES its anchor: move the owner object and the card follows the pin
	// (the object, not the camera — OrbitControls.update() re-derives the camera
	// pose from its own spherical state every frame and would revert a direct write)
	await A.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const box = g.getObjectByProperty('uuid', uuid);
		box.position.x += 2.5;
		box.updateMatrixWorld(true);
	}, boxUuid);
	await A.page.waitForTimeout(400);
	const box1b = await viewCard.first().boundingBox();
	const pix1b = await pinPixel(A.page, id1);
	h.check(
		!!box1b && !!pix1b && gap(box1b, pix1b) < 60 && Math.abs(box1b.y - pix1b.y) < 140,
		'H5: the card re-anchors as its pin moves (projection loop)'
	);
	// the edge facing the pin travelled with it (the card flips sides near an edge,
	// so compare the NEAR edge, not the left one)
	const nearEdge = (b, p) =>
		Math.abs(b.x - p.x) < Math.abs(b.x + b.width - p.x) ? b.x : b.x + b.width;
	h.check(
		!!box1 && !!box1b && Math.abs(nearEdge(box1, pix1) - nearEdge(box1b, pix1b)) > 200,
		`H5: it actually moved (not a fixed top-right card): card edge ${
			box1 && Math.round(nearEdge(box1, pix1))
		} -> ${box1b && Math.round(nearEdge(box1b, pix1b))}, pin ${pix1 && Math.round(pix1.x)} -> ${
			pix1b && Math.round(pix1b.x)
		}`
	);
	// the view card shows the description + the label chip
	const viewText = (await viewCard.first().textContent()) || '';
	h.check(
		viewText.includes('Hinge') && viewText.includes('this corner needs a hinge') && viewText.includes('mechanics'),
		'H5: the view card shows name, description and label'
	);

	// --- H5: edit face saves name/color/label and replicates -------------------
	await A.page.evaluate(() => {
		let original;
		window.__stores.peers.subscribe((p) => (original = p))();
		window.__peerOriginal = original;
		window.__sent = [];
		window.__stores.peers.set({ ...original, send: (m) => window.__sent.push(m) });
	});
	await A.page.evaluate(
		(id) => window.__stores.annotationsHandler.openAnnotation(id, 'edit'),
		id2
	);
	await A.page.waitForTimeout(700);
	const editCard = A.page.locator('[role="dialog"][aria-label="Edit note"]');
	h.check(await editCard.first().isVisible(), 'H2: openAnnotation(id, "edit") opens the EDIT face');
	await editCard.locator('input[placeholder="Name (optional)"]').fill('Latch');
	await editCard.locator('button[aria-label="Pin color #3b82f6"]').click();
	await editCard.locator('input[list="note-labels"]').fill('review');
	await editCard.getByRole('button', { name: 'Save' }).click();
	await A.page.waitForTimeout(400);
	const saved = (await store(A.page)).find((a) => a.id === id2);
	h.check(
		saved && saved.name === 'Latch' && saved.color === '#3b82f6' && saved.label === 'review' && saved.text === 'unlabeled thought',
		'H5: Save writes name + color + label and keeps the description'
	);
	const sent = await A.page.evaluate(() => {
		const list = window.__sent.filter((m) => m.type === 'annotation');
		window.__stores.peers.set(window.__peerOriginal);
		return list;
	});
	const sentNote = sent.find((m) => m.annotation?.id === id2)?.annotation;
	h.check(
		!!sentNote && sentNote.name === 'Latch' && sentNote.color === '#3b82f6' && sentNote.label === 'review',
		'H5: the save replicates the v2 fields on the unchanged {type:"annotation"} wire shape'
	);
	h.check(
		(await active(A.page))?.mode === 'view',
		'H5: saving returns the card to its view face'
	);
	h.check((await pinColor(A.page, id2)) === '#3b82f6', 'H4: the pin re-colors after the edit');

	// receive path: a peer's v2 payload lands normalized
	const remote = await A.page.evaluate(
		({ uuid }) => {
			const ah = window.__stores.annotationsHandler;
			ah.applyAnnotation({
				op: 'set',
				annotation: {
					id: 'remote-note',
					objectUuid: uuid,
					offset: [0, 1.9, 0],
					text: 'from a peer',
					author: 'B',
					ts: 2,
					name: 'Peer note',
					color: '#a855f7',
					label: 'review'
				}
			});
			let list = [];
			ah.annotations.subscribe((l) => (list = l))();
			const a = list.find((x) => x.id === 'remote-note');
			return a ? { name: a.name, color: a.color, label: a.label } : null;
		},
		{ uuid: boxUuid }
	);
	h.check(
		remote && remote.name === 'Peer note' && remote.color === '#a855f7' && remote.label === 'review',
		'H1: a peer note applies with its v2 fields intact'
	);
	await A.page.evaluate(() => {
		const ah = window.__stores.annotationsHandler;
		ah.applyAnnotation({ op: 'delete', annotation: { id: 'remote-note' } });
		ah.activeAnnotation.set(null);
	});

	// --- H5: a draft opens at the CLICKED point ------------------------------
	await A.page.evaluate((uuid) => {
		window.__stores.annotationsHandler.addAnnotation(uuid, [1.4, 2.2, 0.4]);
	}, boxUuid);
	await A.page.waitForTimeout(500);
	h.check(await editCard.first().isVisible(), 'H5: a draft opens straight on the edit face');
	const draft = await active(A.page);
	const draftBox = await editCard.first().boundingBox();
	const draftPix = await pinPixel(A.page, draft?.draft);
	h.check(
		!!draftBox && !!draftPix && gap(draftBox, draftPix) < 60 && Math.abs(draftBox.y - draftPix.y) < 160,
		`H5: the new-note card opens at the clicked point (card ${draftBox && Math.round(draftBox.x)}-${
			draftBox && Math.round(draftBox.x + draftBox.width)
		} vs point ${draftPix && Math.round(draftPix.x)},${draftPix && Math.round(draftPix.y)})`
	);
	await A.page.evaluate(() => window.__stores.annotationsHandler.activeAnnotation.set(null));

	// --- H6: drawer groups, numbering, traversal, pins toggle ----------------
	// a fourth, UNLABELED note so the 'General' group exists
	const id4 = await addNote(A.page, boxUuid, [-0.4, 1.8, -0.4], { text: 'general remark' });
	await A.page.evaluate(() => window.__stores.notesDrawerOpen.set(true));
	await A.page.waitForTimeout(400);
	const drawer = A.page.locator('#notes-drawer');
	h.check(await drawer.isVisible(), 'H6: the notes drawer opens');
	const groupOrder = await drawer.evaluate((el) =>
		[...el.querySelectorAll('.notes-group-toggle')].map((b) => b.textContent.trim().split(/\s+/)[0])
	);
	h.check(
		groupOrder[0] === 'General',
		`H6: 'General' (unlabeled) is the FIRST group (got "${groupOrder.join(', ')}")`
	);
	h.check(
		groupOrder.join(',') === 'General,mechanics,review',
		`H6: label groups render, alphabetical after General (${groupOrder.join(', ')})`
	);
	// numbering: every row's badge equals the note's GLOBAL 1-based index (= pin label)
	const numbering = await drawer.evaluate((el) => {
		const rows = [...el.querySelectorAll('li')];
		return rows.map((li) => ({
			n: li.querySelector('.notes-num')?.textContent?.trim(),
			text: li.textContent
		}));
	});
	const list = await store(A.page);
	const numberingOk = numbering.every((row) => {
		const index = list.findIndex((a) => row.text.includes(a.name || a.text));
		return index >= 0 && row.n === String(index + 1);
	});
	h.check(
		numbering.length === list.length && numberingOk,
		`H6: row numbers match the GLOBAL pin numbering (${numbering.map((r) => r.n).join(',')})`
	);
	// a row click opens the VIEW face; the per-row Edit button opens the EDIT face
	await drawer.locator('li', { hasText: 'Latch' }).first().locator('button').first().click();
	await A.page.waitForTimeout(600);
	h.check(
		(await active(A.page))?.id === id2 && (await active(A.page))?.mode === 'view',
		'H6: a row click flies to the note and opens the view face'
	);
	await drawer.locator('li', { hasText: 'Latch' }).first().locator('button[aria-label="Edit note"]').click();
	await A.page.waitForTimeout(400);
	h.check(
		(await active(A.page))?.mode === 'edit',
		'H6: the per-row Edit button opens the edit face'
	);
	await A.page.evaluate(() => window.__stores.annotationsHandler.activeAnnotation.set(null));

	// group arrows walk that group's notes in pin order, wrapping
	const seq = [];
	for (let i = 0; i < 3; i++) {
		await drawer.locator('button[aria-label="Next note in mechanics"]').click();
		await A.page.waitForTimeout(350);
		seq.push((await active(A.page))?.id);
	}
	h.check(
		seq[0] === id1 && seq[1] === id3 && seq[2] === id1,
		'H6: the group › arrow traverses in pin order and WRAPS'
	);
	await drawer.locator('button[aria-label="Previous note in mechanics"]').click();
	await A.page.waitForTimeout(350);
	h.check((await active(A.page))?.id === id3, 'H6: the ‹ arrow steps back (wrapping)');

	// collapse a group: its two rows disappear, the others stay
	const rowsBefore = await drawer.locator('li').count();
	await drawer.locator('.notes-group-toggle', { hasText: 'mechanics' }).click();
	await A.page.waitForTimeout(250);
	const rowsAfter = await drawer.locator('li').count();
	h.check(
		rowsBefore === 4 && rowsAfter === 2,
		`H6: a label group collapses its rows (${rowsBefore} -> ${rowsAfter})`
	);

	// header pins toggle: hides the pin meshes AND the pin-click raycast branch
	await drawer.locator('button[aria-label="Hide note pins"]').click();
	await A.page.waitForTimeout(300);
	const hidden = await A.page.evaluate(
		() =>
			new Promise((r) => {
				const ah = window.__stores.annotationsHandler;
				let visible = null;
				ah.pinsGroup.subscribe((g) => (visible = g?.visible))();
				ah.showNotePins.subscribe((v) => r({ visible, pref: v }))();
			})
	);
	h.check(
		hidden.visible === false && hidden.pref === false,
		'H3: the header toggle hides the pins group and flips the local pref'
	);
	await drawer.locator('button[aria-label="Show note pins"]').click();
	await A.page.waitForTimeout(300);
	const shown = await A.page.evaluate(
		() =>
			new Promise((r) => {
				let visible = null;
				window.__stores.annotationsHandler.pinsGroup.subscribe((g) => (visible = g?.visible))();
				r(visible);
			})
	);
	h.check(shown === true, 'H3: toggling back shows the pins again');

	// --- two-peer (opt-in): A's fields arrive on B ----------------------------
	if (process.env.TWO_PEER === '1') {
		const B = await h.setupPage(browser, 'B');
		await h.connect(B, A);
		const onB = await store(B.page);
		const mirrored = onB.find((a) => a.id === id1);
		h.check(
			!!mirrored && mirrored.name === 'Hinge' && mirrored.color === '#22c55e' && mirrored.label === 'mechanics',
			'H1/H5 two-peer: the handshake carries name/color/label to a late joiner'
		);
	} else {
		console.log('SKIP two-peer section (set TWO_PEER=1 with the hosts mapping enabled)');
	}

	await h.finish(browser);
});
