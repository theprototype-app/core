<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { explorerItems } from '$lib/explorer';
	import { sendAsset } from '$lib/assetShare';

	type $$Props = NodeProps;
	export let id: string;
	export let data;

	// audio files come from the Explorer library; assigning one PUSHES its
	// bytes to peers (content hash), so everyone can build the same chain (97)
	$: audioItems = $explorerItems.filter((item) => item.kind === 'audio');
	$: known = !data.hash || audioItems.some((item) => item.hash === data.hash);
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<!-- 133: volume can be driven by a value node -->
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="volume" style="top: 74px" />
	<div class="flex w-full flex-col gap-1">
		<select
			class="nodrag"
			value={data.hash ?? ''}
			on:change={(e) => {
				const hash = e.currentTarget.value || null;
				const item = audioItems.find((entry) => entry.hash === hash);
				setNodeData(id, { hash, file: item?.name ?? '' });
				if (hash) sendAsset(hash);
			}}
		>
			<option value="">— pick a sound —</option>
			{#each audioItems as item (item.id)}
				<option value={item.hash}>{item.name}</option>
			{/each}
			{#if !known}
				<option value={data.hash}>{data.file || 'shared sound'} (fetching…)</option>
			{/if}
		</select>
		<label class="flex flex-col">
			<span class="flex justify-between"><span>volume</span><span>{(data.volume ?? 0.8).toFixed(2)}</span></span>
			<input
				class="nodrag accent-[#ff4000]"
				type="range"
				min="0"
				max="1"
				step="0.05"
				value={data.volume ?? 0.8}
				on:input={(e) => setNodeData(id, { volume: +e.currentTarget.value })}
			/>
		</label>
		<label class="flex flex-col">
			<span class="flex justify-between"><span>radius</span><span>{data.radius ?? 5}m</span></span>
			<input
				class="nodrag accent-[#ff4000]"
				type="range"
				min="1"
				max="60"
				step="1"
				value={data.radius ?? 5}
				on:input={(e) => setNodeData(id, { radius: +e.currentTarget.value })}
			/>
		</label>
		<label class="flex flex-col">
			<span class="flex justify-between"><span>rolloff</span><span>{(data.rolloff ?? 1).toFixed(1)}</span></span>
			<input
				class="nodrag accent-[#ff4000]"
				type="range"
				min="0.5"
				max="4"
				step="0.1"
				value={data.rolloff ?? 1}
				on:input={(e) => setNodeData(id, { rolloff: +e.currentTarget.value })}
			/>
		</label>
		<div class="flex items-center gap-2">
			<button
				class="nodrag flex-1 rounded px-1 py-0.5 text-white {data.playing ? 'bg-green-600' : 'bg-[#ff4000]'}"
				on:click={() => setNodeData(id, { playing: !data.playing })}
			>
				{data.playing ? '■ Stop' : '▶ Play'}
			</button>
			<label class="flex items-center gap-1">
				<input
					class="nodrag"
					type="checkbox"
					checked={data.loop !== false}
					on:change={(e) => setNodeData(id, { loop: e.currentTarget.checked })}
				/>
				loop
			</label>
		</div>
	</div>
</NodeWrapper>
