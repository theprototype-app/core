<script>
	// ONE generic node for the whole shader catalog (plan SH3). Sockets and param
	// widgets are rendered from `shaderNodeDef`, so adding a node type is a catalog
	// entry and never a new component — the opposite of the flow editor, where each
	// custom node is its own file because their UIs genuinely differ.
	//
	// Handle placement follows the ObjectFlowNode reference: NodeWrapper's content box
	// is `relative p-3`, so an absolutely-positioned Handle anchors to the PADDED box.
	// Each socket row is its own relative wrapper with `-mx-3 px-3` to cancel that
	// padding, which puts the handle ON the card edge, centred on its label.
	import { Handle, Position } from '@xyflow/svelte';
	import { shaderNodeDef } from '$lib/shaderCatalog';
	import { setShaderParam } from '$lib/shaderGraph';
	import { beginShaderGesture, endShaderGesture } from '$lib/shaderSync';

	let { id, data, type } = $props();

	const def = $derived(shaderNodeDef(type));
	const graphKey = $derived(data?.__graphKey ?? null);

	/** @type {Record<string, string>} */
	const TYPE_COLOUR = {
		float: '#9ca3af',
		vec2: '#4ade80',
		vec3: '#60a5fa',
		vec4: '#c084fc',
		sampler2D: '#fbbf24'
	};

	/** @param {any} socket */
	function colourOf(socket) {
		return TYPE_COLOUR[socket?.type] ?? '#9ca3af';
	}

	/** @param {string} name @param {any} value */
	function writeParam(name, value) {
		if (!graphKey) return;
		setShaderParam(graphKey, id, name, value);
	}

	/** a slider/number drag is ONE undo entry, not one per frame */
	function startDrag() {
		if (graphKey) beginShaderGesture(graphKey);
	}
	function endDrag() {
		if (graphKey) endShaderGesture(graphKey);
	}
</script>

<div class="shader-node flex w-full flex-col gap-1">
	<div class="shader-node-title">{def?.label ?? type}</div>

	{#each def?.inputs ?? [] as socket (socket.name)}
		<div class="relative -mx-3 px-3 py-[2px] text-[10px] text-gray-300">
			<Handle
				type="target"
				position={Position.Left}
				id={socket.name}
				style="top:50%; background:{colourOf(socket)}"
			/>
			{socket.name}
		</div>
	{/each}

	{#each def?.params ?? [] as param (param.name)}
		<label class="shader-param">
			<span>{param.name}</span>
			{#if param.type === 'vec3' && typeof (data?.[param.name] ?? param.default) === 'string'}
				<input
					type="color"
					value={data?.[param.name] ?? param.default}
					oninput={(e) => writeParam(param.name, e.currentTarget.value)}
				/>
			{:else if param.type === 'float'}
				<input
					type="number"
					step="0.05"
					value={data?.[param.name] ?? param.default}
					onpointerdown={startDrag}
					onpointerup={endDrag}
					oninput={(e) => writeParam(param.name, Number(e.currentTarget.value))}
				/>
			{:else if param.type === 'enum'}
				<select
					value={data?.[param.name] ?? param.default}
					onchange={(e) => writeParam(param.name, e.currentTarget.value)}
				>
					{#each param.options ?? [] as option (option)}
						<option value={option}>{option}</option>
					{/each}
				</select>
			{:else}
				<input
					type="text"
					value={data?.[param.name] ?? param.default}
					onchange={(e) => writeParam(param.name, e.currentTarget.value)}
				/>
			{/if}
		</label>
	{/each}

	{#each def?.outputs ?? [] as socket (socket.name)}
		<div class="relative -mx-3 px-3 py-[2px] text-right text-[10px] text-gray-300">
			{socket.name}
			<Handle
				type="source"
				position={Position.Right}
				id={socket.name}
				style="top:50%; background:{colourOf(socket)}"
			/>
		</div>
	{/each}
</div>

<style>
	.shader-node-title {
		font-size: 11px;
		font-weight: 600;
		color: var(--text, #e5e7eb);
		border-bottom: 1px solid rgba(255, 255, 255, 0.12);
		padding-bottom: 2px;
		margin-bottom: 2px;
	}
	.shader-param {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		font-size: 10px;
		color: #d1d5db;
	}
	.shader-param input[type='number'],
	.shader-param input[type='text'],
	.shader-param select {
		width: 62px;
		background: rgba(0, 0, 0, 0.35);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 3px;
		padding: 1px 3px;
		font-size: 10px;
		color: #f3f4f6;
	}
	.shader-param input[type='color'] {
		width: 34px;
		height: 18px;
		padding: 0;
		border: 1px solid rgba(255, 255, 255, 0.15);
		background: transparent;
	}
</style>
