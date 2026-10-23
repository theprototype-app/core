// 59 T1/T2 — which objects get "Replace model…" and "Edit in Blender…". A LEAF (no imports), so
// the object menu and the Inspector can ask without pulling the replace machinery into the boot
// graph (modelReplace is reached by a dynamic import when a row is pressed).

/**
 * Can this object's model be replaced (and edited outside)? A model is anything with geometry in
 * it that is not one of the app's own records (a measurement, a camera marker, terrain, a spline,
 * water, a light) or a placeholder still loading (it has its own Replace).
 * @param {any} object
 */
export function isReplaceableModel(object) {
	if (!object || object.isLight) return false;
	const u = object.userData ?? {};
	if (u.measure || u.camera || u.terrain || u.spline || u.water || u.packStub) return false;
	let mesh = false;
	object.traverse?.((/** @type {any} */ o) => {
		if (o.isMesh) mesh = true;
	});
	return mesh;
}
