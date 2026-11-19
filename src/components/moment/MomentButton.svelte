<script>
	// 95 SM2 — the Play bar's Share a moment button (PlayBanner in the app, EmbedChrome for a
	// published game's player when its author allows moments). Shown only while the buffer records.
	// SM4: the first time it appears on a device, a short hint says what it does (and the key).
	import Icon from '../ui/Icon.svelte';
	import { isLocked, isVRMode } from '../../stores/sceneStore';
	import { momentStatus, openMoment, momentHintSeen, markMomentHintSeen, MOMENT_KEY } from '$lib/moment/momentStores.js';

	/** @type {{id?: string, variant?: 'bar' | 'embed'}} */
	let { id = 'moment-share', variant = 'bar' } = $props();

	const shown = $derived($momentStatus.on && $isLocked === true && !$isVRMode);
	const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
	const label = coarse ? 'Share a moment: the last 10 s' : `Share a moment: the last 10 s (${MOMENT_KEY})`;

	let hint = $state(false);
	$effect(() => {
		if (!shown || momentHintSeen()) return;
		hint = true;
		markMomentHintSeen();
		const t = setTimeout(() => (hint = false), 7000);
		return () => clearTimeout(t);
	});
</script>

{#if shown}
	<span class="moment-wrap" data-variant={variant}>
		<button {id} type="button" class="moment-btn" aria-label={label} title={label} onclick={() => openMoment()}>
			<Icon name="clapperboard" size={16} aria-hidden="true" />
		</button>
		{#if hint}
			<span id="moment-hint" class="moment-hint tp-ui hud-glass" role="status">
				{coarse ? 'Tap to share the last 10 s' : `Press ${MOMENT_KEY} to share the last 10 s`}
			</span>
		{/if}
	</span>
{/if}

<style>
	.moment-wrap {
		position: relative;
		display: inline-flex;
		pointer-events: auto;
	}
	.moment-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border: 1px solid var(--border);
		border-radius: 50%;
		background: var(--surface-1);
		color: var(--text);
		cursor: pointer;
	}
	.moment-btn:hover {
		background: var(--surface-2);
	}
	.moment-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.moment-hint {
		position: absolute;
		top: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		padding: 4px 10px;
		border-radius: var(--radius-window);
		white-space: nowrap;
		font-size: var(--fs-desc);
		color: var(--text-2);
		pointer-events: none;
	}
	/* a published game's chrome sits at the bottom-left: the hint goes above it */
	.moment-wrap[data-variant='embed'] .moment-hint {
		top: auto;
		bottom: calc(100% + 8px);
		left: 0;
		transform: none;
	}
	@media (pointer: coarse) {
		.moment-btn {
			width: 44px;
			height: 44px;
		}
	}
</style>
