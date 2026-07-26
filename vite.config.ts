import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import mkcert from 'vite-plugin-mkcert';

export default defineConfig({
	plugins: [mkcert(), sveltekit()],
	ssr: {
		noExternal: ['three']
	},
	// Serve @threlte/xr from source (not a pre-bundled/cached optimized dep) so the
	// postinstall guard patch (scripts/patch-threlte-xr.cjs) is always what runs in dev
	// too — otherwise Vite keeps serving the old cached bundle after the node_modules edit.
	optimizeDeps: {
		exclude: ['@threlte/xr']
	}
});
