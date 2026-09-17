// Minimal promise wrapper around IndexedDB — used for autosave snapshots,
// which regularly exceed the localStorage size limit.
//
// 27-H (hardening audit M3) — A PROMISE FROM HERE ALWAYS SETTLES.
//
// It used to settle on the request's own `onsuccess` / `onerror` and nothing else, so a
// transaction that ABORTED without firing either left the promise pending FOREVER and an
// `await` on it stalled its caller with no error anywhere: no rejection, no
// `unhandledrejection`, nothing in the console. `storageUsage.js` measured the symptom
// from the outside ("a scan opened from the header chip stopped after three keys") and
// wrote a bounded read around it; this is the fix that finding is owed.
//
// Three rules now, and they compose:
//   1. `tx.onabort` REJECTS. An abort is a real outcome — quota, a closing connection, a
//      `tx.abort()` from anywhere — and it has to reach the caller as one.
//   2. Every op is bounded by `withTimeout`. Rule 1 covers the aborts the browser tells
//      us about; a timeout covers the ones it does not, which is the whole class of "the
//      request object simply never fires again". A bounded failure a caller can report
//      beats an unbounded wait it cannot.
//   3. `open()` is CACHED. Every call used to open its own connection — one per read,
//      one per write — and a storage scan makes a few hundred of them in a burst. The
//      cache is dropped whenever the connection dies (`onclose`, `onversionchange`, or a
//      `transaction()` that throws because the handle is closing), so the next call
//      reopens rather than inheriting a dead handle.
import { log } from './diagnostics';

const DB_NAME = 'theprototype';
const STORE = 'snapshots';

/**
 * How long any one operation may take before it is reported as failed.
 *
 * MEASURED before choosing it (storage-hardening §1): a 25 MB put — larger than the
 * Explorer's own 25 MB import cap and half the autosave snapshot ceiling — completes in
 * well under a second on this hardware, so 10s is roughly two orders of magnitude of
 * headroom over the largest write the app can make. The number exists to bound a HANG,
 * not to police slowness, and the suite asserts the margin so a future change that makes
 * writes genuinely slow turns it red rather than silently failing a user's import.
 */
export const OP_TIMEOUT_MS = 10_000;

/** @type {number | null} test override for the timeout (null = OP_TIMEOUT_MS) */
let timeoutOverride = null;
/** @type {'abort' | 'stall' | 'quota' | null} test override for the next transaction */
let forcedFailure = null;
/** @type {any} the error a forced failure should report instead of the transaction's own */
let forcedError = null;

/**
 * TEST SEAM: make the next transaction fail the way the real ones do.
 * `'abort'` aborts it, `'stall'` swallows every completion callback (the state that
 * used to hang forever and now hits the timeout), and `'quota'` reports the exact
 * `QuotaExceededError` a full disk reports — which cannot be provoked honestly in a
 * headless run, where the origin is granted tens of gigabytes. One-shot: each clears
 * itself as soon as it is used, so a suite cannot poison the rest of its own run.
 * @param {'abort' | 'stall' | 'quota' | null} mode
 */
export function debugForceNextTx(mode) {
	forcedFailure = mode;
}

/**
 * TEST SEAM: shorten the timeout so the bounded-failure path can be exercised in a suite
 * without a ten-second wait. `null` restores the default.
 * @param {number | null} ms
 */
export function debugTimeoutMs(ms) {
	timeoutOverride = ms;
}

/** @returns {number} */
function limit() {
	return timeoutOverride ?? OP_TIMEOUT_MS;
}

/**
 * Bound a promise. Exported because it is the pure half of this module and is unit
 * tested with no IndexedDB at all (tests/unit/idbTimeout).
 *
 * The timer is cleared on BOTH settlements, not only on the win: a 10s handle left
 * running for every read would keep a storage scan's few hundred timers alive and, in a
 * test environment, hold the process open.
 * @template T
 * @param {Promise<T>} promise @param {number} ms @param {string} label
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label) {
	/** @type {any} */
	let timer = null;
	const settled = promise.then(
		(value) => {
			clearTimeout(timer);
			return value;
		},
		(error) => {
			clearTimeout(timer);
			throw error;
		}
	);
	return Promise.race([
		settled,
		new Promise((_resolve, reject) => {
			timer = setTimeout(() => {
				const error = new Error(`idb ${label} timed out after ${ms}ms`);
				// @ts-ignore - a marker the callers can branch on without string matching
				error.timedOut = true;
				log('warn', 'idb', 'operation timed out', { op: label, ms });
				reject(error);
			}, ms);
		})
	]);
}

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/** Drop the cached connection so the next call reopens. @param {Promise<IDBDatabase>} [only] */
function invalidate(only) {
	if (!only || dbPromise === only) dbPromise = null;
}

/** @returns {Promise<IDBDatabase>} */
function open() {
	if (dbPromise) return dbPromise;
	/** @type {Promise<IDBDatabase>} */
	const pending = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => {
			const db = request.result;
			// A cached handle that the browser closes underneath us (a tab in another
			// window upgrading the schema, storage being cleared, the OS reclaiming it)
			// would otherwise be handed out forever, and every transaction on it throws.
			db.onclose = () => invalidate(pending);
			db.onversionchange = () => {
				db.close();
				invalidate(pending);
			};
			resolve(db);
		};
		request.onerror = () => reject(request.error ?? new Error('idb open failed'));
		request.onblocked = () => reject(new Error('idb open blocked'));
	});
	dbPromise = pending;
	// a FAILED open must not be cached, or one transient error disables storage for the
	// life of the tab
	pending.catch(() => invalidate(pending));
	return withTimeout(pending, limit(), 'open');
}

/**
 * Run one transaction against the cached connection, reopening once if the handle turned
 * out to be dead. `db.transaction()` throws synchronously on a closing connection, which
 * is exactly the case the cache introduces — so the retry is what pays for the cache.
 * @template T
 * @param {string} label @param {(db: IDBDatabase) => Promise<T>} body @returns {Promise<T>}
 */
async function withDb(label, body) {
	try {
		return await withTimeout(body(await open()), limit(), label);
	} catch (error) {
		const name = /** @type {any} */ (error)?.name;
		if (name !== 'InvalidStateError' && name !== 'TransactionInactiveError') throw error;
		invalidate();
		log('warn', 'idb', 'connection was stale, reopening', { op: label });
		return withTimeout(body(await open()), limit(), label);
	}
}

/**
 * Settle on every outcome a transaction has: complete, error AND abort. The abort arm is
 * the one that was missing, and it is not hypothetical — `tx.abort()` fires it with
 * `tx.error === null`, which is why the fallback message exists.
 * @param {IDBTransaction} tx @param {() => any} value @returns {Promise<any>}
 */
function settle(tx, value) {
	return new Promise((resolve, reject) => {
		/** @param {string} fallback */
		const fail = (fallback) => {
			const forced = forcedError;
			forcedError = null;
			reject(forced ?? tx.error ?? new Error(fallback));
		};
		tx.oncomplete = () => resolve(value());
		tx.onerror = () => fail('idb transaction failed');
		tx.onabort = () => fail('idb transaction aborted');
	});
}

/**
 * Apply a one-shot test override to a live transaction.
 *
 * `'abort'` aborts AFTER the request has succeeded, and the timing is the whole point:
 * abort a transaction with a request still in flight and that request errors first, which
 * BUBBLES to `tx.onerror` — so the old wrapper happened to settle. Abort once every
 * request has already succeeded and `onabort` is the ONLY event that fires, which is the
 * case that hung forever and the one the counterfactual has to reproduce.
 *
 * `'stall'` removes every handler the transaction could settle through: the shape of an
 * operation the browser never reports on at all, which only the timeout can catch.
 *
 * `'quota'` aborts the same way and hands `settle` the error a full disk raises, so the
 * whole failure path downstream — the name test in autosave, the sticky toast, the
 * diagnostics line — runs against the real exception rather than a stand-in for it.
 * @param {IDBTransaction} tx @param {IDBRequest} [request]
 */
function applyForcedFailure(tx, request) {
	const mode = forcedFailure;
	forcedFailure = null;
	if (mode === 'abort' || mode === 'quota') {
		if (mode === 'quota')
			forcedError = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
		const fire = () => {
			try {
				tx.abort();
			} catch {}
		};
		// `onsuccess` is free to overwrite: every read below takes its value at
		// `oncomplete`, not from this handler
		if (request) request.onsuccess = fire;
		else queueMicrotask(fire);
	} else if (mode === 'stall')
		queueMicrotask(() => {
			tx.oncomplete = null;
			tx.onerror = null;
			tx.onabort = null;
		});
}

/** @param {string} key */
export function idbGet(key) {
	return withDb('get', (db) => {
		const tx = db.transaction(STORE);
		const request = tx.objectStore(STORE).get(key);
		const promise = settle(tx, () => request.result);
		applyForcedFailure(tx, request);
		return promise;
	});
}

/** @param {string} key @param {any} value */
export function idbPut(key, value) {
	return withDb('put', (db) => {
		const tx = db.transaction(STORE, 'readwrite');
		const request = tx.objectStore(STORE).put(value, key);
		const promise = settle(tx, () => undefined);
		applyForcedFailure(tx, request);
		return promise;
	});
}

/** All keys in the store (used to list saved environment presets) */
export function idbKeys() {
	return withDb('keys', (db) => {
		const tx = db.transaction(STORE);
		const request = tx.objectStore(STORE).getAllKeys();
		const promise = settle(tx, () => request.result);
		applyForcedFailure(tx, request);
		return promise;
	});
}

/** @param {string} key */
export function idbDelete(key) {
	return withDb('delete', (db) => {
		const tx = db.transaction(STORE, 'readwrite');
		const request = tx.objectStore(STORE).delete(key);
		const promise = settle(tx, () => undefined);
		applyForcedFailure(tx, request);
		return promise;
	});
}
