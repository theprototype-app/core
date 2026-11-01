// 59 T7c — SANITY CHECKS when a model is replaced from a file. A LEAF: plain numbers in, issues out.
//
// The three ways a round trip through another tool most often goes wrong, each found by comparing
// the new file with the model it replaces (a replace is the one moment the app holds both):
//   · SCALE: the new model is ~100× bigger or smaller — the centimetre/metre mix-up, mostly FBX.
//     Flagged from ~30× (log10 ≥ 1.5); the fix is the nearest power of ten back.
//   · Z-UP: the new model's box is the old one's with Y and Z swapped — it was exported Z-up and is
//     lying on its back. The fix turns it −90° about X (+Z becomes +Y), which is what Blender's
//     "+Y Up" export setting would have done.
//   · UNAPPLIED TRANSFORMS: a root node of the file still carries a scale, or every root node the
//     same quarter turn about X — the object-level transform the tool was meant to apply before
//     export (Blender: Ctrl+A ▸ All Transforms). Invisible on its own, it is what makes the next
//     tool, a collider fit or a retarget see the wrong numbers. The fix bakes it into the geometry
//     (a static model only — a rig's bind pose cannot be re-baked here).
// Each issue carries its one-click fix; `fixMatrix` folds the scale and Z-up fixes into one matrix
// premultiplied onto the file's root nodes.

/** how far apart two boxes' proportions are: Σ|ln| over axes, sizes normalized to their largest
 * @param {number[]} a @param {number[]} b */
function shapeDistance(a, b) {
	const ma = Math.max(...a) || 1;
	const mb = Math.max(...b) || 1;
	let d = 0;
	for (let i = 0; i < 3; i++) d += Math.abs(Math.log((a[i] / ma + 0.05) / (b[i] / mb + 0.05)));
	return d;
}

/** a quaternion (xyzw) that is a quarter turn about ±X, within a degree @param {number[]} q */
function quarterTurnX(q) {
	if (!Array.isArray(q) || q.length < 4) return 0;
	const [x, y, z, w] = q;
	const angle = 2 * Math.acos(Math.min(1, Math.abs(w)));
	const s = Math.sqrt(Math.max(0, 1 - w * w)) || 1;
	const axisX = Math.abs(x / s);
	if (Math.abs(angle - Math.PI / 2) > Math.PI / 180 || axisX < 0.999 || Math.abs(y) + Math.abs(z) > 0.02) return 0;
	return Math.sign(x * w) || 1;
}

/**
 * @typedef {{kind: 'scale', factor: number, ratio: number, message: string, fixLabel: string, fixable: boolean}
 *   | {kind: 'zup', message: string, fixLabel: string, fixable: boolean}
 *   | {kind: 'transforms', message: string, fixLabel: string, fixable: boolean}} SanityIssue
 */

/**
 * What looks wrong with the new model. PURE.
 * @param {{oldSize?: number[] | null, newSize: number[], topNodes?: {scale?: number[], quaternion?: number[]}[],
 *   canTransform?: boolean, canBake?: boolean}} input
 *   `canTransform`: the scale/Z-up fix can be applied (a static tree, or a GLB's bytes);
 *   `canBake`: the transforms can be baked into the geometry (a static tree only)
 * @returns {SanityIssue[]}
 */
export function sanityIssues(input) {
	/** @type {SanityIssue[]} */
	const issues = [];
	const newSize = input.newSize ?? [0, 0, 0];
	const oldSize = input.oldSize ?? null;
	const canTransform = input.canTransform !== false;
	const newMax = Math.max(...newSize);
	const oldMax = oldSize ? Math.max(...oldSize) : 0;
	if (oldSize && newMax > 0 && oldMax > 0) {
		const ratio = newMax / oldMax;
		const log = Math.log10(ratio);
		if (Math.abs(log) >= 1.5) {
			const factor = Math.pow(10, -Math.round(log));
			const times = Math.round(ratio >= 1 ? ratio : 1 / ratio);
			issues.push({
				kind: 'scale',
				factor,
				ratio,
				message:
					'It is about ' + times.toLocaleString('en-US') + '× ' + (ratio >= 1 ? 'larger' : 'smaller') +
					' than the model it replaces — a centimetre/metre mix-up?',
				fixLabel: 'Scale by ' + factor,
				fixable: canTransform
			});
		}
		const straight = shapeDistance(newSize, oldSize);
		const swapped = shapeDistance([newSize[0], newSize[2], newSize[1]], oldSize);
		if (straight > 0.7 && swapped < straight * 0.5) {
			issues.push({
				kind: 'zup',
				message: 'It is lying on its side — exported Z-up? (Blender: tick "+Y Up")',
				fixLabel: 'Stand it up',
				fixable: canTransform
			});
		}
	}
	const tops = input.topNodes ?? [];
	const scaled = tops.some((n) => (n.scale ?? [1, 1, 1]).some((s) => Math.abs(Math.abs(s) - 1) > 0.01));
	const turned = tops.length > 0 && tops.every((n) => quarterTurnX(n.quaternion ?? [0, 0, 0, 1]) !== 0);
	if (scaled || turned) {
		issues.push({
			kind: 'transforms',
			message:
				'Its transforms were not applied (' + [scaled ? 'a scale' : '', turned ? 'a quarter turn' : ''].filter(Boolean).join(' and ') +
				' on the root) — Blender: Ctrl+A ▸ All Transforms before exporting',
			fixLabel: 'Apply transforms',
			fixable: !!input.canBake
		});
	}
	return issues;
}

/**
 * The scale + Z-up fixes as ONE column-major matrix (glTF's layout and three's `elements`), or
 * null when neither applies. The rotation is applied after the scale (both are about the origin,
 * and a uniform scale commutes with a rotation anyway).
 * @param {SanityIssue[]} issues @returns {number[] | null}
 */
export function fixMatrix(issues) {
	const scale = issues.find((i) => i.kind === 'scale' && i.fixable);
	const zup = issues.some((i) => i.kind === 'zup' && i.fixable);
	if (!scale && !zup) return null;
	const f = scale && scale.kind === 'scale' ? scale.factor : 1;
	// Rx(−90°): y' = z, z' = −y
	return zup ? [f, 0, 0, 0, 0, 0, -f, 0, 0, f, 0, 0, 0, 0, 0, 1] : [f, 0, 0, 0, 0, f, 0, 0, 0, 0, f, 0, 0, 0, 0, 1];
}
