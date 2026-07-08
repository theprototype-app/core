// Catalog of creatable primitives, grouped for the Sidebar (and the VR add-menu).
// `command` goes through sceneCommand -> createGeometry and replicates to peers.

/** @type {{ group: string, items: { label: string, command: string }[] }[]} */
export const primitivesCatalog = [
	{
		group: 'Primitives',
		items: [
			{ label: 'Cube', command: '/create Box 2 2 2' },
			{ label: 'Cone', command: '/create Cone 1' },
			{ label: 'Sphere', command: '/create Sphere 1' },
			{ label: 'Cylinder', command: '/create Cylinder 1 1 2' },
			{ label: 'Plane', command: '/create Plane 4 4' },
			{ label: 'Torus', command: '/create Torus 1 0.4' },
			{ label: 'Capsule', command: '/create Capsule 0.5 1' }
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
	}
];
