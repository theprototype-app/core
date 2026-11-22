// 54i (fix-batch-3 c): a WebGL create failure is ONE report whichever seam caught it, and the boot
// probe answers false when the browser hands out no WebGL 2 context.
import { describe, it, expect, vi } from 'vitest';
import { buildReport, WEBGL_CREATE_MSG } from '../../src/lib/errorReportCore.js';

vi.mock('../../src/lib/errorReports.js', () => ({ reportError: vi.fn() }));
const { probeWebGL2, reportNoWebGL } = await import('../../src/lib/webglSupport.js');
const { reportError } = await import('../../src/lib/errorReports.js');

const CTX = { origin: 'https://theprototype.app', release: '1.54.3', build: 'abc', device: 'desktop', browser: 'chrome 140', os: 'windows', gpu: 'none', area: 'boot', env: 'prod' };
const THREE_MSG = 'THREE.WebGLRenderer: Error creating WebGL context.';

describe('WebGL create failure reports', () => {
	it('the window error, the rejection and the boot probe share one signature', () => {
		const err = buildReport({ kind: 'error', message: THREE_MSG, stack: `Error: x\n    at Ue (https://theprototype.app/_app/immutable/chunks/a.js:1:200)` }, CTX);
		const rej = buildReport({ kind: 'rejection', message: THREE_MSG, stack: `Error: x\n    at start (https://theprototype.app/_app/immutable/entry/app.js:9:10)` }, CTX);
		const boot = buildReport({ kind: 'webgl', message: WEBGL_CREATE_MSG }, CTX);
		expect(err?.kind).toBe('webgl');
		expect(err?.msg).toBe(WEBGL_CREATE_MSG);
		expect(rej?.sig).toBe(err?.sig);
		expect(boot?.sig).toBe(err?.sig);
	});

	it('a lost context stays its own report', () => {
		const lost = buildReport({ kind: 'webgl', message: 'WebGL context lost' }, CTX);
		const boot = buildReport({ kind: 'webgl', message: WEBGL_CREATE_MSG }, CTX);
		expect(lost?.sig).not.toBe(boot?.sig);
	});
});

describe('probeWebGL2', () => {
	/** @param {any} ctx */
	const doc = (ctx) => /** @type {any} */ ({ createElement: () => ({ getContext: () => ctx }) });

	it('no context → false, a context → true (and it is released)', () => {
		expect(probeWebGL2(doc(null))).toBe(false);
		const lose = vi.fn();
		expect(probeWebGL2(doc({ getExtension: () => ({ loseContext: lose }) }))).toBe(true);
		expect(lose).toHaveBeenCalled();
	});

	it('a throwing getContext → false', () => {
		expect(probeWebGL2(/** @type {any} */ ({ createElement: () => ({ getContext: () => { throw new Error('blocked'); } }) }))).toBe(false);
	});

	it('reports once per page', () => {
		reportNoWebGL();
		reportNoWebGL();
		expect(reportError).toHaveBeenCalledTimes(1);
		expect(reportError).toHaveBeenCalledWith({ kind: 'webgl', message: WEBGL_CREATE_MSG });
	});
});
