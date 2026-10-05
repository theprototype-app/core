// Catalog of creatable objects, grouped for the viewport Add menu (and the VR
// add-menu). `command` goes through sceneCommand -> createGeometry/createLight
// and replicates to peers. Phase 77: the full three.js primitive + light set.

/** @type {{ group: string, items: { label: string, command: string }[] }[]} */
export const primitivesCatalog = [
	{
		group: 'Mesh',
		items: [
			{ label: 'Cube', command: '/create Box 2 2 2' },
			{ label: 'Sphere', command: '/create Sphere 1' },
			{ label: 'Cylinder', command: '/create Cylinder 1 1 2' },
			{ label: 'Cone', command: '/create Cone 1 2' },
			{ label: 'Capsule', command: '/create Capsule 0.5 1' },
			{ label: 'Torus', command: '/create Torus 1 0.4' },
			{ label: 'Torus Knot', command: '/create TorusKnot 1 0.3' },
			{ label: 'Ring', command: '/create Ring 0.5 1' },
			{ label: 'Circle', command: '/create Circle 1' },
			{ label: 'Plane', command: '/create Plane 4 4' },
			{ label: 'Dodecahedron', command: '/create Dodecahedron 1' },
			{ label: 'Icosahedron', command: '/create Icosahedron 1' },
			{ label: 'Octahedron', command: '/create Octahedron 1' },
			{ label: 'Tetrahedron', command: '/create Tetrahedron 1' },
			{ label: 'Lathe', command: '/create Lathe' },
			{ label: 'Tube', command: '/create Tube' }
		]
	},
	{
		group: 'Building blocks',
		items: [
			{ label: 'Wedge', command: '/create Wedge 2 1 2' },
			{ label: 'Stairs', command: '/create Stairs 2 1.5 2 6' },
			{ label: 'Arch', command: '/create Arch 2 2 0.5' },
			{ label: 'Corner', command: '/create Corner 2 2 0.25' }
		]
	},
	{
		// 37 R3: parametric architecture — every number is editable in the Inspector afterwards
		// (arch/archGeometry.js documents the /create argument codes)
		group: 'Architecture',
		items: [
			{ label: 'Wall', command: '/create Wall 4 2.8 0.2 0' },
			{ label: 'Wall with door', command: '/create Wall 4 2.8 0.2 1' },
			{ label: 'Wall with windows', command: '/create Wall 4 2.8 0.2 2' },
			{ label: 'Wall with door and windows', command: '/create Wall 6 2.8 0.2 3' },
			{ label: 'Door', command: '/create Door 1 2.1 0' },
			{ label: 'Double door', command: '/create Door 2 2.1 1' },
			{ label: 'Window', command: '/create Window 1.2 1.2 0.9 0' },
			{ label: 'Casement window', command: '/create Window 1.2 1.2 0.9 1' },
			{ label: 'Stairs (straight)', command: '/create Staircase 0 1 14 0.18' },
			{ label: 'Stairs (L)', command: '/create Staircase 1 1 14 0.18' },
			{ label: 'Stairs (U)', command: '/create Staircase 2 1 15 0.18' },
			{ label: 'Stairs (spiral)', command: '/create Staircase 3 1 16 0.18' }
		]
	},
	{
		group: 'Ground',
		items: [{ label: 'Terrain', command: '/create Terrain 24 48' }]
	},
	{
		// 36-sim U2b: a glass tank of particle fluid (local per peer; settings replicate)
		group: 'Simulation',
		items: [{ label: 'Fluid tank', command: '/create FluidTank 1.2 0.8 0.8' }]
	},
	{
		// 16-P5: camera OBJECTS are marker meshes carrying userData.camera, so they
		// create / replicate / undo through the same /create path as any primitive
		group: 'Camera',
		items: [
			{ label: 'Perspective', command: '/create Camera' },
			{ label: 'Orthographic', command: '/create CameraOrtho' }
		]
	},
	{
		group: 'Light',
		items: [
			{ label: 'Ambient', command: '/light ambient' },
			{ label: 'Directional', command: '/light directional' },
			{ label: 'Hemisphere', command: '/light hemisphere' },
			{ label: 'Point', command: '/light point' },
			{ label: 'Spot', command: '/light spot' },
			{ label: 'Rect Area', command: '/light rectarea' }
		]
	}
];
