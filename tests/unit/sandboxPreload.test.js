import { describe, it, expect } from 'vitest';
import { payloadCarriesCode, preloadSandboxFor } from '../../src/lib/sandbox/preload.js';
import { sandboxReady } from '../../src/lib/sandbox/engine.js';
import { BUILTIN_CODE } from '../../src/lib/builtinCode.js';

// 69: the guest engine starts loading with a scene that carries code, and only then.

const builtinType = Object.keys(BUILTIN_CODE)[0];

describe('payloadCarriesCode', () => {
	it('finds code nodes in every graph, legacy scene nodes too', () => {
		expect(
			payloadCarriesCode({
				graphs: { scene: { nodes: [{ type: 'box' }] }, abc: { nodes: [{ type: 'behaviour' }] } }
			})
		).toBe(true);
		expect(payloadCarriesCode({ nodes: [{ type: 'script', data: { code: 'x' } }] })).toBe(true);
		expect(payloadCarriesCode({ graphs: { scene: { nodes: [{ type: 'customnode' }] } } })).toBe(
			true
		);
	});
	it('counts built-in code only when it is not the template', () => {
		const template = BUILTIN_CODE[builtinType].template;
		expect(payloadCarriesCode({ nodes: [{ type: builtinType, data: { code: template } }] })).toBe(
			false
		);
		expect(
			payloadCarriesCode({ nodes: [{ type: builtinType, data: { code: 'return { speed: 2 };' } }] })
		).toBe(true);
	});
	it('finds a Custom (code) HUD element in a saved hud map or a huds snapshot', () => {
		const doc = {
			screens: [
				{
					id: 'main',
					elements: [{ kind: 'text' }, { kind: 'custom', code: 'container.textContent = 1;' }]
				}
			]
		};
		expect(payloadCarriesCode({ hud: { scene: doc } })).toBe(true);
		expect(payloadCarriesCode({ type: 'huds', huds: { scene: doc } })).toBe(true);
		expect(
			payloadCarriesCode({
				hud: { scene: { screens: [{ elements: [{ kind: 'custom', code: '  ' }] }] } }
			})
		).toBe(false);
	});
	it('a scene without code needs no engine', () => {
		expect(payloadCarriesCode(null)).toBe(false);
		expect(
			payloadCarriesCode({
				name: 'x',
				objects: [{}],
				graphs: { scene: { nodes: [{ type: 'spin' }] } },
				hud: {}
			})
		).toBe(false);
		expect(preloadSandboxFor({ name: 'plain', graphs: { scene: { nodes: [] } } })).toBe(false);
		expect(sandboxReady()).toBe(false);
	});
});
