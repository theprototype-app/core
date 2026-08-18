<script lang="ts">
	// A3 — ONE generic card for the whole HUD group (the ShaderNode precedent). Every HUD
	// node names an ELEMENT by id and takes its parameters from the catalog spec, so the
	// only thing this card adds over AnimationNode is the element picker.
	//
	// The picker is an `<input list>` + `<datalist>`, NOT a select param (the PlayAnimNode
	// clip-field precedent): a node authored in the scene graph, or naming an element this
	// editor cannot enumerate — one a module creates, one on another screen — must still
	// work. Suggestions are a convenience, never the allowed set.
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { findNodeSpec } from '$lib/nodeCatalog';
	import { flowEdges, flowValues, activeGraphId, SCENE_GRAPH } from '../../../stores/flowStore';
	import { hudDocs, hudRuntime, elementChoices } from '$lib/hudDocs';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	$: spec = findNodeSpec(data.type);
	// which HUD document this node addresses: an object graph's id IS its owner uuid, and
	// the scene graph addresses the scene HUD
	$: docKey = $activeGraphId && $activeGraphId !== SCENE_GRAPH ? $activeGraphId : 'scene';
	// $hudDocs is read purely as the DEPENDENCY (elementChoices does a plain get()), and
	// it is passed as an unused argument rather than through a comma operator.
	const choicesFor = (key: string, _docs: any) => elementChoices(key);
	const screensOf = (key: string, docs: any) => (key ? (docs?.[key]?.screens ?? []) : []);
	$: choices = choicesFor(docKey, $hudDocs);
	// a screen node picks a SCREEN, everything else picks an ELEMENT
	$: isScreenNode = data.type === 'hudscreen';
	$: screenChoices = screensOf(docKey, $hudDocs);

	// the target sockets this node type declares, in a fixed order so the offsets are
	// stable as params come and go
	const INPUTS: Record<string, string[]> = {
		hudtext: ['value'],
		hudbar: ['value', 'min', 'max'],
		hudtimer: ['start', 'duration'],
		hudscreen: ['trigger'],
		hudlist: ['trigger'],
		hudbutton: []
	};
	$: inputs = INPUTS[data.type] ?? [];
	$: wiredSource = (key: string) =>
		($flowEdges as any[]).find((e) => e.target === id && e.targetHandle === key)?.source ?? null;
	function fmt(v: any) {
		if (v === undefined || v === null) return '…';
		if (typeof v === 'number') return (+v).toFixed(2);
		return String(v);
	}
	// what the bound element is showing right now, so the card is a live readout
	$: live = data.element ? ($hudRuntime as any)[String(data.element).trim()] : null;
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	{#each inputs as handle, i (handle)}
		<Socket kind="target" nodeType={data.type} position={Position.Left} id={handle} style={`top: ${34 + i * 38}px`} />
	{/each}
	<div class="flex w-full flex-col gap-1">
		{#if isScreenNode}
			<label class="flex flex-col">
				<span>screen</span>
				<input
					class="nodrag"
					list="hud-screens-{id}"
					placeholder="screen id"
					value={data.screen ?? ''}
					on:change={(e) => setNodeData(id, { screen: e.currentTarget.value.trim() })}
				/>
				<datalist id="hud-screens-{id}">
					{#each screenChoices as screen (screen.id)}
						<option value={screen.id}>{screen.name}</option>
					{/each}
				</datalist>
			</label>
			<!-- The thing that would otherwise be filed as a bug. Screen visibility is
			     deliberately per-peer: one player sits on the start menu while another
			     plays, which is the whole point of a menu in a shared session. -->
			<span class="hud-note">Shows on THIS peer only — each player has their own screen.</span>
		{:else}
			<label class="flex flex-col">
				<span>element</span>
				<input
					class="nodrag"
					list="hud-elements-{id}"
					placeholder="element id"
					value={data.element ?? ''}
					on:change={(e) => setNodeData(id, { element: e.currentTarget.value.trim() })}
				/>
				<datalist id="hud-elements-{id}">
					{#each choices as choice (choice.id)}
						<option value={choice.id}>{choice.kind} · {choice.screen}</option>
					{/each}
				</datalist>
			</label>
		{/if}

		{#if spec?.params}
			{#each spec.params as param (param.key)}
				{#if !(isScreenNode && param.key === 'screen')}
					<label class="flex flex-col">
						<span class="flex justify-between">
							<span>{param.key}</span>
							{#if param.kind === 'range' && !wiredSource(param.key)}
								<span>{data[param.key] ?? spec.defaults[param.key]}</span>
							{/if}
						</span>
						{#if param.kind === 'range' && wiredSource(param.key)}
							<span class="wired-value" title="Driven by the wired input">
								◈ {fmt($flowValues[wiredSource(param.key)])}
							</span>
						{:else if param.kind === 'range'}
							<input
								class="nodrag accent-[#ff4000]"
								type="range"
								min={param.min}
								max={param.max}
								step={param.step}
								value={data[param.key] ?? spec.defaults[param.key]}
								on:input={(e) => setNodeData(id, { [param.key]: +e.currentTarget.value })}
							/>
						{:else if param.kind === 'toggle'}
							<span class="nodrag flex items-center gap-1.5">
								<input
									type="checkbox"
									checked={!!(data[param.key] ?? spec.defaults[param.key])}
									on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.checked })}
								/>
							</span>
						{:else if param.kind === 'text'}
							<!-- `change`, never `input`: setNodeData replicates the whole node -->
							<input
								class="nodrag"
								type="text"
								placeholder={param.placeholder ?? ''}
								maxlength={param.maxLength ?? null}
								value={data[param.key] ?? spec.defaults[param.key] ?? ''}
								on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.value })}
							/>
						{:else if param.kind === 'select'}
							<select
								class="nodrag"
								value={data[param.key] ?? spec.defaults[param.key]}
								on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.value })}
							>
								{#each param.options ?? [] as option (option)}
									<option value={option}>{option}</option>
								{/each}
							</select>
						{/if}
					</label>
				{/if}
			{/each}
		{/if}

		{#if live}
			<span class="hud-live" title="What the bound element is showing now">
				{live.text !== undefined ? live.text : ''}
				{#if live.value !== undefined}<em>{fmt(live.value)}</em>{/if}
			</span>
		{/if}
	</div>
</NodeWrapper>

<style>
	.hud-note {
		margin-top: 2px;
		font-size: 10px;
		line-height: 1.3;
		opacity: 0.62;
	}
	.hud-live {
		margin-top: 2px;
		overflow: hidden;
		border-radius: 2px;
		background: rgb(17 24 39 / 0.7);
		padding: 1px 5px;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: #7dd3fc;
	}
	.hud-live em {
		font-style: normal;
		opacity: 0.65;
	}
	.wired-value {
		border-radius: 2px;
		background: rgb(17 24 39 / 0.7);
		padding: 1px 5px;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: #7dd3fc;
	}
</style>
