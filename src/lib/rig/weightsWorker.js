// 57 M6 — the automatic-weights WORKER: weightsCore's heat diffusion off the main thread (a dense
// character is seconds of diffusion). One message each way, keyed by `id`:
//   in:  {id, op: 'heat'|'smooth', positions, index, bones?, joints?, weights?, steps?}
//   out: {id, joints, weights} | {id, error}     (typed arrays transferred)
import { heatWeights, smoothWeights } from './weightsCore.js';

self.onmessage = (/** @type {MessageEvent} */ event) => {
	const d = event.data ?? {};
	try {
		const mesh = { positions: d.positions, index: d.index ?? null };
		const out =
			d.op === 'smooth'
				? smoothWeights(mesh, d.joints, d.weights, { steps: d.steps })
				: heatWeights(mesh, d.bones, { steps: d.steps });
		/** @type {any} */ (self).postMessage({ id: d.id, joints: out.joints, weights: out.weights }, [
			out.joints.buffer,
			out.weights.buffer
		]);
	} catch (error) {
		/** @type {any} */ (self).postMessage({
			id: d.id,
			error: String(/** @type {any} */ (error)?.message ?? error)
		});
	}
};
