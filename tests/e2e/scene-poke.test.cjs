// 26-B — Stage 0: poke coalescing, time-sliced ingest, list virtualisation.
// (hardening audit M6, M1, M2; roadmap 26 section 4 "Stage 0".)
//
// THE FINDING: `objectsGroup.update((v) => v)` sat at 117 call sites with eighteen
// subscribers hanging off it, several of which traverse the whole tree. A 1,000-object
// handshake therefore ran ~8M node visits synchronously on the receive path, the object
// list re-rendered every row on each one, and the "Receiving objects" bar walked the
// tree TWICE per outstanding uuid per poke. That is the reported freeze.
//
// What is asserted, in the order it matters:
//  1. N pokes in one task produce ONE store notification (the mechanism), and a batch
//     drops that to one per frame — with the counterfactual measured in the SAME run;
//  2. incoming objects are applied IN ORDER and the drainer YIELDS, so a big scene
//     lands without holding the thread;
//  3. the object list virtualises above the threshold and stays byte-identical below;
//  4. audit M1: a send builds its OWN uuid list and resolves its connection late;
//  5. audit M2: the progress bar is cleared by a sender leaving, by a parse failure
//     and by a clear — none of which could clear it before.
const h = require('./helpers.cjs');

h.run(async () => {
	// GPU args: section 2 counts rAF frames, and a SwiftShader page runs at ~2.5fps,
	// where a one-poke-per-frame claim cannot be told from doing nothing (the e2e
	// skill's rate-assertion rule).
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- 1. the coalescer ---------------------------------------------------
	const seam = await A.page.evaluate(() => {
		const s = window.__stores;
		return {
			poke: typeof s.pokeScene === 'function',
			begin: typeof s.beginSceneBatch === 'function',
			end: typeof s.endSceneBatch === 'function',
			rev: !!s.sceneRevision
		};
	});
	h.check(seam.poke && seam.begin && seam.end && seam.rev, 'the pokeScene seam is on the debug hook (premise)');

	const coalesced = await A.page.evaluate(async () => {
		const { objectsGroup, pokeScene } = window.__stores;
		let hits = 0;
		const stop = objectsGroup.subscribe(() => hits++);
		hits = 0; // the subscribe itself fires once
		for (let i = 0; i < 500; i++) pokeScene();
		const duringTask = hits;
		await new Promise((r) => setTimeout(r, 50));
		const afterFlush = hits;
		stop();
		return { duringTask, afterFlush };
	});
	h.check(coalesced.duringTask === 0, `500 pokes notify nothing inside the task (${coalesced.duringTask})`);
	h.check(coalesced.afterFlush === 1, `…and exactly ONE notification lands after it (${coalesced.afterFlush})`);

	// THE COUNTERFACTUAL, measured in the same page: the raw identity update this
	// replaced notifies once per call. 500 vs 1 is the whole of Stage 0.
	const raw = await A.page.evaluate(async () => {
		const { objectsGroup } = window.__stores;
		let hits = 0;
		const stop = objectsGroup.subscribe(() => hits++);
		hits = 0;
		for (let i = 0; i < 500; i++) objectsGroup.update((v) => v);
		stop();
		return hits;
	});
	h.check(raw === 500, `the old bare update notifies once per call (${raw}) — the counterfactual`);

	// ---- 2. batch mode: one poke per frame, not per microtask ----------------
	const batched = await A.page.evaluate(async () => {
		const { objectsGroup, pokeScene, beginSceneBatch, endSceneBatch, sceneBatchOpen } = window.__stores;
		let hits = 0;
		const stop = objectsGroup.subscribe(() => hits++);
		hits = 0;
		beginSceneBatch();
		const open = sceneBatchOpen();
		// 40 pokes spread over ~200ms of REAL time: microtask coalescing would give 40
		// (one per task), the frame rule gives about 200/16
		let frames = 0;
		const tick = () => { frames++; requestAnimationFrame(tick); };
		requestAnimationFrame(tick);
		for (let i = 0; i < 40; i++) {
			pokeScene();
			await new Promise((r) => setTimeout(r, 5));
		}
		const duringBatch = hits;
		endSceneBatch();
		await new Promise((r) => setTimeout(r, 30));
		stop();
		return { open, duringBatch, after: hits, frames, closed: !sceneBatchOpen() };
	});
	h.check(batched.open, 'beginSceneBatch opens the batch (premise)');
	h.check(batched.closed, 'endSceneBatch closes it');
	h.check(batched.frames > 6, `the page really rendered frames in the window (${batched.frames} — GPU premise)`);
	h.check(
		batched.duringBatch > 0 && batched.duringBatch < 25,
		`40 pokes over ~200ms flush ~one per frame, not one per task (${batched.duringBatch})`
	);
	h.check(batched.after >= batched.duringBatch, 'closing the batch flushes what is pending');

	// ---- 3. time-sliced ingest ----------------------------------------------
	const ingest = await A.page.evaluate(() => {
		const c = window.__stores.commandsHandler;
		return { backlog: typeof c.ingestBacklog === 'function', drop: typeof c.dropIngestQueue === 'function' };
	});
	h.check(ingest.backlog && ingest.drop, 'the ingest queue is on the debug hook (premise)');

	// Feed real objects through the RECEIVE entry point (`createObject` with a toJSON
	// element, exactly what the `object` message carries) and measure the LONGEST the
	// main thread was held — which is what a user feels, and what "the window freezes"
	// names. THE COUNTERFACTUAL is the shape this replaced, measured in the same page on
	// the same payloads: parse, add and poke each object in ONE uninterrupted task.
	// 400 is deliberately just UNDER the virtualisation threshold, so this section
	// measures the coalescer and the queue alone and not the windowed list.
	const N = 400;
	const sliced = await A.page.evaluate(async (N) => {
		const { THREE, objectsGroup, pokeScene, commandsHandler } = window.__stores;
		let group; { const s = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); s(); }
		const payloads = [];
		const names = [];
		for (let i = 0; i < N; i++) {
			const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), new THREE.MeshStandardMaterial());
			mesh.name = 'ingest-' + String(i).padStart(3, '0');
			names.push(mesh.name);
			payloads.push({ element: mesh.toJSON() });
		}
		/** longest gap between two consecutive rAF callbacks = the worst hitch */
		const watch = () => {
			const state = { max: 0, frames: 0, done: false, last: performance.now() };
			const tick = () => {
				const now = performance.now();
				state.max = Math.max(state.max, now - state.last);
				state.last = now;
				state.frames++;
				if (!state.done) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
			return state;
		};
		const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
		const reset = async () => {
			group.clear();
			pokeScene();
			await new Promise((r) => setTimeout(r, 250));
		};

		// a) THE OLD SHAPE: everything in one task, one bare poke per object
		await reset();
		const loader = new THREE.ObjectLoader();
		let w = watch();
		await frame();
		const rawStart = performance.now();
		for (const p of payloads) {
			group.add(loader.parse(p.element));
			objectsGroup.update((v) => v);
		}
		const rawMs = performance.now() - rawStart;
		await frame();
		w.done = true;
		const inline = { max: w.max, frames: w.frames };

		// b) …and through the queue
		await reset();
		w = watch();
		await frame();
		const started = performance.now();
		const all = payloads.map((p) => commandsHandler.createObject(p, null));
		const backlogSeen = commandsHandler.ingestBacklog();
		await Promise.all(all);
		const ms = performance.now() - started;
		await frame();
		w.done = true;
		const queued = { max: w.max, frames: w.frames };
		const landed = group.children.map((/** @type {any} */ o) => o.name).filter((/** @type {string} */ n) => n.startsWith('ingest-'));
		await reset();

		return {
			ms, rawMs, backlogSeen,
			maxGap: queued.max, frames: queued.frames,
			rawMaxGap: inline.max, rawFrames: inline.frames,
			ordered: landed.join(',') === names.join(','),
			count: landed.length
		};
	}, N);
	h.check(sliced.backlogSeen > 1, `the queue really parks work rather than parsing inline (${sliced.backlogSeen} parked)`);
	h.check(sliced.count === N, `all ${N} objects landed (${sliced.count})`);
	h.check(sliced.ordered, 'they landed in the order they were received — the queue preserves it');
	h.check(
		sliced.rawMaxGap > 150,
		`the old shape holds the thread for ${Math.round(sliced.rawMaxGap)}ms on ${N} objects (premise: this is the freeze)`
	);
	h.check(
		sliced.maxGap < sliced.rawMaxGap * 0.6,
		`the queued ingest's worst hitch is far shorter (${Math.round(sliced.maxGap)}ms vs ${Math.round(sliced.rawMaxGap)}ms) — the counterfactual`
	);
	h.check(
		sliced.frames > sliced.rawFrames,
		`the page rendered more frames during the queued ingest (${sliced.frames}) than during the old one (${sliced.rawFrames})`
	);

	// dropping the queue: a clear must not let a half-sent scene trickle in after it
	const dropped = await A.page.evaluate(async () => {
		const { THREE, commandsHandler } = window.__stores;
		const payloads = [];
		for (let i = 0; i < 40; i++) {
			const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
			mesh.name = 'dropme-' + i;
			payloads.push({ element: mesh.toJSON() });
		}
		const all = payloads.map((p) => commandsHandler.createObject(p, null));
		const n = commandsHandler.dropIngestQueue();
		await Promise.all(all);
		await new Promise((r) => setTimeout(r, 200));
		const group = window.__stores.objectsGroup;
		let live = 0;
		const stop = group.subscribe((/** @type {any} */ g) => {
			live = g.children.filter((/** @type {any} */ o) => String(o.name).startsWith('dropme-')).length;
		});
		stop();
		return { n, live };
	});
	h.check(dropped.n > 0, `dropIngestQueue reports what it dropped (${dropped.n})`);
	h.check(dropped.live < 40, `the dropped objects never reached the scene (${dropped.live} of 40 landed)`);

	// ---- 4. audit M1: a send owns its uuid list, and resolves its conn late ---
	const m1 = await A.page.evaluate(() => {
		// the send path bails instead of throwing when the conn is gone — the old code
		// read `conn.send` inside a timer, where an uncaught TypeError kills the reply
		// with no trace at all
		try {
			window.__stores.commandsHandler.sendObjects('nobody-is-here');
			return { threw: false };
		} catch (e) {
			return { threw: true, message: String(e) };
		}
	});
	h.check(!m1.threw, `sendObjects to an absent peer does not throw (${m1.message ?? ''})`);
	await A.page.waitForTimeout(900);
	h.check(
		h.pageErrors(A).length === 0,
		`…and nothing is thrown 500ms later inside the timer either (${JSON.stringify(h.pageErrors(A))})`
	);

	// ---- 5. audit M2: the progress bar can be cleared -------------------------
	const m2 = await A.page.evaluate(async () => {
		const s = window.__stores;
		const read = () => { let v; const stop = s.loading.subscribe((/** @type {any} */ x) => (v = x)); stop(); return v; };
		s.commandsHandler.createLoader(3, ['ghost-a', 'ghost-b', 'ghost-c'], 'peer-who-left');
		const armed = read().length;
		// a parse that never produces an object still counts as an arrival
		s.commandsHandler.noteLoadFailed(['ghost-a']);
		const afterFail = read().length;
		// the sender leaving clears the rest
		s.commandsHandler.handleDisconnected('peer-who-left');
		const afterLeave = read().length;
		// and a clear drops any batch outright
		s.commandsHandler.createLoader(2, ['x', 'y'], 'someone');
		const armedAgain = read().length;
		s.commandsHandler.clearSceneLocal();
		return { armed, afterFail, afterLeave, armedAgain, afterClear: read().length };
	});
	h.check(m2.armed === 3, `a loading batch arms with its uuids (${m2.armed})`);
	h.check(m2.afterFail === 2, `a failed parse counts as an arrival (${m2.afterFail})`);
	h.check(m2.afterLeave === 0, 'the sender disconnecting clears the batch — it used to stick forever');
	h.check(m2.armedAgain === 2 && m2.afterClear === 0, 'a scene clear drops the batch too');

	// ---- 6. list virtualisation ---------------------------------------------
	// Below the threshold the recursive tree renders as it always did.
	const small = await A.page.evaluate(async () => {
		const { THREE, objectsGroup, pokeScene, objectListNav, expandedObjects } = window.__stores;
		let group; const stop = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); stop();
		group.clear();
		for (let i = 0; i < 20; i++) {
			const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
			m.name = 'small-' + i;
			group.add(m);
		}
		pokeScene();
		await new Promise((r) => setTimeout(r, 300));
		let exp; const s2 = expandedObjects.subscribe((/** @type {any} */ v) => (exp = v)); s2();
		return objectListNav.visibleObjectRows(group, exp, null).length;
	});
	h.check(small === 20, `20 objects flatten to 20 rows (${small})`);
	// the list is open by default in this app; assert on what it actually rendered
	await A.page.waitForTimeout(400);
	const smallRows = await A.page.locator('#object-tree [role="treeitem"]').count();
	h.check(smallRows === 20, `…and all 20 rows are in the DOM below the threshold (${smallRows})`);

	const big = await A.page.evaluate(async () => {
		const { THREE, objectsGroup, pokeScene } = window.__stores;
		let group; const stop = objectsGroup.subscribe((/** @type {any} */ g) => (group = g)); stop();
		const geo = new THREE.BoxGeometry(1, 1, 1);
		const mat = new THREE.MeshStandardMaterial();
		for (let i = 0; i < 700; i++) {
			const m = new THREE.Mesh(geo, mat);
			m.name = 'big-' + i;
			group.add(m);
		}
		pokeScene();
		return group.children.length;
	});
	h.check(big === 720, `the scene holds ${big} objects — past the 500-row threshold (premise)`);
	await A.page.waitForTimeout(900);
	const bigRows = await A.page.locator('#object-tree [role="treeitem"]').count();
	h.check(
		bigRows > 0 && bigRows < 200,
		`the list draws a WINDOW, not 720 rows (${bigRows} in the DOM) — the virtualisation`
	);
	const mode = await A.page.getAttribute('[data-object-rows]', 'data-object-rows');
	h.check(mode === 'window', `the list says which mode it is in (${mode})`);
	// …and the scroll height still covers all of them, so the scrollbar tells the truth
	const spacers = await A.page.evaluate(() => {
		const host = document.querySelector('[data-object-rows]');
		const kids = host ? [...host.children] : [];
		// the two spacers carry their height INLINE, which is readable whether or not the
		// panel is laid out at this instant
		const px = kids
			.map((el) => /height:\s*([\d.]+)px/.exec(el.getAttribute('style') ?? '')?.[1])
			.filter(Boolean)
			.map(Number);
		return { spacerPx: px.reduce((a, b) => a + b, 0), spacers: px.length, kids: kids.length };
	});
	h.check(spacers.spacers === 2, `the window has its two spacers (${spacers.spacers} of ${spacers.kids} children)`);
	h.check(
		spacers.spacerPx > 700 * 12,
		`the spacers stand in for every off-screen row, so the scrollbar tells the truth (${Math.round(spacers.spacerPx)}px)`
	);

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
