<script>
	// T-2: terrain sculpt toolbar (same pinned-pill language as the mesh-edit /
	// draw toolbars; own runes-mode file so it can use onclick cleanly).
	import {
		sculptObject,
		sculptOp,
		sculptRadius,
		sculptStrength,
		exitSculpt,
		setSculptGizmo
	} from '$lib/terrainSculpt';
	import { gizmoSuppressed } from '../../stores/sceneStore';

	const OPS = [
		{ op: 'raise', label: '⛰ Raise' },
		{ op: 'lower', label: '⛏ Lower' },
		{ op: 'smooth', label: '〰 Smooth' },
		{ op: 'flatten', label: '▭ Flatten' }
	];

	/** @param {KeyboardEvent} event */
	function onKeydown(event) {
		if (event.key === 'Escape' && $sculptObject) exitSculpt();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if $sculptObject}
	<div
		id="sculpt-toolbar"
		class="fixed left-1/2 top-20 z-[var(--z-window)] flex -translate-x-1/2 items-center gap-3 rounded-full bg-gray-800 px-4 py-2 text-sm text-white shadow-xl"
	>
		<span class="font-semibold">⛰ Sculpt</span>
		<div class="flex items-center gap-1">
			{#each OPS as o (o.op)}
				<button
					id={`sculpt-op-${o.op}`}
					class="rounded-full px-2.5 py-1 {o.op === $sculptOp ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					onclick={() => sculptOp.set(/** @type {any} */ (o.op))}>{o.label}</button
				>
			{/each}
		</div>
		<label class="flex items-center gap-1.5 text-xs">
			Radius
			<input
				id="sculpt-radius"
				type="range"
				min="0.5"
				max="8"
				step="0.25"
				class="w-20 accent-[#ff4000]"
				value={$sculptRadius}
				oninput={(e) => sculptRadius.set(+e.currentTarget.value)}
			/>
			<span class="w-7">{$sculptRadius}m</span>
		</label>
		<label class="flex items-center gap-1.5 text-xs">
			Strength
			<input
				id="sculpt-strength"
				type="range"
				min="0.05"
				max="1"
				step="0.05"
				class="w-20 accent-[#ff4000]"
				value={$sculptStrength}
				oninput={(e) => sculptStrength.set(+e.currentTarget.value)}
			/>
			<span class="w-7">{$sculptStrength.toFixed(2)}</span>
		</label>
		<!-- gizmo opt-in: sculpt entry always suppresses the transform gizmo so a
		     stray drag can't move the terrain; this re-enables it deliberately -->
		<button
			id="sculpt-gizmo"
			class="rounded-full px-2.5 py-1 {$gizmoSuppressed ? 'bg-gray-700 hover:bg-gray-600' : 'bg-primary-600 text-white'}"
			title={$gizmoSuppressed ? 'Show the move gizmo (off to avoid accidental terrain moves)' : 'Hide the move gizmo'}
			onclick={() => setSculptGizmo($gizmoSuppressed)}>✥ Gizmo</button
		>
		<button
			id="sculpt-done"
			class="rounded-full bg-gray-700 px-3 py-1 hover:bg-gray-600"
			title="Esc"
			onclick={() => exitSculpt()}>Done ✕</button
		>
	</div>
{/if}
