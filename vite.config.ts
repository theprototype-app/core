import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import mkcert from 'vite-plugin-mkcert';
import pkg from './package.json';
// @ts-ignore -- no @types/node in this project (adding them shifts the svelte-check baseline)
import { execSync } from 'node:child_process';

// Version identity is baked at build time (V1): `npm version` in package.json is the
// single source of truth, the sha comes from the checkout. vite `define` reaches dev,
// build AND the static prerender, so there is no second code path to keep in sync.
// Read them through src/lib/version.js, never the globals directly.
function commitSha(): string {
	try {
		return String(execSync('git rev-parse --short HEAD')).trim() || 'unknown';
	} catch {
		return 'unknown';
	}
}

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

// Dev-only CORS relay for generated-asset CDNs (mirror of the peerjs box's /proxy
// route — infra repo server.js): Meshy's assets.meshy.ai serves finished GLBs with
// no Access-Control-Allow-Origin, so the browser can't fetch them directly. In dev
// the meshy adapter prefers this same-origin /proxy (meshy.js assetProxyFor), which
// keeps local development working with NO deployed proxy / EC2 dependency. Same
// hardening: https-only, host allowlist, redirects refused, size cap.
function devAssetProxy(): Plugin {
	const HOSTS = ['assets.meshy.ai'];
	const MAX_BYTES = 256 * 1048576;
	return {
		name: 'dev-asset-proxy',
		configureServer(server) {
			// req/res as any: the svelte-check project has no node types for the config
			server.middlewares.use('/proxy', async (req: any, res: any) => {
				const fail = (status: number, msg: string) => {
					res.statusCode = status;
					res.end(msg);
				};
				let target: URL;
				try {
					target = new URL(new URL(req.url || '', 'http://x').searchParams.get('url') || '');
				} catch {
					return fail(400, 'bad url');
				}
				if (target.protocol !== 'https:' || !HOSTS.includes(target.hostname)) {
					return fail(403, 'host not allowed');
				}
				try {
					const upstream = await fetch(target, { redirect: 'error' });
					if (!upstream.ok) return fail(502, 'upstream ' + upstream.status);
					const bytes = new Uint8Array(await upstream.arrayBuffer());
					if (bytes.byteLength > MAX_BYTES) return fail(413, 'too large');
					res.statusCode = 200;
					res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
					res.setHeader('Content-Length', String(bytes.byteLength));
					res.setHeader('Cache-Control', 'no-store');
					res.end(bytes);
				} catch {
					fail(502, 'proxy fetch failed');
				}
			});
		}
	};
}

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__COMMIT_SHA__: JSON.stringify(commitSha())
	},
	// guardThrelteXr must run before sveltekit/optimize so it patches the served source
	plugins: [guardThrelteXr(), devAssetProxy(), mkcert(), sveltekit()],
	ssr: {
		noExternal: ['three']
	},
	// Serve @threlte/xr from source (not a pre-bundled esbuild-optimized dep) so the
	// transform plugin above actually runs on it in dev.
	optimizeDeps: {
		exclude: ['@threlte/xr']
	}
});
