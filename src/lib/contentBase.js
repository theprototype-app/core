// The off-bundle CONTENT BASES, overridable at build time.
//
// Three content repos are read over jsDelivr at pinned refs — `scenes@format-2`
// (templates/examples/games), `modules@format-1` (the module gallery; `@main` before 1.27) and `packs@format-1`
// (Explorer packs; 29f/#230: a ref must never look like a semver version, because
// jsDelivr resolves a version ONCE and a retag of it is a no-op forever). Every one
// of them was a hardcoded const, which makes them the only build-time configuration
// in the app that CANNOT be pointed anywhere else:
// the ref a build reads is the ref production reads, so there was no way to try
// unpublished content without publishing it to the ref real users are on.
//
// These take a `VITE_*` override exactly the way the signaling, asset-proxy and
// cloud-plugin config already do, so a PREVIEW deployment can be built against a
// `dev` branch while production keeps the pinned ref.
//
// A LEAF: imports nothing, so the three consumers stay free of each other.

/**
 * Resolve a content base: the build's override if it set one, else the pinned ref.
 *
 * TAKES THE VALUE, NOT THE KEY. vite replaces `import.meta.env.VITE_X` by literal
 * source substitution, so a dynamic `import.meta.env[key]` is NOT replaced and reads
 * undefined in a production build — it would have silently ignored every override
 * while working perfectly in dev. Each call site passes the literal access.
 *
 * THE DEFAULT IS THE PINNED REF, so a build with none of these set is byte-identical
 * to one from before this existed (the `resolvePlaySettings` rule: an absent override
 * must cost nothing). A trailing slash is trimmed because every caller composes
 * `${BASE}/index.json`, and `//index.json` 404s on jsDelivr.
 *
 * @param {unknown} value e.g. `import.meta.env.VITE_SCENES_BASE`
 * @param {string} fallback the pinned ref this build ships with
 * @returns {string}
 */
export function contentBase(value, fallback) {
	return typeof value === 'string' && value ? value.replace(/\/+$/, '') : fallback;
}

/**
 * Fetch a content INDEX — a list that lives on a BRANCH ref (`scenes@format-2/index.json`,
 * `packs@format-1/index.json` and each pack's item list, `modules@format-1/index.json`, the
 * community gallery manifest).
 *
 * 1.19.1: jsDelivr answers a branch ref with `cache-control: max-age=604800` — SEVEN DAYS
 * in the browser. With the default cache mode every device that had opened the tab in the
 * last week kept the old list after a release (1.19.0 shipped three new General levels
 * that those devices could not see; a fresh browser saw them, which is why the
 * production proof passed). `no-cache` = revalidate every time: jsDelivr answers a
 * conditional request with a 304 on its ETag, so an unchanged index costs a header
 * round trip, not the body.
 *
 * ONLY for lists. Content a list points at (GLBs, thumbnails, a scene file by path) keeps
 * the default cache — those are the bulk of the bytes, and a stale list is what hides
 * new content.
 *
 * @param {string} url @returns {Promise<Response>}
 */
export function fetchIndex(url) {
	return fetch(url, { cache: 'no-cache' });
}

/** @type {Set<() => void>} */
const staleHandlers = new Set();

/**
 * Register a memo to drop when the deployed content may have moved on (an app update was
 * noticed): the loaders memoize their index per session, so without this a tab left open
 * across a release kept the old list until a reload, Retry or not.
 * @param {() => void} handler @returns {() => void} unsubscribe
 */
export function onContentStale(handler) {
	staleHandlers.add(handler);
	return () => staleHandlers.delete(handler);
}

/** Drop every registered index memo (updateCheck calls this when it sees a new version);
 * the next open of a tab re-fetches. A throwing handler never stops the others. */
export function markContentStale() {
	for (const handler of staleHandlers) {
		try {
			handler();
		} catch {
			/* one loader's memo must not keep the others stale */
		}
	}
}
