<script lang="ts">
	// 21-F4 — the TRAVEL node's card: a level picker over the Explorer's Levels folder,
	// the GameCameraNode shape (a real <select> with a "— none —" sentinel, and a node
	// whose level is MISSING says so instead of looking empty — the authored hash is
	// kept selectable so opening the card cannot silently rewrite the graph).
	//
	// The card stores the level's content HASH (what every peer can pull) AND its NAME
	// (display + the toast), because a peer that does not hold the bytes cannot resolve
	// the hash to a name at all — the name has to ride the graph.
	//
	// What the card must explain, because it will otherwise be reported: travel happens
	// for EVERYONE. The trigger replicates; each peer loads the level itself, pulling
	// the bytes from whoever has them first. And the game (state, round, variables)
	// CARRIES across the hop — a level is a place, not a new game.
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { explorerItems } from '$lib/explorer';
	import { levelItems } from '$lib/levels';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	// explorerItems IS reactive (unlike a THREE tree), so passing it keeps the list
	// live as levels are saved, pulled or renamed
	const levelsOf = (_items: any) => levelItems();
	$: levels = levelsOf($explorerItems);
	$: chosen = String(data.level ?? '');
	$: missing = !!chosen && !levels.some((l: any) => l.hash === chosen);

	function pick(hash: string) {
		const item = levels.find((l: any) => l.hash === hash);
		const name = item ? String(item.name ?? '').replace(/\.tpscene$/i, '') : String(data.levelName ?? '');
		setNodeData(id, { level: hash, levelName: name });
	}
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="trigger" style="top: 34px" />
	<div class="flex w-full flex-col gap-1">
		<label class="flex flex-col">
			<span>level</span>
			<select class="nodrag" value={chosen} on:change={(e) => pick(e.currentTarget.value)}>
				<option value="">— none —</option>
				{#each levels as level (level.hash)}
					<option value={level.hash}>{level.name.replace(/\.tpscene$/i, '')}</option>
				{/each}
				{#if missing}
					<!-- a level saved by a peer we have not pulled yet, or one deleted locally:
					     the AUTHORED value stays selectable and named, never silently dropped -->
					<option value={chosen}>({data.levelName || 'missing level'})</option>
				{/if}
			</select>
		</label>
		<span class="text-[10px] text-gray-400"
			>everyone travels — peers pull the level and load it themselves; the game state carries</span
		>
	</div>
</NodeWrapper>
