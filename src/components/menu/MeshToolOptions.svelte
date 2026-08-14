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
	import { bevelWidth, bevelSegments, bevelProfile, loopCuts } from '$lib/meshToolParams';

	/** @type {{ mode: 'vertices'|'edges'|'faces', focus: string,
	 *   onApplyOp: () => void, onApplyBevel: () => void, onApplyLoopCut: () => void }} */
	let { mode, focus, onApplyOp, onApplyBevel, onApplyLoopCut } = $props();

	// faces bevel takes (width, segments); edges (width, segments, profile);
	// vertices (width, profile) — the pane mirrors the operator signatures
	const showSegments = $derived(mode !== 'vertices');
	const showProfile = $derived(mode !== 'faces');
</script>

{#if focus === 'extrude' || focus === 'inset'}
	<!-- 176: the amount row keeps its id — it is the toolbox's oldest e2e contract -->
	<span class="tbx-label">{focus} options</span>
	<div id="mesh-op-params" class="tbx-row text-xs text-gray-300">
		<label class="flex items-center gap-1">
			amount
			<input
				id="mesh-op-amount"
				type="number"
				step="0.05"
				class="w-14 rounded-sm bg-gray-900 px-1 py-0.5 text-right"
				bind:value={$faceEditAmount}
			/>
		</label>
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
		<label
			class="flex items-center gap-1"
			title="How far the chamfer reaches (clamped per edge so two bevels can never cross)"
		>
			width
			<input
				id="bevel-width"
				type="number"
				step="0.02"
				min="0.001"
				class="w-14 rounded-sm bg-gray-900 px-1 py-0.5 text-right"
				bind:value={$bevelWidth}
			/>
		</label>
		{#if showSegments}
			<label class="flex items-center gap-1" title="More segments = a rounder edge">
				segments
				<input
					id="bevel-segments"
					type="number"
					step="1"
					min="1"
					max="8"
					class="w-12 rounded-sm bg-gray-900 px-1 py-0.5 text-right"
					bind:value={$bevelSegments}
				/>
			</label>
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
		<label class="flex items-center gap-1" title="How many edge loops Loop cut inserts">
			cuts
			<input
				id="mesh-loop-cuts"
				type="number"
				min="1"
				max="20"
				step="1"
				class="w-12 rounded-sm bg-gray-900 px-1 py-0.5 text-right"
				bind:value={$loopCuts}
			/>
		</label>
		<button
			id="mesh-loopcut-apply"
			class="tbx-primary"
			title="Insert the loops across the ring the selection lies on (C)"
			onclick={onApplyLoopCut}>Cut</button
		>
	</div>
{:else if focus === 'proportional'}
	<span class="tbx-label">Proportional options</span>
	<div class="tbx-row text-xs text-gray-300">
		<label
			class="flex items-center gap-1"
			title="How far the drag carries its neighbours (local units). Weight fades smoothly to zero at the radius."
		>
			radius
			<input
				id="mesh-proportional-radius"
				type="number"
				step="0.1"
				min="0.01"
				class="w-14 rounded-sm bg-gray-900 px-1 py-0.5 text-right"
				bind:value={$proportionalRadius}
			/>
		</label>
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
