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

// 101 F3: the probe lives in the renderer seam now; re-exported so callers stay put
export { probeWebGL2 } from './render/webgl2Probe.js';

let reported = false;

/** report the missing context once per page */
export function reportNoWebGL() {
	if (reported) return;
	reported = true;
	reportError({ kind: 'webgl', message: WEBGL_CREATE_MSG });
}
