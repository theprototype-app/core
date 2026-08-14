<script>
	// The custom icon set for mesh/sculpt tools — glyphs lucide does not have
	// (extrude, inset, bridge…). ONE 24px viewBox, stroke-width 2, round
	// caps/joins, so these sit pixel-consistent next to lucide components.
	//
	// 18-C4 — DUOTONE. Each glyph is `{ base, accent?, accentFill? }`:
	//   base   = the neutral geometry being operated on, in `currentColor`
	//   accent = what the tool CREATES or CHANGES, in --icon-accent
	// That one rule is what makes a grid of twenty outline glyphs readable: the
	// eye finds the accent first and reads "this is the part that moves". A
	// monochrome set relies on silhouette alone, and at 18px an extruded band and
	// an inset ring have nearly the same silhouette (Bevel and Knife were even
	// sharing lucide's Scissors, which is how two tools ended up identical).
	//
	// Still no per-theme image assets: custom themes are unlimited and defined
	// only by colour tokens, so a token-tinted stroke set is the only approach
	// that scales. --icon-accent falls back through --accent to a literal, so a
	// custom theme that never heard of it still gets a coherent icon.
	// State overrides live in ToolboxWindow: an ARMED button sets
	// --icon-accent:#fff (the duotone collapses to white on the solid fill) and a
	// danger button sets it to the danger red.

	/** @typedef {{base: string[], accent?: string[], accentFill?: string[]}} Glyph */

	/** kebab name -> glyph. Legacy array form = base-only, still accepted.
	 * @type {Record<string, Glyph | string[]>} */
	const PATHS = {
		// ---- face tools -------------------------------------------------------
		// a face, and the band pulled out of it along the normal
		extrude: {
			base: ['M4 20h10V10H4z'],
			accent: ['M9 10V3', 'M5.5 6.5L9 3l3.5 3.5', 'M14 20l6-4V6l-6 4']
		},
		// the outer face, and the shrunken copy stitched inside it
		inset: {
			base: ['M3 3h18v18H3z'],
			accent: ['M8 8h8v8H8z']
		},
		// the selection, and the directions it can go
		move: {
			base: ['M9.5 9.5h5v5h-5z'],
			accent: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M10 5l2-2 2 2', 'M10 19l2 2 2-2', 'M5 10l-2 2 2 2', 'M19 10l2 2-2 2']
		},
		// the trail already cut, and the blade cutting it. NOT another bordered
		// square: knife sat next to inset, subdivide and delete, all of which are
		// a square plus a mark, and at 18px they were one icon four times.
		knife: {
			base: ['M3 21l5.5-5.5'],
			accent: ['M8.5 15.5l5-5', 'M13.5 10.5l6-6 2.5 2.5-6 6z']
		},
		// a quad ring, and the loops inserted across it (two, so it cannot be
		// mistaken for subdivide's single cross)
		'loop-cut': {
			base: ['M4 4h16v16H4z'],
			accent: ['M10 3v18', 'M15 3v18']
		},
		// a face, and the cross that splits it into four
		subdivide: {
			base: ['M4 4h16v16H4z'],
			accent: ['M12 4v16', 'M4 12h16']
		},
		// the two end caps, and the tunnel walls between them
		bridge: {
			base: ['M3 5h4v14H3z', 'M17 5h4v14h-4z'],
			accent: ['M7 8.5h10', 'M7 15.5h10']
		},
		// the surface, and the normals now pointing the other way
		'flip-normals': {
			base: ['M3 12h18'],
			accent: ['M8 12V5', 'M5.5 7.5L8 5l2.5 2.5', 'M16 12v7', 'M13.5 16.5L16 19l2.5-2.5']
		},
		// the surrounding mesh, and the face taken out of it
		'delete-face': {
			base: ['M4 4h16v16H4z'],
			accent: ['M8.5 8.5l7 7', 'M15.5 8.5l-7 7']
		},
		// the shape with its corner taken off, and the chamfer that replaced it.
		// The corner it USED to have is dashed, so the glyph shows the change
		// rather than just an odd polygon.
		bevel: {
			base: ['M4 4h9v0M4 4v16h16v-9'],
			accent: ['M13 4l7 7'],
			accentFill: []
		},
		// two edges meeting, and the corner cut off and capped
		'bevel-vertex': {
			base: ['M4 20L11 6', 'M20 20L13 6'],
			accent: ['M9.5 9l5 0'],
			accentFill: ['M12 5.6a1.6 1.6 0 100 3.2 1.6 1.6 0 100-3.2z']
		},
		// two faces, and the edge between them going away
		dissolve: {
			base: ['M3 5h18v14H3z'],
			accent: ['M12 6v2', 'M12 11v2', 'M12 16v2']
		},
		// ---- vertex tools -----------------------------------------------------
		// two vertices, and the arrows bringing them together
		weld: {
			base: ['M3 12h4', 'M17 12h4'],
			accent: ['M8.5 9.5L11 12l-2.5 2.5', 'M15.5 9.5L13 12l2.5 2.5'],
			accentFill: ['M12 10.4a1.6 1.6 0 100 3.2 1.6 1.6 0 100-3.2z']
		},
		// three picked vertices, and the face closing over them
		'create-face': {
			base: [],
			accent: ['M12 5l7 14H5z'],
			accentFill: [
				'M12 3.6a1.6 1.6 0 100 3.2 1.6 1.6 0 100-3.2z',
				'M5 17.6a1.6 1.6 0 100 3.2 1.6 1.6 0 100-3.2z',
				'M19 17.6a1.6 1.6 0 100 3.2 1.6 1.6 0 100-3.2z'
			]
		},
		// a flat neighbourhood, and the falloff the drag carries
		proportional: {
			base: ['M2 18h20'],
			accent: ['M4 18c5 0 4-11 8-11s3 11 8 11']
		},
		// the edge it rides, and the vertex sliding along it
		'vertex-slide': {
			base: ['M3 17L21 7'],
			accent: ['M7.5 6.5L4.5 8l1.5 3', 'M16.5 17.5l3-1.5-1.5-3'],
			accentFill: ['M12 10.4a1.6 1.6 0 100 3.2 1.6 1.6 0 100-3.2z']
		},
		// ---- cleanup / symmetry ----------------------------------------------
		// a face with its normals rewound outward
		'recalc-normals': {
			base: ['M3 14h18'],
			accent: ['M7 14V6', 'M4.5 8.5L7 6l2.5 2.5', 'M17 14V6', 'M14.5 8.5L17 6l2.5 2.5']
		},
		// scattered points, and the ones close enough to collapse
		'merge-distance': {
			base: ['M4 5v14', 'M20 5v14'],
			accent: ['M8 10l3 2-3 2', 'M16 10l-3 2 3 2'],
			accentFill: ['M12 10.4a1.6 1.6 0 100 3.2 1.6 1.6 0 100-3.2z']
		},
		// one half faceted, the other smooth
		shading: {
			base: ['M12 3l-7 5v8l7 5', 'M5 8l7 4', 'M12 21V12'],
			accent: ['M12 3a9 9 0 010 18']
		},
		// the half you keep, and the half replaced by its mirror
		symmetrize: {
			base: ['M10 4L4 12l6 8z'],
			accent: ['M12 2v20', 'M14 4l6 8-6 8']
		},
		// ---- display ----------------------------------------------------------
		// a box seen as WIRE — a 3D silhouette on purpose: as a flat square plus a
		// cross it was pixel-for-pixel the subdivide glyph, sitting two sections
		// apart in the same window
		wireframe: {
			base: ['M3 8h13v13H3z'],
			accent: ['M8 3h13v13', 'M3 8l5-5', 'M16 8l5-5', 'M16 21l5-5']
		},
		// the object, and the outline drawn around it
		outline: {
			base: ['M8.5 8.5h7v7h-7z'],
			accent: ['M4 4h4', 'M16 4h4', 'M4 20h4', 'M16 20h4', 'M4 4v4', 'M20 4v4', 'M4 16v4', 'M20 16v4']
		},
		// a quad, and the triangulation hidden inside it
		triangulation: {
			base: ['M4 4h16v16H4z'],
			accent: ['M4 20L20 4']
		},
		// the axes, and the two you can drag
		gizmo: {
			base: ['M5 19h14'],
			accent: ['M5 19V6', 'M2.5 8.5L5 6l2.5 2.5', 'M5 19h13', 'M15.5 16.5L19 19l-3.5 2.5'],
			accentFill: ['M5 17.4a1.6 1.6 0 100 3.2 1.6 1.6 0 100-3.2z']
		},
		// ---- sculpt brushes ---------------------------------------------------
		raise: {
			base: ['M3 18c4 0 4.5-5 9-5s5 5 9 5'],
			accent: ['M12 9V3', 'M9 6l3-3 3 3']
		},
		lower: {
			base: ['M3 13c4 0 4.5 5 9 5s5-5 9-5'],
			accent: ['M12 3v6', 'M9 6l3 3 3-3']
		},
		smooth: {
			base: ['M3 8.5C6 4 9 4 12 7s6 3 9-1.5'],
			accent: ['M3 17c6 0 12 0 18 0']
		},
		flatten: {
			base: ['M4 7h16'],
			accent: ['M12 7v6', 'M9 10l3 3 3-3', 'M4 18h16']
		}
	};

	/** @type {{ name: string, size?: number }} */
	let { name, size = 18 } = $props();
	// back-compat: a plain array is a base-only glyph, so callers written before
	// the duotone split keep working untouched
	const glyph = $derived.by(() => {
		const raw = PATHS[name] ?? PATHS.wireframe;
		return Array.isArray(raw) ? { base: raw } : raw;
	});
	const ACCENT = 'var(--icon-accent, var(--accent, var(--color-primary-500, #60a5fa)))';
</script>

<svg
	class="lucide"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#each glyph.base ?? [] as d (d)}
		<path {d} />
	{/each}
	{#each glyph.accent ?? [] as d (d)}
		<path {d} stroke={ACCENT} />
	{/each}
	{#each glyph.accentFill ?? [] as d (d)}
		<path {d} fill={ACCENT} stroke="none" />
	{/each}
</svg>
