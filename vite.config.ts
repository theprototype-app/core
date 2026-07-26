import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import mkcert from 'vite-plugin-mkcert';

// @threlte/xr 1.0.0-next.15 crashes on XR session end / inputsourceschange: its
// controller/hand handlers index `stores[handedness]` and read `data.handedness`
// unguarded, and a Cardboard/gaze input's handedness isn't one of {left,right,none}
// (or event.data is undefined on the disconnect) -> "Cannot read properties of undefined".
// The uncaught error aborts the WebXR teardown, wedging the viewport. We guard every such
// access at TRANSFORM time (dev + build) so it can't get stale like a node_modules edit.
function guardThrelteXr(): Plugin {
	const subs: [string, string][] = [
		['stores[event.data.handedness].set', 'stores[event.data?.handedness]?.set'],
		['stores[handedness].set', 'stores[handedness]?.set'],
		['controllerEvents[data.handedness]', 'controllerEvents[data?.handedness]'],
		['handEvent.data.handedness', 'handEvent.data?.handedness']
	];
	return {
		name: 'guard-threlte-xr',
		enforce: 'pre',
		transform(code, id) {
			const norm = id.replace(/\\/g, '/');
			if (!norm.includes('@threlte/xr') || !/setup(Controllers|Hands)\.js$/.test(norm)) return null;
			let out = code;
			for (const [from, to] of subs) out = out.split(from).join(to);
			return out === code ? null : { code: out, map: null };
		}
	};
}

export default defineConfig({
	// guardThrelteXr must run before sveltekit/optimize so it patches the served source
	plugins: [guardThrelteXr(), mkcert(), sveltekit()],
	ssr: {
		noExternal: ['three']
	},
	// Serve @threlte/xr from source (not a pre-bundled esbuild-optimized dep) so the
	// transform plugin above actually runs on it in dev.
	optimizeDeps: {
		exclude: ['@threlte/xr']
	}
});
