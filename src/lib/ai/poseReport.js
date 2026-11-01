// mcp-fix — the pose list_scene reports. While effects run, the object's own transform is one frame of the animation; an
// agent that copies that into update_objects bakes the animation into the base. So the top-level pose is the AUTHORED
// one, and what this frame shows is beside it. A leaf (imports nothing).

/** @param {number} n */
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * @param {any} object a THREE object
 * @param {{pos: number[], rot: number[], scale: number[], visible?: boolean} | null} base its authored pose under a running animation, or null
 * @returns {any} position, rotation, scale, visible, and when animated `animated: true` and (if this frame differs) `live`
 */
export function reportedPose(object, base) {
	const live = {
		position: object.position.toArray().map(r3),
		rotation: [r3(object.rotation.x), r3(object.rotation.y), r3(object.rotation.z)],
		scale: object.scale.toArray().map(r3),
		visible: object.visible !== false
	};
	if (!base) return live;
	const authored = {
		position: base.pos.map(r3),
		rotation: base.rot.map(r3),
		scale: base.scale.map(r3),
		visible: base.visible ?? live.visible
	};
	const differs = JSON.stringify(live) !== JSON.stringify(authored);
	return { ...authored, animated: true, ...(differs ? { live } : {}) };
}
