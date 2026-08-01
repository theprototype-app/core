<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { flowCursors, activeGraphId, SCENE_GRAPH } from '../../stores/flowStore';

	// Renders connected peers' cursors inside the flow editor. Coordinates arrive
	// in flow space; the current viewport (pan/zoom) converts them to screen space.
	export let viewport: any; // plain {x, y, zoom} object bound to <SvelteFlow> (xyflow v1)

	let sweep: any;
	onMount(() => {
		// drop cursors that stopped updating (peer left the pane or disconnected)
		sweep = setInterval(() => {
			flowCursors.update((map) => {
				const now = Date.now();
				const stale = Object.keys(map).filter((id) => now - map[id].ts > 4000);
				if (stale.length === 0) return map;
				const next = { ...map };
				stale.forEach((id) => delete next[id]);
				return next;
			});
		}, 1000);
	});
	onDestroy(() => clearInterval(sweep));

	// stable per-peer color from the id
	function colorOf(id: string) {
		let hash = 0;
		for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
		return `hsl(${hash}, 70%, 50%)`;
	}
</script>

<div class="pointer-events-none absolute inset-0 overflow-hidden" style="z-index: 10;">
	<!-- H1: only cursors on the SAME graph as this editor (missing graphId = scene) -->
	{#each Object.entries($flowCursors).filter(([, c]) => ((c as any).graphId ?? SCENE_GRAPH) === $activeGraphId) as [id, cursor] (id)}
		<div
			class="absolute flex items-start"
			style="left: {cursor.x * viewport.zoom + viewport.x}px; top: {cursor.y * viewport.zoom + viewport.y}px;"
		>
			<svg width="18" height="18" viewBox="0 0 24 24" style="color: {colorOf(id)}">
				<path fill="currentColor" stroke="white" stroke-width="1.5" d="M4 2 L20 12 L12 13.5 L8.5 21 Z" />
			</svg>
			<span
				class="ml-1 mt-3 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs text-white"
				style="background: {colorOf(id)}">{cursor.name}</span
			>
		</div>
	{/each}
</div>
