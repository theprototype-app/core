// 102-int-2: objects that draw nothing of their own. A decal and a Gaussian splat are
// CARRIERS: the mesh in the scene is a placeholder or an invisible proxy box, and what you see is
// rebuilt from its record (userData.decal / splat). Painting, simplifying or exporting
// the carrier's own geometry changes nothing you see (and a print would get a box or a sheet), so
// those tools skip or refuse carriers through this one leaf (no imports: it is safe on the boot).

/** 'decal' | 'splat' | '' @param {any} o @returns {string} */
export function carrierKindOf(o) {
	const u = o?.userData;
	if (!u) return '';
	if (u.decal && typeof u.decal === 'object') return 'decal';
	if (u.splat && typeof u.splat === 'object') return 'splat';
	return '';
}

/** @param {any} o */
export const isProxyCarrier = (o) => carrierKindOf(o) !== '';

/** what Paint says when it is pointed at a carrier ('' = not one) @param {any} o @param {string} doing e.g. 'paint' */
export function carrierRefusal(o, doing) {
	const kind = carrierKindOf(o);
	if (kind === 'decal') return 'A decal has no surface of its own to ' + doing + ' — change it in Properties ▸ Decal, or ' + doing + ' the object under it.';
	if (kind === 'splat') return 'A Gaussian splat is not a mesh, so there is no surface to ' + doing + '.';
	return '';
}
