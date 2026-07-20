// Mesh-generation adapter registry (roadmap #11, G2). Every backend implements the
// SAME small async interface so meshJobs.js can drive any of them, and new backends
// (Tripo, Rodin, a dedicated TRELLIS service, ...) are one file each:
//
//   submit(config, {prompt, seed, image?})  -> ref            (opaque job handle)
//   poll(config, ref)                        -> {status, progress?, error?,
//                                                ref?, resultRef?}
//        status: 'running' | 'done' | 'error'; ref? updates the handle (for
//        multi-phase backends like Meshy preview->refine); resultRef locates the GLB
//   fetchResult(config, resultRef)           -> ArrayBuffer   (GLB bytes)
//
// Adapters never assume browser globals beyond fetch. CORS is the caller's concern
// (documented per backend).
import * as comfyui from './comfyui.js';
import * as meshy from './meshy.js';

/** @param {string} kind @returns {{submit: Function, poll: Function, fetchResult: Function}} */
export function adapterFor(kind) {
	if (kind === 'comfyui') return comfyui;
	if (kind === 'meshy') return meshy;
	throw new Error('no mesh adapter for kind "' + kind + '"');
}
