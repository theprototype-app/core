<script>
	// #20 P4: the touch-tools cluster — round Undo / Redo / Multi-select buttons beside
	// the logo, matching its 48px chrome and dropping below the Connect bar with it.
	//
	// Why these three and not more: touch has no keyboard and no right-click, so Ctrl+Z
	// and Shift-click are the two reflexes a phone user simply cannot perform. Everything
	// else already has a touch path (the long-press viewport menu, the + button).
	//
	// MULTI-SELECT is one toggle covering both gestures a modifier would have covered —
	// a tap ADDS instead of replacing, and a drag on empty space draws the marquee — so
	// there is one thing to learn and one mode to see. Scene.svelte reads
	// `multiSelectMode` in the same two places it reads `event.shiftKey`, which is what
	// keeps this from being a second selection implementation.
	import { Undo2, Redo2, BoxSelect } from '@lucide/svelte';
	import { touchTools, multiSelectMode, connectDocked, connectBarHeight } from '../../stores/appStore';
	import { undo, redo, canUndo, canRedo } from '$lib/history';
</script>

{#if $touchTools}
	<div
		id="touch-tools"
		class="touch-tools"
		style={$connectDocked ? `top: ${$connectBarHeight + 8}px` : ''}
		aria-label="Touch tools"
	>
		<button
			id="touch-undo"
			class="tt-btn"
			disabled={!$canUndo}
			title="Undo"
			aria-label="Undo"
			onclick={() => undo()}
		>
			<Undo2 size={20} aria-hidden="true" />
		</button>
		<button
			id="touch-redo"
			class="tt-btn"
			disabled={!$canRedo}
			title="Redo"
			aria-label="Redo"
			onclick={() => redo()}
		>
			<Redo2 size={20} aria-hidden="true" />
		</button>
		<button
			id="touch-multiselect"
			class="tt-btn"
			class:tt-on={$multiSelectMode}
			aria-pressed={$multiSelectMode}
			title={$multiSelectMode
				? 'Multi-select on — a tap adds to the selection, a drag on empty space boxes'
				: 'Multi-select — tap to add objects, drag empty space to box-select'}
			aria-label="Multi-select"
			onclick={() => multiSelectMode.update((v) => !v)}
		>
			<BoxSelect size={20} aria-hidden="true" />
		</button>
	</div>
{/if}

<style>
	/* sits to the RIGHT of the 48px logo at the same inset, so the two read as one
	   cluster; fixed like every other piece of chrome (an absolute element off an edge
	   grows the document and drags the centred Connect pill sideways) */
	.touch-tools {
		position: fixed;
		top: 20px;
		left: 78px;
		z-index: var(--z-hud);
		display: flex;
		gap: 6px;
	}
	.tt-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 48px;
		width: 48px;
		border-radius: 9999px;
		border: 1px solid rgb(55 65 81 / 0.6);
		background: var(--surface, rgb(31 41 55 / 0.9));
		color: rgb(229 231 235);
		box-shadow:
			0 10px 15px -3px rgb(0 0 0 / 0.1),
			0 4px 6px -4px rgb(0 0 0 / 0.1);
		backdrop-filter: blur(4px);
		transition: transform 0.12s ease;
	}
	.tt-btn:hover:not(:disabled) {
		transform: scale(1.05);
	}
	.tt-btn:disabled {
		opacity: 0.4;
	}
	/* the armed toggle owns its fill from the shell, never from a Tailwind utility —
	   a scoped style beats every utility, which is how the mesh toolbox lost its
	   armed colour in the dark theme */
	.tt-on {
		background: var(--accent, #2563eb);
		border-color: var(--accent, #2563eb);
		color: #fff;
	}

	/* on a narrow screen the logo keeps its inset but the cluster must not run into
	   the centred Connect pill — wrap under the logo instead */
	@media (max-width: 480px) {
		.touch-tools {
			left: 20px;
			top: 76px;
		}
	}
</style>
