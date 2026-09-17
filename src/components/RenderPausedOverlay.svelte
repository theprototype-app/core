<script>
	// 26-G (roadmap 26 section 4, Stage 4) — THE LAST RESORT.
	//
	// When frame after frame takes a quarter of a second, the window has stopped answering
	// and anything we draw into it only makes that worse. So the drawing STOPS, and this
	// says why and offers the three things worth doing — none of which throws anything
	// away: save the scene, set the newest objects aside so the rest can run, or try again.
	//
	// It stands down whenever the context-LOST overlay is up (27-G). That one sits above
	// it and describes a different failure; showing both would be two cards arguing.
	import { contextLost } from '../stores/sceneStore';
	import { save } from '$lib/fileHandler.svelte';
	import { renderPaused, resumeRendering, reduceScene, restoreReduced, reducedObjects } from '$lib/overloadGuard';
	import { showToast } from '../stores/appStore';

	const saveScene = () => save('tpscene');
	function reduce() {
		const n = reduceScene();
		resumeRendering();
		showToast(
			n
				? 'Set aside the ' + n + ' newest object' + (n === 1 ? '' : 's') + ' on this device only — nothing was deleted, and peers still see them.'
				: 'Nothing to set aside — the scene is already inside the budget. Rendering resumed.',
			n ? [{ label: 'Show them again', action: () => restoreReduced() }] : undefined
		);
	}
</script>

{#if $renderPaused && !$contextLost}
	<div id="render-paused" class="rp-overlay" role="alertdialog" aria-modal="true" aria-labelledby="rp-title">
		<div class="rp-card">
			<h2 id="rp-title">Rendering paused</h2>
			<p>
				The scene is too heavy for this device — the last frames each took longer than a
				quarter of a second, so drawing has stopped to give the window back.
				<strong>Nothing is lost</strong>, and autosave keeps running while this is open.
			</p>
			{#if $reducedObjects}
				<p class="rp-note">{$reducedObjects} object{$reducedObjects === 1 ? ' is' : 's are'} already set aside on this device.</p>
			{/if}
			<div class="rp-actions">
				<button id="render-paused-save" class="rp-btn" onclick={saveScene}>Save now</button>
				<button id="render-paused-reduce" class="rp-btn" title="Stop drawing the newest objects on THIS device until the scene fits the budget. Peers are unaffected; nothing is deleted." onclick={reduce}>Reduce</button>
				<button id="render-paused-resume" class="rp-btn rp-primary" onclick={resumeRendering}>Resume</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* one tier BELOW the context-lost overlay, which describes a worse failure */
	.rp-overlay {
		position: fixed;
		inset: 0;
		z-index: calc(var(--z-toast, 1200) + 5);
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.6);
	}
	.rp-card {
		max-width: 440px;
		margin: 16px;
		padding: 20px 22px;
		border-radius: 10px;
		background: var(--surface, #1f2937);
		color: #fff;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
	}
	.rp-card h2 {
		margin: 0 0 8px;
		font-size: 16px;
		font-weight: 600;
	}
	.rp-card p {
		margin: 0 0 12px;
		font-size: 13px;
		line-height: 1.5;
		color: #d1d5db;
	}
	.rp-note {
		font-size: 12px !important;
		color: #fbbf24 !important;
	}
	.rp-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		flex-wrap: wrap;
	}
	.rp-btn {
		padding: 6px 14px;
		border: 0;
		border-radius: 7px;
		font-size: 13px;
		background: #374151;
		color: #fff;
		cursor: pointer;
	}
	.rp-btn:hover {
		filter: brightness(1.2);
	}
	.rp-primary {
		background: var(--accent, #2563eb);
	}
</style>
