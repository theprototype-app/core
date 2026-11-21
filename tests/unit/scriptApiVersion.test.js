// 2.0-n3c (planner Q3): the script api's contract number. Scripts probe `(api.version ?? 1) >= 2` for self() / stamp();
// the host api (flowRuntime.scriptApi) and the sandbox guest's api (sandbox/scripts.js) must say the same number.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCRIPT_API_VERSION } from '../../src/lib/scriptIO.js';

const GUEST = readFileSync(new URL('../../src/lib/sandbox/scripts.js', import.meta.url), 'utf8');
const HOST = readFileSync(new URL('../../src/lib/flowRuntime.js', import.meta.url), 'utf8');

describe('script api version', () => {
	test('is 2: self() and stamp() exist', () => {
		expect(SCRIPT_API_VERSION).toBe(2);
	});
	test('the sandbox guest api carries the same literal, beside self and stamp', () => {
		const api = GUEST.slice(GUEST.indexOf('const api = Object.freeze({'), GUEST.indexOf('});', GUEST.indexOf('const api = Object.freeze({')));
		expect(api).toMatch(new RegExp('version: ' + SCRIPT_API_VERSION + ','));
		expect(api).toMatch(/\bself: \(\) =>/);
		expect(api).toMatch(/\bstamp: \(input\) =>/);
	});
	test('the host api publishes the constant', () => {
		const api = HOST.slice(HOST.indexOf('export function scriptApi('), HOST.indexOf('export function scriptApi(') + 600);
		expect(api).toMatch(/version: SCRIPT_API_VERSION/);
	});
});
