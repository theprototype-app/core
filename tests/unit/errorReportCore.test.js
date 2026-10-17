import { describe, it, expect } from 'vitest';
import {
	scrubMessage,
	ownFrames,
	signatureOf,
	browserOf,
	deviceClassOf,
	envOf,
	buildReport,
	ignoredMessage,
	looksLikeOom,
	MAX_REPORT_BYTES,
	MAX_FRAMES
} from '../../src/lib/errorReportCore.js';

// 48 O1 — the anonymity rule lives in these functions, so each part of it is held here: what a
// report may carry about the person who had it, and what it must never carry.

const ORIGIN = 'https://theprototype.app';
const CTX = { origin: ORIGIN, release: '1.39.0', build: 'abc1234', device: 'desktop', browser: 'chrome 141', os: 'windows', gpu: 'webgl2', area: 'edit', env: 'prod' };

describe('scrubMessage', () => {
	it('keeps the shape of a TypeError, with its property name', () => {
		expect(scrubMessage("Cannot read properties of undefined (reading 'position')")).toBe("Cannot read properties of undefined (reading 'position')");
	});
	it('drops quoted phrases (a scene or object name) but keeps identifiers', () => {
		expect(scrubMessage('Object "My secret house" not found')).toBe('Object "…" not found');
		expect(scrubMessage("Unknown node type 'kit-score-add'")).toBe("Unknown node type 'kit-score-add'");
	});
	it('drops URLs, emails, paths and ids', () => {
		const m = scrubMessage(
			'Failed to fetch https://cdn.theprototype.app/pbc_1/a1b2c3/file.glb?token=x for alice@example.com at /home/alice/scenes/x.tpscene peer 3f2504e0-4f89-11d3-9a0c-0305e82c3301 record a1b2c3d4e5f6g7h hash deadbeefcafe1234'
		);
		expect(m).not.toMatch(/cdn\.theprototype|alice|example\.com|home|3f2504e0|a1b2c3d4e5f6g7h|deadbeefcafe/);
		expect(m).toContain('<url>');
		expect(m).toContain('<email>');
		expect(m).toContain('<path>');
		expect(m).toContain('<id>');
	});
	it('keeps type names that carry digits (Float32Array, WebGL2RenderingContext)', () => {
		expect(scrubMessage('Float32Array length mismatch in WebGL2RenderingContext')).toBe('Float32Array length mismatch in WebGL2RenderingContext');
	});
	it('folds long numbers so one bug does not split into many', () => {
		expect(scrubMessage('Offset 123456 is outside 4096')).toBe('Offset <n> is outside <n>');
		expect(scrubMessage('Offset 12 is outside 40')).toBe('Offset 12 is outside 40');
	});
	it('caps the length', () => {
		expect(scrubMessage('x '.repeat(400)).length).toBeLessThanOrEqual(200);
	});
});

describe('ownFrames', () => {
	const v8 = [
		'TypeError: boom',
		'    at applyMeshGeo (https://theprototype.app/_app/immutable/chunks/Ab12.js?v=3:10:200)',
		'    at chrome-extension://abcdef/content.js:1:1',
		'    at https://cdn.example.com/lib.js:5:6',
		'    at async Object.load (https://theprototype.app/_app/immutable/nodes/2.js:7:8)'
	].join('\n');
	it('keeps only frames from our origin, with the origin and query stripped', () => {
		expect(ownFrames(v8, ORIGIN)).toEqual(['applyMeshGeo@/_app/immutable/chunks/Ab12.js:10:200', 'Object.load@/_app/immutable/nodes/2.js:7:8']);
	});
	it('reads the SpiderMonkey/JSC shape too', () => {
		expect(ownFrames('tick@https://theprototype.app/_app/x.js:3:4\n@https://theprototype.app/_app/y.js:1:2', ORIGIN)).toEqual(['tick@/_app/x.js:3:4', '/_app/y.js:1:2']);
	});
	it('drops blob: frames (a module the person installed is not our code)', () => {
		expect(ownFrames('at run (blob:https://theprototype.app/1234-5678:3:4)', ORIGIN)).toEqual([]);
	});
	it('caps the frame count', () => {
		const deep = Array.from({ length: 20 }, (_, i) => `    at f${i} (${ORIGIN}/a.js:${i + 1}:1)`).join('\n');
		expect(ownFrames(deep, ORIGIN)).toHaveLength(MAX_FRAMES);
	});
});

describe('signatureOf', () => {
	it('ignores the column, so one release groups its builds', () => {
		const a = signatureOf({ kind: 'error', msg: 'x', frames: ['f@/a.js:10:200'] });
		const b = signatureOf({ kind: 'error', msg: 'x', frames: ['f@/a.js:10:999'] });
		const c = signatureOf({ kind: 'error', msg: 'x', frames: ['f@/a.js:11:200'] });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe('browserOf / deviceClassOf / envOf', () => {
	it('names family + major only', () => {
		expect(browserOf('Mozilla/5.0 (Linux; Android 16; CPH2671) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.122 Mobile Safari/537.36')).toEqual({ browser: 'chrome 141', os: 'android 16' });
		expect(browserOf('Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/40.1.0.12 Chrome/138.0 VR Safari/537.36').browser).toBe('oculus 40');
		expect(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'safari 18', os: 'ios 18' });
		expect(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0')).toEqual({ browser: 'firefox 143', os: 'windows' });
	});
	it('classes the device', () => {
		expect(deviceClassOf({ ua: 'OculusBrowser/40 Quest 3', coarse: true, minSide: 1000 })).toBe('headset');
		expect(deviceClassOf({ ua: 'Android 16 Mobile', coarse: true, minSide: 390 })).toBe('phone');
		expect(deviceClassOf({ ua: 'Android 16', coarse: true, minSide: 800 })).toBe('tablet');
		expect(deviceClassOf({ ua: 'Windows NT 10.0', coarse: false, minSide: 1080 })).toBe('desktop');
	});
	it('tells production from previews and dev', () => {
		expect(envOf('theprototype.app')).toBe('prod');
		expect(envOf('theprototype.pages.dev')).toBe('prod');
		expect(envOf('preview-1-39.theprototype.pages.dev')).toBe('preview');
		expect(envOf('localhost')).toBe('dev');
	});
});

describe('buildReport', () => {
	it('carries exactly the agreed fields and nothing personal', () => {
		const r = buildReport({ kind: 'error', message: 'Scene "Alice\'s castle" failed', stack: `at x (${ORIGIN}/a.js:1:2)` }, CTX);
		expect(Object.keys(r ?? {}).sort()).toEqual(['area', 'browser', 'build', 'device', 'env', 'frames', 'gpu', 'kind', 'msg', 'os', 'release', 'sig', 'v']);
		expect(JSON.stringify(r)).not.toMatch(/Alice|castle/);
	});
	it('drops noise and other origins’ errors', () => {
		expect(ignoredMessage('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
		expect(buildReport({ kind: 'error', message: 'ResizeObserver loop limit exceeded' }, CTX)).toBe(null);
		expect(buildReport({ kind: 'error', message: 'x is not defined', stack: 'at y (chrome-extension://a/b.js:1:1)', filename: 'chrome-extension://a/b.js' }, CTX)).toBe(null);
	});
	it('names out-of-memory as its own kind', () => {
		expect(looksLikeOom('RangeError: Array buffer allocation failed')).toBe(true);
		expect(buildReport({ kind: 'rejection', message: 'Array buffer allocation failed' }, CTX)?.kind).toBe('oom');
	});
	it('keeps webgl/crash reports that have no stack', () => {
		expect(buildReport({ kind: 'webgl', message: 'WebGL context lost' }, CTX)?.kind).toBe('webgl');
		expect(buildReport({ kind: 'crash', message: 'The tab ended' }, CTX)?.frames).toEqual([]);
	});
	it('stays under the size cap', () => {
		const stack = Array.from({ length: 5 }, (_, i) => `at ${'f'.repeat(40)}${i} (${ORIGIN}/${'p/'.repeat(200)}a.js:1:1)`).join('\n');
		const r = buildReport({ kind: 'error', message: 'big', stack }, CTX);
		expect(JSON.stringify(r).length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
		expect(r?.frames.length).toBeGreaterThan(0);
	});
});
