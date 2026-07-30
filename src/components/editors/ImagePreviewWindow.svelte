<script lang="ts">
	// Floating image preview (107): wheel/± zoom 10%–800%, drag to pan while
	// zoomed, zoom readout in the header.
	import { imagePreviewTarget } from '$lib/fileWindows';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';

	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let panning = $state(false);
	let openedFor: any = null;
	let winEl: any = $state(null);

	$effect(() => {
		const target = $imagePreviewTarget;
		if (target && target !== openedFor) {
			openedFor = target;
			zoom = 1;
			panX = 0;
			panY = 0;
			setTimeout(() => winEl?.focus(), 0); // focus so Esc closes the preview
		}
	});
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	}

	const clamp = (z: number) => Math.min(Math.max(z, 0.1), 8);
	function onWheel(e: WheelEvent) {
		e.preventDefault();
		zoom = clamp(zoom * (e.deltaY > 0 ? 0.9 : 1.1));
	}
	function close() {
		$imagePreviewTarget?.onClose?.(); // 218: let the opener (Explorer) refocus
		if ($imagePreviewTarget?.url.startsWith('blob:')) URL.revokeObjectURL($imagePreviewTarget.url);
		imagePreviewTarget.set(null);
		openedFor = null;
	}
</script>

{#if $imagePreviewTarget}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="image-preview-window"
		bind:this={winEl}
		tabindex="-1"
		class="ui-panel fixed flex flex-col overflow-hidden outline-none"
		use:dragWindow={{ key: 'imagePreviewWin', defaultRect: { left: 300, top: 130 } }}
		use:focusStack
		style="z-index: var(--z-window); width: 520px; height: 420px"
		onkeydown={onKeydown}
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span><i class="fa-solid fa-image mr-1"></i>{$imagePreviewTarget.title}</span>
			<span id="image-zoom" class="text-xs text-gray-400">{Math.round(zoom * 100)}%</span>
			<span class="flex-1"></span>
			<button class="ui-button-quiet" title="Zoom out" onclick={() => (zoom = clamp(zoom * 0.8))}>−</button>
			<button class="ui-button-quiet" title="Zoom in" onclick={() => (zoom = clamp(zoom * 1.25))}>＋</button>
			<button class="ui-button-quiet" title="Reset" onclick={() => ((zoom = 1), (panX = 0), (panY = 0))}>1:1</button>
			<button class="ui-button-quiet" title="Close" onclick={close}>✕</button>
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="relative min-h-0 flex-1 overflow-hidden bg-[#0d1117]"
			style="cursor: {zoom > 1 ? (panning ? 'grabbing' : 'grab') : 'default'}"
			onwheel={onWheel}
			onpointerdown={(e) => {
				if (zoom <= 1) return;
				panning = true;
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			}}
			onpointermove={(e) => {
				if (!panning) return;
				panX += e.movementX;
				panY += e.movementY;
			}}
			onpointerup={() => (panning = false)}
		>
			<img
				src={$imagePreviewTarget.url}
				alt={$imagePreviewTarget.title}
				class="pointer-events-none absolute left-1/2 top-1/2 max-h-full max-w-full"
				style="transform: translate(-50%, -50%) translate({panX}px, {panY}px) scale({zoom}); image-rendering: {zoom > 2 ? 'pixelated' : 'auto'}"
			/>
		</div>
	</div>
{/if}
