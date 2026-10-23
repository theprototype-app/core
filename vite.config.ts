import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import pkg from './package.json';
// @ts-ignore -- no @types/node in this project (adding them shifts the svelte-check baseline)
import { execSync } from 'node:child_process';
// @ts-ignore -- same node-types caveat
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
// @ts-ignore -- same node-types caveat
import { createRequire } from 'node:module';

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

// SH0 COSTING PROBE — @shaderfrog/core 3.2.0 drops the ARRAY DIMENSION when it
// re-emits a varying. `dedupeQualifiedStatements` (graph/shader-sections.js) rebuilds
// every in/out statement from a TEMPLATE STRING using only the type token and bare
// identifier names that `extractDeclarationNameAndType` returns — each declarator's
// `quantifier` is structurally discarded. So three's
// `varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ]` comes back as
// `out vec4 vDirectionalShadowCoord;`, and `vDirectionalShadowCoord[0] = mat4 * vec4`
// then assigns a vec4 to a float -> the VERTEX shader never links and the mesh is
// invisible whenever shadows are on. Uniforms are unaffected because dedupeUniforms
// manipulates AST nodes instead of re-printing them.
// The declarators carry `quantifier: ArraySpecifierNode[]` and `generate` is already
// imported in that module, so appending the generated quantifier to each name is
// enough — mixing `out vec4 a, b[2];` in one list is valid GLSL.
function fixShaderfrogArrayVaryings(): Plugin {
	const TARGET = 'shader-sections.js';
	const FROM =
		'var _b = extractDeclarationNameAndType(stmt), type = _b.type, names = _b.names;';
	const TO =
		'var _b = extractDeclarationNameAndType(stmt), type = _b.type, names = ' +
		'(stmt.declaration.declarations || []).map(function (d) { return ' +
		'd.identifier.identifier + (d.quantifier && d.quantifier.length ? generate(d.quantifier) : ""); });';
	return {
		name: 'fix-shaderfrog-array-varyings',
		enforce: 'pre',
		transform(code, id) {
			if (!id.includes('@shaderfrog') || !id.includes(TARGET)) return null;
			if (!code.includes(FROM)) {
				// fail LOUDLY on a version bump rather than silently shipping the bug
				console.warn('[fix-shaderfrog-array-varyings] anchor not found in ' + id);
				return null;
			}
			return { code: code.replace(FROM, TO), map: null };
		}
	};
}

// 53 (A1 + A5) — the accessibility CSS transform: every CSS px length becomes
// `calc(Npx * var(--ui-scale, 1))` and every `@media (prefers-reduced-motion)` block is re-keyed onto
// <html data-motion> (the why and the exceptions are in scripts/a11y-css.cjs). `enforce: 'pre'` +
// listed AFTER tailwindcss() so it runs on Tailwind's GENERATED output too (same-enforce plugins run
// in list order); the filter is Tailwind's own (plain .css files and svelte's `&lang.css` component
// styles), minus ?raw / ?url.
function a11yCss(): Plugin {
	const { transformA11yCss } = createRequire(import.meta.url)('./scripts/a11y-css.cjs');
	return {
		name: 'tp:a11y-css',
		enforce: 'pre',
		transform: {
			filter: { id: { include: [/\.css(?:\?.*)?$/, /&lang\.css/], exclude: [/[?&](?:raw|url)\b/, /\/\.vite\//] } },
			handler(code: string) {
				const next = transformA11yCss(code);
				return next === code ? null : { code: next, map: null };
			}
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

// 48 F3: THE THIRD-PARTY LICENCE NOTICES PAGE (scripts/third-party-notices.cjs). Dev writes it into static/
// (gitignored, the version.json way) so the dev server serves it; a BUILD emits it into the client output from the
// lockfile + src's imports AND every package a client chunk really contains — a shipped library can never be
// missing from it. Settings ▸ About links to it; an export carries it with the rest of build/.
function thirdPartyNotices(): Plugin {
	const notices = createRequire(import.meta.url)('./scripts/third-party-notices.cjs');
	let isBuild = false;
	return {
		name: 'third-party-notices',
		configResolved(config) {
			isBuild = config.command === 'build';
			// a dev run's copy in static/ would collide with the emitted one
			if (isBuild) for (const f of ['html', 'json']) rmSync('static/third-party-notices.' + f, { force: true });
		},
		buildStart() {
			if (isBuild) return;
			try {
				notices.writeNotices('static', { version: pkg.version });
			} catch (e) {
				console.warn('third-party notices: not written —', (e as Error)?.message);
			}
		},
		generateBundle(_opts, bundle) {
			const env = (this as any).environment;
			if (!isBuild || (env && env.config?.consumer !== 'client')) return;
			const extra = new Set<string>();
			for (const out of Object.values(bundle) as any[]) {
				if (out.type !== 'chunk') continue;
				for (const id of out.moduleIds ?? Object.keys(out.modules ?? {})) {
					const m = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(String(id).replace(/\\/g, '/'));
					if (m) extra.add(m[1]);
				}
			}
			const list = notices.collectNotices({ extra });
			this.emitFile({ type: 'asset', fileName: 'third-party-notices.html', source: notices.renderHtml(list, { version: pkg.version }) });
			this.emitFile({ type: 'asset', fileName: 'third-party-notices.json', source: JSON.stringify(list.map(({ text, ...rest }: any) => ({ ...rest, hasText: !!text }))) });
		}
	};
}

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__COMMIT_SHA__: JSON.stringify(commitSha())
	},
	// tailwind 4 runs as a vite plugin since vite 8: the old @tailwindcss/postcss route
	// broke because vite 8's internal postcss-import resolves `@import 'tailwindcss'`
	// as a file before the postcss plugin can claim it (build-time ENOENT).
	plugins: [
			fixShaderfrogArrayVaryings(),
			tailwindcss(),
			a11yCss(), // 53 A1/A5: after tailwindcss() — see the function
			devAssetProxy(),
			emitVersionJson(),
			thirdPartyNotices(),
			sveltekit()
		],
		// the transform above only reaches @shaderfrog/core if it is served as SOURCE:
		// vite pre-bundles deps with esbuild, which a Rollup-style transform hook never
		// sees (the guardThrelteXr lesson).
		optimizeDeps: {
			// 46: ktx2-encoder fetches its Basis wasm from `new URL('../basis/…', import.meta.url)`, which a
			// pre-bundle would move away from the wasm — so it is served as source
			exclude: ['@shaderfrog/core', 'ktx2-encoder'],
			// ...but excluding it stops vite pre-bundling its CJS dep too, and
			// `import groupBy from 'lodash.groupby'` then has no default export. Pre-bundle
			// that one explicitly so the interop wrapper still exists.
			// 26-F: the decimation Worker's simplifier is only reached from inside the Worker,
			// so dev discovered it on the FIRST reduction and reloaded the page mid-import
			// ("optimized dependencies changed. reloading") — losing whatever was unsaved.
			// Pre-bundle it up front so the first reduction is as quiet as the rest.
			// 36: the code editor's read-only + highlight extensions are separate bare imports
			// (CodeEditor.svelte); discovered on first use they reloaded the page the same way
			// 46: the optimizer Worker's dependencies, for the same reason as the simplifier above — the
			// first optimize (an import, a Quest export) discovered them and reloaded the page mid-export
			// 46-media H1: libheif's loader is CJS reached only from inside the HEIC worker — the same rule
			// 50 Y1: the shared-text chunk (yjs + its CodeMirror binding) loads with the first code tab
			// opened — discovered then, it would reload the page with the tab half-bound
			include: ['lodash.groupby', 'meshoptimizer/simplifier', '@codemirror/state', '@codemirror/language', '@lezer/highlight', 'meshoptimizer', '@gltf-transform/core', '@gltf-transform/extensions', '@gltf-transform/functions', 'ktx-parse', 'libheif-js/libheif-wasm/libheif.js', 'yjs', 'y-protocols/awareness', 'y-codemirror.next']
		},
	// dev https via the repo's local certs (vite-plugin-mkcert stayed on vite<=5;
	// certs/ was already how CI-less https worked before mkcert)
	server: {
		https: (() => {
			try {
				return { cert: readFileSync('certs/localhost.crt'), key: readFileSync('certs/localhost.key') };
			} catch {
				return undefined;
			}
		})()
	},
	ssr: {
		noExternal: ['three']
	}
});
