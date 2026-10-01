// 31 K2 (U4): VR PANELS ARE NEVER OCCLUDED — a leaf (THREE only).
//
// The Quest report: "menu buttons during game covered by scene objects below untangle (like
// base/floor objects)". A VR panel is a mesh in the world like any other, so whatever stands
// between the eyes and it — Untangle's base, a floor tilted up by a world grab, a wall the
// board followed the head into — was drawn over its buttons, while the laser still reached
// them (a panel hit wins the press), so the player clicked buttons they could not see.
//
// THE CHOICE: a DEPTH CLEAR before the panels, rather than depthTest off on every panel
// material. Every panel mesh joins the TRANSPARENT list (three draws that last) at
// PANEL_ORDER, and one SENTINEL — a colourless, depth-less, never-culled mesh at
// PANEL_ORDER - 1 — clears the depth buffer in its onBeforeRender. So the panels draw over
// the finished scene but still depth-test AGAINST EACH OTHER: a panel's own layers (a
// backdrop, its buttons, their labels a few mm in front) keep their order, and a nearer
// panel covers a farther one, which a blanket depthTest:false would get wrong.
// BOTH EYES: without multiview three renders the left eye completely, then the right; a clear
// during the right eye's transparent pass touches a left half that is already finished. With
// multiview both views advance together, so they clear together. Hit tests are untouched —
// raycasting reads geometry, never materials or render order.
// The beam and its reticle join at BEAM_ORDER while they end ON a panel, so the pointer is
// seen on the button even when the floor is between the hand and the board.

/** the render order every panel mesh takes */
export const PANEL_ORDER = 5000;
/** the beam + reticle, while they end on a panel */
export const BEAM_ORDER = 5010;

/**
 * Put one panel tree into the overlay: transparent (so it draws after the whole scene) at
 * PANEL_ORDER. Idempotent and allocation-free; a material switched to transparent is flagged
 * for a program refresh once.
 * @param {any} root @returns {number} meshes touched
 */
export function overlayPanel(root) {
	if (!root) return 0;
	touched = 0;
	root.traverse(visit);
	return touched;
}
let touched = 0;
/** @param {any} node */
function visit(node) {
	const material = node.material;
	if (!material) return;
	node.renderOrder = PANEL_ORDER;
	if (Array.isArray(material)) for (const m of material) mark(m);
	else mark(material);
	touched++;
}
/** @param {any} m */
function mark(m) {
	if (!m || m.transparent) return;
	m.transparent = true;
	m.needsUpdate = true;
}

/**
 * The depth-clearing sentinel. `renderer` is read at draw time (the one drawing the frame).
 * @param {any} THREE_NS @returns {any} a Mesh to add at the scene root
 */
export function makeDepthSentinel(THREE_NS) {
	const geometry = new THREE_NS.BufferGeometry();
	// one degenerate triangle: something to draw (so onBeforeRender runs), nothing to see
	geometry.setAttribute('position', new THREE_NS.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
	const material = new THREE_NS.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, transparent: true });
	const sentinel = new THREE_NS.Mesh(geometry, material);
	sentinel.name = 'vr-panel-depth-clear';
	sentinel.frustumCulled = false;
	sentinel.renderOrder = PANEL_ORDER - 1;
	sentinel.userData.clears = 0;
	sentinel.onBeforeRender = (/** @type {any} */ renderer) => {
		renderer.clearDepth();
		sentinel.userData.clears++;
	};
	return sentinel;
}
