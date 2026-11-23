// 105-slots phase 3 — LINKED materials (owner choice 22 Nov: "Switch material… > In this scene" = one shared material).
//   L1  linkSlotTo: a box's slot 2 takes the ball's material; both carry one link id; ONE undo step takes it back
//   L2  every look edit fans to every holder, ONE undo step each: roughness, colour, type, a texture, tiling
//   L3  the slot's own data does NOT fan: rename, off
//   L4  the Inspector: the box row says "Shared · used by 2"; the ball (one material) shows the shared note and
//       Make unique gives it its own copy (one step)
//   L5  Switch material… > In this scene LINKS (through the real popover)
//   L6  two peers: the joiner holds the links; an edit on either side reaches both holders on both sides
//   L7  reload = autosave and a saved scene reopened keep the link; an old scene (no link) is unchanged
//   L8  a duplicate of a linked slot is a working copy (no link); D2 (a whole-object share) refuses a slot link
//   L9  E2E_BASE_URL (optional, the release before this one): its page holds ordinary copies and a link edit on
//       this build reaches both holders there
// Counterfactual: on the base (or with linkedEdit returning self() only) L2 goes red: the ball keeps its roughness.
const h = require('./helpers.cjs');

const BASE = process.env.E2E_BASE_URL || '';

/** make the scene: a 3-slot box (red / green / blue) and a one-material ball (gold) @param {any} page */
const build = (page) =>
	page.evaluate(async () => {
		const w = window.__tp.test.v1;
		const made = async (/** @type {string} */ command, /** @type {string} */ name) => {
			const g0 = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const before = new Set(g0.children.map((/** @type {any} */ c) => c.uuid));
			w.commandsHandler.sceneCommand(command);
			for (let i = 0; i < 50; i++) {
				const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
				const o = g.children.find((/** @type {any} */ c) => c.isMesh && !before.has(c.uuid));
				if (o) {
					o.name = name;
					return o;
				}
				await new Promise((r) => setTimeout(r, 200));
			}
			return null;
		};
		const box = await made('/create Box 1 1 1', 'LinkBox');
		const ball = await made('/create Sphere 0.5', 'LinkBall');
		if (!box || !ball) return null;
		box.position.set(-1, 0.5, 0);
		ball.position.set(1, 0.5, 0);
		const M = w.materialsHandler;
		M.addMaterialSlot(box.uuid);
		M.addMaterialSlot(box.uuid);
		M.setObjectMaterials(box.uuid, M.materialsOf(box), [
			{ start: 0, count: 12, materialIndex: 0 },
			{ start: 12, count: 12, materialIndex: 1 },
			{ start: 24, count: 12, materialIndex: 2 }
		]);
		['#ff0000', '#00ff00', '#0000ff'].forEach((hex, i) => M.setObjectColor(box.uuid, hex, true, i));
		M.setObjectColor(ball.uuid, '#d4af37');
		return { box: box.uuid, ball: ball.uuid };
	});

/** what both objects wear @param {any} page */
const look = (page) =>
	page.evaluate(async () => {
		const w = window.__tp.test.v1;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		/** @param {string} name */
		const find = (name) => {
			/** @type {any} */ let o = null;
			g.traverse((/** @type {any} */ n) => (o ??= n.isMesh && n.name === name ? n : null));
			return o;
		};
		/** @param {any} m */
		const row = (m) =>
			m && {
				color: '#' + m.color?.getHexString?.(),
				rough: typeof m.roughness === 'number' ? Math.round(m.roughness * 100) / 100 : null,
				type: m.type,
				name: m.name ?? '',
				link: m.userData?.slot?.link ?? '',
				off: m.userData?.slot?.off === true,
				map: !!m.userData?.mapDataUrl,
				repeat: m.map
					? m.map.repeat.toArray().map((/** @type {number} */ v) => Math.round(v * 100) / 100)
					: null
			};
		const box = find('LinkBox');
		const ball = find('LinkBall');
		const M = w.materialsHandler;
		return {
			box: box ? M.materialsOf(box).map(row) : null,
			ball: ball ? row(M.materialsOf(ball)[0]) : null,
			boxUuid: box?.uuid,
			ballUuid: ball?.uuid
		};
	});

const undo = (/** @type {any} */ peer) =>
	peer.page.evaluate(() => window.__tp.test.v1.history.undo());
const depth = (/** @type {any} */ peer) =>
	peer.page.evaluate(
		() =>
			new Promise((r) =>
				window.__tp.test.v1.history.undoStack.subscribe((/** @type {any} */ v) => r(v.length))()
			)
	);
/** run `body` in the page with (w, ids) @param {any} peer @param {string} body @param {any} ids */
const run = (peer, body, ids) =>
	peer.page.evaluate(
		async ({ body, ids }) => {
			// eslint-disable-next-line no-new-func
			const fn = new Function('w', 'ids', 'return (async () => {' + body + '})()');
			const out = await fn(window.__tp.test.v1, ids);
			await new Promise((r) => setTimeout(r, 120));
			return out === undefined ? null : JSON.parse(JSON.stringify(out));
		},
		{ body, ids }
	);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1280, height: 800 } }
	});
	await h.answerRestore(A);
	const ids = await build(A.page);
	h.check(!!ids, '0 premise: a 3-slot box and a ball');
	const hasLink = await A.page.evaluate(
		() => typeof window.__tp.test.v1.materialSlots?.linkSlotTo === 'function'
	);
	h.check(hasLink, '0 the link API exists');
	if (!ids || !hasLink) return h.finish(browser);

	// ---- L1 ------------------------------------------------------------------------------------------------------
	const d0 = await depth(A);
	const linked = await run(A, `return w.materialSlots.linkSlotTo(ids.box, 1, ids.ball, 0);`, ids);
	let s = await look(A.page);
	h.check(
		linked === true &&
			!!s.ball?.link &&
			s.box?.[1]?.link === s.ball.link &&
			s.box[1].color === '#d4af37',
		"L1.1 the box slot takes the ball's material; both carry one link: " +
			JSON.stringify({ box: s.box?.[1], ball: s.ball })
	);
	h.check(
		s.box?.[1]?.name === 'slot1' && s.box[0].link === '' && s.box[2].link === '',
		'L1.2 the slot keeps its own name; the other slots are untouched'
	);
	h.check(
		/** @type {number} */ (await depth(A)) === /** @type {number} */ (d0) + 1,
		'L1.3 one undo step'
	);
	await undo(A);
	s = await look(A.page);
	h.check(
		s.box?.[1]?.color === '#00ff00' && s.box[1].link === '' && s.ball?.link === '',
		'L1.4 undo takes the link back on both objects'
	);
	await run(A, `w.materialSlots.linkSlotTo(ids.box, 1, ids.ball, 0);`, ids);

	// ---- L2 every look edit fans -------------------------------------------------------------------------------------
	/** what an undo of this edit must restore: everything, or (a one-material TYPE switch) what that undo rebuilds —
	 * it re-creates the material by type, so a number the other type lacks comes back at its default (pre-existing,
	 * the same without links: Standard -> Phong -> undo loses roughness 0.85) @param {any} x @param {boolean} byType */
	const comparable = (x, byType) =>
		x && byType ? { color: x.color, type: x.type, link: x.link, name: x.name, off: x.off } : x;
	const fan = async (
		/** @type {string} */ label,
		/** @type {string} */ body,
		/** @type {(s: any) => boolean} */ ok,
		byType = false
	) => {
		const before = await look(A.page);
		const d = await depth(A);
		await run(A, body, ids);
		const after = await look(A.page);
		h.check(
			ok(after),
			label + ': both holders changed: ' + JSON.stringify({ box: after.box?.[1], ball: after.ball })
		);
		h.check(
			/** @type {number} */ (await depth(A)) === /** @type {number} */ (d) + 1,
			label + ': ONE undo step'
		);
		await undo(A);
		const back = await look(A.page);
		h.check(
			JSON.stringify(back.box?.[1]) === JSON.stringify(before.box?.[1]) &&
				JSON.stringify(comparable(back.ball, byType)) ===
					JSON.stringify(comparable(before.ball, byType)),
			label +
				': undo puts both back' +
				(byType ? ' (the one-material object as a type undo rebuilds it)' : '') +
				': ' +
				JSON.stringify({ box: back.box?.[1], ball: back.ball })
		);
	};
	await fan(
		'L2.1 roughness on the box slot',
		`w.materialsHandler.setMaterialParam(ids.box, 'roughness', 0.3, true, 1);`,
		(x) => x.box?.[1]?.rough === 0.3 && x.ball?.rough === 0.3 && x.box[0].rough !== 0.3
	);
	await fan(
		'L2.2 colour on the ball',
		`w.materialsHandler.setObjectColor(ids.ball, '#123456');`,
		(x) =>
			x.ball?.color === '#123456' && x.box?.[1]?.color === '#123456' && x.box[0].color === '#ff0000'
	);
	await fan(
		'L2.3 type on the box slot',
		`w.materialsHandler.switchMaterialType(ids.box, 'MeshPhongMaterial', true, 1);`,
		(x) =>
			x.box?.[1]?.type === 'MeshPhongMaterial' &&
			x.ball?.type === 'MeshPhongMaterial' &&
			!!x.ball.link &&
			x.ball.link === x.box[1].link,
		true
	);
	// the ball's roughness after that undo (pre-existing: a one-material type undo rebuilds by type) — put it back
	await run(A, `w.materialsHandler.setMaterialParam(ids.ball, 'roughness', 0.85, true, 0);`, ids);
	await fan(
		'L2.4 a texture on the ball',
		`const c = document.createElement('canvas'); c.width = c.height = 8; const x = c.getContext('2d'); x.fillStyle = '#ff00ff'; x.fillRect(0, 0, 8, 8);
		const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
		await w.materialsHandler.setObjectsTexture([ids.ball], blob, 0);
		await new Promise((r) => setTimeout(r, 800));`,
		(x) => !!x.ball?.map && !!x.box?.[1]?.map && !x.box[0].map
	);

	// ---- L3 the slot's own data does not fan -----------------------------------------------------------------------
	await run(
		A,
		`w.materialSlots.renameSlot(ids.box, 1, 'Trim'); w.materialSlots.setSlotOff(ids.box, 1, true);`,
		ids
	);
	s = await look(A.page);
	h.check(
		s.box?.[1]?.name === 'Trim' && s.box[1].off && s.ball?.name !== 'Trim' && !s.ball?.off,
		'L3 rename and off stay on that slot: ' + JSON.stringify({ box: s.box?.[1], ball: s.ball })
	);
	await undo(A);
	await undo(A);

	// ---- L4 the Inspector -------------------------------------------------------------------------------------------
	const select = async (/** @type {string} */ uuid) => {
		await A.page.evaluate((id) => {
			window.__tp.test.v1.inspectorClose.set(false);
			window.__tp.test.v1.objectActions.selectObject(id);
		}, uuid);
		await A.page.waitForTimeout(800);
	};
	await select(ids.box);
	await A.page.waitForSelector('#ins-slot-list', { timeout: 15000 }).catch(() => {});
	const badge = await A.page
		.locator('#ins-slot-row-1 .slot-badge-shared')
		.innerText()
		.catch(() => '');
	h.check(/Shared · used by 2/.test(badge), 'L4.1 the box row says "Shared · used by 2": ' + badge);
	await select(ids.ball);
	h.check(
		(await A.page.locator('#material-slot-shared-note').count()) === 1,
		'L4.2 the one-material ball shows the shared note'
	);
	await A.page.locator('#material-make-unique').click();
	await A.page.waitForTimeout(400);
	s = await look(A.page);
	h.check(
		s.ball?.link === '' && !!s.box?.[1]?.link,
		'L4.3 Make unique: the ball leaves the link, the box slot keeps its copy'
	);
	await run(A, `w.materialsHandler.setMaterialParam(ids.ball, 'roughness', 0.66, true, 0);`, ids);
	s = await look(A.page);
	h.check(
		s.ball?.rough === 0.66 && s.box?.[1]?.rough !== 0.66,
		'L4.4 after Make unique an edit stays on that object'
	);
	await undo(A);
	await undo(A);
	h.check(
		(await look(A.page)).ball?.link === (await look(A.page)).box?.[1]?.link,
		'L4.5 undo of Make unique links it again (one step)'
	);

	// ---- L5 Switch material… > In this scene links ------------------------------------------------------------------
	await select(ids.box);
	await A.page.waitForSelector('#ins-slot-list', { timeout: 15000 }).catch(() => {});
	await A.page.locator('#ins-slot-more-2').click();
	await A.page.locator('[data-testid="ins-slot-menu-switch"]').click();
	const item = A.page.locator('#slot-switch [data-switch-scene="' + ids.box + ':0"]');
	await item.waitFor({ timeout: 10000 }).catch(() => {}); // the popover is lazy
	h.check((await item.count()) === 1, 'L5.1 "In this scene" lists the box\'s first slot');
	await item.click();
	await A.page.waitForTimeout(500);
	s = await look(A.page);
	h.check(
		!!s.box?.[2]?.link && s.box[2].link === s.box[0].link && s.box[2].color === '#ff0000',
		'L5.2 picking it links slot 3 to slot 1 (same object): ' + JSON.stringify(s.box)
	);
	await run(A, `w.materialsHandler.setObjectColor(ids.box, '#ffaa00', true, 0);`, ids);
	h.check(
		(await look(A.page)).box?.[2]?.color === '#ffaa00',
		'L5.3 an edit on slot 1 reaches slot 3'
	);
	await undo(A);
	await undo(A);

	// ---- L6 two peers ------------------------------------------------------------------------------------------------
	// the host lets go of its selection: a selected object is LOCKED to its holder (80a), and the joiner edits below
	await A.page.evaluate(() => window.__tp.test.v1.objectActions.applySelectionSet([]));
	await A.page.waitForTimeout(500);
	const B = await h.setupPageQuiet(browser, 'B', [A], {
		context: { viewport: { width: 1100, height: 750 } }
	});
	await h.answerRestore(B);
	await h.connect(B, A);
	const sA = await look(A.page);
	await h.eventually(
		() => look(B.page),
		(x) => !!x.ball && x.ball.link === sA.ball.link && x.box?.[1]?.link === sA.ball.link,
		'L6.1 the joiner holds the same link on both objects',
		30000
	);
	await run(A, `w.materialsHandler.setMaterialParam(ids.box, 'roughness', 0.42, true, 1);`, ids);
	await h.eventually(
		() => look(B.page),
		(x) => x.box?.[1]?.rough === 0.42 && x.ball?.rough === 0.42,
		'L6.2 an edit on the host reaches both holders on the joiner',
		15000
	);
	await run(B, `w.materialsHandler.setObjectColor(ids.ball, '#3366ff');`, ids);
	await h.eventually(
		() => look(A.page),
		(x) => x.ball?.color === '#3366ff' && x.box?.[1]?.color === '#3366ff',
		'L6.3 an edit on the joiner reaches both holders on the host',
		15000
	);

	// ---- L7 reload, a saved scene, an old scene ------------------------------------------------------------------------
	await A.page.evaluate(() => window.__tp.test.v1.autosave.saveNow());
	const keep = await look(A.page);
	await h.freshReload(A);
	await A.page.waitForTimeout(3000);
	await h
		.answerRestore(A, 'restore', 20000)
		.catch(() =>
			A.page.evaluate(() =>
				/** @type {any} */ (document.getElementById('restore-session-restore'))?.click()
			)
		);
	await h.eventually(
		() => look(A.page),
		(x) =>
			!!x.ball &&
			x.ball.link === keep.ball.link &&
			x.box?.[1]?.link === keep.ball.link &&
			x.ball.color === keep.ball.color,
		'L7.1 reload = autosave keeps the link',
		30000
	);
	const file = await A.page.evaluate(() =>
		JSON.parse(
			JSON.stringify(
				window.__tp.test.v1.sessions.buildSessionPayload('link-file', { thumbnail: false })
			)
		)
	);
	await A.page.evaluate(
		(p) =>
			window.__tp.test.v1.sessions.applySession(p, {
				backup: false,
				replicate: false,
				quiet: true
			}),
		file
	);
	await h.eventually(
		() => look(A.page),
		(x) => !!x.ball && x.ball.link === keep.ball.link && x.box?.[1]?.link === keep.ball.link,
		'L7.2 a saved scene reopened keeps the link',
		20000
	);
	const after = await run(
		A,
		`const r = []; const g = await new Promise((res) => w.objectsGroup.subscribe(res)()); g.traverse((n) => { if (n.isMesh) r.push(...w.materialsHandler.materialsOf(n).map((m) => m.userData?.slot?.link ?? '')); }); return r.filter(Boolean).length;`,
		ids
	);
	h.check(
		after === 2,
		'L7.3 exactly the two holders carry a link (nothing else gained one): ' + after
	);

	// ---- L8 duplicate, D2 ------------------------------------------------------------------------------------------------
	const dup = await run(
		A,
		`const i = w.materialSlots.duplicateSlot(ids.box, 1); const o = (await new Promise((r) => w.objectsGroup.subscribe(r)())).getObjectByProperty('uuid', ids.box); return w.materialsHandler.materialsOf(o)[i]?.userData?.slot?.link ?? '';`,
		ids
	);
	h.check(dup === '', 'L8.1 a duplicate of a linked slot is a working copy (no link)');
	await undo(A);
	const d2 = await run(
		A,
		`const c = w.objectActions.duplicateObject(ids.ball, { select: false }); c.name = 'LinkBallD2';
		const copyLink = c.material?.userData?.slot?.link ?? '';
		w.materialSharing.setMaterialId(c, 'matTestD2');
		return { copyLink, ok: w.materialSlots.linkSlotTo(c.uuid, 0, ids.box, 0), uuid: c.uuid };`,
		ids
	);
	h.check(d2?.copyLink === '', 'L8.2 a duplicated object is a working copy: it leaves the link');
	h.check(d2?.ok === false, 'L8.3 an object sharing its whole material (D2) refuses a slot link');

	// ---- L9 the release before this one (optional) ------------------------------------------------------------------------
	if (!BASE) console.log('SKIP L9 E2E_BASE_URL not set (a peer on the release before this one)');
	else {
		const O = await h.setupPageQuiet(browser, 'O', [A, B], {
			url: BASE,
			context: { viewport: { width: 1000, height: 700 } }
		});
		await h.answerRestore(O);
		await h.connect(O, A);
		await h.eventually(
			() => look(O.page),
			(x) => !!x.ball && !!x.box,
			'L9.1 the older peer has both objects',
			30000
		);
		await run(A, `w.materialsHandler.setMaterialParam(ids.ball, 'roughness', 0.77, true, 0);`, ids);
		await h.eventually(
			() => look(O.page),
			(x) => x.ball?.rough === 0.77 && x.box?.[1]?.rough === 0.77,
			'L9.2 a linked edit on this build reaches both holders on the older peer (per-holder messages + the slots2 heal)',
			20000
		);
	}

	h.check(h.pageErrors(A).length === 0 && h.pageErrors(B).length === 0, 'L10 no page errors');
	await h.finish(browser);
});
