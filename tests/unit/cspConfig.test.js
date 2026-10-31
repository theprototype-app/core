import { describe, it, expect } from 'vitest';
import { cspDirectives, frameAncestors, cspText, playOrigin } from '../../csp.config.js';
import { originOf } from '../../src/lib/playOrigin.js';

// 69 T3/T4: the policy a build ships, and the knobs a deployment turns.

describe('csp.config', () => {
	it('defaults: strict script-src (no eval, no inline), wasm allowed, open https connect', () => {
		const d = /** @type {Record<string, string[]>} */ (cspDirectives({}));
		expect(d['script-src']).toEqual(['self', 'wasm-unsafe-eval', 'blob:']);
		expect(d['script-src']).not.toContain('unsafe-eval');
		expect(d['script-src']).not.toContain('unsafe-inline');
		expect(d['connect-src']).toEqual(expect.arrayContaining(['self', 'https:', 'wss:']));
		expect(d['object-src']).toEqual(['none']);
		expect(cspText({ 'script-src': d['script-src'] })).toBe("script-src 'self' 'wasm-unsafe-eval' blob:");
	});

	it('the env extends or replaces; the cloud plugin and an insecure peer server are allowed', () => {
		const d = /** @type {Record<string, string[]>} */ (
			cspDirectives({
				VITE_CLOUD_PLUGIN: 'https://cloud.example/plugin.js?v=3',
				VITE_CSP_SCRIPT_SRC: "https://beacon.example 'self'",
				VITE_CSP_CONNECT_SRC: 'self https://api.example',
				VITE_PEER_SECURE: 'false',
				VITE_PEER_HOST: '10.0.0.5',
				VITE_PEER_PORT: '9000'
			})
		);
		expect(d['script-src']).toEqual(['self', 'wasm-unsafe-eval', 'blob:', 'https://cloud.example', 'https://beacon.example']);
		expect(d['connect-src']).toEqual(['self', 'https://api.example', 'https://cloud.example']);
		const lan = /** @type {Record<string, string[]>} */ (cspDirectives({ VITE_PEER_SECURE: 'false', VITE_PEER_HOST: '10.0.0.5', VITE_PEER_PORT: '9000' }));
		expect(lan['connect-src']).toContain('ws://10.0.0.5:9000');
		expect(cspDirectives({ VITE_CSP: 'off' })).toBeNull();
	});

	it('frame-ancestors: open while play is on this origin, self once a play origin exists', () => {
		expect(frameAncestors({})).toEqual(['*']);
		expect(frameAncestors({ VITE_PLAY_ORIGIN: 'https://play.example/x' })).toEqual(['self']);
		expect(playOrigin({ VITE_PLAY_ORIGIN: 'https://play.example/x' })).toBe('https://play.example');
		expect(frameAncestors({ VITE_PLAY_ORIGIN: 'https://play.example', VITE_CSP_FRAME_ANCESTORS: 'https://a.example' })).toEqual(['https://a.example']);
		expect(originOf('javascript:alert(1)')).toBe('');
		expect(originOf('not a url')).toBe('');
	});
});
