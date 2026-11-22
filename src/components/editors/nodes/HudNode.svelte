<script lang="ts">
	// A3 — ONE generic card for the whole HUD group (the ShaderNode precedent). Every HUD
	// node names an ELEMENT by id and takes its parameters from the catalog spec, so the
	// only thing this card adds over AnimationNode is the element picker.
	//
	// 21-D3: the picker is HudElementPicker - a resolved NAME, a grouped searchable list, a
	// clear X, an amber unresolved state and an artboard eyedropper. It replaced an
	// `<input list>` + `<datalist>`, which reads as a FILTER rather than a reference and
	// shows a raw id, so a field naming nothing looked exactly like one naming a real
	// element. The constraint that control got right survives inside the picker: a typed id
	// this editor cannot enumerate still works, so suggestions stay a convenience and never
	// become the allowed set.
	import { Position, type NodeProps } from '@xyflow/svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import { findNodeSpec } from '$lib/nodeCatalog';
	import { flowEdges, flowValues, activeGraphId } from '../../../stores/flowStore';
	import { hudRuntime, hudDocs, hudDocKeyFor } from '$lib/hudDocs';
	import HudElementPicker from '../../hud/HudElementPicker.svelte';

	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	$: spec = findNodeSpec(data.type);
	// 21-E2.2: which HUD document this node addresses. This used to be "the graph id unless
	// it is the scene graph", i.e. the OBJECT UUID inside an object graph — and almost no
	// object has a HUD document, so the picker enumerated nothing and offered "nothing on
	// any screen yet" with a full scene HUD right there. `hudDocKeyFor` answers the owner's
	// own document when one exists (a camera HUD) and the scene HUD otherwise. `$hudDocs`
	// is the DEPENDENCY: the helper reads the store through get(), so without it the key
	// would never re-derive when a camera HUD is created.
	const keyFor = (graphId: string, _docs: any) => hudDocKeyFor(graphId);
	$: docKey = keyFor($activeGraphId, $hudDocs);
	// a screen node picks a SCREEN, everything else picks an ELEMENT. The picker owns the
	// enumeration and the reactivity now, so this card just says which mode it is in.
	$: isScreenNode = data.type === 'hudscreen';

	// the target sockets this node type declares, in a fixed order so the offsets are
	// stable as params come and go
	const INPUTS: Record<string, string[]> = {
		// 36 (U10): `format` = the whole text, wired (a rules node's line) — it had no socket, so
		// such wires were invisible on the card
		hudtext: ['value', 'format'],
		hudbar: ['value', 'min', 'max'],
		hudtimer: ['start', 'duration'],
		hudscreen: ['trigger'],
		hudlist: ['trigger'],
		hudbutton: [],
		// 102b-hud: Show / Hide Element — a trigger, or a wired visible (above 0 = shown)
		hudvisible: ['trigger', 'visible'],
		// fix-batch-1 (docs-1 Q1): the runtime read these (flowSockets types them) but the card
		// drew no socket, so neither node could be wired by hand
		hudrows: ['trigger', 'text'],
		hudset: ['trigger', 'value', 'options']
	};
	$: inputs = INPUTS[data.type] ?? [];
	// 80a-fix4-ui D2: each socket sits BESIDE ITS ROW (it used to sit at 34 + 38 * i px, which drifted off the rows as
	// soon as a card had a picker or a note above them) and says what it takes. An input with a param row rides that
	// row; one without (a trigger, a wired-only text) gets a named row of its own at the top
	const TIPS: Record<string, string> = {
		value: 'value: the number to show',
		format: 'format: the whole text, wired in',
		min: 'min: the empty end of the bar',
		max: 'max: the full end of the bar',
		start: 'start: a pulse starts the timer',
		duration: 'duration: seconds',
		trigger: 'trigger: a pulse runs this node',
		text: 'text: the rows, one per line',
		options: 'options: the dropdown choices, one per line'
	};
	const tip = (key: string) => TIPS[key] ?? key;
	$: paramKeys = new Set(((spec?.params ?? []) as any[]).map((p) => p.key));
	$: namedRows = inputs.filter((k) => !paramKeys.has(k));
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
	{#if data.type === 'hudbutton'}
		<!-- 102b-hud: the pressed button's value -->
		<Socket kind="source" nodeType={data.type} position={Position.Right} id="value" style="top: 72px" />
	{/if}
	<div class="flex w-full flex-col gap-1">
		{#each namedRows as handle (handle)}
			<div class="hud-in relative -mx-3 flex h-5 items-center px-3" data-socket={handle}>
				<Socket kind="target" nodeType={data.type} position={Position.Left} id={handle} style="top: 50%;" title={tip(handle)} />
				<span class="truncate text-[10px] text-text-2" title={tip(handle)}>{handle}</span>
			</div>
		{/each}
		{#if isScreenNode}
			<div class="flex flex-col">
				<span>screen</span>
				<HudElementPicker
					mode="screen"
					{docKey}
					value={data.screen ?? ''}
					onpick={(next) => setNodeData(id, { screen: next })}
				/>
			</div>
			<!-- The thing that would otherwise be filed as a bug. Screen visibility is
			     deliberately per-peer: one player sits on the start menu while another
			     plays, which is the whole point of a menu in a shared session. -->
			<span class="hud-note">Shows on THIS peer only — each player has their own screen.</span>
		{:else}
			<div class="flex flex-col">
				<span>element</span>
				<HudElementPicker
					{docKey}
					value={data.element ?? ''}
					onpick={(next) => setNodeData(id, { element: next })}
				/>
			</div>
		{/if}

		{#if spec?.params}
			{#each spec.params as param (param.key)}
				{#if data.type === 'hudbutton' && param.key === 'screen'}
					<!-- 102b-hud: leave the element empty to answer every button on this screen -->
					<div class="flex flex-col" title="Leave the element empty: this node then fires for every button on this screen, and its value output says which">
						<span>or any button on screen</span>
						<HudElementPicker mode="screen" {docKey} value={data.screen ?? ''} onpick={(next) => setNodeData(id, { screen: next })} />
					</div>
					<span class="hud-note">value output: the pressed button's value field</span>
				{:else if !(isScreenNode && param.key === 'screen')}
					<div class="relative" class:hud-row-in={inputs.includes(param.key)} data-socket={inputs.includes(param.key) ? param.key : undefined}>
					{#if inputs.includes(param.key)}
						<Socket kind="target" nodeType={data.type} position={Position.Left} id={param.key} style="top: 50%;" title={tip(param.key)} />
					{/if}
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
								class="nodrag nopan accent-accent"
								type="range"
								min={param.min}
								max={param.max}
								step={param.step}
								value={data[param.key] ?? spec.defaults[param.key]}
								on:input={(e) => setNodeData(id, { [param.key]: +e.currentTarget.value })}
							/>
						{:else if param.kind === 'toggle'}
							<span class="nodrag nopan flex items-center gap-1.5">
								<input
									type="checkbox"
									checked={!!(data[param.key] ?? spec.defaults[param.key])}
									on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.checked })}
								/>
							</span>
						{:else if param.kind === 'text'}
							<!-- `change`, never `input`: setNodeData replicates the whole node -->
							<input
								class="nodrag nopan"
								type="text"
								placeholder={param.placeholder ?? ''}
								maxlength={param.maxLength ?? null}
								value={data[param.key] ?? spec.defaults[param.key] ?? ''}
								on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.value })}
							/>
						{:else if param.kind === 'select'}
							<select
								class="nodrag nopan"
								value={data[param.key] ?? spec.defaults[param.key]}
								on:change={(e) => setNodeData(id, { [param.key]: e.currentTarget.value })}
							>
								{#each param.options ?? [] as option (option)}
									<option value={option}>{option}</option>
								{/each}
							</select>
						{/if}
					</label>
					</div>
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
	/* D2: a param row that takes a wire reaches the card's edge, so its socket sits on the edge beside it */
	.hud-row-in {
		margin-inline: -0.75rem;
		padding-inline: 0.75rem;
	}
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
		background: var(--surface-inset);
		padding: 1px 5px;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--accent-text);
	}
	.hud-live em {
		font-style: normal;
		opacity: 0.65;
	}
	.wired-value {
		border-radius: 2px;
		background: var(--surface-inset);
		padding: 1px 5px;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: var(--accent-text);
	}
</style>
