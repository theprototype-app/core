<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';

	// H5: interface nodes — Flow Input / Flow Output DECLARE an object flow's
	// public sockets. Inside the graph a Flow Input is a value source (fed by the
	// scene's embedded Object Flow node, else its fallback); a Flow Output is a
	// sink whose wired value surfaces on the embedded node. One-way flow: render
	// from data, write through setNodeData (replicates).
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	const VTYPES = ['number', 'boolean', 'vector3', 'color'];

	// a fallback only makes sense in its own type — switching the type RESETS it
	// (matches the runtime's typedFallback defaults)
	function typedDefault(vtype: string): any {
		if (vtype === 'boolean') return false;
		if (vtype === 'vector3') return [0, 0, 0];
		if (vtype === 'color') return '#ffffff';
		return 0;
	}
	function onTypeChange(vtype: string) {
		setNodeData(id, { vtype, fallback: typedDefault(vtype) });
	}
	function setVectorPart(index: number, value: number) {
		const current = Array.isArray(data.fallback) ? [...data.fallback] : [0, 0, 0];
		current[index] = value;
		setNodeData(id, { fallback: current });
	}
</script>

<NodeWrapper type={data.type} label={data.label}>
	{#if data.type === 'flowinput'}
		<Socket kind="source" nodeType={data.type} position={Position.Right} forceType={data.vtype ?? 'number'} />
	{:else}
		<!-- a Flow Output accepts ANY value type (only effect wires are blocked —
		     effects are animations, not values); neutral gray = the 'any' socket -->
		<Socket kind="target" nodeType={data.type} id="value" position={Position.Left} forceType="any" />
	{/if}
	<!-- NodeWrapper's slot is a flex ROW — stack the fields in ONE column or they
	     squeeze side-by-side and the name shows three letters -->
	<div class="flex w-full flex-col gap-1">
		<label class="flex w-full flex-col">
			<span class="text-gray-400">name</span>
			<input
				class="nodrag w-full"
				type="text"
				value={data.name ?? (data.type === 'flowinput' ? 'value' : 'out')}
				on:change={(e) => setNodeData(id, { name: e.currentTarget.value.trim() || 'value' })}
			/>
		</label>
		{#if data.type === 'flowinput'}
			<label class="flex w-full flex-col">
				<span class="text-gray-400">type</span>
				<select
					class="nodrag w-full"
					value={data.vtype ?? 'number'}
					on:change={(e) => onTypeChange(e.currentTarget.value)}
				>
					{#each VTYPES as t (t)}
						<option value={t}>{t}</option>
					{/each}
				</select>
			</label>
			<!-- the fallback editor matches the declared type -->
			<div class="flex w-full flex-col">
				<span class="text-gray-400">fallback</span>
				{#if (data.vtype ?? 'number') === 'boolean'}
					<label class="flex items-center gap-1">
						<input
							class="nodrag"
							type="checkbox"
							checked={data.fallback === true}
							on:change={(e) => setNodeData(id, { fallback: e.currentTarget.checked })}
						/>
						<span>{data.fallback === true ? 'true' : 'false'}</span>
					</label>
				{:else if (data.vtype ?? 'number') === 'color'}
					<input
						class="nodrag h-6 w-full"
						type="color"
						value={typeof data.fallback === 'string' ? data.fallback : '#ffffff'}
						on:change={(e) => setNodeData(id, { fallback: e.currentTarget.value })}
					/>
				{:else if (data.vtype ?? 'number') === 'vector3'}
					<div class="flex w-full gap-0.5">
						{#each ['x', 'y', 'z'] as axis, i (axis)}
							<input
								class="nodrag min-w-0 flex-1"
								type="number"
								step="0.1"
								title={axis}
								value={Array.isArray(data.fallback) ? data.fallback[i] ?? 0 : 0}
								on:change={(e) => setVectorPart(i, +e.currentTarget.value)}
							/>
						{/each}
					</div>
				{:else}
					<input
						class="nodrag w-full"
						type="number"
						step="0.1"
						value={typeof data.fallback === 'number' ? data.fallback : 0}
						on:change={(e) => setNodeData(id, { fallback: +e.currentTarget.value })}
					/>
				{/if}
			</div>
		{/if}
	</div>
</NodeWrapper>
