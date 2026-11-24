// 64-vector row 6 — the agent's way to VECTOR SHAPES: `create_vector`. No new connector tool name: the
// connector reaches it as create_shape {action: 'vector'} (tools/agent/src/catalog.js), the create_text /
// create_path precedent. Kinds: rect, ellipse, star, polygon (live corner radius), path (2D points in the
// shape's own plane, corners or a smooth curve), svg (SVG text, through the same untrusted-file gate as a
// dropped .svg). A shape is a flat mesh facing the camera (or `rotation`); edit it later with edit_shape
// {action: 'params'} (set_geometry: the same record keys). One undo step per call. Everything vector is a
// lazy import here: this module is reached by the AI tools only.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalCamera } from '../../stores/sceneStore';
import { AGENT_VECTOR_KINDS, vectorArgs } from '../vector/vectorAgentCore.js';

export const VECTOR_TOOL_NAMES = ['create_vector'];

const V3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

export const VECTOR_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'create_vector',
			description:
				'Add a flat VECTOR SHAPE (a 2D drawing standing in the scene: a logo, a sign, a decal-like panel, a star, a speech bubble): kind rect / ellipse (width, height), star (count points, radius, innerRatio), polygon (sides, radius); rect / star / polygon take a live corner radius. path = your own outline: vertices [[x, y], …] in metres in the shape\'s own plane around its position, closed (fills) or open (a line), smooth for a curve through them. svg = an SVG file as text (scripts, embedded HTML and external links are refused or taken out; up to 2 MB, 500 shapes). Colours: fill, stroke + strokeWidth, fill2 for a gradient (fillType linear or radial). depth > 0 extrudes it into a solid. It faces the camera unless rotation is given. Returns the uuid(s); change it later with set_geometry params (the same keys), combine shapes from the object menu (union, subtract).',
			parameters: {
				type: 'object',
				properties: {
					kind: { type: 'string', enum: AGENT_VECTOR_KINDS },
					width: { type: 'number', description: 'rect / ellipse, metres (default 1)' },
					height: { type: 'number', description: 'rect / ellipse, metres (default 1)' },
					radius: { type: 'number', description: 'star / polygon: outer radius, metres (default 0.5)' },
					count: { type: 'number', description: 'star: how many points (3..32, default 5)' },
					sides: { type: 'number', description: 'polygon: how many sides (3..32, default 6)' },
					innerRatio: { type: 'number', description: 'star: inner / outer radius (0.05..1, default 0.45)' },
					corner: { type: 'number', description: 'rect / star / polygon: corner radius in metres' },
					vertices: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: 'path: [[x, y], …] metres in the shape\'s plane' },
					closed: { type: 'boolean', description: 'path: join the last point to the first (it fills)' },
					smooth: { type: 'boolean', description: 'path: a smooth curve through the points (default corners)' },
					svg: { type: 'string', description: 'svg: the file\'s text' },
					fill: { type: 'string', description: 'hex #rrggbb' },
					fill2: { type: 'string', description: 'second gradient colour, hex' },
					fillType: { type: 'string', enum: ['solid', 'linear', 'radial', 'none'] },
					stroke: { type: 'string', description: 'outline colour, hex' },
					strokeWidth: { type: 'number', description: 'outline width in metres (0 = none)' },
					depth: { type: 'number', description: 'extrude into a solid this thick, metres (0 = flat)' },
					name: { type: 'string' },
					position: { ...V3, description: 'world point, metres (default 2 m in front of the camera)' },
					rotation: { ...V3, description: 'Euler radians (default: facing the camera, upright)' }
				},
				required: ['kind']
			}
		}
	}
];

export const VECTOR_PROMPT =
	'\nVector shapes: create_vector draws flat 2D shapes in the scene (rect, ellipse, star, polygon with a live corner radius, a path from 2D points, or an SVG file as text), filled, stroked or with a gradient, flat or extruded with depth; set_geometry params edits them.';

/** a world point -> objectsGroup frame @param {number[]} p */
function toGroup(p) {
	const group = /** @type {any} */ (get(objectsGroup));
	group.updateMatrixWorld(true);
	return group.worldToLocal(new THREE.Vector3(p[0], p[1], p[2]));
}

/** where it goes and how it faces: the given point / rotation, else 2 m ahead, upright, facing the camera @param {any} a */
function placement(a) {
	/** @type {any} */
	const camera = get(globalCamera);
	const given = Array.isArray(a.position) && a.position.length === 3 && a.position.every((/** @type {any} */ n) => Number.isFinite(n)) ? a.position : null;
	let world = given;
	if (!world) {
		const eye = camera?.getWorldPosition?.(new THREE.Vector3()) ?? new THREE.Vector3(0, 1.6, 4);
		const dir = camera?.getWorldDirection?.(new THREE.Vector3()) ?? new THREE.Vector3(0, 0, -1);
		dir.y = 0;
		if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
		world = eye.add(dir.normalize().multiplyScalar(2)).toArray();
	}
	const quaternion = new THREE.Quaternion();
	if (Array.isArray(a.rotation) && a.rotation.length === 3 && a.rotation.every((/** @type {any} */ n) => Number.isFinite(n))) {
		quaternion.setFromEuler(new THREE.Euler(a.rotation[0], a.rotation[1], a.rotation[2]));
	} else if (camera?.position) {
		const dx = camera.position.x - world[0];
		const dz = camera.position.z - world[2];
		if (Math.hypot(dx, dz) > 1e-6) quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz));
	}
	const group = /** @type {any} */ (get(objectsGroup));
	const local = group.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(quaternion);
	return { world, position: toGroup(world), quaternion: local };
}

/** @param {any} args */
async function createVectorTool(args) {
	const a = args ?? {};
	if (!get(objectsGroup)) return { error: 'the scene is not ready' };
	const r = vectorArgs(a);
	if ('error' in r) return { error: r.error };
	const at = placement(a);
	if ('svg' in r) {
		const svg = await import('../vector/vectorSvgActions.js');
		const { checkSvgText } = await import('../vector/vectorSvgSafety.js');
		const gate = checkSvgText(r.svg);
		if (!gate.ok) return { error: 'svg: ' + gate.reason };
		const uuids = svg.placeSvg(r.svg, { frame: { origin: at.world, quat: new THREE.Quaternion().copy(/** @type {any} */ (get(objectsGroup)).getWorldQuaternion(new THREE.Quaternion())).multiply(at.quaternion).toArray() } });
		if (!uuids.length) return { error: 'svg: no shapes could be read from it (see the message in the app)' };
		return { created: uuids.map((uuid) => ({ uuid })), ...(gate.stripped.length ? { note: 'taken out of the file: ' + gate.stripped.join(', ') } : {}), hint: 'One undo step for the whole drawing. Our own exports read back exactly.' };
	}
	const actions = await import('../vector/vectorActions.js');
	const mesh = actions.addVectorShape(r.params, { position: at.position, quaternion: at.quaternion, name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 80) : undefined });
	if (!mesh) return { error: 'could not add the shape' };
	return {
		created: { uuid: mesh.uuid, name: mesh.name, kind: r.params.kind },
		hint: 'Edit it with set_geometry params (width, height, radius, points, corner, fill, stroke, strokeWidth, depth, …). Booleans (union, subtract, intersect, exclude) are in the object menu under Shape.'
	};
}

/** @param {string} name @param {any} args */
export async function vectorTool(name, args) {
	if (name === 'create_vector') return createVectorTool(args);
	return { error: 'unknown vector tool ' + name };
}
