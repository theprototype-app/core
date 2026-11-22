// 54i (fix-batch-3 aa) — A LAZY CHUNK THAT WILL NOT LOAD.
//
// A tab left open across a redeploy asks for hashed chunks the new deployment no longer serves
// (Cloudflare Pages answers only the ACTIVE deployment's files: an old chunk name is a 404), and a
// phone on a bad network can drop one fetch. Before, the import just rejected: a button did
// nothing, a panel never opened, and nothing said why ("Failed to fetch dynamically imported
// module …/chunks/cm70kyiT.js" ×3 from an Android tab pressing Connect Claude).
//
// Now: vite's preload helper hands a failed lazy import to `retryImport` ONCE (the splice is
// scripts/import-retry.cjs); if the second try fails too — or any chunk failure reaches
// `vite:preloadError` / an unhandled rejection — ONE sticky "A new version is ready – Reload"
// toast. Never an automatic reload, so there is no reload loop; error reports file every chunk
// failure under one signature (errorReportCore CHUNK_LOAD_RE).
import { showToast } from '../stores/appStore.js';
import { CHUNK_LOAD_RE } from './errorReportCore.js';

/** how long to wait before the one retry (a dropped fetch on a phone usually recovers this fast) */
export const RETRY_MS = 400;

/** the suites' view */
export const chunkReloadDebug = { retries: 0, recovered: 0, failed: 0, notices: 0 };

/** a browser's "this code chunk could not be fetched", in any engine's words @param {any} err */
export function isChunkLoadError(err) {
	const message = typeof err === 'string' ? err : String(err?.message ?? '');
	return CHUNK_LOAD_RE.test(message);
}

/**
 * Retry a failed lazy import once. Anything that is not a chunk failure (a module that threw
 * while evaluating) is passed straight on.
 * @template T @param {() => Promise<T>} load @param {any} err @returns {Promise<T>}
 */
export async function retryImport(load, err) {
	if (!isChunkLoadError(err)) throw err;
	chunkReloadDebug.retries++;
	await new Promise((r) => setTimeout(r, RETRY_MS));
	try {
		const mod = await load();
		chunkReloadDebug.recovered++;
		return mod;
	} catch (again) {
		chunkReloadDebug.failed++;
		if (isChunkLoadError(again)) noteStaleCode();
		throw again;
	}
}

let noticed = false;

/** say so ONCE per page; the person decides when to reload */
export function noteStaleCode() {
	if (noticed) return;
	noticed = true;
	chunkReloadDebug.notices++;
	showToast('A new version is ready – Reload to keep working.', [{ label: 'Reload', action: () => location.reload() }], { keep: true });
}

let installed = false;

/** Install the retry seam + the two listeners. Idempotent; App.svelte calls it first thing. */
export function installChunkReload() {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	/** @type {any} */ (globalThis).__tpImportRetry = retryImport;
	// after the retry failed (or a CSS preload failed): vite still throws to the caller
	window.addEventListener('vite:preloadError', () => noteStaleCode());
	// an import vite did not wrap, or a caller that let it go unhandled
	window.addEventListener('unhandledrejection', (event) => {
		if (isChunkLoadError(/** @type {any} */ (event).reason)) noteStaleCode();
	});
}
