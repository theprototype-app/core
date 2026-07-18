// Geometry parameter registry (phase 78): for every primitive, the constructor
// args as typed UI specs. `order` mirrors the three.js constructor signature —
// rebuilds call new THREE[type+'Geometry'](...order.map(k => params[k])).
// Only serializable numeric/boolean params live here; Lathe/Tube keep their
// default profile curves (quiz: fixed presets).

const TAU = Math.PI * 2;

/** @typedef {{key: string, label: string, kind: 'slider'|'int'|'angle'|'bool', min?: number, max?: number, step?: number, def: number|boolean}} ParamSpec */

/** @type {Record<string, {order: string[], params: ParamSpec[]}>} */
export const GEOMETRY_PARAMS = {
	Box: {
		order: ['width', 'height', 'depth', 'widthSegments', 'heightSegments', 'depthSegments'],
		params: [
			{ key: 'width', label: 'Width', kind: 'slider', min: 0.1, max: 20, step: 0.1, def: 1 },
			{ key: 'height', label: 'Height', kind: 'slider', min: 0.1, max: 20, step: 0.1, def: 1 },
			{ key: 'depth', label: 'Depth', kind: 'slider', min: 0.1, max: 20, step: 0.1, def: 1 },
			{ key: 'widthSegments', label: 'Width segs', kind: 'int', min: 1, max: 10, def: 1 },
			{ key: 'heightSegments', label: 'Height segs', kind: 'int', min: 1, max: 10, def: 1 },
			{ key: 'depthSegments', label: 'Depth segs', kind: 'int', min: 1, max: 10, def: 1 }
		]
	},
	Sphere: {
		order: ['radius', 'widthSegments', 'heightSegments', 'phiStart', 'phiLength', 'thetaStart', 'thetaLength'],
		params: [
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.1, max: 10, step: 0.05, def: 1 },
			{ key: 'widthSegments', label: 'Width segs', kind: 'int', min: 3, max: 64, def: 32 },
			{ key: 'heightSegments', label: 'Height segs', kind: 'int', min: 2, max: 32, def: 16 },
			{ key: 'phiLength', label: 'Sweep', kind: 'angle', min: 0.1, max: TAU, def: TAU },
			{ key: 'thetaLength', label: 'Arc', kind: 'angle', min: 0.1, max: Math.PI, def: Math.PI }
		]
	},
	Cylinder: {
		order: ['radiusTop', 'radiusBottom', 'height', 'radialSegments', 'heightSegments', 'openEnded'],
		params: [
			{ key: 'radiusTop', label: 'Radius top', kind: 'slider', min: 0, max: 10, step: 0.05, def: 1 },
			{ key: 'radiusBottom', label: 'Radius btm', kind: 'slider', min: 0, max: 10, step: 0.05, def: 1 },
			{ key: 'height', label: 'Height', kind: 'slider', min: 0.1, max: 20, step: 0.1, def: 1 },
			{ key: 'radialSegments', label: 'Radial segs', kind: 'int', min: 3, max: 64, def: 32 },
			{ key: 'heightSegments', label: 'Height segs', kind: 'int', min: 1, max: 16, def: 1 },
			{ key: 'openEnded', label: 'Open ended', kind: 'bool', def: false }
		]
	},
	Cone: {
		order: ['radius', 'height', 'radialSegments', 'heightSegments', 'openEnded'],
		params: [
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.1, max: 10, step: 0.05, def: 1 },
			{ key: 'height', label: 'Height', kind: 'slider', min: 0.1, max: 20, step: 0.1, def: 1 },
			{ key: 'radialSegments', label: 'Radial segs', kind: 'int', min: 3, max: 64, def: 32 },
			{ key: 'heightSegments', label: 'Height segs', kind: 'int', min: 1, max: 16, def: 1 },
			{ key: 'openEnded', label: 'Open ended', kind: 'bool', def: false }
		]
	},
	Capsule: {
		order: ['radius', 'length', 'capSegments', 'radialSegments'],
		params: [
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.05, max: 5, step: 0.05, def: 0.5 },
			{ key: 'length', label: 'Length', kind: 'slider', min: 0, max: 10, step: 0.05, def: 1 },
			{ key: 'capSegments', label: 'Cap segs', kind: 'int', min: 1, max: 16, def: 4 },
			{ key: 'radialSegments', label: 'Radial segs', kind: 'int', min: 3, max: 32, def: 8 }
		]
	},
	Torus: {
		order: ['radius', 'tube', 'radialSegments', 'tubularSegments', 'arc'],
		params: [
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.1, max: 10, step: 0.05, def: 1 },
			{ key: 'tube', label: 'Tube', kind: 'slider', min: 0.02, max: 5, step: 0.02, def: 0.4 },
			{ key: 'radialSegments', label: 'Radial segs', kind: 'int', min: 3, max: 32, def: 12 },
			{ key: 'tubularSegments', label: 'Tube segs', kind: 'int', min: 3, max: 128, def: 48 },
			{ key: 'arc', label: 'Arc', kind: 'angle', min: 0.1, max: TAU, def: TAU }
		]
	},
	TorusKnot: {
		order: ['radius', 'tube', 'tubularSegments', 'radialSegments', 'p', 'q'],
		params: [
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.1, max: 10, step: 0.05, def: 1 },
			{ key: 'tube', label: 'Tube', kind: 'slider', min: 0.02, max: 5, step: 0.02, def: 0.4 },
			{ key: 'tubularSegments', label: 'Tube segs', kind: 'int', min: 8, max: 256, def: 64 },
			{ key: 'radialSegments', label: 'Radial segs', kind: 'int', min: 3, max: 32, def: 8 },
			{ key: 'p', label: 'P winds', kind: 'int', min: 1, max: 10, def: 2 },
			{ key: 'q', label: 'Q winds', kind: 'int', min: 1, max: 10, def: 3 }
		]
	},
	Ring: {
		order: ['innerRadius', 'outerRadius', 'thetaSegments', 'phiSegments', 'thetaStart', 'thetaLength'],
		params: [
			{ key: 'innerRadius', label: 'Inner', kind: 'slider', min: 0, max: 10, step: 0.05, def: 0.5 },
			{ key: 'outerRadius', label: 'Outer', kind: 'slider', min: 0.1, max: 10, step: 0.05, def: 1 },
			{ key: 'thetaSegments', label: 'Segments', kind: 'int', min: 3, max: 64, def: 32 },
			{ key: 'thetaLength', label: 'Arc', kind: 'angle', min: 0.1, max: TAU, def: TAU }
		]
	},
	Circle: {
		order: ['radius', 'segments', 'thetaStart', 'thetaLength'],
		params: [
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.1, max: 10, step: 0.05, def: 1 },
			{ key: 'segments', label: 'Segments', kind: 'int', min: 3, max: 64, def: 32 },
			{ key: 'thetaLength', label: 'Arc', kind: 'angle', min: 0.1, max: TAU, def: TAU }
		]
	},
	Plane: {
		order: ['width', 'height', 'widthSegments', 'heightSegments'],
		params: [
			{ key: 'width', label: 'Width', kind: 'slider', min: 0.1, max: 40, step: 0.1, def: 1 },
			{ key: 'height', label: 'Height', kind: 'slider', min: 0.1, max: 40, step: 0.1, def: 1 },
			{ key: 'widthSegments', label: 'Width segs', kind: 'int', min: 1, max: 32, def: 1 },
			{ key: 'heightSegments', label: 'Height segs', kind: 'int', min: 1, max: 32, def: 1 }
		]
	},
	Dodecahedron: {
		order: ['radius', 'detail'],
		params: [
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.1, max: 10, step: 0.05, def: 1 },
			{ key: 'detail', label: 'Detail', kind: 'int', min: 0, max: 3, def: 0 }
		]
	},
	Icosahedron: {
		order: ['radius', 'detail'],
		params: [
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.1, max: 10, step: 0.05, def: 1 },
			{ key: 'detail', label: 'Detail', kind: 'int', min: 0, max: 3, def: 0 }
		]
	},
	Octahedron: {
		order: ['radius', 'detail'],
		params: [
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.1, max: 10, step: 0.05, def: 1 },
			{ key: 'detail', label: 'Detail', kind: 'int', min: 0, max: 3, def: 0 }
		]
	},
	Tetrahedron: {
		order: ['radius', 'detail'],
		params: [
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.1, max: 10, step: 0.05, def: 1 },
			{ key: 'detail', label: 'Detail', kind: 'int', min: 0, max: 3, def: 0 }
		]
	},
	Lathe: {
		// points stay the default profile (quiz: fixed presets)
		order: ['points', 'segments', 'phiStart', 'phiLength'],
		params: [
			{ key: 'segments', label: 'Segments', kind: 'int', min: 3, max: 64, def: 12 },
			{ key: 'phiLength', label: 'Sweep', kind: 'angle', min: 0.1, max: TAU, def: TAU }
		]
	},
	Tube: {
		// path stays the default curve (quiz: fixed presets)
		order: ['path', 'tubularSegments', 'radius', 'radialSegments', 'closed'],
		params: [
			{ key: 'tubularSegments', label: 'Tube segs', kind: 'int', min: 3, max: 128, def: 64 },
			{ key: 'radius', label: 'Radius', kind: 'slider', min: 0.02, max: 5, step: 0.02, def: 1 },
			{ key: 'radialSegments', label: 'Radial segs', kind: 'int', min: 3, max: 32, def: 8 },
			{ key: 'closed', label: 'Closed', kind: 'bool', def: false }
		]
	}
};

/** Registry spec for a mesh's geometry, by three type name @param {string} gtype e.g. 'Sphere' */
export function geometrySpec(gtype) {
	return GEOMETRY_PARAMS[gtype] ?? null;
}
