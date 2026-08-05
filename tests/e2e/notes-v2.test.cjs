// 15-H (scene notes v2): the name/description/color/label model, the near-pin
// view+edit popover, and the drawer's label groups / traversal / pins toggle.
// Follow-up drop (H8-H12): the two-pass pin render (occluded = dim, never an
// add-order lottery), pin shapes + border + contrast ink, 'Me' as a DISPLAY-only
// author, and the persistence fixes (autosave dirty on annotation changes,
// scene-root re-key, prune grace).
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

// everything the pin's meshes/text tell us about the H8 two-pass render
const pinInfo = (page, id) =>
	page.evaluate(
		(id) =>
			new Promise((resolve) => {
				window.__stores.annotationsHandler.pinsGroup.subscribe((group) => {
					const pin = group?.getObjectByName('pin-' + id);
					if (!pin) return resolve(null);
					const meshes = [];
					let text = null;
					pin.traverse((node) => {
						if (!node.isMesh) return;
						// troika Text extends Mesh; its (possibly multi-) material is marked
						const material = Array.isArray(node.material)
							? node.material[node.material.length - 1]
							: node.material;
						if (material?.isTroikaTextMaterial) {
							text = {
								renderOrder: node.renderOrder,
								depthTest: material.depthTest,
								value: node.text
							};
							return;
						}
						if (!material?.color) return;
						meshes.push({
							hex: '#' + material.color.getHexString(),
							depthTest: material.depthTest,
							depthWrite: material.depthWrite,
							transparent: material.transparent,
							opacity: material.opacity,
							renderOrder: node.renderOrder,
							verts: node.geometry?.attributes?.position?.count ?? 0
						});
					});
					resolve({ meshes, text });
				})();
			}),
		id
	);

// the FILL color of the pin's brightest pass (the note color, not the border)
const pinColor = async (page, id) => {
	const info = await pinInfo(page, id);
	if (!info?.meshes?.length) return null;
	// the fill passes carry the note color; the border passes are the darker shade
	const counts = {};
	for (const m of info.meshes) counts[m.hex] = (counts[m.hex] || 0) + 1;
	// fill appears on the disc + cone in both passes (4), border only twice
	return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
};

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
	// a KNOWN nickname first: authorship must not depend on the live peer id (the
	// signaling box can hand out a new one on a reconnect mid-suite)
	const boxUuid = await A.page.evaluate(() => {
		const s = window.__stores;
		s.username.set('Old Nick');
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
		label: 'mechanics',
		shape: 'star'
	});
	h.check(!!(id1 && id2 && id3), 'setup: three notes committed');

	// --- H4: the pin takes the note color -------------------------------------
	await A.page.waitForTimeout(400);
	h.check((await pinColor(A.page, id1)) === '#22c55e', 'H4: pin material uses the note color');
	h.check(
		(await pinColor(A.page, id2)) === '#f59e0b',
		'H4: a note with no explicit color keeps the amber default pin'
	);

	// --- H8: two render passes + an always-on-top number ----------------------
	const info1 = await pinInfo(A.page, id1);
	const tested = (info1?.meshes ?? []).filter((m) => m.depthTest);
	const ghosts = (info1?.meshes ?? []).filter((m) => !m.depthTest);
	h.check(
		tested.length >= 2 && ghosts.length >= 2,
		`H8: the pin draws a depth-tested SOLID pass and a depth-test-off GHOST pass (${tested.length}/${ghosts.length} meshes)`
	);
	h.check(
		ghosts.every((m) => m.transparent && m.opacity < 0.5) &&
			tested.every((m) => m.transparent && m.opacity > 0.5),
		`H8: the ghost pass is dim and the solid pass is not (ghost ${ghosts
			.map((m) => m.opacity)
			.join('/')} vs solid ${tested.map((m) => m.opacity).join('/')})`
	);
	// the SOLID pass paints over the ghost, so a visible pin reads as its own
	// saturated colour instead of the ghost border bleeding up through the fill
	h.check(
		(info1?.meshes ?? []).every((m) => m.renderOrder > 0) &&
			Math.max(...ghosts.map((m) => m.renderOrder)) <
				Math.min(...tested.map((m) => m.renderOrder)),
		'H8: every pin mesh has an explicit renderOrder, ghost under solid (no add-order lottery)'
	);
	h.check(
		!!info1?.text &&
			info1.text.depthTest === false &&
			info1.text.renderOrder > Math.max(...(info1.meshes ?? []).map((m) => m.renderOrder)),
		`H8: the number draws through everything, above every pin mesh (renderOrder ${info1?.text?.renderOrder})`
	);
	// an occluded pin keeps its ghost — the report was "new pins show through, received ones do not"
	const infoLate = await pinInfo(A.page, id2);
	h.check(
		(infoLate?.meshes ?? []).some((m) => !m.depthTest) &&
			(infoLate?.meshes ?? []).some((m) => m.depthTest),
		'H8: every pin gets both passes, whenever/however it was created'
	);

	// --- H9: shape geometry + darker border + contrast ink --------------------
	const roundVerts = (await pinInfo(A.page, id1))?.meshes?.[0]?.verts ?? 0;
	const starVerts = (await pinInfo(A.page, id3))?.meshes?.[0]?.verts ?? 0;
	h.check(
		roundVerts > 0 && starVerts > 0 && roundVerts !== starVerts,
		`H9: a star pin renders a different geometry than a round one (${roundVerts} vs ${starVerts} verts)`
	);
	const border = await A.page.evaluate(() => {
		const ah = window.__stores.annotationsHandler;
		return { dark: ah.shadeHex('#22c55e'), inkOnGreen: ah.contrastOn('#22c55e'), inkOnBlue: ah.contrastOn('#3b82f6') };
	});
	h.check(
		border.dark === '#136c34',
		`H9: the border shade is a darker sRGB shade of the fill (${border.dark})`
	);
	h.check(
		border.inkOnGreen === '#1c1917' && border.inkOnBlue === '#f8fafc',
		`H9: the number ink is contrast-aware (green -> ${border.inkOnGreen}, blue -> ${border.inkOnBlue})`
	);
	const hasBorder = (await pinInfo(A.page, id1))?.meshes?.some((m) => m.hex === border.dark);
	h.check(!!hasBorder, 'H9: the pin actually renders that darker border shade');

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
	await editCard.locator('button[aria-label="Pin shape square"]').click();
	await editCard.locator('input[list="note-labels"]').fill('review');
	await editCard.getByRole('button', { name: 'Save' }).click();
	await A.page.waitForTimeout(400);
	const saved = (await store(A.page)).find((a) => a.id === id2);
	h.check(
		saved && saved.name === 'Latch' && saved.color === '#3b82f6' && saved.label === 'review' && saved.text === 'unlabeled thought',
		'H5: Save writes name + color + label and keeps the description'
	);
	h.check(saved?.shape === 'square', `H9: the shape selector saves the pin shape (${saved?.shape})`);
	const sent = await A.page.evaluate(() => {
		const list = window.__sent.filter((m) => m.type === 'annotation');
		window.__stores.peers.set(window.__peerOriginal);
		return list;
	});
	const sentNote = sent.find((m) => m.annotation?.id === id2)?.annotation;
	h.check(
		!!sentNote &&
			sentNote.name === 'Latch' &&
			sentNote.color === '#3b82f6' &&
			sentNote.label === 'review' &&
			sentNote.shape === 'square',
		'H5/H9: the save replicates the v2 fields (incl. shape) on the unchanged {type:"annotation"} wire shape'
	);
	h.check(
		sentNote?.author === 'Old Nick',
		`H10: the REPLICATED author is the real nickname, never the literal 'me' (${sentNote?.author})`
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

	// --- H10: 'Me' is display-only; the stored/replicated author is a real name --
	const cardText = () =>
		viewCard
			.first()
			.textContent()
			.then((t) => (t || '').replace(/\s+/g, ' ').trim())
			.catch(() => '');
	await A.page.evaluate(() => window.__stores.annotationsHandler.openAnnotation('remote-note'));
	await h.eventually(
		cardText,
		(t) => t.includes('Peer note') && t.includes('B') && !t.includes('Me'),
		"H10: someone else's note shows THEIR author, not 'Me'"
	);
	await A.page.evaluate(() => {
		const ah = window.__stores.annotationsHandler;
		ah.applyAnnotation({ op: 'delete', annotation: { id: 'remote-note' } });
		ah.activeAnnotation.set(null);
	});
	await A.page.evaluate((id) => window.__stores.annotationsHandler.openAnnotation(id), id1);
	await h.eventually(
		cardText,
		(t) => t.includes('Hinge') && t.includes('Me'),
		"H10: our own note reads 'Me' in the card"
	);
	// ownership rides a stable device key, so it survives renames and reconnects
	// (peer ids are re-issued; nicknames change) — legacy keyless notes still match
	// by name
	const ownership = await A.page.evaluate(() => {
		const ah = window.__stores.annotationsHandler;
		return {
			byKey: ah.isMyNote({ author: 'whoever', authorKey: ah.myAuthorKey() }),
			foreignKey: ah.isMyNote({ author: 'Old Nick', authorKey: 'someone-elses-key' }),
			legacyMine: ah.isMyNote({ author: 'Old Nick' }),
			legacyOther: ah.isMyNote({ author: 'Sam' })
		};
	});
	h.check(
		ownership.byKey === true &&
			ownership.foreignKey === false &&
			ownership.legacyMine === true &&
			ownership.legacyOther === false,
		`H10: ownership is the stable authorKey, with a name fallback for old notes (${JSON.stringify(ownership)})`
	);
	// renaming yourself upgrades your OWN notes' stored author on the next save
	await A.page.evaluate(
		(id) => {
			window.__stores.username.set('New Nick');
			window.__stores.annotationsHandler.openAnnotation(id, 'edit');
		},
		id3
	);
	await A.page.waitForTimeout(600);
	await editCard.getByRole('button', { name: 'Save' }).click();
	await A.page.waitForTimeout(400);
	const upgraded = (await store(A.page)).find((a) => a.id === id3);
	h.check(
		upgraded?.author === 'New Nick',
		`H10: our own note re-stamps the author when we rename ourselves (${upgraded?.author})`
	);
	const displayed = await A.page.evaluate((id) => {
		const ah = window.__stores.annotationsHandler;
		let list = [];
		ah.annotations.subscribe((l) => (list = l))();
		const mine = list.find((a) => a.id === id);
		return {
			mine: ah.displayAuthor(mine),
			// exactly what a DIFFERENT device sees when it loads the saved file: same
			// note, foreign authorKey → the owner's nickname, never 'Me'
			saved: ah.displayAuthor({ ...mine, authorKey: 'another-device' }),
			other: ah.displayAuthor({ author: 'Sam' })
		};
	}, id3);
	h.check(
		displayed.mine === 'Me' && displayed.other === 'Sam',
		`H10: displayAuthor maps only OUR notes to 'Me' (${displayed.mine} / ${displayed.other})`
	);
	h.check(
		displayed.saved === 'New Nick',
		`H10: the same note reads as its owner's NICKNAME for anyone else (${displayed.saved})`
	);
	await A.page.evaluate(() => window.__stores.annotationsHandler.activeAnnotation.set(null));

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

	// --- H12: notes actually persist ------------------------------------------
	// (1) an annotation change ALONE has to schedule an autosave — before the fix
	// only objectsGroup/flowGraphs marked dirty, so a note added after the last
	// object change was never written ("some notes disappear on reload")
	const dirtyFlow = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		await s.autosave.saveNow(); // clears the dirty flag
		const before = s.autosave.isDirty();
		const ah = s.annotationsHandler;
		ah.addAnnotation(uuid, [0.2, 1.4, 0.2]);
		let cur = null;
		ah.activeAnnotation.subscribe((a) => (cur = a))();
		ah.setAnnotation({ ...cur.draft, text: 'persist me' });
		ah.activeAnnotation.set(null);
		return { before, after: s.autosave.isDirty(), id: cur.draft.id };
	}, boxUuid);
	h.check(
		dirtyFlow.before === false && dirtyFlow.after === true,
		`H12: an annotation change on its own marks the autosave dirty (${dirtyFlow.before} -> ${dirtyFlow.after})`
	);
	const snapshotHasNote = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		await s.autosave.saveNow();
		const list = s.autosave.annotationsSnapshot();
		return Array.isArray(list) && list.some((a) => a.id === id);
	}, dirtyFlow.id);
	h.check(snapshotHasNote, 'H12: the fresh snapshot carries that note');

	// (2) a SCENE-ROOT anchor is rebuilt with a new uuid every boot — the note
	// remembers the object NAME and re-keys instead of being pruned
	const heal = await A.page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		let scene;
		s.globalScene.subscribe((x) => (scene = x))();
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
		mesh.name = 'sys-anchor-heal';
		mesh.position.set(-5, 1, 0);
		mesh.updateMatrixWorld(true);
		scene.add(mesh);
		const ah = s.annotationsHandler;
		ah.addAnnotation(mesh.uuid, [-5, 1.6, 0]);
		let cur = null;
		ah.activeAnnotation.subscribe((a) => (cur = a))();
		const draft = cur.draft;
		ah.setAnnotation({ ...draft, text: 'on the env rig' });
		ah.activeAnnotation.set(null);
		const oldUuid = mesh.uuid;
		mesh.uuid = THREE.MathUtils.generateUUID(); // simulate the reboot rebuild
		return { id: draft.id, objectName: draft.objectName, oldUuid, newUuid: mesh.uuid };
	});
	h.check(
		heal.objectName === 'sys-anchor-heal',
		`H12: a note on a scene-root object remembers its anchor NAME (${heal.objectName})`
	);
	await A.page.evaluate(() => window.__stores.annotationsHandler.sweepAnnotations());
	const healed = (await store(A.page)).find((a) => a.id === heal.id);
	h.check(
		!!healed && healed.objectUuid === heal.newUuid && healed.objectUuid !== heal.oldUuid,
		'H12: the sweep re-keys it to the rebuilt object instead of pruning it'
	);

	// (3) an orphaned note gets a grace window before the sweep deletes it
	const doomedBox = await A.page.evaluate(() => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		return g.children[g.children.length - 1].uuid;
	});
	const doomed = await addNote(A.page, doomedBox, [3, 1, 3], { text: 'doomed' });
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const object = g.getObjectByProperty('uuid', uuid);
		object.parent.remove(object);
		s.objectsGroup.update((v) => v);
	}, doomedBox);
	await A.page.waitForTimeout(900); // first sweep ran (500ms debounce)
	h.check(
		(await store(A.page)).some((a) => a.id === doomed),
		'H12: the first sweep spares an orphan (a restore race used to eat notes here)'
	);
	await A.page.waitForTimeout(3500); // grace expires, the re-armed sweep prunes
	h.check(
		!(await store(A.page)).some((a) => a.id === doomed),
		'H12: after the grace window the orphan is pruned'
	);

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
		const starOnB = onB.find((a) => a.id === id3);
		h.check(!!starOnB && starOnB.shape === 'star', 'H9 two-peer: the pin shape replicates');
		h.check(
			!!mirrored && (await B.page.evaluate((a) => window.__stores.annotationsHandler.displayAuthor(a), mirrored)) !== 'Me',
			"H10 two-peer: A's note does NOT read 'Me' on B"
		);
	} else {
		console.log('SKIP two-peer section (set TWO_PEER=1 with the hosts mapping enabled)');
	}

	await h.finish(browser);
});
