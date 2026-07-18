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
