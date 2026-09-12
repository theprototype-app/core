<script>
	// 27-G (audit M13) — WHAT A LOST GRAPHICS CONTEXT LOOKS LIKE.
	//
	// When the browser takes the WebGL context away (a GPU reset, a driver update, too
	// many contexts, the tab backgrounded on a low-memory device) the canvas simply stops
	// updating. Everything else keeps answering — menus open, buttons respond — so it
	// reads as "the 3D view froze" with nothing to act on, and the scene looks lost.
	//
	// It usually is not lost: the scene graph lives in JavaScript, so a save still works
	// and the browser often hands the context back on its own. This says both of those
	// things and gives the two actions worth having.
	import { contextLost } from '../stores/sceneStore';
	import { save } from '$lib/fileHandler.svelte';

	// .tpscene rather than GLTF: it is the whole scene bundle and needs no selection,
	// where a GLTF export covers the SELECTION and asks when there is none — the last
	// thing to put in front of someone whose viewport has just gone dark.
	const saveScene = () => save('tpscene');
	const reload = () => location.reload();
</script>

{#if $contextLost}
	<div class="gl-lost" role="alertdialog" aria-modal="true" aria-labelledby="gl-lost-title">
		<div class="gl-lost-card">
			<h2 id="gl-lost-title">The 3D view has stopped</h2>
			<p>
				The browser took back this page's graphics context. That is usually temporary, and
				it often comes back by itself. <strong>Your scene is still here</strong> — it lives
				in the page, not on the graphics card — so you can save it right now.
			</p>
			<div class="gl-lost-actions">
				<button class="gl-lost-btn gl-lost-primary" onclick={saveScene}>Save scene</button>
				<button class="gl-lost-btn" onclick={reload}>Reload</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* above every other tier: nothing else on screen is usable while this is true */
	.gl-lost {
		position: fixed;
		inset: 0;
		z-index: calc(var(--z-toast, 1200) + 10);
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.72);
		backdrop-filter: blur(2px);
	}
	.gl-lost-card {
		max-width: 420px;
		margin: 16px;
		padding: 20px 22px;
		border-radius: 10px;
		background: var(--surface, #1f2937);
		color: #fff;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
	}
	.gl-lost-card h2 {
		margin: 0 0 8px;
		font-size: 16px;
		font-weight: 600;
	}
	.gl-lost-card p {
		margin: 0 0 16px;
		font-size: 13px;
		line-height: 1.5;
		color: #d1d5db;
	}
	.gl-lost-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}
	.gl-lost-btn {
		padding: 6px 14px;
		border: 0;
		border-radius: 7px;
		font-size: 13px;
		color: #fff;
		background: #374151;
		cursor: pointer;
	}
	.gl-lost-btn:hover {
		background: #4b5563;
	}
	.gl-lost-primary {
		background: #2563eb;
	}
	.gl-lost-primary:hover {
		background: #1d4ed8;
	}
</style>
