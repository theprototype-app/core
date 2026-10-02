<script>
	// 31 K3 G3 — the desktop FPS counter: this game's "Show FPS" setting, while playing it.
	// The headset shows the same reading on the top strip and the wrist card (vrGamePanel).
	// LOCAL chrome, pointer-events none, over the game's HUD.
	// 33 Q1: the SAME counter answers the app-wide "Show FPS + draw calls" preference — in
	// any scene, in any mode — and then colours the draw calls against the Quest budget
	// (amber past 120, red past 150). One meter, one implementation: the headset's half is
	// vrPerfStrip.js, reading the same `fpsReading`.
	import { isLocked, isVRMode, editorMode } from '../../stores/sceneStore';
	import { gameSettingValues } from '$lib/gameSettings';
	import { fpsReading, perfParts, perfStatsShown } from '$lib/fpsMeter';

	const playing = $derived($isLocked === true);
	const gameShown = $derived(!!$gameSettingValues.showFps && (playing || $editorMode === 'interact'));
	const shown = $derived(!$isVRMode && ($perfStatsShown || gameShown));
	const parts = $derived(perfParts($fpsReading));
</script>

{#if shown}
	<div id="game-fps-counter" class="fps" class:fps-play={playing} data-tier={parts.tier} aria-live="off">
		<span class="fps-main">{parts.fps}</span>
		{#if parts.ms || parts.calls || parts.tris}
			<span class="fps-detail">
				{#if parts.ms}<span>{parts.ms}</span>{/if}
				{#if parts.calls}{#if parts.ms}{' · '}{/if}<span id="fps-calls" class="fps-calls" data-tier={parts.tier}>{parts.calls}</span>{/if}
				{#if parts.tris}{#if parts.ms || parts.calls}{' · '}{/if}<span>{parts.tris}</span>{/if}
			</span>
		{/if}
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
	/* 33 Q1: the draw-call budget — TIER_COLORS in fpsMeter.js holds the same three */
	.fps-calls[data-tier='warn'] {
		color: #fbbf24;
		font-weight: 700;
	}
	.fps-calls[data-tier='over'] {
		color: #f87171;
		font-weight: 700;
	}
</style>
