<script lang="ts">
	// 21-F4 — the TRAVEL node's card: a scene picker over every .tpscene in the Explorer
	// (21-G1: discovery is BY KIND, so a scene counts wherever it lives), the
	// GameCameraNode shape (a real <select> with a "— none —" sentinel, and a node whose
	// scene is MISSING says so instead of looking empty — the authored hash is kept
	// selectable so opening the card cannot silently rewrite the graph).
	//
	// 21-G2 adds the NAME mode: the manifest's scene names come FIRST in the picker, and
	// choosing one stores {sceneName} — resolved to the scene's CURRENT pointer at fire
	// time through the replicated manifest, so "the latest of Arena" is the same hash on
	// every peer. Choosing a library FILE stores {level: hash} — a specific version,
	// frozen forever. Two different promises, so the optgroups say which is which.
	//
	// What the card must explain, because it will otherwise be reported: travel happens
	// for EVERYONE. The trigger replicates; each peer loads the scene itself, pulling
	// the bytes from whoever has them first. And the game (state, round, variables)
	// CARRIES across the hop — another scene is a place, not a new game.
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { explorerItems } from '$lib/explorer';
	import { levelItems } from '$lib/levels';
	import { projectManifest, manifestSceneNames } from '$lib/projectManifest';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	// explorerItems IS reactive (unlike a THREE tree), so passing it keeps the list
	// live as scenes are saved, pulled or renamed — and the manifest store likewise
	const levelsOf = (_items: any) => levelItems();
	const namesOf = (_manifest: any) => manifestSceneNames();
	$: levels = levelsOf($explorerItems);
	$: names = namesOf($projectManifest);
	$: chosenName = String(data.sceneName ?? '');
	$: chosen = chosenName ? 'name:' + chosenName : String(data.level ?? '');
	$: missing =
		!chosenName && !!chosen && !levels.some((l: any) => l.hash === chosen);
	$: nameGone = !!chosenName && !names.includes(chosenName);

	function pick(value: string) {
		if (value.startsWith('name:')) {
			// name mode: the manifest resolves it at fire time — no hash is frozen
			setNodeData(id, { sceneName: value.slice(5), level: '', levelName: '' });
			return;
		}
		const item = levels.find((l: any) => l.hash === value);
		const name = item ? String(item.name ?? '').replace(/\.tpscene$/i, '') : String(data.levelName ?? '');
		setNodeData(id, { level: value, levelName: name, sceneName: '' });
	}
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="trigger" style="top: 34px" />
	<div class="flex w-full flex-col gap-1">
		<label class="flex flex-col">
			<span>scene</span>
			<select class="nodrag" value={chosen} on:change={(e) => pick(e.currentTarget.value)}>
				<option value="">— none —</option>
				{#if names.length}
					<optgroup label="Project scenes (latest version)">
						{#each names as name (name)}
							<option value={'name:' + name}>{name}</option>
						{/each}
					</optgroup>
				{/if}
				<optgroup label="Library files (that exact version)">
					{#each levels as level (level.hash)}
						<option value={level.hash}>{level.name.replace(/\.tpscene$/i, '')}</option>
					{/each}
				</optgroup>
				{#if missing}
					<!-- a scene saved by a peer we have not pulled yet, or one deleted locally:
					     the AUTHORED value stays selectable and named, never silently dropped -->
					<option value={chosen}>({data.levelName || 'missing scene'})</option>
				{/if}
				{#if nameGone}
					<option value={chosen}>({chosenName} — not in the project yet)</option>
				{/if}
			</select>
		</label>
		<span class="text-[10px] text-gray-400"
			>everyone travels — peers pull the scene and load it themselves; the game state carries</span
		>
	</div>
</NodeWrapper>
