// 54i (fix-batch-3 aa) — ONE RETRY FOR A LAZY CHUNK THAT FAILED TO LOAD.
//
// A tab left open across a redeploy asks for hashed chunks the new deployment no longer has
// ("Failed to fetch dynamically imported module …/chunks/xxx.js"), and a flaky phone network can
// drop one fetch. Every lazy `import()` in a vite build goes through vite's preload helper
// (`\0vite/preload-helper.js`, `return baseModule().catch(handlePreloadError)`), so that ONE line is
// where a retry reaches all of them: on failure it hands the loader to the app's retry
// (`globalThis.__tpImportRetry`, installed by src/lib/chunkReload.js), and only a second failure
// reaches vite's `vite:preloadError` + the caller. Build-only (dev serves modules unwrapped).
// An anchor that stops matching (a vite upgrade) warns loudly; tests/unit/importRetry.test.js
// pins it against the installed vite.

const HELPER_ID = '\0vite/preload-helper.js';
const ANCHOR = /baseModule\(\)\.catch\(handlePreloadError\)/;
const REPLACEMENT =
	'baseModule().catch((err) => (typeof globalThis.__tpImportRetry === "function" ? globalThis.__tpImportRetry(baseModule, err) : Promise.reject(err))).catch(handlePreloadError)';

/**
 * The helper with the retry spliced in, or null when the id is not vite's preload helper.
 * @param {string} code @param {string} id
 * @returns {{code: string, matched: boolean} | null}
 */
function addImportRetry(code, id) {
	if (id !== HELPER_ID) return null;
	if (!ANCHOR.test(code)) return { code, matched: false };
	return { code: code.replace(ANCHOR, REPLACEMENT), matched: true };
}

module.exports = { addImportRetry, HELPER_ID, ANCHOR };
