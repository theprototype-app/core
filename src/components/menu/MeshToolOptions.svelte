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
	// 19-A P2: the pane has TWO faces now. Normally it shows the tool's rows, an
	// Apply button and — when the op's precondition is unmet — a hint line
	// (#mesh-op-hint) saying what is missing. While the ADJUST ENGINE holds the
	// focused op it becomes the live adjust: "Adjusting <op>", every row re-runs
	// the op as it changes (scrub end / a 300ms pause after typing settles the
	// result), and the primary button is replaced by ✕ Revert.
	//
	// The operators are NOT called from here: the toolbox owns the toasts, the
	// flash feedback and the "is there a target" checks, so the Apply buttons
	// AND the adjust callbacks call back into it. This component is layout.
	import {
		faceEditAmount,
		faceAutoApply,
		opAdjustState
	} from '$lib/faceEdit';
	import { proportionalRadius } from '$lib/meshEdit';
	// 19-A P4: scrubbing the radius previews the falloff RING at the current
	// selection (live — the ring re-scales as the store changes under the scrub)
	import { showRadiusPreview, hideProportionalRing } from '$lib/proportionalRing';
	import {
		bevelWidth,
		bevelSegments,
		bevelProfile,
		bevelDirection,
		bevelFaceProfile,
		loopCuts,
		loopCutPosition,
		bridgeCuts,
		bridgeTwist,
		bridgeInvert,
		extrudeIndividual,
		insetDepth,
		insetIndividual,
		subdivideLevelCount,
		edgeExtrudeDistance,
		smoothFactor,
		smoothIterations,
		slideClamp
	} from '$lib/meshToolParams';
	import DragRow from '../ui/DragRow.svelte';

	/** @type {{ mode: 'vertices'|'edges'|'faces', focus: string, hint?: string,
	 *   adjusting?: boolean,
	 *   onApplyOp: () => void, onApplyBevel: () => void, onApplyLoopCut: () => void,
	 *   onApplyBridge: () => void, onApplySubdivide?: () => void,
	 *   onApplyEdgeExtrude?: () => void, onApplySmooth?: () => void,
	 *   onAdjust?: (patch: any) => void, onSettle?: () => void, onRevert?: () => void }} */
	let {
		mode,
		focus,
		hint = '',
		adjusting = false,
		onApplyOp,
		onApplyBevel,
		onApplyLoopCut,
		onApplyBridge,
		onApplySubdivide = () => {},
		onApplyEdgeExtrude = () => {},
		onApplySmooth = () => {},
		onAdjust = () => {},
		onSettle = () => {},
		onRevert = () => {}
	} = $props();

	// faces bevel takes (width, segments, profile, direction); edges (width,
	// segments, profile); vertices (width, profile) — the pane mirrors the
	// operator signatures
	const showSegments = $derived(mode !== 'vertices');
	const showProfile = $derived(mode !== 'faces');

	// 19-A P3: what the edge/vertex CORES receive as `profile` — the direction
	// buttons own the SIGN (dome vs dish) and the slider the magnitude, so the
	// two controls can never disagree. The cores' own -1..1 range is unchanged;
	// only this pane wiring maps the pair onto it.
	/** @param {'out'|'in'} dir @param {number} magnitude */
	function effectiveProfile(dir, magnitude) {
		return (dir === 'in' ? -1 : 1) * Math.abs(magnitude);
	}
	/** @param {'out'|'in'} dir */
	function setDirection(dir) {
		bevelDirection.set(dir);
		if (!adjusting) return;
		// faces carry direction as its own param; edges/verts fold it into the
		// signed profile the cores already understand
		if (mode === 'faces') adjustChanged({ direction: dir });
		else adjustChanged({ profile: effectiveProfile(dir, $bevelProfile) });
	}

	// 19-A P2: adjust plumbing. A row change while adjusting re-runs the op
	// live; SETTLING (the full-quality apply + the unconditional broadcast + the
	// history entry's `after`) happens on scrub END, or 300ms after the last
	// TYPED change — DragRow fires no scrub events for typing, so the debounce
	// is the only bracket a keyboard edit has.
	/** @type {any} */
	let settleTimer = 0;
	let scrubActive = false;
	/** @param {any} patch */
	function adjustChanged(patch) {
		onAdjust(patch);
		if (!scrubActive) {
			clearTimeout(settleTimer);
			settleTimer = setTimeout(() => onSettle(), 300);
		}
	}
	function scrubStart() {
		if (!adjusting) return;
		scrubActive = true;
		clearTimeout(settleTimer);
	}
	function scrubEnd() {
		if (!adjusting) return;
		scrubActive = false;
		clearTimeout(settleTimer);
		onSettle();
	}

	// 19-A P7b: the loop-cut AXIS — a quad lies on TWO rings, and the begin-time
	// selection pick can be the wrong one. The engine captured both, so the
	// toggle just re-runs the cut across the other; `axisAlt` is false at a pole
	// (no perpendicular ring), which disables the second button.
	const loopAxis = $derived($opAdjustState?.params?.axis === 1 ? 1 : 0);
	const loopAxisAlt = $derived(!!$opAdjustState?.axisAlt);
	/** @param {0|1} axis */
	function setLoopAxis(axis) {
		if (!adjusting || axis === loopAxis) return;
		adjustChanged({ axis });
	}
</script>

{#snippet hintLine()}
	{#if hint && !adjusting}
		<div id="mesh-op-hint" class="tbx-row text-xs text-amber-300">{hint}</div>
	{/if}
{/snippet}

{#snippet revertBtn()}
	<button
		id="mesh-adjust-revert"
		class="tbx-cmd tbx-danger"
		title="Revert — undo this operation and drop its history entry"
		onclick={onRevert}>✕ Revert</button
	>
{/snippet}

{#if focus === 'extrude' || focus === 'inset'}
	<!-- 176: the amount row keeps its id — it is the toolbox's oldest e2e contract -->
	<span class="tbx-label">{adjusting ? `Adjusting ${focus}` : `${focus} options`}</span>
	{@render hintLine()}
	<div id="mesh-op-params" class="tbx-row text-xs text-gray-300">
		<DragRow
			id="mesh-op-amount"
			label="amount"
			value={$faceEditAmount}
			step={0.01}
			decimals={2}
			title="How far Extrude pushes, or how far Inset shrinks (drag to scrub, type, arrows step)"
			onchange={(v) => {
				faceEditAmount.set(v);
				if (adjusting) adjustChanged({ distance: v });
			}}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
		/>
		{#if focus === 'inset'}
			<DragRow
				id="inset-depth"
				label="depth"
				value={$insetDepth}
				step={0.01}
				decimals={2}
				min={-2}
				max={2}
				title="Push the inset cap along its normal (world units) — 0 keeps it in the surface, negative sinks it"
				onchange={(v) => {
					insetDepth.set(v);
					if (adjusting) adjustChanged({ depth: v });
				}}
				onscrubstart={scrubStart}
				onscrubend={scrubEnd}
			/>
		{/if}
		<label
			class="flex items-center gap-1"
			title={focus === 'extrude'
				? 'Extrude each separate piece along its OWN normal instead of one averaged direction'
				: 'Inset each picked face separately — one ring apiece instead of one shared ring'}
		>
			<input
				id={focus === 'extrude' ? 'extrude-individual' : 'inset-individual'}
				class="tbx-check"
				type="checkbox"
				checked={focus === 'extrude' ? $extrudeIndividual : $insetIndividual}
				onchange={(e) => {
					const on = e.currentTarget.checked;
					(focus === 'extrude' ? extrudeIndividual : insetIndividual).set(on);
					if (adjusting) adjustChanged({ individual: on });
				}}
			/>
			individual
		</label>
		<label class="flex items-center gap-1" title="Apply the op when you click a face">
			<input id="mesh-op-autoapply" class="tbx-check" type="checkbox" bind:checked={$faceAutoApply} />
			auto-apply
		</label>
		{#if adjusting}
			{@render revertBtn()}
		{:else}
			<button
				id="mesh-op-apply"
				class="tbx-primary"
				title="Apply the active op to the selected face"
				onclick={onApplyOp}>Apply</button
			>
		{/if}
	</div>
{:else if focus === 'bevel'}
	<span class="tbx-label">{adjusting ? 'Adjusting bevel' : 'Bevel options'}</span>
	{@render hintLine()}
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
			onchange={(v) => {
				bevelWidth.set(v);
				if (adjusting) adjustChanged({ width: v });
			}}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
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
				onchange={(v) => {
					bevelSegments.set(Math.round(v));
					if (adjusting) adjustChanged({ segments: Math.round(v) });
				}}
				onscrubstart={scrubStart}
				onscrubend={scrubEnd}
			/>
		{/if}
		<!-- 19-A P3: direction, in ALL THREE modes. Faces: Out raises the cap
		     along +normal (the old hardwired behaviour), In recesses it.
		     Edges/verts: the sign of the dome/dish — Out domes, In dishes. -->
		<div
			class="tbx-seg"
			title={mode === 'faces'
				? 'Chamfer direction — Out raises the cap along the face normal, In recesses it into the surface'
				: 'Cap direction — Out domes the cap outward, In dishes it inward (needs profile > 0)'}
		>
			<button
				id="bevel-dir-out"
				class="px-2 py-0.5 {$bevelDirection === 'out' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
				onclick={() => setDirection('out')}>Out</button
			>
			<button
				id="bevel-dir-in"
				class="px-2 py-0.5 {$bevelDirection === 'in' ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
				onclick={() => setDirection('in')}>In</button
			>
		</div>
		{#if mode === 'faces'}
			<!-- P3: the faces profile is the step SCHEDULE — 1 = quarter-circle
			     round (the pre-P3 behaviour), 0 = straight 45° chamfer.
			     P7a: negative = the CONCAVE quarter circle (the same arc, curving
			     the other way); the reach is the same at every profile. -->
			<DragRow
				id="bevel-face-profile"
				label="profile"
				value={$bevelFaceProfile}
				step={0.01}
				decimals={2}
				min={-1}
				max={1}
				title="Profile of the chamfer: 1 rounds it outward (quarter-circle), 0 is a straight 45° ramp, -1 hollows it the other way. The chamfer reaches just as far whichever you pick."
				onchange={(v) => {
					bevelFaceProfile.set(v);
					if (adjusting) adjustChanged({ profile: v });
				}}
				onscrubstart={scrubStart}
				onscrubend={scrubEnd}
			/>
		{/if}
		{#if showProfile}
			<label
				class="flex items-center gap-1"
				title="Profile: 0 is a flat cap, more bulges it — the Out/In buttons pick dome vs dish"
			>
				profile
				<input
					id="bevel-profile"
					type="range"
					min="0"
					max="1"
					step="0.1"
					class="w-20"
					value={Math.abs($bevelProfile)}
					oninput={(e) => {
						const v = parseFloat(e.currentTarget.value);
						// the STORE keeps the magnitude; the sign belongs to the
						// direction buttons and is applied where the cores are called
						bevelProfile.set(v);
						if (adjusting) adjustChanged({ profile: effectiveProfile($bevelDirection, v) });
					}}
				/>
				<span class="w-10 text-right tabular-nums"
					>{Math.abs($bevelProfile) < 0.05
						? 'flat'
						: ($bevelDirection === 'in' ? 'in ' : 'out ') + Math.abs($bevelProfile).toFixed(1)}</span
				>
			</label>
		{/if}
		{#if adjusting}
			{@render revertBtn()}
		{:else}
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
		{/if}
	</div>
{:else if focus === 'loopcut'}
	<span class="tbx-label">{adjusting ? 'Adjusting loop cut' : 'Loop cut options'}</span>
	{@render hintLine()}
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
			onchange={(v) => {
				loopCuts.set(Math.round(v));
				if (adjusting) adjustChanged({ cuts: Math.round(v) });
			}}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
		/>
		<!-- 19-A P3: single-cut placement; multi-cut is ALWAYS evenly spaced
		     (the Blender rule), so the row disables at cuts > 1 -->
		<DragRow
			id="loopcut-position"
			label="position"
			value={$loopCutPosition}
			step={0.005}
			decimals={2}
			min={0.01}
			max={0.99}
			disabled={$loopCuts > 1}
			title={$loopCuts > 1
				? 'Multiple cuts are always evenly spaced — set cuts to 1 to place a single cut'
				: 'Where the single cut lands along the ring (0.5 = midway)'}
			onchange={(v) => {
				loopCutPosition.set(v);
				if (adjusting) adjustChanged({ position: v });
			}}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
		/>
		{#if adjusting}
			<!-- 19-A P7b: which of the quad's TWO rings the cut runs across. Only
			     meaningful while the adjust is live (the rings were captured at
			     apply); Across disables when no perpendicular ring exists (a pole). -->
			<div
				id="loopcut-axis"
				class="tbx-seg"
				title="A quad lies on two rings — flip the cut onto the perpendicular one"
			>
				<button
					id="loopcut-axis-along"
					class="px-2 py-0.5 {loopAxis === 0 ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					title="Cut across the ring the pick chose"
					onclick={() => setLoopAxis(0)}>Along</button
				>
				<button
					id="loopcut-axis-across"
					class="px-2 py-0.5 {loopAxis === 1 ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					disabled={!loopAxisAlt}
					title={loopAxisAlt
						? 'Cut across the PERPENDICULAR ring instead'
						: 'No perpendicular loop runs through that quad'}
					onclick={() => setLoopAxis(1)}>Across</button
				>
			</div>
		{/if}
		{#if adjusting}
			{@render revertBtn()}
		{:else}
			<button
				id="mesh-loopcut-apply"
				class="tbx-primary"
				title="Insert the loops across the ring the selection lies on (C)"
				onclick={onApplyLoopCut}>Cut</button
			>
		{/if}
	</div>
{:else if focus === 'bridge'}
	<span class="tbx-label">{adjusting ? 'Adjusting bridge' : 'Bridge options'}</span>
	{@render hintLine()}
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
			onchange={(v) => {
				bridgeCuts.set(Math.round(v));
				if (adjusting) adjustChanged({ cuts: Math.round(v) });
			}}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
		/>
		<!-- 19-A P3: rotate the loop pairing — a skewed tunnel is one step away
		     from a straight one, and the angle ordering cannot know which -->
		<DragRow
			id="bridge-twist"
			label="twist"
			value={$bridgeTwist}
			step={0.05}
			decimals={0}
			min={-20}
			max={20}
			title="Rotate how the two loops pair up, one edge per step — untwists a skewed tunnel"
			onchange={(v) => {
				bridgeTwist.set(Math.round(v));
				if (adjusting) adjustChanged({ twist: Math.round(v) });
			}}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
		/>
		<!-- 19-A P7a: the wall direction is a GUESS (a hole through one solid shows
		     its inner surface, two shells make a tube seen from outside) — this is
		     the correction for the shapes the guess gets wrong -->
		<label
			class="flex items-center gap-1"
			title="Flip which way the tunnel walls face. The bridge guesses from the shape — a hole through one solid shows its inner surface, two separate pieces make a tube seen from outside — and an unusual shape can fool that guess."
		>
			<input
				id="bridge-invert"
				class="tbx-check"
				type="checkbox"
				checked={$bridgeInvert}
				onchange={(e) => {
					const on = e.currentTarget.checked;
					bridgeInvert.set(on);
					if (adjusting) adjustChanged({ invert: on });
				}}
			/>
			invert faces
		</label>
		{#if adjusting}
			{@render revertBtn()}
		{:else}
			<button
				id="mesh-bridge-apply"
				class="tbx-primary"
				title="Bridge the two selected pieces (B) — they need one closed boundary each and matching edge counts"
				onclick={onApplyBridge}>Bridge</button
			>
		{/if}
	</div>
{:else if focus === 'subdivide'}
	<span class="tbx-label">{adjusting ? 'Adjusting subdivide' : 'Subdivide options'}</span>
	{@render hintLine()}
	<div id="subdivide-params" class="tbx-row text-xs text-gray-300">
		<DragRow
			id="subdivide-levels"
			label="levels"
			value={$subdivideLevelCount}
			step={0.05}
			decimals={0}
			min={1}
			max={3}
			title="How many times to split — each level turns every quad into four (growth is 4^levels, capped by the sync limit)"
			onchange={(v) => {
				subdivideLevelCount.set(Math.round(v));
				if (adjusting) adjustChanged({ levels: Math.round(v) });
			}}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
		/>
		{#if adjusting}
			{@render revertBtn()}
		{:else}
			<button
				id="mesh-subdivide-apply"
				class="tbx-primary"
				title="Split the selected faces (S) — quad-aware, so the loop tools survive it"
				onclick={onApplySubdivide}>Apply</button
			>
		{/if}
	</div>
{:else if focus === 'edge-extrude'}
	<span class="tbx-label">{adjusting ? 'Adjusting edge extrude' : 'Edge extrude options'}</span>
	{@render hintLine()}
	<div id="edge-extrude-params" class="tbx-row text-xs text-gray-300">
		<DragRow
			id="edge-extrude-distance"
			label="distance"
			value={$edgeExtrudeDistance}
			step={0.01}
			decimals={2}
			min={-5}
			max={5}
			title="How far the strip reaches, along the border's averaged surface normal (world units; negative pulls the other way)"
			onchange={(v) => {
				edgeExtrudeDistance.set(v);
				if (adjusting) adjustChanged({ distance: v });
			}}
			onscrubstart={scrubStart}
			onscrubend={scrubEnd}
		/>
		{#if adjusting}
			{@render revertBtn()}
		{:else}
			<button
				id="edge-extrude-apply"
				class="tbx-primary"
				title="Extrude the selected border edges into one welded strip"
				onclick={onApplyEdgeExtrude}>Extrude</button
			>
		{/if}
	</div>
{:else if focus === 'smooth'}
	<span class="tbx-label">Smooth options</span>
	{@render hintLine()}
	<div id="smooth-params" class="tbx-row text-xs text-gray-300">
		<DragRow
			id="smooth-factor"
			label="factor"
			value={$smoothFactor}
			step={0.01}
			decimals={2}
			min={0}
			max={1}
			title="How far each vertex moves toward the average of its neighbours (1 = lands exactly on it)"
			onchange={(v) => smoothFactor.set(v)}
		/>
		<DragRow
			id="smooth-iterations"
			label="passes"
			value={$smoothIterations}
			step={0.05}
			decimals={0}
			min={1}
			max={10}
			title="How many relax passes one click runs (each pass reads the previous pass's result)"
			onchange={(v) => smoothIterations.set(Math.round(v))}
		/>
		<button
			id="mesh-smooth-apply"
			class="tbx-primary"
			title="Relax the selected vertices — one undoable commit per click"
			onclick={onApplySmooth}>Smooth</button
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
			onscrubstart={() => showRadiusPreview(mode)}
			onscrubend={() => hideProportionalRing()}
		/>
	</div>
{:else if focus === 'slide'}
	<span class="tbx-label">Slide options</span>
	<div id="slide-params" class="tbx-row text-xs text-gray-300">
		<label
			class="flex items-center gap-1"
			title="ON (default): the vertex stops at the edge's ends. OFF: it may slide PAST either end, continuing the edge's direction — a marker shows where it will land while it is off the edge."
		>
			<input
				id="slide-clamp"
				class="tbx-check"
				type="checkbox"
				checked={$slideClamp}
				onchange={(e) => slideClamp.set(e.currentTarget.checked)}
			/>
			clamp to edge
		</label>
	</div>
{:else if focus === 'knife'}
	<span class="tbx-label">Knife options</span>
	<div class="tbx-row text-xs text-gray-400">
		Click one end of the cut, then the other. Esc drops a pending cut.
	</div>
{/if}
