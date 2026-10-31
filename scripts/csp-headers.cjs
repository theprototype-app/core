#!/usr/bin/env node
// 69 T3 — build/_headers: the response headers a static host should send with the build.
//
// The Content-Security-Policy itself is in every page's <meta> (svelte.config.js → kit.csp, with the
// hash of SvelteKit's inline boot script). A meta policy cannot carry `frame-ancestors`, so that one
// directive goes here, as a header, beside two plain hardening headers. Cloudflare Pages reads
// `_headers` as is; any other server can send the same lines (the docs' self-hosting page says how).
// The header holds ONLY frame-ancestors on purpose: policies are intersected, and repeating the meta
// policy here without the boot-script hash would block the app.
//
//   node scripts/csp-headers.cjs [buildDir]     (default ./build; runs in postbuild)
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.resolve(process.argv[2] || path.join(ROOT, 'build'));

(async () => {
	const { loadEnv } = await import('vite');
	const { frameAncestors, cspText, cspDirectives, playOrigin } = await import(path.join(ROOT, 'csp.config.js'));
	const env = { ...loadEnv(process.env.MODE || 'production', ROOT, 'VITE_'), ...process.env };
	const lines = ['/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin'];
	if (cspDirectives(env)) {
		lines.push('  Content-Security-Policy: ' + cspText({ 'frame-ancestors': frameAncestors(env) }));
		// 69 T4: ONE build serves both origins. The play origin is what embeds frame, so there the
		// app-origin rule above is detached (`!`) and any site may frame it.
		const play = playOrigin(env);
		if (play && !env.VITE_CSP_FRAME_ANCESTORS)
			lines.push(play + '/*', '  ! Content-Security-Policy', '  Content-Security-Policy: ' + cspText({ 'frame-ancestors': ['*'] }));
	}
	fs.writeFileSync(path.join(BUILD, '_headers'), lines.join('\n') + '\n');
	console.log('csp-headers: wrote ' + path.relative(ROOT, path.join(BUILD, '_headers')));
})().catch((error) => {
	console.error('csp-headers:', error);
	process.exit(1);
});
