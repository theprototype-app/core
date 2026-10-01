<script>
	// 31 K3 G3 — the desktop FPS counter: this game's "Show FPS" setting, while playing it.
	// The headset shows the same reading on the top strip and the wrist card (vrGamePanel).
	// LOCAL chrome, pointer-events none, over the game's HUD.
	import { isLocked, isVRMode, editorMode } from '../../stores/sceneStore';
	import { gameSettingValues } from '$lib/gameSettings';
	import { fpsReading, fpsText } from '$lib/fpsMeter';

	const playing = $derived($isLocked === true);
	const shown = $derived(!!$gameSettingValues.showFps && !$isVRMode && (playing || $editorMode === 'interact'));
	const text = $derived(fpsText($fpsReading));
</script>

{#if shown}
	<div id="game-fps-counter" class="fps" class:fps-play={playing} aria-live="off">
		<span class="fps-main">{text.main}</span>
		{#if text.detail}<span class="fps-detail">{text.detail}</span>{/if}
	</div>
{/if}

<style>
	.fps {
		position: fixed;
		top: calc(var(--connect-bottom, 0px) + 148px);
		left: 16px;
		z-index: 46;
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 4px 8px;
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.62);
		color: #a7f3d0;
		font: 600 12px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
		pointer-events: none;
		user-select: none;
	}
	.fps-play {
		top: 58px;
		right: 16px;
		left: auto;
		text-align: right;
	}
	.fps-main {
		font-size: 14px;
	}
	.fps-detail {
		color: #d1d5db;
		font-weight: 500;
		font-size: 11px;
	}
</style>
