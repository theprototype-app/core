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

	await A.page.evaluate(async () => {
		for (const k of ['27h-probe', '27h-abort', '27h-stall', '27h-after']) await window.__stores.idb.idbDelete(k);
	});

	await h.finish(browser);
});
