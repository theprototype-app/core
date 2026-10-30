// 69 T3 — THE CONTENT SECURITY POLICY A BUILD SHIPS, in one place.
//
// Two consumers read this file: svelte.config.js (kit.csp — SvelteKit hashes its own inline boot
// script and writes the policy into every prerendered page as a <meta http-equiv>) and
// scripts/csp-headers.cjs (postbuild — `frame-ancestors`, which a meta tag cannot carry, as a real
// header in build/_headers for Cloudflare Pages; a self-hoster's server sends the same line). The
// header carries ONLY that directive: two policies are intersected, and the meta holds the hash of
// SvelteKit's inline boot script that a hand-written header would not.
//
// Builds only: `npm run dev` stays policy-free, so self-hosting needs no config at all.
//
// What it is for. Scene code (scripts, behaviours, custom HUD elements) runs in the QuickJS guest
// and has no network or DOM at all, so the policy is defence in depth against an INJECTED script:
// `script-src` is strict (no inline script, no eval — nothing in the app needs either; wasm needs
// 'wasm-unsafe-eval'; installed modules load by blob import, hence blob:). `connect-src` is open to
// https/wss by default because users point the app at endpoints of their own at run time (a custom
// AI server, ComfyUI, a module repo, an HDRI CDN); a deployment that knows its list sets
// VITE_CSP_CONNECT_SRC to replace it.
//
// Environment (all optional, space-separated source lists):
//   VITE_CSP_SCRIPT_SRC      added to script-src (e.g. an analytics beacon's origin)
//   VITE_CSP_CONNECT_SRC     REPLACES the default connect-src
//   VITE_CSP_EXTRA_CONNECT   added to connect-src (keeps the default)
//   VITE_CSP_IMG_SRC         REPLACES the default img-src / media-src
//   VITE_CSP_FRAME_ANCESTORS the header's frame-ancestors (default: * while play/embeds are served
//                            from this origin, 'self' once VITE_PLAY_ORIGIN names another one)
//   VITE_CSP=off             no policy at all (a deployment that sets its own at the edge)

const KEYWORDS = new Set(['self', 'none', 'unsafe-inline', 'unsafe-eval', 'wasm-unsafe-eval', 'strict-dynamic', 'unsafe-hashes']);

/** @param {string | undefined} value */
const list = (value) =>
	String(value ?? '')
		.split(/\s+/)
		.map((s) => s.trim().replace(/^'(.*)'$/, '$1'))
		.filter(Boolean);

/** the origin of an absolute http(s) URL, else '' @param {string | undefined} url */
function originOf(url) {
	try {
		const u = new URL(String(url ?? ''));
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : '';
	} catch {
		return '';
	}
}

/** a self-hosted PeerJS server on plain ws (VITE_PEER_SECURE=false) @param {Record<string, string | undefined>} env */
function insecurePeer(env) {
	if (String(env.VITE_PEER_SECURE ?? '').toLowerCase() !== 'false' || !env.VITE_PEER_HOST) return [];
	const port = env.VITE_PEER_PORT ? ':' + env.VITE_PEER_PORT : '';
	return ['ws://' + env.VITE_PEER_HOST + port, 'http://' + env.VITE_PEER_HOST + port];
}

/**
 * The directives, in kit.csp's shape (keywords bare — SvelteKit quotes them).
 * @param {Record<string, string | undefined>} env @returns {Record<string, string[]> | null} null = no policy
 */
export function cspDirectives(env) {
	if (String(env.VITE_CSP ?? '').toLowerCase() === 'off') return null;
	const plugin = originOf(env.VITE_CLOUD_PLUGIN);
	const connect = env.VITE_CSP_CONNECT_SRC
		? list(env.VITE_CSP_CONNECT_SRC)
		: ['self', 'https:', 'wss:', 'blob:', 'data:', 'http://localhost:*', 'http://127.0.0.1:*', ...insecurePeer(env)];
	const media = env.VITE_CSP_IMG_SRC ? list(env.VITE_CSP_IMG_SRC) : ['self', 'data:', 'blob:', 'https:'];
	const uniq = (/** @type {string[]} */ a) => [...new Set(a.filter(Boolean))];
	return {
		'default-src': ['self'],
		'script-src': uniq(['self', 'wasm-unsafe-eval', 'blob:', plugin, ...list(env.VITE_CSP_SCRIPT_SRC)]),
		'worker-src': ['self', 'blob:'],
		// svelte transitions and style attributes are inline styles
		'style-src': ['self', 'unsafe-inline'],
		'img-src': media,
		'media-src': media,
		'font-src': ['self', 'data:'],
		'connect-src': uniq([...connect, plugin, ...list(env.VITE_CSP_EXTRA_CONNECT)]),
		'frame-src': ['self', 'https:'],
		'manifest-src': ['self'],
		'object-src': ['none'],
		'base-uri': ['self'],
		'form-action': ['self']
	};
}

/** the configured play origin ('' = none) @param {Record<string, string | undefined>} env */
export function playOrigin(env) {
	return originOf(env.VITE_PLAY_ORIGIN);
}

/** frame-ancestors for the app origin's header @param {Record<string, string | undefined>} env @returns {string[]} */
export function frameAncestors(env) {
	if (env.VITE_CSP_FRAME_ANCESTORS) return list(env.VITE_CSP_FRAME_ANCESTORS);
	return playOrigin(env) ? ['self'] : ['*'];
}

/** one directive set as header text (keywords quoted) @param {Record<string, string[]>} directives */
export function cspText(directives) {
	return Object.entries(directives)
		.map(([name, sources]) => [name, ...sources.map((s) => (KEYWORDS.has(s) ? `'${s}'` : s))].join(' '))
		.join('; ');
}
