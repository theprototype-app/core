// 54i (fix-batch-3 b): an opaque non-Error rejection ("Ma", iPad Chrome, no stack) must reach a
// report with its constructor name and a safe, size-capped JSON — and nothing personal.
import { describe, it, expect } from 'vitest';
import { describeReason, safeReasonJson, buildReport, MAX_REASON_JSON, MAX_REPORT_BYTES } from '../../src/lib/errorReportCore.js';

const CTX = { origin: 'https://theprototype.app', release: '1.54.3', build: 'abc', device: 'tablet', browser: 'chrome 140', os: 'ios 18', gpu: 'webgl2', area: 'edit', env: 'prod' };
/** @param {any} reason */
const reportOf = (reason) => buildReport({ kind: 'rejection', ...describeReason(reason) }, CTX);

describe('describeReason', () => {
	it('names a minified class instance and shows its fields', () => {
		class Ma {
			constructor() {
				this.code = 3;
				this.kind = 'peer-unavailable';
			}
		}
		const r = reportOf(new Ma());
		expect(r?.msg).toBe('Non-Error rejection (Ma): {"code":3,"kind":"peer-unavailable"}');
	});

	it('an Error keeps its message and stack untouched', () => {
		const e = new TypeError('boom');
		expect(describeReason(e)).toEqual({ message: 'boom', stack: e.stack });
	});

	it('an Error with no stack leads with its constructor name', () => {
		class Ma extends Error {}
		const e = new Ma('x failed');
		e.stack = undefined;
		expect(describeReason(e).message).toBe('Ma: x failed');
	});

	it('a string, a number and nothing at all are named by type', () => {
		expect(describeReason('Ma').message).toBe('Non-Error rejection (string): Ma');
		expect(describeReason(42).message).toBe('Non-Error rejection (number): 42');
		expect(describeReason(undefined).message).toBe('Non-Error rejection (undefined)');
		expect(reportOf(undefined)).not.toBeNull();
	});

	it('an Event-like reason keeps its type from the prototype', () => {
		class FakeEvent {
			get type() {
				return 'error';
			}
		}
		const proto = Object.create(FakeEvent.prototype);
		expect(describeReason(proto).message).toBe('Non-Error rejection (FakeEvent): {"type":"error"}');
	});

	it('leaks no personal data: long strings, urls with queries, emails, ids', () => {
		const r = reportOf({
			note: 'My secret house plan for the garden party next week',
			url: 'https://pb.theprototype.app/api?token=abc',
			who: 'a@b.co',
			peer: '3f2a9c1b8d7e6f50',
			name: 'My house'
		});
		const msg = String(r?.msg);
		expect(msg).not.toMatch(/secret|token=|a@b\.co|3f2a9c1b|My house/);
		expect(msg).toBe('Non-Error rejection (Object): {"note":"…","url":"…","who":"…","peer":"…","name":"…"}');
	});

	it('caps the JSON and survives cycles, deep nesting and throwing getters', () => {
		/** @type {any} */
		const o = { a: { b: { c: { d: 1 } } }, list: Array.from({ length: 50 }, (_, i) => i) };
		o.self = o;
		Object.defineProperty(o, 'bad', { enumerable: true, get() { throw new Error('no'); } });
		const json = safeReasonJson(o);
		expect(json.length).toBeLessThanOrEqual(MAX_REASON_JSON);
		expect(json).toContain('"self":"cycle"');
		expect(json).toContain('"b":"<Object>"');
		const big = Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['k' + i, 'v'.repeat(30)]));
		const r = reportOf(big);
		expect(JSON.stringify(r).length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
	});
});
