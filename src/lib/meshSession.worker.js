// Roadmap 99 K3: the edit session's kernel build, off the main thread (meshSession.js
// `buildSessionKernel`). In: the geometry's import arrays + the weld. Out: the kernel as
// transferable typed arrays (`toTransfer`) and its ID maps (`triFace`, `cornerVertex`).
import { MeshKernel, fromArrays, toArrays } from './meshKernel/index.js';

self.onmessage = (event) => {
	const { id, arrays, weld } = event.data ?? {};
	const t0 = performance.now();
	try {
		const { mesh } = fromArrays(arrays, { weld });
		const out = toArrays(mesh);
		const packed = mesh.toTransfer();
		const ms = performance.now() - t0;
		/** @type {Set<any>} */
		const transfer = new Set(MeshKernel.transferList(packed));
		transfer.add(out.triFace.buffer);
		transfer.add(out.cornerVertex.buffer);
		/** @type {any} */ (self).postMessage(
			{ id, packed, triFace: out.triFace, cornerVertex: out.cornerVertex, ms },
			[...transfer]
		);
	} catch (error) {
		self.postMessage({ id, error: String(/** @type {any} */ (error)?.message ?? error) });
	}
};
