<script>
	// 64 D1: the vector toolbar — which shape the next drag draws (or the pen), the style it is
	// drawn with, and the pen's Finish / Undo point; while a shape's points are being edited, the
	// session's own strip (convert / delete / done). The DrawToolbar shape, one tool family over.
	import { vectorTool, vectorStyle, penDraft, armVectorTool, disarmVectorTool, finishPen, undoPenPoint, VECTOR_TOOLS } from '$lib/vector/vectorTool.js';
	import { vectorEditObject, vectorEditPick, exitVectorEdit, convertPoint, deletePickedPoint } from '$lib/vector/vectorEdit.js';

	/** @type {Record<string, string>} */
	const LABELS = { rect: 'Rectangle', ellipse: 'Ellipse', star: 'Star', polygon: 'Polygon', pen: 'Pen' };
	/** @type {Record<string, string>} */
	const TIPS = {
		rect: 'Drag a rectangle (Shift = square, Alt = from the centre)',
		ellipse: 'Drag an ellipse (Shift = circle, Alt = from the centre)',
		star: 'Drag out a star from its centre',
		polygon: 'Drag out a polygon from its centre',
		pen: 'Click for corners, click-drag for curves; click the first point to close, Enter to finish'
	};
	const pen = $derived($vectorTool === 'pen');

	/** @param {string} key @param {any} value */
	function setStyle(key, value) {
		vectorStyle.update((s) => ({ ...s, [key]: value }));
	}
</script>

{#if $vectorTool}
	<div
		id="vector-toolbar"
		data-key-scope="keep"
		class="fixed left-1/2 top-20 z-(--z-window) flex -translate-x-1/2 flex-wrap items-center gap-3 rounded-full bg-surface-1 px-4 py-2 text-sm text-text shadow-window"
	>
		<span class="font-semibold">Shapes</span>
		<div class="flex overflow-hidden rounded-full border border-border-strong text-xs" role="group" aria-label="Shape tool">
			{#each VECTOR_TOOLS as tool (tool)}
				<button
					id={`vector-tool-${tool}`}
					class="px-2.5 py-0.5 {$vectorTool === tool ? 'bg-accent-fill text-on-accent' : 'bg-surface-2 hover:bg-surface-hover'}"
					aria-pressed={$vectorTool === tool}
					title={TIPS[tool]}
					onclick={() => armVectorTool(tool)}>{LABELS[tool]}</button
				>
			{/each}
		</div>
		<label class="flex items-center gap-1 text-xs text-text-2" title="Fill colour">
			fill
			<input id="vector-style-fill" type="color" value={$vectorStyle.fill} oninput={(e) => setStyle('fill', e.currentTarget.value)} />
		</label>
		<label class="flex items-center gap-1 text-xs text-text-2" title="Stroke colour">
			stroke
			<input id="vector-style-stroke" type="color" value={$vectorStyle.stroke} oninput={(e) => setStyle('stroke', e.currentTarget.value)} />
		</label>
		<label class="flex items-center gap-1 text-xs text-text-2" title={pen ? 'Pen line width' : 'Stroke width (0 = none)'}>
			width
			<input
				id="vector-style-width"
				type="range"
				class="w-20 accent-accent"
				min="0"
				max="0.2"
				step="0.005"
				value={pen ? $vectorStyle.penWidth : $vectorStyle.strokeWidth}
				oninput={(e) => setStyle(pen ? 'penWidth' : 'strokeWidth', +e.currentTarget.value)}
			/>
		</label>
		{#if pen}
			<span id="vector-pen-count" class="text-xs text-text-2">{$penDraft.count} point{$penDraft.count === 1 ? '' : 's'}</span>
			<button id="vector-pen-undo" class="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs hover:bg-surface-hover" title="Remove the last point (Backspace)" onclick={() => undoPenPoint()}
				>Undo point</button
			>
			<button id="vector-pen-finish" class="rounded-full bg-accent-fill px-3 py-0.5 text-on-accent" title="End the path here (Enter)" onclick={() => finishPen(false)}>Finish</button>
		{/if}
		<button id="vector-tool-done" class="rounded-full bg-accent-muted px-3 py-0.5 text-accent-soft-text" onclick={() => disarmVectorTool()}>Done</button>
	</div>
{:else if $vectorEditObject}
	<div
		id="vector-edit-toolbar"
		data-key-scope="keep"
		class="fixed left-1/2 top-20 z-(--z-window) flex -translate-x-1/2 items-center gap-3 rounded-full bg-surface-1 px-4 py-2 text-sm text-text shadow-window"
	>
		<span class="font-semibold">Edit points</span>
		<span class="text-xs text-text-2">drag points and handles · click the outline to add · double-click to convert · Alt breaks a handle</span>
		<button
			id="vector-edit-convert"
			class="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs hover:bg-surface-hover disabled:opacity-50"
			disabled={!$vectorEditPick}
			title="Corner <-> smooth"
			onclick={() => $vectorEditPick && convertPoint($vectorEditPick.sub, $vectorEditPick.index)}>Convert</button
		>
		<button
			id="vector-edit-delete"
			class="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs hover:bg-surface-hover disabled:opacity-50"
			disabled={!$vectorEditPick}
			title="Remove the picked point (Delete)"
			onclick={() => deletePickedPoint()}>Delete point</button
		>
		<button id="vector-edit-done" class="rounded-full bg-accent-muted px-3 py-0.5 text-accent-soft-text" onclick={() => exitVectorEdit()}>Done</button>
	</div>
{/if}
