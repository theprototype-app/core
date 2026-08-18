// A2 — the HUD across the persistence paths. Four paths, none sharing a serializer:
// the wire (hud-sync), AUTOSAVE, SESSIONS/.tpscene, and UNDO.
//
// The autosave DIRTY SUBSCRIPTION is the check that matters most, and it is the one a
// reasonable implementation forgets: authoring a HUD touches no object, so without
// `hudDocs.subscribe(markDirty)` the document sits in the snapshot with nothing ever
// triggering one being written. Exactly the scenePost lesson, and the
// notes-disappear-on-reload one before it — both shipped broken.
//
// Run: $env:APP_URL='https://localhost:5201/'; npm run e2e -- hud-persist
const h = require('./helpers.cjs');

const AUTHOR = () => {
	const H = window.__stores.hudDocs;
	H.setHudDocFor('scene', {
		screens: [
			{
				id: 'main',
				name: 'Main',
				elements: [
					{ id: 'score', kind: 'text', label: 'Gems: 0', anchor: 'top-right', x: 24, y: 24, style: { size: 18, color: 'accent' } },
					{ id: 'hp', kind: 'bar', label: '', anchor: 'bottom-center', x: 0, y: 40, w: 200, h: 14 }
				]
			},
			{ id: 'menu', name: 'Menu', elements: [{ id: 'play', kind: 'button', label: 'Play', anchor: 'center' }] }
		],
		active: 'main'
	});
};

const READ = () => {
	const doc = window.__stores.hudDocs.hudDocOf('scene');
	return doc
		? {
				screens: doc.screens.map((s) => s.id),
				active: doc.active,
				ids: doc.screens.flatMap((s) => s.elements.map((e) => e.id)),
				scoreStyle: doc.screens[0].elements.find((e) => e.id === 'score')?.style ?? null,
				barW: doc.screens[0].elements.find((e) => e.id === 'hp')?.w
			}
		: null;
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.hudDocs, { timeout: 30000 });

	// ---- 1. a DEFAULT scene saves byte-identically (null, not {}) ------------
	// The scenePostSnapshot rule: absent means default, so an older build reading the file
	// sees no field at all and a scene with no HUD is unchanged on disk.
	const empty = await page.evaluate(() => {
		const H = window.__stores.hudDocs;
		H.clearHudDocs();
		return { snapshot: H.hudDocsSnapshot(), isNull: H.hudDocsSnapshot() === null };
	});
	h.check(empty.isNull, `a scene with no HUD snapshots as NULL, not an empty object (${JSON.stringify(empty.snapshot)})`);

	// ---- 2. SESSIONS / .tpscene ---------------------------------------------
	await page.evaluate(AUTHOR);
	await page.waitForTimeout(600);
	const authored = await page.evaluate(READ);
	h.check(authored?.ids.length === 3, `premise: three elements authored (${authored?.ids.length})`);

	const session = await page.evaluate(async () => {
		const s = window.__stores;
		// the real save path, then wipe and reload it
		const payload = s.sessions.buildSessionPayload('hud-test');
		const hasHud = !!payload.hud;
		s.hudDocs.clearHudDocs();
		await new Promise((r) => setTimeout(r, 300));
		const wiped = s.hudDocs.hudDocOf('scene');
		await s.sessions.applySession(payload);
		await new Promise((r) => setTimeout(r, 800));
		return { hasHud, wiped, payloadKeys: Object.keys(payload.hud ?? {}) };
	});
	h.check(session.hasHud, 'buildSessionPayload carries a `hud` field');
	h.check(session.wiped === null, 'premise: the wipe emptied the store');
	h.check(
		JSON.stringify(session.payloadKeys) === '["scene"]',
		`keyed the way the document store is (${JSON.stringify(session.payloadKeys)})`
	);
	const afterSession = await page.evaluate(READ);
	h.check(!!afterSession, 'applySession brings the HUD back');
	h.check(
		JSON.stringify(afterSession?.ids) === JSON.stringify(authored?.ids),
		`with every element (${JSON.stringify(afterSession?.ids)})`
	);
	h.check(
		JSON.stringify(afterSession?.screens) === JSON.stringify(authored?.screens),
		`and every screen (${JSON.stringify(afterSession?.screens)})`
	);
	h.check(
		afterSession?.scoreStyle?.size === 18 && afterSession?.scoreStyle?.color === 'accent',
		`and the authored style, theme-token colour included (${JSON.stringify(afterSession?.scoreStyle)})`
	);
	h.check(afterSession?.barW === 200, `and an element's size (${afterSession?.barW})`);
	const rendersAfterSession = await page.evaluate(
		() => document.querySelectorAll('#hud-layer .hud-slot').length
	);
	h.check(rendersAfterSession === 2, `and the layer renders the active screen again (${rendersAfterSession})`);

	// a restore stamps FRESH — an authoritative local write must beat the file's stale
	// changedAt, or a peer holding a newer document would refuse it
	const stamp = await page.evaluate(async () => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('hud-test');
		const fileStamp = payload.hud.scene.changedAt;
		// pretend the file is ancient
		payload.hud.scene.changedAt = 1000;
		await s.sessions.applySession(payload);
		await new Promise((r) => setTimeout(r, 600));
		return { fileStamp, after: s.hudDocs.hudDocOf('scene').changedAt };
	});
	h.check(
		stamp.after > 1000 + 1e6,
		`a restore stamps FRESH rather than keeping the file's (file 1000 -> ${stamp.after})`
	);

	// ---- 3. AUTOSAVE: the DIRTY SUBSCRIPTION, then the round trip -----------
	// `isDirty()` is the direct test of the subscription, and it is the exact failure
	// mode: authoring a HUD touches NO object, so with no hudDocs.subscribe(markDirty)
	// the document is in the snapshot and nothing ever triggers one being written.
	// autosave REFUSES to write an empty snapshot ("never overwrite a good snapshot with
	// emptiness"), so a scene with no objects never produces one and `dirty` can never
	// settle. One object is the premise, not decoration.
	await page.evaluate(() => window.__stores.autosave.autosaveEnabled.set(true));
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1800);
	const dirtyCheck = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudDocs.clearHudDocs();
		await new Promise((r) => setTimeout(r, 200));
		// settle: write once, so `dirty` is false with nothing outstanding
		await s.autosave.saveNow();
		await new Promise((r) => setTimeout(r, 900));
		const settled = await s.idb.idbGet('latest');
		const beforeAuthoring = s.autosave.isDirty();
		// author a HUD and touch NOTHING else
		s.hudDocs.setHudDocFor('scene', {
			screens: [
				{ id: 'main', name: 'Main', elements: [{ id: 'survivor', kind: 'text', label: 'SURVIVOR', anchor: 'top-left' }] }
			],
			active: 'main'
		});
		await new Promise((r) => setTimeout(r, 300));
		return { beforeAuthoring, afterAuthoring: s.autosave.isDirty(), wroteSomething: !!settled };
	});
	h.check(dirtyCheck.wroteSomething, 'premise: autosave really wrote a snapshot to settle against');
	h.check(
		dirtyCheck.beforeAuthoring === false,
		`premise: nothing outstanding after a settle (dirty=${dirtyCheck.beforeAuthoring})`
	);
	h.check(
		dirtyCheck.afterAuthoring === true,
		`a HUD-only edit marks autosave DIRTY — the subscription (dirty=${dirtyCheck.afterAuthoring})`
	);

	// and the whole round trip through the real snapshot store
	const roundTrip = await page.evaluate(async () => {
		const s = window.__stores;
		await s.autosave.saveNow();
		await new Promise((r) => setTimeout(r, 1200));
		const stored = await s.idb.idbGet('latest');
		// idbPut('latest', snapshot) stores the snapshot itself, not a wrapper
		const inSnapshot = stored?.hud?.scene?.screens?.[0]?.elements?.map((/** @type {any} */ e) => e.label) ?? [];
		return { inSnapshot, keys: Object.keys(stored ?? {}) };
	});
	h.check(
		roundTrip.inSnapshot.includes('SURVIVOR'),
		`AUTOSAVE really wrote the HUD to storage (${JSON.stringify(roundTrip.inSnapshot)}; record keys ${JSON.stringify(roundTrip.keys)})`
	);

	// the RESTORE path: wipe the live store, then restore from that snapshot
	const restored = await page.evaluate(async () => {
		const s = window.__stores;
		const stored = await s.idb.idbGet('latest');
		const snapshot = stored;
		s.hudDocs.clearHudDocs();
		await new Promise((r) => setTimeout(r, 300));
		const wiped = s.hudDocs.hudDocOf('scene');
		// hudDocsRestore is the shared path applyRestore calls; drive it with the REAL
		// stored field rather than a hand-built one
		s.hudDocs.hudDocsRestore(snapshot.hud, true, false);
		await new Promise((r) => setTimeout(r, 700));
		const doc = s.hudDocs.hudDocOf('scene');
		return {
			wiped,
			labels: doc?.screens.flatMap((/** @type {any} */ sc) => sc.elements.map((/** @type {any} */ e) => e.label)) ?? [],
			rendered: [...document.querySelectorAll('#hud-layer .hud-el')].map((e) => e.textContent),
			stamped: (doc?.changedAt ?? 0) > 1e12
		};
	});
	h.check(restored.wiped === null, 'premise: the live store was wiped');
	h.check(
		restored.labels.includes('SURVIVOR'),
		`restoring the autosave field brings the HUD back (${JSON.stringify(restored.labels)})`
	);
	h.check(
		restored.rendered.includes('SURVIVOR'),
		`and the layer renders it (${JSON.stringify(restored.rendered)})`
	);
	h.check(restored.stamped, 'a restore stamps fresh, so it wins over a peer holding an older doc');

	// ---- 4. an UNKNOWN kind survives a full save/load round trip ------------
	// The wire proves it in hud-sync; the FILE has its own serializer, so it needs its own
	// check — a normalize that dropped it here would lose a newer peer's work on save.
	const future = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudDocs.clearHudDocs();
		s.hudDocs.setHudDocFor('scene', {
			screens: [
				{
					id: 'main',
					name: 'Main',
					elements: [
						{ id: 'ok', kind: 'text', label: 'known' },
						{ id: 'future', kind: 'radar', label: 'Radar', newProp: 7 }
					]
				}
			],
			active: 'main'
		});
		await new Promise((r) => setTimeout(r, 300));
		const payload = s.sessions.buildSessionPayload('hud-test');
		s.hudDocs.clearHudDocs();
		await s.sessions.applySession(payload);
		await new Promise((r) => setTimeout(r, 700));
		const doc = s.hudDocs.hudDocOf('scene');
		const el = doc.screens[0].elements.find((/** @type {any} */ e) => e.id === 'future');
		return {
			kept: !!el,
			kind: el?.kind,
			newProp: el?.newProp,
			rendered: [...document.querySelectorAll('#hud-layer .hud-slot')].map((e) => e.getAttribute('data-hud-kind'))
		};
	});
	h.check(future.kept, 'an UNKNOWN element kind survives a save and load');
	h.check(future.kind === 'radar' && future.newProp === 7, `verbatim (${future.kind}, newProp=${future.newProp})`);
	h.check(
		future.rendered.includes('text') && !future.rendered.includes('radar'),
		`and is skipped only at RENDER (${JSON.stringify(future.rendered)})`
	);

	await h.finish(browser);
});
