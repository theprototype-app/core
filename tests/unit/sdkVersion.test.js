// 101 F6: the module api carries its contract number. A module probes `(api.version ?? 1) >= 2`;
// the number lives in ONE place (sdk/core.js) and the table re-exports it.
import { describe, test, expect } from 'vitest';
import { sdkCore, SDK_API_VERSION } from '../../src/lib/sdk/core.js';
import { SDK_API_VERSION as fromIndex, SDK_TABLE } from '../../src/lib/sdk/index.js';

describe('module api version (101 F6)', () => {
	test('is 2, from one constant', () => {
		expect(SDK_API_VERSION).toBe(2);
		expect(fromIndex).toBe(SDK_API_VERSION);
	});
	test('the core slice publishes it as a plain value', () => {
		const slice = /** @type {any} */ (sdkCore(/** @type {any} */ ({ moduleId: 'm', moduleName: 'm' })));
		expect(slice.version).toBe(2);
		expect(/** @type {any} */ (sdkCore).surface.version).toBe('value');
		expect(SDK_TABLE.some(([name]) => name === 'core')).toBe(true);
	});
});
