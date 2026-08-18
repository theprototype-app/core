<script>
	// ONE generic node for the whole shader catalog (plan SH3). Sockets and param
	// widgets render from `shaderNodeDef`, so adding a node type is a catalog entry and
	// never a new component — the flow editor's per-node files exist because those UIs
	// genuinely differ; these do not.
	//
	// Chrome mirrors NodeWrapper.svelte (same `.node-card` shell, so flow.css styles the
	// inputs and the selected/dragging states for free) with the header tinted by CATALOG
	// GROUP. Both Unreal and Unity colour shader nodes by category because a shader graph
	// gets dense fast and category is the quickest way to read one.
	//
	// Handles carry `socket-typed` and set `--socket-color` from the GLSL type, reusing
	// the node editor's socket CSS — including the hover/connecting states and the RED
	// invalid-target styling. Each socket row is its own relative wrapper with
	// `-mx-3 px-3` to cancel the card's padding, so the handle sits ON the card edge
	// centred on its label (the ObjectFlowNode recipe).
	import { Handle, Position } from '@xyflow/svelte';
	import { shaderNodeDef, SURFACE_NODE } from '$lib/shaderCatalog';
	import { setShaderParam } from '$lib/shaderGraph';
	import { beginShaderGesture, endShaderGesture } from '$lib/shaderSync';
	import ShaderTexturePicker from './ShaderTexturePicker.svelte';
	import ShaderVectorInput from './ShaderVectorInput.svelte';
	import DragRow from '../../ui/DragRow.svelte';

	let { id, data, type } = $props();

	const def = $derived(shaderNodeDef(type));
	const graphKey = $derived(data?.__graphKey ?? null);

	// group accents deliberately echo the node editor's language (flow's Input blue,
	// Logic teal, Effects purple) so the two editors read as one app
	/** @type {Record<string, string>} */
	const GROUP_ACCENT = {
		Input: '#38bdf8',
		Math: '#2dd4bf',
		Channel: '#facc15',
		UV: '#4ade80',
		Utility: '#c084fc',
		Output: '#fb923c'
	};
	const accent = $derived(GROUP_ACCENT[def?.group ?? ''] ?? '#94a3b8');

	// GLSL type -> socket colour. Distinct per width so a mis-wire is visible before
	// the coercion silently reinterprets it.
	/** @type {Record<string, string>} */
	const TYPE_COLOUR = {
		float: '#9ca3af',
		vec2: '#4ade80',
		vec3: '#60a5fa',
		vec4: '#c084fc',
		sampler2D: '#fbbf24'
	};

	/** @param {any} socket */
	function socketStyle(socket) {
		return '--socket-color: ' + (TYPE_COLOUR[socket?.type] ?? '#9ca3af') + '; top: 50%;';
	}

	/** @param {string} name @param {any} value */
	function writeParam(name, value) {
		if (graphKey) setShaderParam(graphKey, id, name, value);
	}

	/** a drag/scrub is ONE undo entry, not one per frame */
	function startGesture() {
		if (graphKey) beginShaderGesture(graphKey);
	}
	function endGesture() {
		if (graphKey) endShaderGesture(graphKey);
	}
</script>

<div
	class="node-card flex h-full flex-col rounded-lg border border-gray-600/70 bg-gray-800/95 text-gray-200 shadow-lg"
	style={`--node-accent: ${accent}; border-top: 2px solid ${accent}`}
>
	<div
		class="flex items-center gap-1.5 rounded-t-md border-b border-gray-700/60 bg-gray-900/50 px-3 py-1.5 font-mono text-xs font-semibold text-gray-100"
	>
		<span class="h-2 w-2 shrink-0 rounded-full" style="background: var(--node-accent)"></span>
		<span class="overflow-hidden text-ellipsis whitespace-nowrap">
			{data?.label || def?.label || type}
		</span>
	</div>

	<div class="relative flex flex-col gap-1 rounded-b-lg p-3 text-xs text-gray-300">
		{#each def?.inputs ?? [] as socket (socket.name)}
			<div class="socket-row relative -mx-3 px-3">
				<Handle
					type="target"
					position={Position.Left}
					id={socket.name}
					class="socket-typed"
					style={socketStyle(socket)}
				/>
				<span class="socket-label">{socket.name}</span>
			</div>
		{/each}

		{#each def?.params ?? [] as param (param.name)}
			{#if param.type === 'texture'}
				<!-- NOT a <label>: the picker owns one of its own around the file input, and
				     nesting labels is invalid HTML that double-fires the click -->
				<div class="shader-param">
					<span class="socket-label">{param.name}</span>
					<ShaderTexturePicker
						compact
						hash={data?.[param.name] ?? ''}
						onpick={(/** @type {string} */ next) => writeParam(param.name, next)}
					/>
				</div>
			{:else}
			<label class="shader-param">
				<span class="socket-label">{param.name}</span>
				{#if param.type === 'vec3' && typeof (data?.[param.name] ?? param.default) === 'string'}
					<input
						type="color"
						value={data?.[param.name] ?? param.default}
						oninput={(e) => writeParam(param.name, e.currentTarget.value)}
					/>
				{:else if param.type === 'vec2' || param.type === 'vec3' || param.type === 'vec4'}
					<ShaderVectorInput
						value={data?.[param.name] ?? param.default}
						size={param.type === 'vec2' ? 2 : param.type === 'vec4' ? 4 : 3}
						onchange={(/** @type {number[]} */ next) => writeParam(param.name, next)}
						onstart={startGesture}
						onend={endGesture}
					/>
				{:else if param.type === 'float'}
					<DragRow
						nodrag
						step={0.005}
						decimals={3}
						value={data?.[param.name] ?? param.default}
						onscrubstart={startGesture}
						onscrubend={endGesture}
						onchange={(/** @type {number} */ v) => writeParam(param.name, v)}
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
			{/if}
		{/each}

		{#each def?.outputs ?? [] as socket (socket.name)}
			<div class="socket-row relative -mx-3 px-3 text-right">
				<span class="socket-label">{socket.name}</span>
				<Handle
					type="source"
					position={Position.Right}
					id={socket.name}
					class="socket-typed"
					style={socketStyle(socket)}
				/>
			</div>
		{/each}

		{#if type === SURFACE_NODE}
			<p class="mt-1 text-[9px] leading-tight text-gray-500">
				Unconnected inputs keep the material's own value
			</p>
		{/if}
	</div>
</div>

<style>
	.socket-row {
		padding-top: 2px;
		padding-bottom: 2px;
		min-height: 16px;
	}
	.socket-label {
		font-size: 10px;
		color: #d1d5db;
	}
	.shader-param {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
	}
	/* widths only — flow.css styles .node-card inputs, so they match the node editor */
	.shader-param :global(input[type='number']),
	.shader-param :global(input[type='text']),
	.shader-param :global(select) {
		width: 64px;
	}
	.shader-param input[type='color'] {
		width: 34px;
		height: 18px;
		padding: 0;
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 3px;
		background: transparent;
	}
	:global(.svelte-flow__node.selected) .node-card {
		border-color: var(--node-accent);
		box-shadow: 0 0 0 1px var(--node-accent), 0 8px 18px rgb(0 0 0 / 0.45);
	}
	:global(.svelte-flow__node.dragging) .node-card {
		opacity: 0.85;
	}
</style>
