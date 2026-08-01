<script>
	// T-2: terrain sculpt toolbar — CL-B B5 redesign: a FLOATING, draggable
	// segmented toolbar (dragWindow, key sculptToolbar) matching the mesh-edit
	// toolbar's visual language. Also hosts the MESH sculpt session (same
	// stores — sculptObject may be any mesh now, not just terrain).
	import {
		sculptObject,
		sculptMode,
		sculptOp,
		sculptRadius,
		sculptStrength,
		exitSculpt,
		setSculptGizmo
	} from '$lib/terrainSculpt';
	import { dragWindow } from '$lib/dragWindow';
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

	// floating default: near the top center (dragWindow persists win:sculptToolbar)
	const defaultRect = {
		left: typeof window !== 'undefined' ? Math.max(12, Math.round(window.innerWidth / 2 - 300)) : 120,
		top: 76
	};
</script>

<svelte:window onkeydown={onKeydown} />

{#if $sculptObject}
	<div
		id="sculpt-toolbar"
		use:dragWindow={{ key: 'sculptToolbar', defaultRect }}
		class="move-handle z-(--z-window) flex max-w-[min(96vw,680px)] cursor-move select-none flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-gray-700/60 bg-gray-800/95 px-3 py-2 text-sm text-white shadow-xl backdrop-blur-sm"
	>
		<span class="font-semibold" title="Drag to move this toolbar"
			>⠿ {$sculptMode === 'mesh' ? '🗿 Sculpt mesh' : '⛰ Sculpt'}</span
		>
		<div class="flex items-center gap-1">
			{#each OPS as o (o.op)}
				<button
					id={`sculpt-op-${o.op}`}
					class="rounded-full px-2.5 py-1 {o.op === $sculptOp ? 'bg-primary-600 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					onclick={() => sculptOp.set(/** @type {any} */ (o.op))}>{o.label}</button
				>
			{/each}
		</div>

		<span class="h-5 w-px shrink-0 bg-gray-600/70"></span>

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

		<span class="h-5 w-px shrink-0 bg-gray-600/70"></span>

		<!-- gizmo opt-in: sculpt entry always suppresses the transform gizmo so a
		     stray drag can't move the object; this re-enables it deliberately -->
		<button
			id="sculpt-gizmo"
			class="rounded-full px-2.5 py-1 {$gizmoSuppressed ? 'bg-gray-700 hover:bg-gray-600' : 'bg-primary-600 text-white'}"
			title={$gizmoSuppressed ? 'Show the move gizmo (off to avoid accidental moves)' : 'Hide the move gizmo'}
			onclick={() => setSculptGizmo($gizmoSuppressed)}>✥ Gizmo</button
		>
		<button
			id="sculpt-done"
			class="rounded-full bg-[#ff4000] px-3 py-1 text-white"
			title="Esc"
			onclick={() => exitSculpt()}>Done</button
		>
	</div>
{/if}
