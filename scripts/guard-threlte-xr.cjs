// 54i (fix-batch-3 a) — guard @threlte/xr's per-frame tasks against a NULL XR frame.
//
// Quest 1.49 error report: "Cannot read properties of null (reading 'getViewerPose')". @threlte/xr
// 1.6's headset task (internal/setupHeadset.svelte.js) runs while ITS `isPresenting` is true and
// calls `xr.getFrame().getViewerPose(space)` unguarded; three's WebXRManager only holds a frame
// INSIDE an XR animation frame (getFrame() is null after the session ends / between frames), so a
// task run outside one throws every frame until threlte notices the end. useHitTest has the same
// shape. Rewritten at TRANSFORM time (vite.config.ts `guardThrelteXr`, build + dev — @threlte/xr is
// served as source so the transform reaches it): no frame → no pose / no hits → the task skips.
// An anchor that no longer matches (a threlte upgrade) is a loud warning, never a silent no-op.

/** @type {{file: RegExp, from: string, to: string}[]} */
const SUBS = [
	{
		file: /internal\/setupHeadset\.svelte\.js$/,
		from: 'const pose = xr.getFrame().getViewerPose(space);',
		to: 'const pose = xr.getFrame()?.getViewerPose(space);'
	},
	{
		file: /hooks\/useHitTest\.svelte\.js$/,
		from: 'const [hit] = xr.getFrame().getHitTestResults(hitTestSource);',
		to: 'const [hit] = xr.getFrame()?.getHitTestResults(hitTestSource) ?? [];'
	}
];

/**
 * The guarded source for one module id, or null when the id is not a guarded file.
 * @param {string} code @param {string} id
 * @returns {{code: string, missing: string[]} | null}
 */
function guardThrelteXrSource(code, id) {
	const norm = String(id).replace(/\\/g, '/').replace(/\?.*$/, '');
	if (!norm.includes('@threlte/xr/')) return null;
	const subs = SUBS.filter((s) => s.file.test(norm));
	if (!subs.length) return null;
	let out = code;
	/** @type {string[]} */
	const missing = [];
	for (const s of subs) {
		if (out.includes(s.from)) out = out.split(s.from).join(s.to);
		else if (!out.includes(s.to)) missing.push(s.from);
	}
	return { code: out, missing };
}

module.exports = { guardThrelteXrSource, SUBS };
