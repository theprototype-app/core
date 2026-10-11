<script>
	// 31 K3 — THE PAUSE MENU, desktop. "I should be able to enter main menu during game in
	// any game." One card over the game: Resume · Restart · Levels (when the game registered
	// some) · Settings · How to play · Main menu, plus a quiet Back to editor. The pages and
	// the actions live in gameShell.js; the headset draws the SAME model on the VR game
	// panel. Opened by Escape in play (PointerLockControls), the corner Menu button, a
	// controller's X in VR, or `api.game.openMenu()`.
	//
	// LOCAL chrome at --z-modal (1100): over the game's HUD (45), under toasts (1200) — an
	// approval card must still reach the player. Not in a headset (DOM is invisible there),
	// never in the editor.
	import { tick } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { isLocked, isVRMode, editorMode } from '../../stores/sceneStore';
	import { hudDocs } from '$lib/hudDocs';
	import {
		shellMenu,
		gameLevels,
		gameHelp,
		gameDescription,
		shellMenuAvailable,
		shellMenuItems,
		shellSettingViews,
		shellLevelTabs,
		shellPageTitle,
		shellGameName,
		shellHelpLines,
		openShellMenu,
		closeShellMenu,
		runShellItem,
		pickGameLevel,
		stepGameSetting
	} from '$lib/gameShell';
	import { touchControlsVisible } from '$lib/touchActions'; // 36 U8: the Touch controls row
	import { gameSettingValues, gameSettingRows, setGameSetting } from '$lib/gameSettings';
	// 36-community (C6): a PUBLISHED game's heart (null without a cloud plugin / for a local scene)
	import { sceneHeart } from '$lib/cloudHooks';
	import HeartButton from '../ui/HeartButton.svelte';

	const playing = $derived($isLocked === true);
	// the dependencies are passed as unused arguments: shellMenuAvailable reads its stores
	// through get(), which a $derived cannot see
	const offeredNow = (/** @type {any[]} */ ..._deps) => shellMenuAvailable();
	const offered = $derived(!$isVRMode && offeredNow($isLocked, $editorMode, $hudDocs, $gameLevels));
	const open = $derived($shellMenu.open && offered);
	const page = $derived($shellMenu.page);
	const itemsFor = (/** @type {any[]} */ ..._deps) => shellMenuItems({ vr: false });
	const items = $derived(itemsFor($gameLevels, $touchControlsVisible));
	const viewsFor = (/** @type {any[]} */ ..._deps) => shellSettingViews({ vr: false });
	const settings = $derived(viewsFor($gameSettingValues, $gameSettingRows));
	// 33 (G3): a game's level-picking choice (Untangle's Board) as tabs above the grid
	const tabsFor = (/** @type {any[]} */ ..._deps) => shellLevelTabs();
	const levelTabs = $derived(tabsFor($gameSettingValues, $gameSettingRows));
	const vrViewsFor = (/** @type {any[]} */ ..._deps) => shellSettingViews({ vr: true }).filter((/** @type {any} */ r) => r.vrOnly);
	const vrSettings = $derived(vrViewsFor($gameSettingValues));
	const helpFor = (/** @type {any[]} */ ..._deps) => shellHelpLines({ vr: false });
	const help = $derived(helpFor($gameHelp, $gameDescription));
	const nameFor = (/** @type {any[]} */ ..._deps) => shellGameName();
	const gameName = $derived(nameFor($gameDescription, $gameSettingValues));

	/** @type {HTMLDivElement | null} */
	let card = $state(null);

	// focus the first control of every page as it opens (keyboard players and the ring)
	$effect(() => {
		if (!open) return;
		void page;
		tick().then(() => {
			const first = /** @type {HTMLElement | null} */ (card?.querySelector('[data-shell-focus]') ?? card?.querySelector('button, input'));
			first?.focus({ preventScroll: true });
		});
	});

	/** @param {KeyboardEvent} event */
	function onKeyDown(event) {
		if (!open) {
			// desktop INTERACT has no pointer lock and no PointerLockControls: Escape opens
			// the menu here (in Play, PointerLockControls owns Escape)
			if (event.code === 'Escape' && !playing && offered && !event.defaultPrevented && !isTyping(event)) {
				openShellMenu();
				event.preventDefault();
			}
			return;
		}
		if (isTyping(event)) return;
		if (event.code === 'Escape' && !playing) {
			event.preventDefault();
			page === 'main' ? closeShellMenu() : runShellItem('back');
			return;
		}
		if (event.code === 'Backspace' && page !== 'main') {
			event.preventDefault();
			runShellItem('back');
			return;
		}
		if (event.code === 'ArrowDown' || event.code === 'ArrowUp') {
			const all = /** @type {HTMLElement[]} */ ([...(card?.querySelectorAll('button:not([disabled]), input') ?? [])]);
			if (!all.length) return;
			const at = all.indexOf(/** @type {HTMLElement} */ (document.activeElement));
			const next = all[(at + (event.code === 'ArrowDown' ? 1 : -1) + all.length) % all.length];
			next?.focus();
			event.preventDefault();
			event.stopPropagation();
		}
	}
	/** @param {KeyboardEvent} event */
	function isTyping(event) {
		const t = /** @type {any} */ (event.target);
		return !!t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(t.type)));
	}
</script>

<svelte:window onkeydown={onKeyDown} />

{#if offered && !open}
	<button
		id="game-shell-menu-button"
		type="button"
		class="gs-corner"
		class:gs-corner-play={playing}
		title="Game menu (Esc)"
		aria-label="Open the game menu"
		onclick={() => openShellMenu()}
	>
		<Icon name="menu" size={16} aria-hidden="true" />
		<span>Menu</span>
		{#if playing}<kbd>Esc</kbd>{/if}
	</button>
{/if}

{#if open}
	<div id="game-shell-menu" class="gs-backdrop" data-page={page}>
		<div class="gs-card" bind:this={card} use:minimalScroll role="dialog" aria-label={shellPageTitle(page)}>
			<header class="gs-head">
				{#if page !== 'main'}
					<button type="button" class="gs-back" aria-label="Back" onclick={() => runShellItem('back')}>
						<Icon name="chevron-left" size={20} aria-hidden="true" />
					</button>
				{/if}
				<div class="gs-titles">
					<h2 class="gs-title">{shellPageTitle(page)}</h2>
					<p class="gs-sub">{gameName}</p>
				</div>
				{#if page === 'main' && $sceneHeart}
					<span class="gs-heart">
						<HeartButton id="game-shell-heart" size="md" count={$sceneHeart.count} liked={$sceneHeart.liked} label="Like this game" ontoggle={() => $sceneHeart.toggle()} />
					</span>
				{/if}
			</header>

			{#if page === 'main'}
				<div class="gs-list">
					{#each items as item (item.id)}
						<button
							type="button"
							class="gs-item"
							class:gs-primary={item.id === 'resume'}
							class:gs-quiet={item.id === 'editor'}
							data-shell-item={item.id}
							data-shell-focus={item.id === 'resume' ? '' : undefined}
							onclick={() => runShellItem(item.id)}>{item.label}</button
						>
					{/each}
				</div>
			{:else if page === 'levels'}
				{#each levelTabs as tab (tab.id)}
					<div class="gs-tabs" role="tablist" aria-label={tab.label} data-shell-tabs={tab.id}>
						<span class="gs-tabs-label">{tab.label}</span>
						{#each tab.options as option (option.value)}
							<button
								type="button"
								role="tab"
								class="gs-tab"
								class:gs-tab-on={option.value === tab.value}
								aria-selected={option.value === tab.value}
								data-shell-tab={tab.id + ':' + option.value}
								onclick={() => option.value !== tab.value && setGameSetting(tab.id, option.value)}>{option.label}</button
							>
						{/each}
					</div>
				{/each}
				<div class="gs-levels">
					{#each $gameLevels?.list ?? [] as level (level.id)}
						<button
							type="button"
							class="gs-level"
							class:gs-level-current={$gameLevels?.current === level.id}
							data-shell-level={level.id}
							disabled={!!level.locked}
							title={level.locked ? level.label + ' (locked)' : level.label}
							onclick={() => pickGameLevel(level.id)}
						>
							<span class="gs-level-label">{level.label}</span>
							{#if level.locked}
								<span class="gs-level-sub"><Icon name="lock" size={16} aria-hidden="true" /> Locked</span>
							{:else if level.stars}
								<span class="gs-level-sub gs-stars" aria-label={level.stars + ' stars'}>
									{#each Array(level.stars) as _, i (i)}<Icon name="star" size={16} aria-hidden="true" />{/each}
								</span>
							{/if}
						</button>
					{/each}
				</div>
			{:else if page === 'settings'}
				<div class="gs-settings">
					{#each settings as row (row.id)}
						{#if !row.vrOnly}
							{@render settingRow(row)}
						{/if}
					{/each}
					{#if vrSettings.length}
						<h3 class="gs-group">In VR</h3>
						{#each vrSettings as row (row.id)}
							{@render settingRow(row)}
						{/each}
					{/if}
				</div>
			{:else}
				<div class="gs-help">
					{#each help as line, i (i)}
						{#if line}<p>{line}</p>{:else}<hr />{/if}
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}

{#snippet settingRow(/** @type {any} */ row)}
	<div class="gs-row" class:gs-row-game={row.game} data-shell-setting={row.id}>
		<span class="gs-row-label">{row.label}</span>
		{#if row.type === 'toggle'}
			<input
				type="checkbox"
				class="tp-check"
				aria-label={row.label}
				checked={!!row.value}
				onchange={(e) => setGameSetting(row.id, /** @type {HTMLInputElement} */ (e.currentTarget).checked)}
			/>
		{:else if row.type === 'range'}
			<span class="gs-range">
				<input
					type="range"
					aria-label={row.label}
					min={row.min}
					max={row.max}
					step={row.step}
					value={row.value}
					oninput={(e) => setGameSetting(row.id, Number(/** @type {HTMLInputElement} */ (e.currentTarget).value))}
				/>
				<span class="gs-range-value">{row.display}</span>
			</span>
		{:else}
			<span class="gs-choice">
				<button type="button" aria-label={'Previous ' + row.label} onclick={() => stepGameSetting(row.id, -1)}>
					<Icon name="chevron-left" size={16} aria-hidden="true" />
				</button>
				<span class="gs-choice-value">{row.display}</span>
				<button type="button" aria-label={'Next ' + row.label} onclick={() => stepGameSetting(row.id, 1)}>
					<Icon name="chevron-right" size={16} aria-hidden="true" />
				</button>
			</span>
		{/if}
	</div>
{/snippet}

<style>
	/* 36-community (C6): the heart sits at the right end of the header row, out of the flow so the
	   centred title stays centred */
	.gs-head {
		position: relative;
	}
	.gs-heart {
		position: absolute;
		right: 0;
		top: 50%;
		transform: translateY(-50%);
	}
	.gs-corner {
		position: fixed;
		top: calc(var(--connect-bottom, 0px) + 108px);
		left: 16px;
		z-index: calc(var(--z-hud) + 1);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px 6px 10px;
		border-radius: 9999px;
		background: color-mix(in srgb, var(--surface-1) 88%, transparent);
		color: var(--text);
		border: 1px solid var(--border-strong);
		font-size: 13px;
		font-weight: 600;
		pointer-events: auto;
		box-shadow: var(--shadow-window);
	}
	.gs-corner-play {
		top: 16px;
		right: 16px;
		left: auto;
	}
	.gs-corner kbd {
		font-size: 10px;
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--surface-active);
		font-family: inherit;
	}
	.gs-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal, 1100);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		background: var(--scrim);
		backdrop-filter: blur(2px);
	}
	.gs-card {
		width: min(460px, 100%);
		max-height: calc(100vh - 32px);
		overflow-y: auto;
		padding: 20px 22px 22px;
		border-radius: 16px;
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
	}
	.gs-card:has(.gs-levels),
	.gs-card:has(.gs-settings) {
		width: min(620px, 100%);
	}
	.gs-head {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 16px;
	}
	.gs-titles {
		flex: 1;
		text-align: center;
	}
	.gs-head:has(.gs-back) .gs-titles {
		text-align: left;
	}
	.gs-title {
		font-size: 24px;
		font-weight: 800;
		line-height: 1.1;
	}
	.gs-sub {
		font-size: 13px;
		opacity: 0.7;
		margin-top: 2px;
	}
	.gs-back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		border-radius: 9999px;
		background: var(--surface-2);
	}
	.gs-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.gs-item {
		padding: 12px 16px;
		border-radius: 10px;
		background: var(--surface-2);
		font-size: 16px;
		font-weight: 600;
		text-align: center;
		border: 1px solid transparent;
	}
	.gs-item:hover,
	.gs-item:focus-visible,
	.gs-tab:hover:not(.gs-tab-on),
	.gs-tab:focus-visible,
	.gs-level:hover:not(:disabled),
	.gs-level:focus-visible {
		border-color: var(--accent);
		outline: none;
		background: var(--accent-soft);
	}
	.gs-primary {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.gs-primary:hover,
	.gs-primary:focus-visible {
		background: var(--accent-fill);
		filter: brightness(1.08);
	}
	.gs-quiet {
		background: transparent;
		font-size: 14px;
		font-weight: 500;
		opacity: 0.75;
		padding: 8px;
	}
	.gs-tabs {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 12px;
	}
	.gs-tabs-label {
		margin-right: 6px;
		font-size: 14px;
		font-weight: 600;
		opacity: 0.8;
	}
	.gs-tab {
		flex: 1;
		min-height: 40px;
		padding: 6px 12px;
		border-radius: 10px;
		background: var(--surface-2);
		border: 1px solid transparent;
		font-weight: 600;
	}
	.gs-tab-on {
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.gs-levels {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
		gap: 8px;
	}
	.gs-level {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		min-height: 72px;
		padding: 8px;
		border-radius: 10px;
		background: var(--surface-2);
		border: 1px solid transparent;
		font-weight: 600;
	}
	.gs-level:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.gs-level-current {
		border-color: var(--accent);
	}
	.gs-level-sub {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 12px;
		font-weight: 500;
		opacity: 0.85;
	}
	.gs-stars {
		color: var(--ink-warn);
	}
	.gs-settings {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.gs-group {
		margin-top: 12px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		opacity: 0.6;
	}
	.gs-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 40px;
		padding: 4px 8px;
		border-radius: 8px;
	}
	.gs-row:hover {
		background: var(--surface-hover);
	}
	.gs-row-game .gs-row-label {
		color: var(--ink-warn);
	}
	.gs-range {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.gs-range input {
		width: 160px;
	}
	.gs-range-value {
		width: 3ch;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.gs-choice {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.gs-choice button {
		display: inline-flex;
		width: 28px;
		height: 28px;
		align-items: center;
		justify-content: center;
		border-radius: 8px;
		background: var(--surface-2);
	}
	.gs-choice-value {
		min-width: 8.5em;
		text-align: center;
	}
	.gs-help p {
		margin: 6px 0;
		line-height: 1.45;
	}
	.gs-help hr {
		margin: 10px 0;
		border-color: var(--border);
	}
</style>
