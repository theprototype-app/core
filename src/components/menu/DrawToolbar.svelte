<script>
	// 57.2: the draw toolbar now switches between two TOOLS. Freehand paints while
	// you drag (drawMode.js); Spline places control points click by click and the
	// result stays editable (splineTool.js). Both share the colour + size pickers,
	// which are the new spline's defaults.
	// RUNES mode (the tool switch needs $derived) — hence the attribute-form
	// handlers throughout: `on:` directives are deprecated here and each one adds
	// a svelte-check warning.
	import { drawMode, drawTool, drawColor, drawSize, liveStreaming, toggleDrawMode } from '$lib/drawMode';
	import {
		splineDraft,
		splineClosed,
		finishSpline,
		undoSplinePoint,
		cancelSplinePlacement
	} from '$lib/splineTool';

	const spline = $derived($drawTool === 'spline');

	/** @param {KeyboardEvent} event */
	function onKeydown(event) {
		if (!$drawMode) return;
		const target = /** @type {any} */ (event.target);
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable))
			return;
		if (event.key === 'Escape') {
			toggleDrawMode();
			return;
		}
		if (!spline) return;
		if (event.key === 'Enter') {
			finishSpline();
			event.preventDefault();
		} else if (event.key === 'Backspace') {
			undoSplinePoint();
			event.preventDefault();
		}
	}

	/** @param {'freehand' | 'spline'} next */
	function setTool(next) {
		if (next === $drawTool) return;
		if ($drawTool === 'spline') cancelSplinePlacement();
		drawTool.set(next);
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if $drawMode}
	<div
		id="draw-toolbar"
		class="fixed left-1/2 top-20 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full bg-gray-800 px-4 py-2 text-sm text-white shadow-xl"
	>
		<span class="font-semibold">{spline ? '〰 Spline' : '✏️ Drawing'}</span>

		<div class="flex overflow-hidden rounded-full border border-gray-600 text-xs">
			<button
				id="draw-tool-freehand"
				class="px-2.5 py-0.5 {spline ? 'bg-gray-700 hover:bg-gray-600' : 'bg-primary-600 text-white'}"
				title="Paint a stroke while you drag"
				onclick={() => setTool('freehand')}>Freehand</button
			>
			<button
				id="draw-tool-spline"
				class="px-2.5 py-0.5 {spline ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
				title="Click to place control points — the result stays editable"
				onclick={() => setTool('spline')}>Spline</button
			>
		</div>

		<input
			type="color"
			title="Stroke color"
			value={$drawColor}
			oninput={(e) => drawColor.set(e.currentTarget.value)}
		/>
		<label class="flex items-center gap-1">
			<span class="text-xs text-gray-300">{spline ? 'radius' : 'size'}</span>
			<input
				type="range"
				class="w-24 accent-[#ff4000]"
				min="0.01"
				max="0.15"
				step="0.01"
				value={$drawSize}
				oninput={(e) => drawSize.set(+e.currentTarget.value)}
			/>
		</label>

		{#if spline}
			<span id="draw-spline-count" class="text-xs text-gray-300"
				>{$splineDraft.length} point{$splineDraft.length === 1 ? '' : 's'}</span
			>
			<label class="flex items-center gap-1 text-xs text-gray-300" title="Join the last point back to the first">
				<input type="checkbox" checked={$splineClosed} onchange={(e) => splineClosed.set(e.currentTarget.checked)} />
				loop
			</label>
			<button
				id="draw-spline-undo"
				class="rounded-full bg-gray-700 px-2.5 py-0.5 text-xs hover:bg-gray-600"
				title="Remove the last point (Backspace)"
				onclick={() => undoSplinePoint()}>Undo point</button
			>
			<!-- Finish keeps draw mode ARMED so several splines can be placed in a
			     row — the same rhythm freehand has (one stroke per drag) -->
			<button
				id="draw-spline-finish"
				class="rounded-full bg-[#22c55e] px-3 py-0.5"
				title="Turn the points into a spline (Enter)"
				onclick={() => finishSpline()}>Finish</button
			>
		{:else}
			<label class="flex items-center gap-1 text-xs text-gray-300" title="Peers watch the line grow while you draw">
				<input
					type="checkbox"
					checked={$liveStreaming}
					onchange={(e) => liveStreaming.set(e.currentTarget.checked)}
				/>
				live
			</label>
		{/if}
		<button class="rounded-full bg-[#ff4000] px-3 py-0.5" onclick={() => toggleDrawMode()}>Done</button>
	</div>
{/if}
