// 54i (fix-batch-3 c) — NO WEBGL AT BOOT.
//
// three's WebGLRenderer throws "Error creating WebGL context." when the browser refuses a WebGL 2
// context (hardware acceleration off, a blocklisted GPU, an old browser). Thrown inside threlte's
// <Canvas> during the first mount it took the whole app down (a blank page) and was reported TWICE
// (the window error + the start promise's rejection). App.svelte asks this probe first: no
// context → no <Canvas>, the NoWebGLScreen instead, and ONE `webgl` report. The reporter files
// every create failure under one signature (errorReportCore WEBGL_CREATE_RE), so a failure the
// probe did not foresee still dedupes to one.
import { reportError } from './errorReports.js';
import { WEBGL_CREATE_MSG } from './errorReportCore.js';

/** where the "what to try" section lives (docs PR #61, merged with 1.54.3) */
export const NO_WEBGL_DOCS = 'https://docs.theprototype.app/performance/#3d-view-does-not-start';

/**
 * Can this browser give us a WebGL 2 context (all three r163+ draws with)? The probe context is
 * released at once, so it never counts against the browser's context limit. SSR = yes.
 * @param {Document} [doc] @returns {boolean}
 */
export function probeWebGL2(doc = typeof document !== 'undefined' ? document : undefined) {
	if (!doc) return true;
	try {
		const canvas = doc.createElement('canvas');
		const gl = /** @type {WebGL2RenderingContext | null} */ (canvas.getContext('webgl2'));
		if (!gl) return false;
		try {
			gl.getExtension('WEBGL_lose_context')?.loseContext();
		} catch {
			/* releasing is a courtesy */
		}
		return true;
	} catch {
		return false;
	}
}

let reported = false;

/** report the missing context once per page */
export function reportNoWebGL() {
	if (reported) return;
	reported = true;
	reportError({ kind: 'webgl', message: WEBGL_CREATE_MSG });
}
