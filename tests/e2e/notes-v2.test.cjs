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

// V3: the desktop marker is a screen-space DOM badge + leader line, so its state
// is read from the DOM (the in-scene meshes are the VR path now). Everything one
// badge tells us:
const markerInfo = (page, number) =>
	page.evaluate((number) => {
		const badge = [...document.querySelectorAll('.marker-badge')].find(
			(b) => b.querySelector('.marker-num')?.textContent?.trim() === String(number)
		);
		if (!badge) return null;
		const rect = badge.getBoundingClientRect();
		const style = getComputedStyle(badge);
		const svg = document.querySelector('.marker-lines');
		const lines = [...(svg?.querySelectorAll('line') ?? [])].map((l) => ({
			x1: +l.getAttribute('x1'),
			y1: +l.getAttribute('y1'),
			x2: +l.getAttribute('x2'),
			y2: +l.getAttribute('y2'),
			dashed: (l.parentElement?.getAttribute('stroke-dasharray') ?? 'none') !== 'none',
			opacity: +(l.parentElement?.getAttribute('opacity') ?? 1)
		}));
		// the leader whose badge end matches THIS badge's centre (x and y — two
		// markers can share an x)
		const cx = rect.x + rect.width / 2;
		const cy = rect.y + rect.height / 2;
		const leader = lines.find(
			(l) => Math.abs(l.x1 - cx) < 2 && Math.abs(l.y1 - (cy + rect.height / 2 - 2)) < 3
		);
		return {
			text: badge.textContent.trim(),
			center: [cx, rect.y + rect.height / 2],
			size: [Math.round(rect.width), Math.round(rect.height)],
			background: style.backgroundColor,
			color: style.color,
			radius: style.borderTopLeftRadius,
			opacity: +style.opacity,
			occluded: badge.classList.contains('is-occluded'),
			active: badge.classList.contains('is-active'),
			cluster: badge.classList.contains('is-cluster'),
			svgSize: svg ? [svg.getBoundingClientRect().width, svg.getBoundingClientRect().height] : null,
			leader,
			icon: !!badge.querySelector('svg')
		};
	}, number);

const badgeCount = (page) => page.locator('.marker-badge').count();

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
		return a
			? { name: a.name, color: a.color, label: a.label, text: a.text, camera: a.camera, follow: a.follow }
			: null;
	});
	h.check(
		legacy?.camera === null && legacy?.follow === false,
		`H11: an old note normalizes to no saved view and follow off (${JSON.stringify(legacy?.camera)}/${legacy?.follow})`
	);
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

	// --- V3 markers: screen-space badge + leader line -------------------------
	// close in first: from the default distance these three notes overlap on screen
	// and CLUSTER (that is the feature — checked further down)
	await A.page.evaluate(() => window.__stores.objectActions.flyTo([1.6, 1.8, 2.6], [0, 1, 0], 1));
	await A.page.waitForTimeout(900);
	const m1 = await markerInfo(A.page, 1);
	h.check(
		m1?.background === 'rgb(34, 197, 94)',
		`V3/H4: the badge fill is the note colour (${m1?.background})`
	);
	h.check(
		(await markerInfo(A.page, 2))?.background === 'rgb(245, 158, 11)',
		'V3/H4: a note with no explicit colour keeps the amber default'
	);
	h.check(
		m1?.color === 'rgb(28, 25, 23)',
		`V3/H9: the number ink is contrast-aware — dark on green (${m1?.color})`
	);
	h.check(!!m1?.icon, 'V3: the badge carries a small type icon next to the number');
	h.check(
		!!m1 && m1.size[1] >= 24 && m1.radius.startsWith('999'),
		`V3: a pill badge with room for bolder type (${m1?.size?.join('x')}, radius ${m1?.radius})`
	);
	// every 2D badge is the SAME pill — the per-note shape is a VR-only distinction
	const starBadge = await markerInfo(A.page, 3);
	h.check(
		!!starBadge && starBadge.radius === m1?.radius,
		`V3: a 'star' note renders the same pill in 2D — shape only applies to the VR pin (${starBadge?.radius})`
	);
	// the leader line runs from the badge to the EXACT projected point
	const pix1First = await pinPixel(A.page, id1);
	h.check(
		!!m1?.leader &&
			!!pix1First &&
			Math.abs(m1.leader.x2 - pix1First.x) < 2 &&
			Math.abs(m1.leader.y2 - pix1First.y) < 2 &&
			m1.leader.y1 < m1.leader.y2,
		`V3: a leader line joins the badge to the exact 3D point (${m1?.leader?.x2?.toFixed(
			0
		)},${m1?.leader?.y2?.toFixed(0)} vs ${pix1First && Math.round(pix1First.x)},${
			pix1First && Math.round(pix1First.y)
		})`
	);
	h.check(
		!!m1?.svgSize && m1.svgSize[0] > 1000 && m1.svgSize[1] > 600,
		`V3: the leader-line layer spans the viewport (an <svg> falls back to 300x150) (${m1?.svgSize?.join(
			'x'
		)})`
	);
	// --- V3: the badge must not LAG the camera (the "jiggle") -----------------
	// The positions are published from inside threlte's RENDER stage, so a badge
	// always matches the camera pose that rendered the frame it sits on. When the
	// marker layer owned a private requestAnimationFrame loop it could run before
	// the scheduler updated the camera and trailed the geometry by one frame — the
	// reported jiggle (and why an XR session "fixed" it: entering VR re-registers
	// threlte's loop and flips the callback order). Spin the camera fast and compare
	// each badge against the pin projected with the camera AS IT IS at that instant:
	// the residual must stay far below the per-frame travel.
	const drift = await A.page.evaluate(
		(leader) =>
			new Promise((resolve) => {
				const s = window.__stores;
				const ah = s.annotationsHandler;
				let controls;
				let camera;
				let renderer;
				let views = [];
				s.orbitControls.subscribe((v) => (controls = v))();
				s.globalCamera.subscribe((v) => (camera = v))();
				s.globalRenderer.subscribe((v) => (renderer = v))();
				ah.noteMarkers.subscribe((v) => (views = v))();
				const id = views[0]?.id;
				if (!id || !controls) return resolve(null);
				const wasRotating = controls.autoRotate;
				const wasSpeed = controls.autoRotateSpeed;
				controls.autoRotate = true;
				controls.autoRotateSpeed = 40;
				const residuals = [];
				const steps = [];
				let previous = null;
				let frames = 0;
				const sample = () => {
					frames++;
					const badge = [...document.querySelectorAll('.marker-badge')].find(
						(b) => b.querySelector('.marker-num')?.textContent?.trim() === '1'
					);
					const world = ah.annotationWorldPosition(id);
					if (badge && world && camera && renderer?.domElement) {
						const rect = renderer.domElement.getBoundingClientRect();
						const v = world.clone().project(camera);
						const px = rect.left + ((v.x + 1) / 2) * rect.width;
						const py = rect.top + ((1 - v.y) / 2) * rect.height;
						const r = badge.getBoundingClientRect();
						// the badge sits `leader` px above the point it describes
						residuals.push(Math.hypot(r.x + r.width / 2 - px, r.y + r.height / 2 + leader - py));
						if (previous) steps.push(Math.hypot(px - previous[0], py - previous[1]));
						previous = [px, py];
					}
					if (frames < 45) requestAnimationFrame(sample);
					else {
						controls.autoRotate = wasRotating;
						controls.autoRotateSpeed = wasSpeed;
						const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
						resolve({ residual: median(residuals), step: median(steps), n: residuals.length });
					}
				};
				requestAnimationFrame(sample);
			}),
		38
	);
	h.check(
		!!drift && drift.step > 3,
		`V3: the spin actually moved the marker between frames (${drift?.step?.toFixed(1)}px/frame over ${drift?.n} samples)`
	);
	h.check(
		!!drift && drift.residual < drift.step * 0.35,
		`V3: no frame lag while the camera spins — badge vs live projection ${drift?.residual?.toFixed(
			1
		)}px against a ${drift?.step?.toFixed(1)}px/frame step`
	);
	await A.page.waitForTimeout(300);

	// nothing can clip a DOM badge, and the in-scene meshes are VR-only now
	const meshCount = await A.page.evaluate(
		() =>
			new Promise((r) => {
				window.__stores.annotationsHandler.pinsGroup.subscribe((group) => {
					let meshes = 0;
					let pins = 0;
					group?.traverse((node) => {
						if (node.isMesh) meshes++;
						if (node.name?.startsWith('pin-')) pins++;
					});
					r({ meshes, pins });
				})();
			})
	);
	h.check(
		meshCount.pins === 3 && meshCount.meshes === 0,
		`V3: the pin anchors stay live but render NO in-scene meshes outside VR (${meshCount.pins} anchors, ${meshCount.meshes} meshes)`
	);

	// --- V3: behind-geometry markers go translucent, never half-clipped --------
	const behindId = await addNote(A.page, boxUuid, [0, 0.5, -0.55], {
		name: 'Back face',
		text: 'behind the box from here'
	});
	await A.page.evaluate(() => window.__stores.objectActions.flyTo([0, 1.2, 4], [0, 0.5, 0], 1));
	await A.page.waitForTimeout(900);
	const behind = await markerInfo(A.page, 4);
	h.check(
		!!behind?.occluded && /rgba\(/.test(behind.background),
		`V3: a marker behind geometry fades its FILL (${behind?.background})`
	);
	h.check(
		behind?.color === 'rgb(28, 25, 23)' && behind?.opacity === 1,
		'V3: ...while the number itself stays fully readable'
	);
	h.check(!!behind?.leader?.dashed, 'V3: the occluded leader line is dashed');
	// a marker sitting ON a surface must NOT count as occluded (the slack window)
	const onSurface = await markerInfo(A.page, 1);
	h.check(
		onSurface?.occluded === false && !/rgba\(/.test(onSurface?.background ?? ''),
		`V3: a marker resting on its surface stays solid — the few-cm slack (${onSurface?.background})`
	);
	await A.page.evaluate((id) => {
		window.__stores.annotationsHandler.deleteAnnotation(id);
	}, behindId);

	// --- V3: clustering ------------------------------------------------------
	// three notes almost on top of each other, low on the box so the cluster badge
	// does not land under the Connect bar
	const crowd = [];
	for (const offset of [
		[0.45, 0.15, 0.5],
		[0.5, 0.1, 0.45],
		[0.4, 0.12, 0.55]
	])
		crowd.push(await addNote(A.page, boxUuid, offset, { text: 'crowded ' + crowd.length }));
	await A.page.waitForTimeout(800);
	const clusterBadge = await A.page.locator('.marker-badge.is-cluster').count();
	const beforeExpand = await badgeCount(A.page);
	h.check(
		clusterBadge === 1,
		`V3: overlapping markers collapse into ONE counted badge (${clusterBadge} cluster badge, ${beforeExpand} badges total)`
	);
	const clusterText = await A.page.locator('.marker-badge.is-cluster .marker-num').first().textContent();
	h.check(
		Number(clusterText) >= 3,
		`V3: the cluster badge shows how many notes are stacked (${clusterText})`
	);
	// click in page context: fixed app chrome can sit over a marker and Playwright's
	// actionability check then refuses (a real user just clicks a visible badge)
	const clusterClicked = await A.page.evaluate(() => {
		const badge = document.querySelector('.marker-badge.is-cluster');
		if (!badge) return false;
		badge.click();
		return true;
	});
	await A.page.waitForTimeout(500);
	h.check(
		clusterClicked &&
			(await A.page.locator('.marker-badge.is-cluster').count()) === 0 &&
			(await badgeCount(A.page)) > beforeExpand,
		'V3: clicking the cluster fans its members out, each with its own leader'
	);
	for (const id of crowd)
		await A.page.evaluate((id) => window.__stores.annotationsHandler.deleteAnnotation(id), id);
	await A.page.evaluate(() => window.__stores.annotationsHandler.activeAnnotation.set(null));

	// --- H9 colour maths (shared by the badge and the VR pin) -----------------
	const border = await A.page.evaluate(() => {
		const ah = window.__stores.annotationsHandler;
		return {
			dark: ah.shadeHex('#22c55e'),
			inkOnGreen: ah.contrastOn('#22c55e'),
			inkOnBlue: ah.contrastOn('#3b82f6'),
			faded: ah.rgbaOf('#22c55e', 0.5)
		};
	});
	h.check(
		border.dark === '#136c34',
		`H9: the border shade is a darker sRGB shade of the fill (${border.dark})`
	);
	h.check(
		border.inkOnGreen === '#1c1917' && border.inkOnBlue === '#f8fafc',
		`H9: the ink is contrast-aware (green -> ${border.inkOnGreen}, blue -> ${border.inkOnBlue})`
	);
	h.check(
		border.faded === 'rgba(34, 197, 94, 0.5)',
		`V3: rgbaOf fades a fill without touching its text (${border.faded})`
	);

	// --- V3: hover preview ----------------------------------------------------
	await A.page.evaluate(() => {
		const badge = [...document.querySelectorAll('.marker-badge')].find(
			(b) => b.querySelector('.marker-num')?.textContent?.trim() === '1'
		);
		badge?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
	});
	await A.page.waitForTimeout(250);
	const tip = await A.page.evaluate(() => {
		const t = document.querySelector('.marker-tip');
		return t ? t.textContent.replace(/\s+/g, ' ').trim() : null;
	});
	h.check(
		!!tip && tip.includes('Hinge') && tip.includes('this corner needs a hinge') && /Me · /.test(tip),
		`V3: hovering a marker previews its note, author and date (${tip})`
	);
	await A.page.evaluate(() => {
		document
			.querySelector('.marker-badge')
			?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
	});

	// --- H2/H5: the popover opens ANCHORED near its pin, in VIEW mode ---------
	await A.page.evaluate((id) => window.__stores.annotationsHandler.openAnnotation(id), id1);
	await A.page.waitForTimeout(900); // let the 400ms fly settle
	const viewCard = A.page.locator('[role="dialog"][aria-label="Note"]');
	h.check(await viewCard.first().isVisible(), 'H2: pin open lands on the VIEW face');
	h.check(
		(await markerInfo(A.page, 1))?.active === true &&
			(await markerInfo(A.page, 3))?.active === false,
		'V3: the open note\'s marker takes the selected ring, the others do not'
	);
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
	await editCard.getByRole('button', { name: 'Save', exact: true }).click();
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
	const recolored = await markerInfo(A.page, 2);
	h.check(
		recolored?.background === 'rgb(59, 130, 246)' && recolored?.radius.startsWith('999'),
		`H4: the badge re-colours after the edit and stays a pill — shape is VR-only (${recolored?.background}, radius ${recolored?.radius})`
	);

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
	await editCard.getByRole('button', { name: 'Save', exact: true }).click();
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
	h.check(
		(await badgeCount(A.page)) === 0,
		'H3/V3: the screen-space markers go with it (one pref hides both paths)'
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
	await A.page.waitForTimeout(300);
	h.check((await badgeCount(A.page)) > 0, 'H3/V3: ...and the markers come back');

	// --- H11: saved camera framing + follow sessions --------------------------
	const camState = (page) =>
		page.evaluate(
			() =>
				new Promise((r) => {
					const s = window.__stores;
					let camera;
					let controls;
					s.globalCamera.subscribe((v) => (camera = v))();
					s.orbitControls.subscribe((v) => (controls = v))();
					let session = null;
					s.annotationsHandler.followingNote.subscribe((v) => (session = v))();
					r({
						position: camera.position.toArray(),
						target: controls.target.toArray(),
						// the offset the viewer chose — follow must preserve it
						offset: camera.position.clone().sub(controls.target).toArray(),
						following: session?.id ?? null
					});
				})
		);
	const toastIds = (page) =>
		page.evaluate(
			() =>
				new Promise((r) =>
					window.__stores.toastStore.subscribe((list) =>
						r(list.map((e) => (typeof e === 'string' ? e : e.id || e.text)))
					)()
				)
		);

	// park the camera somewhere deliberate, then store it on the note. NOTE: never
	// assert the requested numbers — OrbitControls.update() re-derives the camera
	// position from its own spherical state, so the pose we save is wherever the
	// controls actually left us. Read it and compare against THAT.
	await A.page.evaluate((id) => {
		const s = window.__stores;
		let camera;
		let controls;
		s.globalCamera.subscribe((v) => (camera = v))();
		s.orbitControls.subscribe((v) => (controls = v))();
		camera.position.set(3, 2.5, 3);
		controls.target.set(0, 1, 0);
		controls.update();
		s.annotationsHandler.openAnnotation(id, 'edit');
	}, id1);
	await A.page.waitForTimeout(600);
	const parked = await camState(A.page);
	await editCard.getByRole('button', { name: /camera view/ }).click();
	await editCard.getByRole('button', { name: 'Save', exact: true }).click();
	await A.page.waitForTimeout(300);
	const withPose = (await store(A.page)).find((a) => a.id === id1);
	const near3 = (a, b, e = 0.05) =>
		!!a && !!b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < e;
	h.check(
		!!withPose?.camera &&
			near3(withPose.camera.position, parked.position) &&
			near3(withPose.camera.target, parked.target),
		`H11: "Save camera view" stores the CURRENT framing on the note (${JSON.stringify(
			withPose?.camera?.position?.map((n) => +n.toFixed(2))
		)})`
	);
	// fly away, then open the note: it must land back on the SAVED pose
	await A.page.evaluate(() => window.__stores.objectActions.flyTo([-8, 6, -8], [0, 0, 0], 1));
	await A.page.waitForTimeout(400);
	await A.page.evaluate((id) => window.__stores.annotationsHandler.openAnnotation(id), id1);
	await h.eventually(
		() => camState(A.page),
		(c) => near3(c.position, parked.position, 0.3) && near3(c.target, parked.target, 0.3),
		'H11: opening a note with a saved view flies to THAT pose, not the generic 4m approach'
	);

	// follow: the camera rides the pin, and the offset the viewer chose survives
	const before = await camState(A.page);
	await A.page.evaluate((id) => window.__stores.annotationsHandler.startNoteFollow(id), id1);
	await A.page.waitForTimeout(200);
	h.check((await camState(A.page)).following === id1, 'H11: a follow session starts');
	h.check(
		(await toastIds(A.page)).includes('note-follow'),
		'H11: a sticky indicator toast says we are following (and offers Stop)'
	);
	await A.page.evaluate((uuid) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const box = g.getObjectByProperty('uuid', uuid);
		box.position.x += 3;
		box.position.y += 1;
		box.updateMatrixWorld(true);
	}, boxUuid);
	await A.page.waitForTimeout(500);
	const after = await camState(A.page);
	h.check(
		Math.abs(after.position[0] - (before.position[0] + 3)) < 0.2 &&
			Math.abs(after.target[0] - (before.target[0] + 3)) < 0.2,
		`H11: camera AND orbit target translate with the pin (${before.position[0].toFixed(
			1
		)} -> ${after.position[0].toFixed(1)})`
	);
	h.check(
		Math.hypot(
			after.offset[0] - before.offset[0],
			after.offset[1] - before.offset[1],
			after.offset[2] - before.offset[2]
		) < 0.05,
		'H11: ...so the viewer keeps the exact offset they had — orbiting stays theirs'
	);
	// the user's own navigation must NOT end the session: a PAN moves the orbit
	// target exactly like our follow step does, so handover has to be an explicit
	// signal (cameraClaim) rather than a deviation guess
	await A.page.evaluate(() => {
		const s = window.__stores;
		let camera;
		let controls;
		s.globalCamera.subscribe((v) => (camera = v))();
		s.orbitControls.subscribe((v) => (controls = v))();
		camera.position.x += 1.5; // pan: both ends move together
		controls.target.x += 1.5;
		controls.update();
	});
	await A.page.waitForTimeout(300);
	h.check(
		(await camState(A.page)).following === id1,
		'H11: panning/orbiting keeps the session — navigation stays the user\'s'
	);

	// the session OUTLIVES the popover (that was the whole point)
	await A.page.evaluate(() => window.__stores.annotationsHandler.activeAnnotation.set(null));
	await A.page.waitForTimeout(250);
	h.check(
		(await camState(A.page)).following === id1,
		'H11: closing the note card does NOT stop following'
	);
	// any other camera owner takes over cleanly (bookmark/focus/another note)
	await A.page.evaluate(() => window.__stores.objectActions.flyTo([9, 7, 9], [1, 1, 1], 1));
	await h.eventually(
		() => camState(A.page),
		(c) => c.following === null,
		'H11: an external camera move (flyTo) hands the camera back and ends the session'
	);
	h.check(
		!(await toastIds(A.page)).includes('note-follow'),
		'H11: the indicator toast goes with it'
	);
	// Esc stops a session too
	await A.page.evaluate((id) => window.__stores.annotationsHandler.startNoteFollow(id), id1);
	await A.page.waitForTimeout(200);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);
	h.check((await camState(A.page)).following === null, 'H11: Esc stops following');
	// the author hint auto-starts a session on open, and replicates
	await A.page.evaluate(() => {
		let original;
		window.__stores.peers.subscribe((p) => (original = p))();
		window.__peerOriginal = original;
		window.__sent = [];
		window.__stores.peers.set({ ...original, send: (m) => window.__sent.push(m) });
	});
	await A.page.evaluate((id) => {
		const ah = window.__stores.annotationsHandler;
		let list = [];
		ah.annotations.subscribe((l) => (list = l))();
		const note = list.find((a) => a.id === id);
		ah.setAnnotation({ ...note, follow: true });
		ah.activeAnnotation.set(null);
	}, id1);
	const followSent = await A.page.evaluate(() => {
		const list = window.__sent.filter((m) => m.type === 'annotation');
		window.__stores.peers.set(window.__peerOriginal);
		return list[list.length - 1]?.annotation;
	});
	h.check(
		followSent?.follow === true && !!followSent?.camera,
		'H11: the follow flag and the saved view replicate on the same annotation message'
	);
	await A.page.evaluate((id) => window.__stores.annotationsHandler.openAnnotation(id), id1);
	await h.eventually(
		() => camState(A.page),
		(c) => c.following === id1,
		'H11: a note flagged "follow when opened" auto-starts the session'
	);
	// deleting the followed note releases the camera
	await A.page.evaluate((id) => {
		const ah = window.__stores.annotationsHandler;
		let list = [];
		ah.annotations.subscribe((l) => (list = l))();
		const note = list.find((a) => a.id === id);
		ah.setAnnotation({ ...note, follow: false }); // keep the rest of the suite calm
		ah.applyAnnotation({ op: 'delete', annotation: { id: 'no-such-note' } });
	}, id1);
	await A.page.evaluate(() => window.__stores.annotationsHandler.stopNoteFollow());
	await A.page.evaluate(() => window.__stores.annotationsHandler.activeAnnotation.set(null));

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
