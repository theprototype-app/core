import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { loadEnv } from 'vite';
import { cspDirectives } from './csp.config.js';

// 69 T3: a build ships a Content Security Policy (csp.config.js); `npm run dev` does not
const building = process.argv.includes('build');
const env = { ...loadEnv(process.env.MODE || 'production', process.cwd(), 'VITE_'), ...process.env };
const directives = building ? cspDirectives(env) : null;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		adapter: adapter({
			// fallback: '404.html'
		  }),
		// hash mode: the pages are prerendered, so the policy goes into each page's <meta> with the
		// hash of SvelteKit's own inline boot script
		...(directives ? { csp: { mode: 'hash', directives } } : {})
	}
};

export default config;
