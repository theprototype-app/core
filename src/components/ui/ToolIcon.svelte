<script>
	// M0 (mesh toolbox): the custom stroke icon set for mesh/sculpt tools —
	// glyphs lucide does not have (extrude, inset, bridge...). ONE 24px viewBox,
	// stroke-width 2, round caps/joins and `currentColor`, so these sit
	// pixel-consistent next to lucide components and recolor per theme AND per
	// state (armed white-on-accent, danger red, muted disabled) for free.
	// Deliberately NO per-theme image assets: custom themes are unlimited and
	// defined only by color tokens, so monochrome-stroke-tinted-by-token is the
	// only approach that scales (the Blender/Maya convention). Per-theme flavor
	// stays CSS-only, e.g. [data-theme='bit8'] svg { stroke-width: 2.5 }.
	// Later mesh phases (loop select/cut, bevel, edge mode, mirror, knife...)
	// add their glyphs HERE — this file is the long-term home.

	/** kebab name -> array of path `d` strings (all stroked, never filled).
	 * @type {Record<string, string[]>} */
	const PATHS = {
		// a face with an arrow pulled out along its normal
		extrude: ['M4 16l6 3 10-4-6-3z', 'M12 12V4', 'M8.5 7.5L12 4l3.5 3.5'],
		// a face shrunk inside its ring
		inset: ['M4 4h16v16H4z', 'M9.5 9.5h5v5h-5z'],
		// two caps joined by a tunnel
		bridge: ['M3 6h4v12H3z', 'M17 6h4v12h-4z', 'M7 9.5h10', 'M7 14.5h10'],
		// opposing normals across a face
		'flip-normals': ['M4 12h16', 'M9 12V5', 'M6.5 7.5L9 5l2.5 2.5', 'M15 12v7', 'M12.5 16.5L15 19l2.5-2.5'],
		// three picked vertices closing into a face
		'create-face': ['M12 4.5v.01', 'M4.5 19v.01', 'M19.5 19v.01', 'M10.5 7l-4.5 9', 'M13.5 7l4.5 9', 'M7.5 19h9'],
		// a quad crossed by its wire diagonal
		wireframe: ['M4 4h16v16H4z', 'M4 20L20 4'],
		// a quad ring with a new loop inserted across it
		'loop-cut': ['M4 4h16v16H4z', 'M12 3v18', 'M9.5 8L12 5.5L14.5 8'],
		// sculpt: a bump pulled up / pushed down, a relaxed wave, a leveled bar
		raise: ['M3 18c4 0 4.5-5 9-5s5 5 9 5', 'M12 9V3', 'M9 6l3-3 3 3'],
		lower: ['M3 13c4 0 4.5 5 9 5s5-5 9-5', 'M12 3v6', 'M9 6l3 3 3-3'],
		smooth: ['M3 13.5C6 9 9 9 12 12s6 3 9-1.5'],
		flatten: ['M4 7h16', 'M12 7v6', 'M9 10l3 3 3-3', 'M4 18h16']
	};

	/** @type {{ name: string, size?: number }} */
	let { name, size = 18 } = $props();
	const paths = $derived(PATHS[name] ?? PATHS.wireframe);
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
	{#each paths as d (d)}
		<path {d} />
	{/each}
</svg>
