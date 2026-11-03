<script>
	// 29-E + 36-export — THE PLAYER'S CHROME on a play link, an embed and an exported game (all
	// three are `embedMode`). The editor chrome is gone for the page's life; what a player needs
	// instead is drawn here:
	//   · while NOT playing (before the autoplay lands, or after an Esc): a start card with
	//     ▶ Play (`#embed-play` — a real gesture, which the pointer lock and fullscreen want)
	//     and, on a headset browser, Enter VR (`#embed-vr` — the XR session needs that gesture
	//     too; an export can switch the button off);
	//   · always: a fullscreen toggle where the page may go fullscreen, and — on a play link /
	//     embed only — the corner link that opens the same scene in the full app. An export has
	//     no "same scene" to open: the badge is its way to theprototype.app.
	// --z-hud: above the canvas, below modals.
	import { embedMode, embedOpenUrl, embedSceneId, requestPlay, vrSupported } from '$lib/playMode';
	// 94 (94-routes A3 + A5): the play entry's account line (a cloud plugin's mountProfile) and Remix
	import { playEntry } from '$lib/play/playEntry.js';
	import { appUrl } from '$lib/playOrigin.js';
	import { profileSlot } from '$lib/cloudHooks';
	import CloudSlot from '../CloudSlot.svelte';
	import { isLocked, isVRMode } from '../../stores/sceneStore';
	import { exportConfig, exportMode } from '$lib/export/exportBoot.js';
	// 36-community (C6): the published scene's heart on the start card (a cloud plugin sets it)
	import { sceneHeart } from '$lib/cloudHooks';
	import HeartButton from '../ui/HeartButton.svelte';
	// 53 (A6): captions / colour filter / text size / controls, set before pressing Play
	import { openAccessCard } from '$lib/gameShell';

	const vrAllowed = exportConfig ? exportConfig.vrButton : true;
	/** the same scene opened in the editor as a remix ('' without a scene id; an export has none) */
	const remixHref = embedSceneId && !exportMode ? appUrl(`/?s=${encodeURIComponent(embedSceneId)}&remix=1`) : '';
	const title = exportConfig?.title || '';
	let fullscreen = $state(typeof document !== 'undefined' && !!document.fullscreenElement);
	const canFullscreen = typeof document !== 'undefined' && !!document.fullscreenEnabled;

	function toggleFullscreen() {
		try {
			if (document.fullscreenElement) document.exitFullscreen?.();
			else document.documentElement.requestFullscreen?.().catch(() => {});
		} catch {
			/* a frame without allow=fullscreen: the button simply does nothing */
		}
	}

	function play() {
		// the export's "start fullscreen" asks inside THIS gesture, before the lock does
		if (exportConfig?.startFullscreen && canFullscreen && !document.fullscreenElement) {
			try {
				document.documentElement.requestFullscreen?.().catch(() => {});
			} catch {
				/* refused — play anyway */
			}
		}
		requestPlay({ flat: true });
	}
</script>

<svelte:document onfullscreenchange={() => (fullscreen = !!document.fullscreenElement)} />

{#if $embedMode && !$isVRMode}
	<div id="embed-chrome" class="embed-chrome" data-play-chrome>
		{#if canFullscreen}
			<button
				id="embed-fullscreen"
				type="button"
				class="embed-btn"
				aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
				title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
				aria-pressed={fullscreen}
				onclick={toggleFullscreen}
			>
				<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					{#if fullscreen}
						<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
					{:else}
						<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
					{/if}
				</svg>
			</button>
		{/if}
		{#if !exportMode}
			<a id="embed-open-link" class="embed-btn embed-link" href={embedOpenUrl()} target="_blank" rel="noopener">Open in theprototype.app ↗</a>
		{/if}
		{#if remixHref}
			<a id="embed-remix-link" class="embed-btn embed-link" href={remixHref} target="_blank" rel="noopener">Remix ↗</a>
		{/if}
	</div>
	{#if $isLocked !== true}
		<div id="embed-start" class="embed-start">
			{#if title}<div class="embed-title">{title}</div>{/if}
			<div class="embed-actions">
				<button id="embed-play" type="button" class="embed-play" onclick={play}>▶ Play</button>
				{#if vrAllowed && $vrSupported}
					<button id="embed-vr" type="button" class="embed-play embed-vr" onclick={() => requestPlay()}>Enter VR</button>
				{/if}
				{#if $sceneHeart}
					<HeartButton id="embed-heart" size="md" count={$sceneHeart.count} liked={$sceneHeart.liked} label="Like this game" ontoggle={() => $sceneHeart.toggle()} />
				{/if}
			</div>
			<button id="embed-access" type="button" class="embed-access" onclick={() => openAccessCard()}>Accessibility</button>
			<div class="embed-hint">Click to look around · Esc to pause</div>
			{#if playEntry}
				<!-- 94-routes A3: the cloud plugin's account line (sign in to join, who you are) -->
				<div id="play-account-slot" class="embed-account"><CloudSlot mount={$profileSlot} /></div>
			{/if}
		</div>
	{/if}
{/if}

<style>
	.embed-chrome {
		position: fixed;
		left: calc(env(safe-area-inset-left, 0px) + 10px);
		bottom: calc(env(safe-area-inset-bottom, 0px) + 10px);
		z-index: var(--z-hud, 45);
		display: flex;
		gap: 6px;
		align-items: center;
		pointer-events: none;
	}
	.embed-btn {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 32px;
		height: 32px;
		padding: 0 8px;
		box-sizing: border-box;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 80%, transparent);
		color: var(--text);
		font: 600 11px/1 system-ui, sans-serif;
		text-decoration: none;
		cursor: pointer;
		backdrop-filter: blur(4px);
		touch-action: manipulation;
	}
	.embed-btn:hover {
		background: color-mix(in srgb, var(--surface-1) 95%, transparent);
	}
	.embed-start {
		position: fixed;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		z-index: var(--z-hud, 45);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 16px 20px;
		max-width: calc(100vw - 32px);
		box-sizing: border-box;
		border-radius: 14px;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 78%, transparent);
		color: var(--text);
		backdrop-filter: blur(6px);
		text-align: center;
	}
	.embed-title {
		font: 700 16px/1.2 system-ui, sans-serif;
		overflow-wrap: anywhere;
	}
	.embed-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: center;
	}
	.embed-play {
		min-height: 40px;
		padding: 0 18px;
		border: 0;
		border-radius: 10px;
		background: var(--live);
		color: var(--on-live);
		font: 700 14px/1 system-ui, sans-serif;
		cursor: pointer;
		touch-action: manipulation;
	}
	.embed-vr {
		background: var(--accent-muted);
		color: var(--accent-soft-text);
	}
	.embed-play:hover {
		filter: brightness(1.1);
	}
	.embed-access {
		min-height: 32px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: transparent;
		color: var(--text-2);
		font: 600 12px/1 system-ui, sans-serif;
		cursor: pointer;
		touch-action: manipulation;
	}
	.embed-access:hover,
	.embed-access:focus-visible {
		border-color: var(--accent);
		outline: none;
	}
	.embed-account:empty {
		display: none;
	}
	.embed-hint {
		font: 500 11px/1.3 system-ui, sans-serif;
		color: var(--text-muted);
	}
	@media (pointer: coarse) {
		.embed-hint {
			display: none;
		}
	}
</style>
