<script>
	// 36-export (E1) — THE "MADE WITH THEPROTOTYPE" BADGE. Drawn by the RUNTIME (never by an
	// exported page's HTML) on every published play link, every embed and every exported game:
	// `embedMode` is true for all three (an export boots as an embed for its whole life).
	//
	// There is deliberately NO prop, query parameter, config key or DOM attribute that hides it —
	// the export config does not even carry such a key (exportBoot copies known keys only). An
	// exported file is the owner's to edit, so this is a POLICY, stated in the docs, not DRM.
	//
	// Bottom-right, monochrome logo (a currentColor T + opaque dark-grey accent parts over a
	// theme-token pill), ~40% at rest and 85%
	// on hover/focus, where the words slide out. ≤ 28 px tall on coarse pointers, clear of the
	// safe-area insets, and lifted above anything that marks itself `data-hud-avoid` (36-touch's
	// action buttons). DOM never reaches a headset's eye buffer, and the badge also stands down
	// while a VR session runs. The click opens theprototype.app in a NEW tab — never the frame.
	import { onMount } from 'svelte';
	import { embedMode, embedSceneId, embedSource, embedBuild } from '$lib/playMode';
	import { gameIdentity } from '$lib/gameIdentity.js';
	import { isVRMode } from '../../stores/sceneStore';
	import { exportConfig } from '$lib/export/exportBoot.js';
	import { badgeHref, badgeRefFor, BADGE_TEXT } from '$lib/export/badge.js';
	import { avoidRects, liftAbove } from '$lib/play/hudAvoid.js';

	const BASE = 10;
	// 36-community (C4): the game id is known once the scene has LOADED (it is in the file), so the
	// link follows it — a pending remix still counts the original: that is the game being played
	const href = $derived(
		badgeHref(badgeRefFor({ exportConfig, gameId: $gameIdentity?.gameId || '', sceneId: embedSceneId, source: embedSource, build: embedBuild }))
	);
	let lift = $state(BASE);
	/** @type {HTMLAnchorElement | null} */
	let el = $state(null);

	onMount(() => {
		// a handful of rect reads twice a second: the avoid set changes when a game's touch
		// layout does (an orientation change, the layout editor), never per frame
		const tick = () => {
			if (!el) return;
			const r = el.getBoundingClientRect();
			const vh = window.innerHeight;
			// the footprint at the DEFAULT place, so a lift is undone once the obstacle goes
			const box = { left: r.left, right: r.right, top: vh - BASE - r.height, bottom: vh - BASE };
			lift = liftAbove(box, avoidRects(), vh, BASE);
		};
		tick();
		const id = setInterval(tick, 500);
		window.addEventListener('resize', tick);
		return () => {
			clearInterval(id);
			window.removeEventListener('resize', tick);
		};
	});
</script>

{#if $embedMode && !$isVRMode}
	<a
		bind:this={el}
		id="made-with-tp"
		class="made-with-tp"
		{href}
		target="_blank"
		rel="noopener"
		aria-label={BADGE_TEXT + ' — opens theprototype.app in a new tab'}
		title={BADGE_TEXT}
		style:--badge-lift="{lift}px"
	>
		<svg class="mwt-logo" viewBox="0 0 400 400" aria-hidden="true">
			<path
				fill="currentColor"
				d="m279.1 1.3c-1.1 0.7-20.9 7.5-44 15.1l-42.1 13.8c-55-17.3-73.9-22.9-77.5-23.7-5.9-1.2-8.2-0.9-23 3.3-9 2.6-22.3 6.5-29.6 8.7-7.2 2.2-13.7 4.5-14.4 5.1-0.8 0.6 2 2.5 6.6 4.5 4.3 1.9 16.7 6.7 27.6 10.6 10.8 3.8 32.1 11.7 47.2 17.4 15.2 5.8 35.8 13.4 45.8 16.9l18.2 6.4c-1.3 79.4-2.2 133.8-2.9 172.1-0.7 38.3-1.3 87.2-1.3 108.7 0 30.7 0.4 39 1.7 38.7 0.9-0.3 13.4-8.1 27.7-17.4 14.4-9.4 26.6-18 27.3-19.3 0.6-1.3 1.7-8 2.4-15.1 0.7-7 1.6-23.2 2.1-35.8l1-23c72.7-145.6 95.4-191.6 97.3-196.1 2.6-6.3 4-13.4 6-30.9 1.4-12.4 2.8-27.2 3.3-32.8l0.7-10.2c-10.7-2.9-25.8-7.1-40.4-11.1-14.6-4-29.1-7.2-32.2-7.2-3 0-6.4 0.6-7.5 1.3z"
			/>
			<!-- the two originally-green parts (#94c995 in static/logo.svg): the left leg and the small right
			     triangle, a SOLID dark grey (user, 1.21.0) — never translucent, so no game colour shows through -->
			<path class="mwt-accent" data-part="leg" d="m40.8 27.8c-1.7 2.4-9.3 13.7-16.8 25.2-7.5 11.5-13.8 21.6-14 22.4-0.2 0.7 6.3 4.6 14.5 8.5 8.1 3.8 23.4 10.9 33.8 15.6 10.5 4.7 29.4 13.1 42.1 18.8l23 10.2c1.3 30.2 2.4 72.9 3.3 114.5 0.8 41.5 1.9 84.9 2.4 96.4l0.8 20.8c7.2 6.1 20.3 15.2 33.9 24.2 13.5 8.9 25.2 15.9 25.9 15.6 0.9-0.4 1.3-15.2 1.3-40.4 0-21.9 0.6-68.7 1.3-104.1 0.7-35.4 1.6-89.5 2.1-120.3l0.8-55.8c-20-7.6-34.1-12.8-44.2-16.5-10.1-3.7-30-11-44-16.4-14.1-5.3-33.5-12.6-43.1-16.3-9.5-3.6-17.9-6.6-18.6-6.6-0.7 0-2.7 1.9-4.5 4.2z" />
			<path class="mwt-accent" data-part="triangle" d="M304 110c-1.1 0.5-4.9 2.7-8.5 4.9-3.6 2.1-8.8 5.1-11.4 6.5-2.7 1.5-7.4 4.1-10.5 5.8-3.2 1.7-6.1 3.9-6.7 4.9-0.5 1-1.9 1.8-2.9 1.8-1.1 0-2.7 1.7-3.5 3.6-0.8 2.1-1.8 16.4-2.3 32.9-0.8 27.3-0.7 29.2 1.5 29.2 1.3 0 2.7-1 3.2-2.3 0.5-1.2 2.5-4.6 4.4-7.5 2-2.9 9.5-16.2 16.7-29.6 7.2-13.4 15.8-29.8 19.2-36.4 3.3-6.7 6.1-12.8 6.1-13.5 0-0.7-0.8-1.3-1.7-1.2-0.9 0-2.5 0.5-3.6 0.9z" />
		</svg>
		<span class="mwt-text">{BADGE_TEXT}</span>
	</a>
{/if}

<style>
	.made-with-tp {
		position: fixed;
		right: calc(env(safe-area-inset-right, 0px) + 10px);
		bottom: calc(env(safe-area-inset-bottom, 0px) + var(--badge-lift, 10px));
		/* one above the HUD, like the play ✕: a game's own overlay may not cover the credit,
		   and it still loses to modal / toast / menu */
		z-index: calc(var(--z-hud, 45) + 1);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		max-width: 32px;
		padding: 0 7px;
		box-sizing: border-box;
		overflow: hidden;
		white-space: nowrap;
		border-radius: 9999px;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.2));
		background: rgb(var(--surface-rgb, 17 24 39) / 0.72);
		color: var(--text, #e5e7eb);
		text-decoration: none;
		font: 600 12px/1 system-ui, sans-serif;
		opacity: 0.4;
		backdrop-filter: blur(4px);
		transition:
			opacity 0.15s ease,
			max-width 0.2s ease;
		user-select: none;
		touch-action: manipulation;
	}
	.made-with-tp:hover,
	.made-with-tp:focus-visible {
		opacity: 0.85;
		max-width: 240px;
	}
	.mwt-logo {
		flex: 0 0 auto;
		width: 18px;
		height: 18px;
	}
	/* the logo's accent parts (green in the full-colour logo): an OPAQUE NEUTRAL dark grey, so the
	   scene never shows through them and a green game cannot tint them. Deliberately not mixed from
	   the theme's ink/surface: that mix comes out light grey on Light and green on Green. The
	   badge-level opacity above (0.4 rest / 0.85 hover) still applies to the whole badge. */
	.mwt-accent {
		fill: rgb(88 88 88);
		opacity: 1;
	}
	.mwt-text {
		flex: 0 0 auto;
	}
	/* phones: never taller than 28 px */
	@media (pointer: coarse), (max-width: 640px) {
		.made-with-tp {
			height: 26px;
			max-width: 26px;
			padding: 0 5px;
			font-size: 11px;
		}
		.mwt-logo {
			width: 15px;
			height: 15px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.made-with-tp {
			transition: none;
		}
	}
</style>
