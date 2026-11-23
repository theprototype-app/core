<script>
	// 92 (GC1) — A GAME'S TITLE SCREEN: the game's name over its own scene (or a colour / an image),
	// with Continue · Play (New game) · Load game · Settings · Quit to editor. A LAZY chunk.
	//   `start`  a play link / an exported game before play (EmbedChrome draws this instead of its start
	//            card): Play / Continue ARE the gesture the pointer lock and fullscreen want; on a headset
	//            browser Enter VR stays beside them
	//   `play`   over editor Play (the author testing): the pointer is free (HudLayer's fold), the game is
	//            paused when alone (the menu's pause rule) and Escape goes back to the editor
	// Keyboard: Tab / the arrows walk the buttons, Enter presses, Backspace leaves a sub-page. A pad: the
	// arrows come from the HUD ring's D-pad + A.
	import { tick } from 'svelte';
	import { titleScreen, showTitlePage, gameMenus } from '$lib/gameMenus';
	import { titleButtons, titleWords, runTitleItem, pickTitleSlot } from '$lib/titleActions.js';
	import { hudImageFor, resolveHudImage } from '$lib/hudImages';
	import { requestPlay, vrSupported } from '$lib/playMode';
	import { exportConfig } from '$lib/export/exportBoot.js';
	import { bundledLoadingPath } from '$lib/gameLevels/exportLoading.js';
	import { markTitlePassed, closeTitleScreen } from '$lib/gameMenus';
	import SaveSlotList from './SaveSlotList.svelte';
	import { shellMenu } from '$lib/gameShell';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

	/** @type {{mode?: 'start' | 'play'}} */
	let { mode = 'play' } = $props();

	const cfg = $derived($gameMenus.title);
	const page = $derived($titleScreen.page);
	// recomputed when the page changes (a slot written or deleted changes Continue)
	const buttonsFor = (/** @type {any[]} */ ..._deps) => titleButtons();
	const buttons = $derived(buttonsFor(page, $gameMenus, $shellMenu.open));
	const words = $derived(titleWords());
	const vrAllowed = exportConfig ? exportConfig.vrButton : true;
	/** the background image: a bundled export path, a URL, or a library image (an Explorer hash) */
	let libraryImage = $state('');
	const imageRef = $derived(cfg?.background === 'image' ? String(cfg?.image ?? '') : '');
	$effect(() => {
		const ref = imageRef;
		if (!ref || exportConfig?.titleImage || /^(https?:|data:image\/)/.test(ref)) return;
		libraryImage = hudImageFor(ref) ?? '';
		if (!libraryImage) void resolveHudImage(ref).then((url) => ref === imageRef && (libraryImage = url ?? ''));
	});
	const imageSrc = $derived.by(() => {
		if (!imageRef) return '';
		// an export draws the copy in its bundle; a URL draws as it is; a library image through the HUD's cache
		if (exportConfig?.titleImage && bundledLoadingPath(exportConfig.titleImage)) return exportConfig.titleImage;
		if (/^(https?:|data:image\/)/.test(imageRef)) return imageRef;
		return libraryImage;
	});
	const bg = $derived(cfg?.background === 'color' ? cfg?.color || 'var(--surface-0)' : '');

	/** @type {HTMLDivElement | null} */
	let card = $state(null);
	$effect(() => {
		void page;
		tick().then(() => {
			// a standalone Settings page over the title owns the focus
			if (document.querySelector('#game-shell-menu')) return;
			const first = /** @type {HTMLElement | null} */ (card?.querySelector('[data-title-focus]') ?? card?.querySelector('button:not([disabled])'));
			first?.focus({ preventScroll: true });
		});
	});

	/** capture: the title owns its keys while it is up (the game's keys and PointerLockControls' Escape
	 * must not see them) @param {KeyboardEvent} event */
	function onKey(event) {
		if ($shellMenu.open) return; // the Settings card over the title answers its own keys
		const t = /** @type {any} */ (event.target);
		if (t && (t.tagName === 'INPUT' && t.type === 'text')) return;
		if (event.code === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			if (page) return showTitlePage('');
			if (mode === 'play') runTitleItem('quit');
			return;
		}
		if (event.code === 'Backspace' && page) {
			event.preventDefault();
			event.stopPropagation();
			showTitlePage('');
			return;
		}
		if (event.code === 'ArrowDown' || event.code === 'ArrowUp') {
			const all = /** @type {HTMLElement[]} */ ([...(card?.querySelectorAll('button:not([disabled])') ?? [])]);
			if (!all.length) return;
			const at = all.indexOf(/** @type {HTMLElement} */ (document.activeElement));
			all[(at + (event.code === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		// every other key stays on the title (no walking off behind it), Tab and Enter / Space excepted
		if (event.code !== 'Tab' && event.code !== 'Enter' && event.code !== 'Space') event.stopPropagation();
	}

	function enterVr() {
		markTitlePassed(true);
		closeTitleScreen();
		requestPlay();
	}
</script>

<svelte:window onkeydowncapture={onKey} />

<div
	id="game-title-screen"
	class="ts-screen"
	class:ts-image={!!imageSrc}
	class:ts-color={!!bg}
	data-mode={mode}
	data-page={page || 'main'}
	style:background-color={bg || undefined}
	style:background-image={imageSrc ? `url("${imageSrc}")` : undefined}
	role="dialog"
	aria-modal="true"
	aria-label={words.title}
>
	<div class="ts-card" bind:this={card} use:minimalScroll>
		<h1 class="ts-title">{words.title}</h1>
		{#if words.subtitle}<p class="ts-sub">{words.subtitle}</p>{/if}

		{#if page === 'load' || page === 'new'}
			<div class="ts-page">
				<h2 class="ts-page-title">{page === 'load' ? 'Load game' : 'Pick a slot for the new game'}</h2>
				<SaveSlotList mode={page === 'load' ? 'load' : 'new'} onpick={(n) => pickTitleSlot(page === 'load' ? 'load' : 'new', n)} />
				<button type="button" class="ts-btn ts-quiet" onclick={() => showTitlePage('')}>Back</button>
			</div>
		{:else}
			<div class="ts-buttons">
				{#if mode === 'start' && vrAllowed && $vrSupported}
					<button id="title-vr" type="button" class="ts-btn ts-primary" data-title-focus="" onclick={enterVr}>Enter VR</button>
				{/if}
				{#each buttons as item, i (item.id)}
					<button
						type="button"
						class="ts-btn"
						class:ts-primary={i === 0 && !(mode === 'start' && vrAllowed && $vrSupported)}
						class:ts-quiet={item.id === 'quit'}
						data-title-item={item.id}
						data-title-focus={i === 0 && !(mode === 'start' && vrAllowed && $vrSupported) ? '' : undefined}
						onclick={() => runTitleItem(item.id)}>{item.label}</button
					>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.ts-screen {
		position: fixed;
		inset: 0;
		z-index: calc(var(--z-modal, 1100) - 1);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		/* the game's own scene behind, dimmed: the default background */
		background: var(--scrim);
		background-size: cover;
		background-position: center;
		color: var(--text);
		pointer-events: auto;
	}
	.ts-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		width: min(440px, 100%);
		max-height: calc(100dvh - 32px);
		overflow-y: auto;
		padding: 28px 24px 24px;
		border-radius: 18px;
		background: color-mix(in srgb, var(--surface-1) 90%, transparent);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
	}
	.ts-title {
		margin: 0;
		font-size: clamp(28px, 6vw, 44px);
		font-weight: 800;
		line-height: 1.05;
		text-align: center;
		overflow-wrap: anywhere;
	}
	.ts-sub {
		margin: 0;
		font-size: 15px;
		color: var(--text-muted);
		text-align: center;
	}
	.ts-buttons,
	.ts-page {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
		margin-top: 8px;
	}
	.ts-page-title {
		margin: 0 0 4px;
		font-size: 16px;
		font-weight: 700;
	}
	.ts-btn {
		min-height: 48px;
		padding: 12px 16px;
		border-radius: 12px;
		background: var(--surface-2);
		border: 1px solid transparent;
		font-size: 17px;
		font-weight: 700;
	}
	.ts-btn:hover,
	.ts-btn:focus-visible {
		border-color: var(--accent);
		background: var(--accent-soft);
		outline: none;
	}
	.ts-primary,
	.ts-primary:hover,
	.ts-primary:focus-visible {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.ts-primary:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}
	.ts-quiet {
		min-height: 40px;
		background: transparent;
		font-size: 14px;
		font-weight: 500;
		color: var(--text-muted);
	}
</style>
