<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { PARTICLE_PRESETS, particlePreset } from '$lib/particlePresets';

	// PFX-B: particle emitter node. Drives the connected object (or the graph
	// owner) via the particle runtime. The card seeds a full config from a
	// preset, then exposes the key params; count/color take wired inputs and a
	// burst-mode emitter fires from the `trigger` event input (On Click / Key
	// Press / On Impact). Legacy-mode, like every sibling node file.
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	const set = (patch: any) => setNodeData(id, patch);
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<!-- wired inputs (aligned to the first three rows, AnimationNode cadence) -->
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="count" style="top: 34px" />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="color" style="top: 72px" />
	<Socket kind="target" nodeType={data.type} position={Position.Left} id="trigger" style="top: 110px" />
	<div class="flex w-full flex-col gap-1">
		<!-- row 0: count (wired input) -->
		<label class="flex flex-col">
			<span class="flex justify-between"><span>count</span><span>{data.count ?? 80}</span></span>
			<input class="nodrag accent-[#c084fc]" type="range" min="1" max="500" step="1"
				value={data.count ?? 80} on:input={(e) => set({ count: +e.currentTarget.value })} />
		</label>
		<!-- row 1: color (wired input) -->
		<label class="flex flex-col">
			<span>color</span>
			<span class="flex items-center gap-2">
				<input class="nodrag h-5 w-7" type="color" value={data.colorStart ?? '#ffffff'}
					on:input={(e) => set({ colorStart: e.currentTarget.value })} />
				<span class="text-[10px] text-gray-400">or wire a color</span>
			</span>
		</label>
		<!-- row 2: trigger (event input) -->
		<div class="flex flex-col">
			<span>trigger</span>
			<span class="text-[10px] text-gray-400">wire an event to burst</span>
		</div>

		<label class="flex flex-col">
			<span>preset</span>
			<select class="nodrag" value={data.preset ?? 'sparkles'}
				on:change={(e) => set(particlePreset(e.currentTarget.value))}>
				{#each PARTICLE_PRESETS as preset (preset.key)}
					<option value={preset.key}>{preset.name}</option>
				{/each}
			</select>
		</label>
		<label class="flex flex-col">
			<span>emission</span>
			<select class="nodrag" value={data.mode ?? 'continuous'}
				on:change={(e) => set({ mode: e.currentTarget.value })}>
				<option value="continuous">continuous</option>
				<option value="burst">burst (triggered)</option>
			</select>
		</label>
		<label class="flex flex-col">
			<span class="flex justify-between"><span>speed</span><span>{data.speed ?? 1}</span></span>
			<input class="nodrag accent-[#c084fc]" type="range" min="0" max="8" step="0.1"
				value={data.speed ?? 1} on:input={(e) => set({ speed: +e.currentTarget.value })} />
		</label>
		<label class="flex flex-col">
			<span class="flex justify-between"><span>gravity</span><span>{data.gravity ?? 0}</span></span>
			<input class="nodrag accent-[#c084fc]" type="range" min="-10" max="10" step="0.1"
				value={data.gravity ?? 0} on:input={(e) => set({ gravity: +e.currentTarget.value })} />
		</label>
		<label class="flex flex-col">
			<span class="flex justify-between"><span>size</span><span>{data.sizeStart ?? 0.1}</span></span>
			<input class="nodrag accent-[#c084fc]" type="range" min="0.01" max="1" step="0.01"
				value={data.sizeStart ?? 0.1} on:input={(e) => set({ sizeStart: +e.currentTarget.value })} />
		</label>
		<label class="flex flex-col">
			<span>sprite</span>
			<select class="nodrag" value={data.sprite ?? 'dot'}
				on:change={(e) => set({ sprite: e.currentTarget.value })}>
				<option value="dot">soft dot</option>
				<option value="streak">spark streak</option>
				<option value="puff">smoke puff</option>
				<option value="star">star</option>
				<option value="square">confetti</option>
			</select>
		</label>
		<label class="flex flex-col">
			<span>space</span>
			<select class="nodrag" value={data.space ?? 'local'}
				on:change={(e) => set({ space: e.currentTarget.value })}>
				<option value="local">local (rides object)</option>
				<option value="world">world (trails)</option>
			</select>
		</label>
	</div>
</NodeWrapper>
