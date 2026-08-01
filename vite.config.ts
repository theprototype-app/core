import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import mkcert from 'vite-plugin-mkcert';
import pkg from './package.json';
// @ts-ignore -- no @types/node in this project (adding them shifts the svelte-check baseline)
import { execSync } from 'node:child_process';
// @ts-ignore -- same node-types caveat
import { writeFileSync } from 'node:fs';

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

// The guardThrelteXr transform plugin (Cardboard/gaze `stores[handedness]` crash in
// @threlte/xr 1.0.0-next.15) was DELETED with the 1.6 stable upgrade: the package's
// input handling was rewritten (setupInputSources keyed map) and the unguarded
// handedness indexing no longer exists anywhere in the dist.

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

// V8: emit static/version.json at build start so the deployed site can answer
// "is there a newer build?" (updateCheck.js polls it; adapter-static copies
// everything in static/ into the output). Written in dev too — harmless, the
// poll is skipped under IS_DEV. The file is gitignored (build artifact).
function emitVersionJson(): Plugin {
	return {
		name: 'emit-version-json',
		buildStart() {
			try {
				writeFileSync('static/version.json', JSON.stringify({ version: pkg.version, sha: commitSha() }));
			} catch {
				/* read-only checkout — the update check just stays silent */
			}
		}
	};
}

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__COMMIT_SHA__: JSON.stringify(commitSha())
	},
	plugins: [devAssetProxy(), emitVersionJson(), mkcert(), sveltekit()],
	ssr: {
		noExternal: ['three'],
		// flowbite-svelte 1.x has an internal circular import vite 5's ssrImport
		// can't order (500 at dev boot: 'not yet fully initialized due to circular
		// dependency'); esbuild pre-bundling for SSR resolves the cycle
		optimizeDeps: { include: ['flowbite-svelte'] }
	}
});
