// 99 K3: the edit session's DATA, a leaf (imports nothing) so faceEdit and meshEdit can read it at
// module evaluation whatever order the history import cycle evaluates them in. The lifecycle lives in
// editSession.js.

/**
 * 99 K3: THE mesh edit session — one object for vertex mode AND face mode (they used to keep
 * the same facts in two sets of module globals). Each mode keeps its working state in its own
 * part (`face` / `vertex`, owned and reset by that mode's enter/exit exactly as the globals were);
 * the shared part lives from the first enter on an object until the history session seals
 * (`openSession` / `closeSession` below): the entry arrays, whether anything was edited, the
 * kernel and the selection as element IDs.
 *
 * `face.frame` / `face.faces` / `face.quadPartner` are VIEWS of the live geometry the face mode rebuilds on a
 * geometry swap (`rebuildFaces`); 99 K5 removed the triangle soup: every reader runs on the frame, and a live
 * edit (grab, adjust scrub) writes into the geometry the frame reads in place.
 */
export const session = {
	/** @type {string|null} the uuid the shared part belongs to */
	uuid: null,
	/** @type {any} the edited object (either mode) */
	object: null,
	/** @type {any} the geometry's arrays at entry (meshSessionState.captureEntry), re-emitted on a leave with no edit */
	entry: null,
	/** any geometry swap on the object since the session opened */
	edited: false,
	/** @type {any} the kernel (built lazily after entry), or null */
	kernel: null,
	/** @type {any} the kernel's ID maps for the geometry it was built from, or null */
	kernelMaps: null,
	/** @type {{ faces: number[], verts: number[], edges: [number, number][] }} the last stashed selection, as element IDs */
	selection: { faces: [], verts: [], edges: [] },
	/** @type {any} 99 K4: what `kernelMaps` were built from when an operator (not the entry) set them: a
	 * captureEntry snapshot of that geometry; null = the entry */
	kernelStamp: null,
	/** @type {any} 99 K4: the lazy kernel operators (`meshOps/index.js`) once loaded; shared by every session */
	ops: null,
	/** @type {any} 99 K4: the op mesh of the live geometry, kept across operators:
	 * `{ geometry, stamp, topo, partner, om }` — valid while the geometry, its stored partition and the quad
	 * pairing are the ones it was built for */
	opMesh: null,
	/** 99 K4: element IDs a geometry was applied with (an undo / redo of a kernel op's entry): the next op
	 * rebuilds with them, so IDs survive the round trip — `{ ids, stamp }`, valid while the geometry is unwritten
	 * since @type {WeakMap<object, any>} */
	geometryIds: new WeakMap(),
	face: {
		/** @type {any} the face-mode object (null outside face mode) */
		object: null,
		/** @type {import('./triFrame').TriFrame} 99 K5: the live geometry's triangles as flat arrays (triFrame.js), what
		 * every session reader runs on; rebuilt on a geometry swap, read in place during a live edit */
		frame: { count: 0, P: new Float32Array(0), M: null, UV: null, V: new Int32Array(0), nV: 0, geometry: null, live: false },
		/** @type {any[]} adapter (K4 input): coplanar+adjacent face groups */
		faces: [],
		/** adapter (K4 input): quad pairing over the frame — quadPartner[i] is i's mate, or -1
		 * @type {Int32Array} */
		quadPartner: new Int32Array(0),
		/** @type {any} highlighted-face tint at the scene root (= overlayParts.sel) */
		overlay: null,
		/** SELECTION and HOVER overlay meshes (indexed by part name) @type {Record<string, any>} */
		overlayParts: { sel: null, hover: null },
		/** @type {any} rigid face-grab state */
		grab: null,
		/** @type {any} the live op adjust (19-A P2) */
		adjust: null,
		/** @type {any} desktop gizmo proxy (163) */
		proxy: null,
		/** @type {any} */
		proxyStart: null,
		/** @type {any} the op target the gizmo was seated on */
		gizmoTarget: null
	},
	vertex: {
		/** @type {any} the vertex-mode object (null outside vertex mode) */
		object: null,
		/** @type {{indices: number[], position: any}[]} one handle per welded vertex */
		handles: [],
		/** @type {any} InstancedMesh of vertex handles */
		handleMesh: null,
		/** @type {any} wireframe overlay child */
		overlay: null,
		/** @type {any} gizmo target for the selected handle */
		proxy: null,
		selectedHandle: -1,
		/** @type {Set<number>} the multi-selection (handle indices) */
		selection: new Set(),
		/** @type {any} an open gizmo drag */
		proxyGesture: null
	}
};
