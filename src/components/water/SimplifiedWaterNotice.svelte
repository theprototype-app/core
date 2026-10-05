<script>
	// 36-fb-water F27 — ONE small, dismissible notice when this device's quality level simplified the
	// water (no refraction) or a fluid tank (drops instead of a smooth surface): what happened and
	// where to give it back. Once per session (sessionStorage), never in Play, never in a headset.
	// Theme tokens only. Its own file; App.svelte mounts it with one line.
	import { X } from '@lucide/svelte';
	import { simplifiedWater } from '$lib/water/simplifiedNotice.js';
	import { isLocked, globalRenderer } from '../../stores/sceneStore';
	import { settingsOpen, settingsSection } from '../../stores/appStore';

	const KEY = 'water:simplifiedNoticeSeen';
	const seenAlready = () => {
		try {
			return sessionStorage.getItem(KEY) === '1';
		} catch {
			return false;
		}
	};
	let shown = $state(false);
	let done = $state(seenAlready());
	/** @type {any} */ let timer = null;

	function finish() {
		shown = false;
		done = true;
		clearTimeout(timer);
	}
	function openSetting() {
		finish();
		settingsSection.set('scene');
		settingsOpen.set(true);
		setTimeout(() => document.getElementById('water-quality')?.scrollIntoView({ block: 'center' }), 350);
	}
	$effect(() => {
		const want = ($simplifiedWater.water || $simplifiedWater.fluid) && $isLocked !== true && !$globalRenderer?.xr?.isPresenting;
		if (want && !done && !shown) {
			shown = true;
			try {
				sessionStorage.setItem(KEY, '1'); // once per session, shown = seen
			} catch {}
			timer = setTimeout(finish, 15000);
		}
		if (shown && ($isLocked === true || $globalRenderer?.xr?.isPresenting)) finish();
	});
</script>

{#if shown}
	<div id="simplified-water-notice" class="sw-notice" role="status">
		<span>
			Simplified water for this device —
			<button type="button" class="sw-link" onclick={openSetting}>Settings ▸ Scene ▸ Water quality ▸ High</button>
			shows refraction.
		</span>
		<button type="button" class="sw-x" aria-label="Dismiss" onclick={finish}><X size={14} aria-hidden="true" /></button>
	</div>
{/if}

<style>
	.sw-notice {
		position: fixed;
		left: 50%;
		bottom: calc(var(--controls-inset, 0px) + 72px);
		transform: translateX(-50%);
		z-index: var(--z-hud, 45);
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: min(92vw, 34rem);
		padding: 0.35rem 0.5rem 0.35rem 0.75rem;
		border-radius: 0.5rem;
		font-size: 0.75rem;
		line-height: 1.3;
		color: var(--text, #e5e7eb);
		background: var(--surface, #1f2937);
		border: 1px solid var(--border, #374151);
		box-shadow: 0 4px 14px rgb(0 0 0 / 0.25);
	}
	.sw-link {
		color: var(--accent, #f97316);
		text-decoration: underline;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		font: inherit;
	}
	.sw-x {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 1.75rem;
		min-height: 1.75rem;
		color: var(--muted, #9ca3af);
		background: none;
		border: 0;
		border-radius: 0.25rem;
		cursor: pointer;
	}
	.sw-x:hover {
		color: var(--text, #e5e7eb);
	}
</style>
