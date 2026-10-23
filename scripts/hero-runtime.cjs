// 65 M7 — bundle the website section runtime (src/lib/recording/heroRuntime.js + the anime.js v4
// animation module + heroMath.js) into ONE minified IIFE string (`var TPHero=...`). Used by
// vite.config.ts' `virtual:tp-hero-runtime` plugin and by the unit suite, so both see the same bytes.
const path = require('path');

const ENTRY = 'src/lib/recording/heroRuntime.js';

/**
 * @param {string} [root] the repo root
 * @returns {Promise<{code: string, files: string[]}>} the IIFE and the repo files it was built from
 */
async function bundleHeroRuntime(root = path.join(__dirname, '..')) {
	const { rolldown } = require('rolldown');
	// tsconfig: false — the project's tsconfig extends .svelte-kit's, absent before a sync
	const bundle = await rolldown({ input: path.join(root, ENTRY), cwd: root, tsconfig: false, logLevel: 'warn' });
	try {
		const { output } = await bundle.generate({ format: 'iife', name: 'TPHero', minify: true });
		const chunk = output[0];
		/** @type {string[]} */
		const ids = chunk.type === 'chunk' ? chunk.moduleIds : [];
		return { code: chunk.type === 'chunk' ? chunk.code : '', files: ids.filter((m) => !m.includes('node_modules')) };
	} finally {
		await bundle.close();
	}
}

module.exports = { bundleHeroRuntime, ENTRY };
