<script>
	// T-2: sculpt toolbar — CL-B B5 floating strip -> M0 TOOLBOX: rebuilt on the
	// shared ToolboxWindow shell so both edit toolboxes look and behave the same
	// (header drag, width-resize reflows the square brush buttons, status
	// footer). Also hosts the MESH sculpt session (same stores — sculptObject
	// may be any mesh now, not just terrain). Ids and behavior unchanged.
	import {
		sculptObject,
		sculptMode,
		sculptOp,
		sculptRadius,
		sculptStrength,
		exitSculpt,
		setSculptGizmo
	} from '$lib/terrainSculpt';
	import { Check, Move3d } from '@lucide/svelte';
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import ToolIcon from '../ui/ToolIcon.svelte';
	import { gizmoSuppressed } from '../../stores/sceneStore';

	const OPS = [
		{ op: 'raise', label: 'Raise', icon: 'raise', desc: 'pull the surface up along its normals' },
		{ op: 'lower', label: 'Lower', icon: 'lower', desc: 'push the surface down' },
		{ op: 'smooth', label: 'Smooth', icon: 'smooth', desc: 'relax the surface' },
		{ op: 'flatten', label: 'Flatten', icon: 'flatten', desc: 'level toward the hit plane' }
	];

	/** @param {KeyboardEvent} event */
	function onKeydown(event) {
		if (event.key === 'Escape' && $sculptObject) exitSculpt();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if $sculptObject}
	<ToolboxWindow
		id="sculpt-toolbar"
		key="sculptToolbox"
		title={$sculptMode === 'mesh' ? 'Sculpt mesh' : 'Sculpt terrain'}
	>
		{#snippet actions()}
			<button
				id="sculpt-done"
				class="tbx-hbtn tbx-done"
				aria-label="Done"
				title="Finish sculpting (Esc)"
				onclick={() => exitSculpt()}><Check size={14} aria-hidden="true" /></button
			>
		{/snippet}

		<!-- BRUSH: an armed radio — exactly one brush is active -->
		<span class="tbx-label">Brush</span>
		{#each OPS as o (o.op)}
			<button
				id={`sculpt-op-${o.op}`}
				class="tbx-btn {o.op === $sculptOp ? 'tbx-on bg-primary-600 text-white' : ''}"
				aria-label={o.label}
				title={`${o.label} — ${o.desc}`}
				onclick={() => sculptOp.set(/** @type {any} */ (o.op))}><ToolIcon name={o.icon} /></button
			>
		{/each}

		<div class="tbx-row text-xs">
			<label class="flex items-center gap-1.5">
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
		</div>
		<div class="tbx-row text-xs">
			<label class="flex items-center gap-1.5">
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
		</div>

		<!-- DISPLAY: gizmo opt-in — sculpt entry always suppresses the transform
		     gizmo so a stray drag can't move the object; this re-enables it -->
		<span class="tbx-label">Display</span>
		<button
			id="sculpt-gizmo"
			class="tbx-btn"
			aria-label="Toggle the move gizmo"
			aria-pressed={!$gizmoSuppressed}
			title={$gizmoSuppressed ? 'Show the move gizmo (off to avoid accidental moves)' : 'Hide the move gizmo'}
			onclick={() => setSculptGizmo($gizmoSuppressed)}><Move3d size={18} aria-hidden="true" /></button
		>

		{#snippet status()}
			<span>{$sculptRadius}m · {Math.round($sculptStrength * 100)}%</span>
		{/snippet}
	</ToolboxWindow>
{/if}
