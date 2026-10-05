<script lang="ts">
	// 34 R3 (D2): one node of a behaviour's DERIVED view — read-only, its live value and its
	// fired glow laid on by BehaviourView every 100 ms. A param node carries a knob that writes
	// back into the source literal (one AST edit, one undo entry) when released.
	import { Handle, Position } from '@xyflow/svelte';
	import { formatValue } from '$lib/behaviours/graph.js';

	let { id, data }: { id: string; data: any } = $props();
	const ICON: Record<string, string> = { event: '⚡', param: '◆', fn: 'ƒ', state: '▣', kit: '⊕', timer: '⏱', action: '✋' };
	const kind = $derived(data.view?.kind ?? 'fn');
	let dragging = $state<number | null>(null);
	const shown = $derived(dragging ?? data.live);
</script>

<div
	class="bview-node bview-{kind}"
	class:bview-glow={data.glow}
	class:bview-error={!!data.error || data.unknown}
	data-bview-id={id}
	data-bview-kind={kind}
	title={data.line ? 'line ' + data.line : ''}
>
	{#if kind !== 'event' && kind !== 'param'}
		<Handle type="target" position={Position.Left} isConnectable={false} />
	{/if}
	<div class="bview-head">
		<span class="bview-icon">{ICON[kind] ?? '•'}</span>
		<span class="bview-label">{data.label}</span>
		{#if kind === 'fn' && data.random}<span class="bview-tag" title="uses this.rand()">🎲</span>{/if}
	</div>
	{#if data.sub}<div class="bview-sub">{data.sub}</div>{/if}
	{#if kind === 'event' && data.outputs?.length}
		<div class="bview-sub">{data.outputs.join(' · ')}</div>
	{/if}
	{#if kind === 'param'}
		<div class="bview-value" data-bview-value>{formatValue(shown)}{data.unit ? ' ' + data.unit : ''}</div>
		{#if data.editable && data.ptype === 'number'}
			<input
				class="nodrag nopan bview-knob"
				type="range"
				min={data.min}
				max={data.max}
				step={data.step}
				value={shown}
				data-bview-knob={data.key}
				oninput={(e) => {
					dragging = Number((e.currentTarget as HTMLInputElement).value);
					data.onKnob?.(data.key, dragging, false);
				}}
				onchange={(e) => {
					const v = Number((e.currentTarget as HTMLInputElement).value);
					data.onKnob?.(data.key, v, true);
					dragging = null;
				}}
			/>
		{:else if data.editable && data.ptype === 'boolean'}
			<label class="nodrag nopan bview-sub"><input type="checkbox" checked={!!shown} onchange={(e) => data.onKnob?.(data.key, (e.currentTarget as HTMLInputElement).checked, true)} /> on</label>
		{/if}
	{:else if data.liveText !== undefined}
		<div class="bview-value" data-bview-value>{data.liveText}</div>
	{/if}
	{#if data.error}<div class="bview-err">⚠ {data.error}</div>{/if}
	{#if kind !== 'state' && kind !== 'kit' && kind !== 'action'}
		<Handle type="source" position={Position.Right} isConnectable={false} />
	{/if}
</div>

<style>
	.bview-node {
		min-width: 170px;
		max-width: 230px;
		padding: 5px 8px;
		border-radius: 6px;
		border: 1px solid #4b5563;
		background: #1f2937;
		color: #e5e7eb;
		font-size: 11px;
		line-height: 1.25;
		transition: box-shadow 0.25s, border-color 0.25s;
	}
	.bview-event { border-left: 3px solid #facc15; }
	.bview-param { border-left: 3px solid #38bdf8; }
	.bview-fn { border-left: 3px solid #2dd4bf; }
	.bview-state { border-left: 3px solid #fb923c; }
	.bview-kit { border-left: 3px solid #34d399; }
	.bview-timer { border-left: 3px solid #c084fc; }
	.bview-action { border-left: 3px solid #f87171; }
	.bview-glow {
		border-color: #fde047;
		box-shadow: 0 0 10px 2px rgba(253, 224, 71, 0.65);
	}
	.bview-error { border-color: #ef4444; }
	.bview-head { display: flex; gap: 5px; align-items: center; font-weight: 600; }
	.bview-icon { opacity: 0.85; }
	.bview-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.bview-tag { margin-left: auto; }
	.bview-sub { color: #9ca3af; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.bview-value { font-family: ui-monospace, monospace; color: #fef3c7; font-size: 12px; margin-top: 2px; }
	.bview-knob { width: 100%; margin-top: 3px; accent-color: #38bdf8; }
	.bview-err { color: #fca5a5; font-size: 10px; white-space: normal; }
</style>
