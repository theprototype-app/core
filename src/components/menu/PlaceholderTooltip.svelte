<script>
	// 36 U9 — hovering a loading placeholder says what it is waiting for: the file, how far it
	// got, and for a red one the HTTP status and the reason, plus how to recover. Desktop only
	// (a pointer that hovers); only does any work while placeholders exist.
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three';
	import { globalCamera, globalRenderer, isLocked } from '../../stores/sceneStore';
	import { placeholderStubObjects, stubLoadInfo } from '$lib/packRefs';
	import { describeLoad, visualState, loadNow, placeholderStuckSeconds, VIS_FAILED, VIS_STUCK } from '$lib/loadStates';

	/** @type {{x: number, y: number, title: string, text: string, hint: string, tone: string} | null} */
	let tip = $state(null);
	const raycaster = new THREE.Raycaster();
	const ndc = new THREE.Vector2();
	let last = 0;

	/** @param {PointerEvent} e */
	function onMove(e) {
		const now = performance.now();
		if (now - last < 80) return;
		last = now;
		const stubs = placeholderStubObjects();
		/** @type {any} */
		const renderer = $globalRenderer;
		/** @type {any} */
		const camera = $globalCamera;
		if (!stubs.length || !renderer || !camera || $isLocked === true || e.pointerType === 'touch' || e.target !== renderer.domElement) {
			tip = null;
			return;
		}
		const rect = renderer.domElement.getBoundingClientRect();
		ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
		raycaster.setFromCamera(ndc, camera);
		const hit = raycaster.intersectObjects(stubs, false)[0];
		const info = hit ? stubLoadInfo(hit.object) : null;
		if (!info) {
			tip = null;
			return;
		}
		const state = visualState(info.load, loadNow(), $placeholderStuckSeconds * 1000);
		tip = {
			x: e.clientX + 14,
			y: e.clientY + 16,
			title: (hit.object.name || info.item) + (state === VIS_FAILED ? ' — failed' : state === VIS_STUCK ? ' — stuck' : ' — loading'),
			text: describeLoad(info.load),
			hint: state === VIS_FAILED ? 'Double-click or right-click ▸ Retry loading · Replace model…' : 'You can already move it — the model lands where the box is',
			tone: state === VIS_FAILED ? 'var(--icon-danger)' : state === VIS_STUCK ? 'var(--icon-warning, var(--icon-danger))' : 'var(--accent)'
		};
	}
</script>

<svelte:window onpointermove={onMove} />

{#if tip}
	<div id="placeholder-tooltip" class="ph-tip" style:left={tip.x + 'px'} style:top={tip.y + 'px'} style:border-color={tip.tone} role="tooltip">
		<div class="ph-title">{tip.title}</div>
		<div class="ph-text">{tip.text}</div>
		<div class="ph-hint">{tip.hint}</div>
	</div>
{/if}

<style>
	.ph-tip {
		position: fixed;
		z-index: var(--z-toast, 1200);
		max-width: min(420px, calc(100vw - 32px));
		padding: 6px 8px;
		border-radius: 6px;
		border: 1px solid var(--border);
		border-left-width: 3px;
		background: var(--surface, #1f2937);
		color: var(--text, #e5e7eb);
		font-size: 11px;
		line-height: 1.35;
		pointer-events: none;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
		word-break: break-all;
	}
	.ph-title {
		font-weight: 600;
		word-break: normal;
	}
	.ph-text {
		opacity: 0.85;
	}
	.ph-hint {
		margin-top: 2px;
		font-style: italic;
		opacity: 0.7;
		word-break: normal;
	}
</style>
