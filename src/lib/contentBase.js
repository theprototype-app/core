// The off-bundle CONTENT BASES, overridable at build time.
//
// Three content repos are read over jsDelivr at pinned refs — `scenes@v2`
// (templates/examples/games), `modules@main` (the module gallery) and `packs@v1`
// (Explorer packs). Every one of them was a hardcoded const, which makes them the
// only build-time configuration in the app that CANNOT be pointed anywhere else:
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
