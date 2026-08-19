<script lang="ts">
	// Node card chrome (phase 69) — the single place node visuals live.
	// The category accent lands in --node-accent, which the handle CSS picks up.
	import { groupOf } from '$lib/nodeCatalog';

	export let type: string;
	export let label: string = '';
	// A6.4: an explicit accent overrides the group lookup. Today the accent derives
	// only from groupOf(type), and an UNKNOWN type has no group at all — it needs to
	// read as a warning, not as another gray module node.
	export let accent: string = '';

	const ACCENTS: Record<string, string> = {
		Input: '#38bdf8', // blue
		Scene: '#4ade80', // green
		Animation: '#fb923c', // orange
		Effects: '#c084fc', // purple
		Physics: '#f87171', // red
		Logic: '#2dd4bf', // teal
		Triggers: '#facc15', // yellow
		HUD: '#f0abfc', // A3: pink-violet, distinct from Effects' purple
		Game: '#34d399', // 21-D6: emerald — the game shell
		// 'Object Flow' was MISSING, so flowinput/flowoutput/objectflow fell through to
		// the module-node gray and read as third-party cards. Fixed while adding HUD.
		'Object Flow': '#818cf8' // indigo
	};
	$: group = groupOf(type);
	// module groups → gray, user-designed custom nodes → user accent
	$: resolvedAccent = accent || (group ? (ACCENTS[group] ?? '#94a3b8') : '#e879f9');
</script>

<div
	class="node-card flex h-full flex-col rounded-lg border border-gray-600/70 bg-gray-800/95 text-gray-200 shadow-lg"
	style={`--node-accent: ${resolvedAccent}; border-top: 2px solid ${resolvedAccent}`}
>
	<div
		class="flex items-center gap-1.5 rounded-t-md border-b border-gray-700/60 bg-gray-900/50 px-3 py-1.5 font-mono text-xs font-semibold text-gray-100"
	>
		<span class="h-2 w-2 shrink-0 rounded-full" style="background: var(--node-accent)"></span>
		<span class="overflow-hidden text-ellipsis whitespace-nowrap">{label ? label : type}</span>
	</div>
	<div class="relative flex rounded-b-lg p-3 text-xs text-gray-300">
		<slot />
	</div>
</div>

<style>
	/* selected / dragging states come from the xyflow node wrapper */
	:global(.svelte-flow__node.selected) .node-card {
		border-color: var(--node-accent);
		box-shadow: 0 0 0 1px var(--node-accent), 0 8px 18px rgb(0 0 0 / 0.45);
	}
	:global(.svelte-flow__node.dragging) .node-card {
		opacity: 0.85;
		box-shadow: 0 12px 24px rgb(0 0 0 / 0.5);
	}
</style>
