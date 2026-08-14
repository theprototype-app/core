<script>
	// 18-C2: the Edit Mesh toolbox's TOOL OPTIONS pane — the parameters of
	// whichever tool is currently selected, right under the tool grid.
	//
	// Before this, every tool's parameters were permanently visible somewhere in
	// the toolbox, in an order that had nothing to do with the tool that used
	// them: the bevel width sat under the GIZMO section, the extrude amount at
	// the very bottom of the window, and the merge distance two sections away
	// from the Merge button. The pane shows one tool's options at a time and
	// nothing at all when the selected tool has none — no empty chrome.
	//
	// The operators are NOT called from here: the toolbox owns the toasts, the
	// flash feedback and the "is there a target" checks, so the Apply buttons
	// call back into it. This component is layout.
	import {
		faceEditAmount,
		faceAutoApply
	} from '$lib/faceEdit';
	import { proportionalRadius } from '$lib/meshEdit';
	import { bevelWidth, bevelSegments, bevelProfile, loopCuts, bridgeCuts } from '$lib/meshToolParams';
	import DragRow from '../ui/DragRow.svelte';

	/** @type {{ mode: 'vertices'|'edges'|'faces', focus: string,
	 *   onApplyOp: () => void, onApplyBevel: () => void, onApplyLoopCut: () => void,
	 *   onApplyBridge: () => void }} */
	let { mode, focus, onApplyOp, onApplyBevel, onApplyLoopCut, onApplyBridge } = $props();

	// faces bevel takes (width, segments); edges (width, segments, profile);
	// vertices (width, profile) — the pane mirrors the operator signatures
	const showSegments = $derived(mode !== 'vertices');
	const showProfile = $derived(mode !== 'faces');
</script>

{#if focus === 'extrude' || focus === 'inset'}
	<!-- 176: the amount row keeps its id — it is the toolbox's oldest e2e contract -->
	<span class="tbx-label">{focus} options</span>
	<div id="mesh-op-params" class="tbx-row text-xs text-gray-300">
		<DragRow
			id="mesh-op-amount"
			label="amount"
			value={$faceEditAmount}
			step={0.01}
			decimals={2}
			title="How far Extrude pushes, or how far Inset shrinks (drag to scrub, type, arrows step)"
			onchange={(v) => faceEditAmount.set(v)}
		/>
		<label class="flex items-center gap-1" title="Apply the op when you click a face">
			<input id="mesh-op-autoapply" type="checkbox" bind:checked={$faceAutoApply} />
			auto-apply
		</label>
		<button
			id="mesh-op-apply"
			class="tbx-primary"
			title="Apply the active op to the selected face"
			onclick={onApplyOp}>Apply</button
		>
	</div>
{:else if focus === 'bevel'}
	<span class="tbx-label">Bevel options</span>
	<div id="bevel-params" class="tbx-row text-xs text-gray-300">
		<DragRow
			id="bevel-width"
			label="width"
			value={$bevelWidth}
			step={0.005}
			snap={0.05}
			decimals={3}
			min={0.001}
			title="How far the chamfer reaches (clamped per edge so two bevels can never cross)"
			onchange={(v) => bevelWidth.set(v)}
		/>
		{#if showSegments}
			<DragRow
				id="bevel-segments"
				label="segments"
				value={$bevelSegments}
				step={0.05}
				decimals={0}
				min={1}
				max={8}
				title="More segments = a rounder edge"
				onchange={(v) => bevelSegments.set(Math.round(v))}
			/>
		{/if}
		{#if showProfile}
			<label
				class="flex items-center gap-1"
				title="Profile: 0 is a flat chamfer, positive domes the cap OUT, negative dishes it IN"
			>
				profile
				<input
					id="bevel-profile"
					type="range"
					min="-1"
					max="1"
					step="0.1"
					class="w-20"
					bind:value={$bevelProfile}
				/>
				<span class="w-10 text-right tabular-nums"
					>{$bevelProfile > 0.05 ? 'out' : $bevelProfile < -0.05 ? 'in' : 'flat'}</span
				>
			</label>
		{/if}
		<button
			id="face-bevel"
			class="tbx-primary"
			title={mode === 'vertices'
				? 'Cut the corner off every selected vertex and cap it'
				: mode === 'edges'
					? 'Replace each selected edge with a chamfer strip'
					: "Chamfer the selected face's border (inset + push per segment)"}
			onclick={onApplyBevel}>Apply bevel</button
		>
	</div>
{:else if focus === 'loopcut'}
	<span class="tbx-label">Loop cut options</span>
	<div id="loopcut-params" class="tbx-row text-xs text-gray-300">
		<DragRow
			id="mesh-loop-cuts"
			label="cuts"
			value={$loopCuts}
			step={0.05}
			decimals={0}
			min={1}
			max={20}
			title="How many edge loops Loop cut inserts"
			onchange={(v) => loopCuts.set(Math.round(v))}
		/>
		<button
			id="mesh-loopcut-apply"
			class="tbx-primary"
			title="Insert the loops across the ring the selection lies on (C)"
			onclick={onApplyLoopCut}>Cut</button
		>
	</div>
{:else if focus === 'bridge'}
	<span class="tbx-label">Bridge options</span>
	<div id="bridge-params" class="tbx-row text-xs text-gray-300">
		<DragRow
			id="mesh-bridge-cuts"
			label="cuts"
			value={$bridgeCuts}
			step={0.05}
			decimals={0}
			min={0}
			max={20}
			title="Extra loops along the tunnel. 0 is a single band; more rings give the bridge something to deform with afterwards."
			onchange={(v) => bridgeCuts.set(Math.round(v))}
		/>
		<button
			id="mesh-bridge-apply"
			class="tbx-primary"
			title="Bridge the two selected pieces (B) — they need one closed boundary each and matching edge counts"
			onclick={onApplyBridge}>Bridge</button
		>
	</div>
{:else if focus === 'proportional'}
	<span class="tbx-label">Proportional options</span>
	<div class="tbx-row text-xs text-gray-300">
		<DragRow
			id="mesh-proportional-radius"
			label="radius"
			value={$proportionalRadius}
			step={0.02}
			decimals={2}
			min={0.01}
			title="How far the drag carries its neighbours (local units). Weight fades smoothly to zero at the radius."
			onchange={(v) => proportionalRadius.set(v)}
		/>
	</div>
{:else if focus === 'move'}
	<span class="tbx-label">Move options</span>
	<div class="tbx-row text-xs text-gray-400">Drag the gizmo. Its orientation is above.</div>
{:else if focus === 'knife'}
	<span class="tbx-label">Knife options</span>
	<div class="tbx-row text-xs text-gray-400">
		Click one end of the cut, then the other. Esc drops a pending cut.
	</div>
{/if}
