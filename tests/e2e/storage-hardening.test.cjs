// 27-H (hardening audit M3, M4, M5, M9) — STORAGE THAT FAILS OUT LOUD.
//
// Four things this covers, each of which used to fail silently:
//   1. an IndexedDB transaction that ABORTS or STALLS now rejects, instead of leaving
//      its caller awaiting a promise that never settles
//   2. autosave cannot re-enter itself, measures its own export, backs off when the
//      scene gets expensive, and raises a STICKY toast when the disk is full
//   3. `safeStorage` keeps working when `localStorage` throws (Safari private mode, a
//      full quota), so a setting still applies for the session
//   4. the microphone is released when voice goes off
//
// Run: APP_URL=https://theprototype.app:5176/ npm run e2e -- storage-hardening
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- 1. a transaction always settles -----------------------------------------------
	const seams = await A.page.evaluate(
		() => typeof window.__stores.idb?.debugForceNextTx === 'function' && typeof window.__stores.idb?.debugTimeoutMs === 'function'
	);
	h.check(seams, 'premise: the idb test seams are reachable');

	const wrote = await A.page.evaluate(async () => {
		try {
			await window.__stores.idb.idbPut('27h-probe', { hello: 'world' });
			const back = await window.__stores.idb.idbGet('27h-probe');
			return back?.hello ?? null;
		} catch (e) {
			return 'threw: ' + e;
		}
	});
	h.check(wrote === 'world', `premise: an ordinary put/get round trip still works (${wrote})`);

	// THE FINDING. `tx.abort()` fires `onabort` and NOTHING else — no `oncomplete`, no
	// `onerror` — so the old wrapper's promise stayed pending forever. The assertion is
	// that the put REJECTS, not that it resolves: an abort is a failure and has to reach
	// the caller as one.
	// The probe RACES a 5s timer so the counterfactual reads as a clean failure rather
	// than a harness crash: with `tx.onabort` removed this promise never settles, and
	// "still waiting" is exactly the bug's name.
	const aborted = await A.page.evaluate(async () => {
		const t0 = performance.now();
		window.__stores.idb.debugForceNextTx('abort');
		const put = window.__stores.idb
			.idbPut('27h-abort', { n: 1 })
			.then(() => ({ outcome: 'resolved', message: '' }))
			.catch((error) => ({ outcome: 'rejected', message: String(error && error.message) }));
		const result = await Promise.race([
			put,
			new Promise((resolve) => setTimeout(() => resolve({ outcome: 'still waiting', message: '' }), 5000))
		]);
		return { ...result, ms: performance.now() - t0 };
	});
	h.check(
		aborted.outcome === 'rejected',
		`an aborted transaction REJECTS rather than hanging (${aborted.outcome} in ${Math.round(aborted.ms)}ms)`
	);
	h.check(
		/abort/i.test(aborted.message || ''),
		`and it says an abort is what happened ("${aborted.message}")`
	);
	h.check(
		aborted.ms < 1000,
		`and it says so immediately, not after the 10s bound (${Math.round(aborted.ms)}ms)`
	);

	// The other half: an operation the browser never reports on at all. `'stall'` removes
	// every handler the transaction could settle through, which IS the original bug — the
	// timeout is what turns it into a failure a caller can report.
	const stalled = await A.page.evaluate(async () => {
		window.__stores.idb.debugTimeoutMs(400);
		const t0 = performance.now();
		window.__stores.idb.debugForceNextTx('stall');
		const put = window.__stores.idb
			.idbPut('27h-stall', { n: 2 })
			.then(() => ({ outcome: 'resolved', timedOut: false, message: '' }))
			.catch((error) => ({
				outcome: 'rejected',
				timedOut: !!(error && error.timedOut),
				message: String(error && error.message)
			}));
		const result = await Promise.race([
			put,
			new Promise((resolve) =>
				setTimeout(() => resolve({ outcome: 'still waiting', timedOut: false, message: '' }), 5000)
			)
		]);
		window.__stores.idb.debugTimeoutMs(null);
		return { ...result, ms: performance.now() - t0 };
	});
	h.check(
		stalled.outcome === 'rejected' && stalled.timedOut === true,
		`a transaction that never reports back is bounded and rejects (${stalled.outcome}, timedOut=${stalled.timedOut})`
	);
	h.check(
		stalled.ms >= 350 && stalled.ms < 3000,
		`and it waits the bound it was given, no more (${Math.round(stalled.ms)}ms for a 400ms bound)`
	);

	// A failure must not disable storage for the rest of the session — the abort and the
	// stall above both went through the CACHED connection, so this is also the check that
	// the cache is not poisoned by them.
	const recovered = await A.page.evaluate(async () => {
		try {
			await window.__stores.idb.idbPut('27h-after', { n: 3 });
			const back = await window.__stores.idb.idbGet('27h-after');
			return back?.n ?? null;
		} catch (e) {
			return 'threw: ' + e;
		}
	});
	h.check(recovered === 3, `storage still works after both failures (${recovered})`);

	// The cache. Every op used to open its own connection, and a storage scan makes a few
	// hundred in a burst. Counted at the source rather than inferred from timing.
	const opens = await A.page.evaluate(async () => {
		const real = indexedDB.open.bind(indexedDB);
		let count = 0;
		// @ts-ignore - deliberate instrumentation
		indexedDB.open = (...args) => {
			count++;
			return real(...args);
		};
		try {
			await window.__stores.idb.idbGet('27h-probe'); // warm, in case nothing had opened yet
			const warm = count;
			for (let i = 0; i < 20; i++) await window.__stores.idb.idbGet('27h-probe');
			return { warm, after: count };
		} finally {
			// @ts-ignore
			indexedDB.open = real;
		}
	});
	h.check(
		opens.after === opens.warm,
		`20 reads reuse one connection instead of opening 20 (${opens.after - opens.warm} new opens)`
	);

	// WHY 10s IS THE RIGHT BOUND, measured rather than assumed: the largest write this app
	// can make is an Explorer import at its own 25MB cap (the autosave ceiling is 50MB of
	// JSON, which structured-clones comparably). If this ever approaches the bound, the
	// timeout would start failing legitimate saves — so the margin is asserted, not hoped
	// for.
	const big = await A.page.evaluate(async () => {
		const bytes = new Uint8Array(25 * 1024 * 1024);
		for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 255; // not all-zero
		const t0 = performance.now();
		await window.__stores.idb.idbPut('27h-big', bytes);
		const ms = performance.now() - t0;
		await window.__stores.idb.idbDelete('27h-big');
		return { ms, bound: window.__stores.idb.OP_TIMEOUT_MS };
	});
	h.check(
		big.ms * 5 < big.bound,
		`a 25MB put has at least 5x headroom under the bound (${Math.round(big.ms)}ms of ${big.bound}ms)`
	);

	// ---- 2. autosave: one at a time, adaptive, and loud when it fails ------------------
	// A snapshot needs something to snapshot: `saveSnapshot` refuses to overwrite a good
	// snapshot with emptiness, so an empty scene never writes at all.
	await A.page.evaluate(() => {
		for (let i = 0; i < 6; i++)
			window.__stores.addObjects.spawnAtPoint('/create Box 1 1 1', [i * 2 - 5, 0.5, -4]);
	});
	await A.page.waitForTimeout(1200);

	const cadence = await A.page.evaluate(() => {
		const f = window.__stores.autosave.cadenceFor;
		return { at0: f(0), at150: f(150), at151: f(151), at300: f(300), at700: f(700), huge: f(1e9) };
	});
	h.check(
		cadence.at0 === 30_000 && cadence.at150 === 30_000,
		`a cheap export leaves the 30s cadence alone (${cadence.at0} / ${cadence.at150})`
	);
	h.check(
		cadence.at151 === 60_000 && cadence.at300 === 60_000 && cadence.at700 === 240_000,
		`past 150ms it doubles per doubling of the cost (151ms -> ${cadence.at151}, 300 -> ${cadence.at300}, 700 -> ${cadence.at700})`
	);
	h.check(cadence.huge === 300_000, `and it caps at 5 minutes (${cadence.huge})`);

	// The estimate. WHY IT EXISTS: the probe it replaces was a full `JSON.stringify` of
	// everything, thrown away immediately, purely to learn a number — so the property that
	// matters is not accuracy, it is COST.
	const sizing = await A.page.evaluate(() => {
		const big = 'A'.repeat(4 * 1024 * 1024);
		const snapshot = {
			scene: { buffers: [{ uri: big }], images: [], nodes: new Array(500).fill({ name: 'n' }) },
			animated: [{ bytes: big }],
			multiMaterial: [],
			nodes: new Array(50).fill({ id: 'n' })
		};
		const t0 = performance.now();
		let bytes = 0;
		for (let i = 0; i < 20; i++) bytes = window.__stores.autosave.estimateSnapshotBytes(snapshot);
		const estimateMs = (performance.now() - t0) / 20;
		const t1 = performance.now();
		const probe = JSON.stringify(snapshot).length;
		const probeMs = performance.now() - t1;
		return { bytes, probe, estimateMs, probeMs };
	});
	h.check(
		sizing.bytes > 8 * 1024 * 1024 && sizing.bytes < sizing.probe * 1.5,
		`the estimate is in the right neighbourhood (${sizing.bytes} vs a real ${sizing.probe})`
	);
	h.check(
		sizing.estimateMs * 20 < sizing.probeMs,
		`and it is at least 20x cheaper than the stringify it replaced (${sizing.estimateMs.toFixed(3)}ms vs ${sizing.probeMs.toFixed(1)}ms)`
	);

	// ONE EXPORT AT A TIME. `debugRequestSave` is what the debounce timer calls — including
	// the re-entrancy refusal, which `saveNow` deliberately skips (it waits its turn).
	const reentry = await A.page.evaluate(async () => {
		const a = window.__stores.autosave;
		let before = null;
		a.autosaveStatus.subscribe((v) => (before = v))();
		const all = [a.debugRequestSave(), a.debugRequestSave(), a.debugRequestSave()];
		const duringFirst = a.isSaving();
		await Promise.all(all);
		let after = null;
		a.autosaveStatus.subscribe((v) => (after = v))();
		return {
			duringFirst,
			writes: after.writes - before.writes,
			coalesced: after.coalesced - before.coalesced,
			exportMs: after.lastExportMs,
			debounceMs: after.debounceMs
		};
	});
	h.check(reentry.duringFirst === true, 'premise: a save really was in flight');
	h.check(
		reentry.writes === 1,
		`three ticks during one save write ONE snapshot, not three (${reentry.writes})`
	);
	h.check(
		reentry.coalesced === 2,
		`and the other two are folded into it rather than starting their own export (${reentry.coalesced})`
	);

	// The cadence is DERIVED from that measurement, so the relation holds whatever the
	// host's speed — which is the only honest way to assert it on a machine whose export
	// cost is not ours to fix.
	const derived = await A.page.evaluate(() => {
		const a = window.__stores.autosave;
		let state = null;
		a.autosaveStatus.subscribe((v) => (state = v))();
		return { ms: state.lastExportMs, debounce: state.debounceMs, expected: a.cadenceFor(state.lastExportMs) };
	});
	h.check(
		derived.ms > 0 && derived.debounce === derived.expected,
		`the live cadence is the one that measurement implies (${Math.round(derived.ms)}ms -> ${derived.debounce}ms)`
	);

	// A FAILED AUTOSAVE IS SAID OUT LOUD. This used to reach `console.log` and stop there,
	// so a full disk meant crash recovery had silently switched itself off. The quota error
	// is raised through the idb seam because a headless origin is granted tens of gigabytes
	// and cannot honestly be filled.
	const quota = await A.page.evaluate(async () => {
		window.__stores.toastStore.set([]);
		window.__stores.idb.debugForceNextTx('quota');
		await window.__stores.autosave.saveNow();
		let toasts = [];
		window.__stores.toastStore.subscribe((v) => (toasts = v))();
		let state = null;
		window.__stores.autosave.autosaveStatus.subscribe((v) => (state = v))();
		const card = toasts.find((t) => t && t.id === 'autosave-failed');
		return {
			found: !!card,
			sticky: !!card?.sticky,
			text: card?.text ?? '',
			actions: (card?.actions ?? []).map((entry) => entry.label),
			lastError: state.lastError
		};
	});
	h.check(quota.found, 'a full disk raises a toast instead of a console line');
	h.check(quota.sticky, '...and it is STICKY — a 5s toast about losing work is one nobody reads');
	h.check(
		/room left/i.test(quota.text) && /recovery/i.test(quota.text),
		`...saying what it means for crash recovery ("${quota.text}")`
	);
	h.check(
		quota.actions.includes('Manage storage'),
		`...and carrying the way to act on it (${JSON.stringify(quota.actions)})`
	);
	h.check(
		/Quota/i.test(String(quota.lastError)),
		`...and the diagnostics bundle records why (${quota.lastError})`
	);

	// and it clears itself once a save works again, or it is a permanent scar
	const cleared = await A.page.evaluate(async () => {
		await window.__stores.autosave.saveNow();
		let toasts = [];
		window.__stores.toastStore.subscribe((v) => (toasts = v))();
		let state = null;
		window.__stores.autosave.autosaveStatus.subscribe((v) => (state = v))();
		return { still: toasts.some((t) => t && t.id === 'autosave-failed'), lastError: state.lastError };
	});
	h.check(
		!cleared.still && cleared.lastError === null,
		'a later successful save takes the warning back down'
	);

	// The Storage panel says what the cadence currently is — an adaptive interval nobody
	// can see is indistinguishable from autosave being broken.
	// NOT a page-side `import()` of the module path: once vite has timestamped the app's
	// own copy that binds a SECOND instance, whose stores nothing is rendering — the
	// documented HMR module-identity trap, which cost two runs here before it was spotted.
	const panel = await A.page.evaluate(() => {
		window.__stores.storageUsage.openStorageModal();
		return true;
	});
	h.check(panel, 'premise: the Storage panel opens');
	await A.page.waitForSelector('#storage-autosave', { timeout: 15000 });
	const line = await A.page.evaluate(() => {
		const el = document.querySelector('#storage-autosave');
		return {
			text: el ? el.textContent.replace(/\s+/g, ' ').trim() : '',
			cadence: document.querySelector('#storage-autosave-cadence')?.textContent ?? '',
			cost: document.querySelector('#storage-autosave-cost')?.textContent ?? ''
		};
	});
	h.check(
		/seconds|minute/.test(line.cadence),
		`the panel names the current cadence in words ("${line.cadence}")`
	);
	h.check(/ms$/.test(line.cost), `...and what the last snapshot cost to prepare ("${line.cost}")`);
	await A.page.evaluate(() => window.__stores.storageUsage.storageModalOpen.set(false));

	await A.page.evaluate(async () => {
		for (const k of ['27h-probe', '27h-abort', '27h-stall', '27h-after']) await window.__stores.idb.idbDelete(k);
	});

	await h.finish(browser);
});
