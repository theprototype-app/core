<script lang="ts">
	import { Position, type NodeProps } from '@xyflow/svelte';
	import { onDestroy } from 'svelte';
	import Socket from './Socket.svelte';
	import NodeWrapper from './NodeWrapper.svelte';
	import { setNodeData } from '$lib/nodesHandler';
	import DragRow from '../../ui/DragRow.svelte';
	import { flowValues } from '../../../stores/flowStore';
	import { GAMEPAD_BUTTONS, GAMEPAD_AXES } from '$lib/gamepadPrefs';
	import { onInput, gamepadName } from '$lib/inputRuntime';

	// 21-E5: ONE card for the whole gamepad group — the HudNode / ShaderNode precedent.
	// The two nodes share a device, a picker vocabulary and a live readout, and splitting
	// them would mean two files that drift.
	//
	// Legacy mode (`export let` + `on:`) like every sibling node card: a single `$state`
	// here would flip the file to runes mode and make every `on:` a warning against the
	// svelte-check baseline.
	type $$Props = NodeProps;
	export let id: string;
	export let data: any;

	// THE PRIMARY PATH IS THE SELECT, and capture is the convenience. A pad cannot be
	// pressed headlessly, so a capture-only control would be a feature no suite can drive
	// and no keyboard-only user can reach; the select always works, including for someone
	// authoring a pad binding with no pad plugged in.
	let capturing = false;
	let stopCapture: (() => void) | null = null;

	function endCapture() {
		capturing = false;
		stopCapture?.();
		stopCapture = null;
	}

	function beginCapture() {
		if (capturing) return endCapture();
		capturing = true;
		// the same positional channel the keyboard uses — fn(kind, code); pad codes are
		// namespaced 'Gamepad*', which is exactly what makes this filter safe
		stopCapture = onInput((kind: 'down' | 'up', code: string) => {
			if (kind !== 'down' || !code.startsWith('Gamepad')) return;
			setNodeData(id, { button: code });
			endCapture();
		});
	}

	onDestroy(endCapture);

	// the live value, so a stick can be TRIMMED against a real reading rather than guessed
	$: live = typeof $flowValues[id] === 'number' ? $flowValues[id] : 0;
	// gamepadName() is a plain module read, so a bare `$:` would run it ONCE and this
	// hint would never notice a pad being plugged in. `_tick` is the DEPENDENCY, not an
	// argument — the comma-operator form is reactive too but fails svelte-check.
	const padFor = (_tick: any) => gamepadName();
	$: pad = padFor($flowValues);
	// a button label without the 'Gamepad' prefix — the card is already a gamepad card
	const shortName = (code: string) => String(code ?? '').replace(/^Gamepad/, '');
</script>

<NodeWrapper type={data.type} label={data.label}>
	<Socket kind="source" nodeType={data.type} position={Position.Right} />
	<!-- one column: the wrapper slot is a flex ROW, so sibling fields would squeeze
	     side-by-side into the ~150px card -->
	<div class="flex w-full flex-col gap-1">
		{#if data.type === 'gamepadbutton'}
			<label class="flex w-full flex-col">
				<span class="text-gray-400">button</span>
				<select
					class="nodrag rounded-sm border border-gray-600 bg-transparent px-1 py-0.5 text-xs"
					value={data.button ?? 'GamepadA'}
					on:change={(e) => setNodeData(id, { button: e.currentTarget.value })}
				>
					{#each GAMEPAD_BUTTONS as code (code)}<option value={code}>{shortName(code)}</option>{/each}
				</select>
			</label>
			<button
				class="nodrag w-full rounded-sm border border-gray-600 px-1 py-0.5 text-xs {capturing
					? 'bg-primary-700 text-white'
					: ''}"
				on:click={beginCapture}
			>
				{capturing ? 'press a button…' : 'capture'}
			</button>
			<label class="flex w-full flex-col">
				<span class="text-gray-400">edge</span>
				<!-- the Key Press vocabulary verbatim: down = the pulse on press (a held button
				     keeps it high through the re-stamp), up = the falling edge, held = the same
				     read said as a level -->
				<select
					class="nodrag rounded-sm border border-gray-600 bg-transparent px-1 py-0.5 text-xs"
					value={data.edge ?? 'down'}
					on:change={(e) => setNodeData(id, { edge: e.currentTarget.value })}
				>
					{#each ['down', 'up', 'held'] as opt (opt)}<option value={opt}>{opt}</option>{/each}
				</select>
			</label>
			<label class="flex w-full flex-col">
				<span class="text-gray-400">pulse (s)</span>
				<DragRow
					nodrag
					step={0.01}
					decimals={2}
					min={0.1}
					value={data.pulse ?? 0.3}
					onchange={(v: number) => setNodeData(id, { pulse: v })}
				/>
			</label>
			<p class="text-[10px] text-gray-400">
				presses replicate as trigger stamps, like a key
			</p>
		{:else}
			<label class="flex w-full flex-col">
				<span class="text-gray-400">axis</span>
				<select
					class="nodrag rounded-sm border border-gray-600 bg-transparent px-1 py-0.5 text-xs"
					value={data.axis ?? 'lx'}
					on:change={(e) => setNodeData(id, { axis: e.currentTarget.value })}
				>
					{#each GAMEPAD_AXES as axis (axis)}<option value={axis}>{axis}</option>{/each}
				</select>
			</label>
			<span class="rounded-sm bg-gray-900/70 px-1.5 py-0.5 font-mono text-[11px] text-primary-300"
				>{live.toFixed(2)}</span
			>
			<label class="flex w-full flex-col">
				<span class="text-gray-400">deadzone</span>
				<DragRow
					nodrag
					step={0.01}
					decimals={2}
					min={0}
					max={0.9}
					value={data.deadzone ?? 0}
					onchange={(v: number) => setNodeData(id, { deadzone: v })}
				/>
			</label>
			<label class="flex w-full flex-col">
				<span class="text-gray-400">scale</span>
				<DragRow
					nodrag
					step={0.1}
					decimals={2}
					value={data.scale ?? 1}
					onchange={(v: number) => setNodeData(id, { scale: v })}
				/>
			</label>
			<label class="flex w-full items-center gap-1">
				<input
					type="checkbox"
					class="nodrag"
					checked={!!data.invert}
					on:change={(e) => setNodeData(id, { invert: e.currentTarget.checked })}
				/>
				<span class="text-gray-400">invert</span>
			</label>
			<!-- SAY IT ON THE CARD. A stick is local hardware, so every peer evaluates this
			     node against ITS OWN pad and gets a different number — that is the design
			     (never stream local state), but without the notice it gets filed as a sync
			     bug. A shared axis goes through the controller/possess authority instead. -->
			<p class="text-[10px] text-gray-400">
				local to this player — peers do not see this value
			</p>
		{/if}
		{#if !pad}
			<p class="text-[10px] text-amber-400">no gamepad detected</p>
		{/if}
	</div>
</NodeWrapper>
