<script>
	// 102b-play row 2 — INFO POINTS IN PLAY. The notes an author marked "Show to visitors" are
	// what a visitor of the published scene can open: a button in the player's chrome lists them,
	// their pins stay clickable in the viewport, and a card shows the title, the text, one picture
	// and — when the author saved a framing — "Show the view". Every other note is left out of the
	// play app (PlayApp sets the pin filter). Works with no live session: the notes ride the scene file.
	//
	// Keyboard: the button is in the tab order; the list and the card are dialogs that take focus,
	// Escape closes them and hands focus back. Screen readers get a named button with the count,
	// a labelled list and a labelled card.
	import { tick } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { annotations, activeAnnotation, focusAnnotation } from '$lib/annotationsHandler';
	import { visitorNotes, infoTitle } from '$lib/infoPoints.js';
	import { isLocked } from '../../stores/sceneStore';

	const notes = $derived(visitorNotes($annotations));
	let listOpen = $state(false);
	/** the card shows a visitor note only: a pin click in the viewport opens it through activeAnnotation */
	const openId = $derived($activeAnnotation?.id && notes.some((n) => n.id === $activeAnnotation.id) ? $activeAnnotation.id : null);
	const note = $derived(openId ? notes.find((n) => n.id === openId) : null);
	const index = $derived(note ? notes.indexOf(note) : -1);
	const playing = $derived($isLocked === true);

	/** @type {HTMLButtonElement | null} */
	let trigger = $state(null);
	/** @type {HTMLElement | null} */
	let card = $state(null);
	/** @type {HTMLElement | null} */
	let list = $state(null);


	// focus follows what opened: the card when a note opens, the list when it opens
	$effect(() => {
		if (note && card) tick().then(() => card?.focus());
	});
	$effect(() => {
		if (listOpen && list) tick().then(() => list?.querySelector(/** @type {'button'} */ ('button.ip-item'))?.focus());
	});

	/** @param {string} id */
	function openNote(id) {
		listOpen = false;
		activeAnnotation.set({ id, mode: 'view' });
	}
	function closeCard() {
		activeAnnotation.set(null);
		trigger?.focus();
	}
	function toggleList() {
		if (note) activeAnnotation.set(null);
		listOpen = !listOpen;
	}
	/** @param {number} step */
	function stepNote(step) {
		if (index < 0 || !notes.length) return;
		const next = notes[(index + step + notes.length) % notes.length];
		activeAnnotation.set({ id: next.id, mode: 'view' });
	}
	function showView() {
		if (note) focusAnnotation(note.id);
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (e.key !== 'Escape') return;
		if (note) {
			e.preventDefault();
			e.stopPropagation();
			closeCard();
		} else if (listOpen) {
			e.preventDefault();
			e.stopPropagation();
			listOpen = false;
			trigger?.focus();
		}
	}
</script>

{#if notes.length}
	<button
		bind:this={trigger}
		id="info-points-button"
		type="button"
		class="ip-trigger"
		aria-haspopup="dialog"
		aria-expanded={listOpen || !!note}
		aria-label={'Info points (' + notes.length + ')'}
		title="Info points: notes the author left for visitors"
		onclick={toggleList}
	>
		<Icon name="info" size={16} aria-hidden="true" />
		<span class="ip-count" aria-hidden="true">{notes.length}</span>
	</button>
{/if}

{#if listOpen && notes.length && !note}
	<div
		bind:this={list}
		id="info-points-list"
		class="ip-panel"
		role="dialog"
		aria-label="Info points"
		tabindex="-1"
		onkeydown={onKey}
	>
		<div class="ip-head">
			<strong>Info points</strong>
			<button type="button" class="ip-icon" aria-label="Close info points" title="Close" onclick={() => ((listOpen = false), trigger?.focus())}>
				<Icon name="x" size={16} aria-hidden="true" />
			</button>
		</div>
		<ul class="ip-list" use:minimalScroll>
			{#each notes as n, i (n.id)}
				<li>
					<button type="button" class="ip-item" data-info-point={n.id} onclick={() => openNote(n.id)}>
						<span class="ip-dot" style:background={n.color} aria-hidden="true"></span>
						<span class="ip-item-title">{infoTitle(n, i)}</span>
						{#if n.picture}<Icon name="image" size={16} aria-hidden="true" />{/if}
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}

{#if note}
	<div
		bind:this={card}
		id="info-point-card"
		class="ip-panel ip-card"
		role="dialog"
		aria-labelledby="info-point-title"
		tabindex="-1"
		data-info-point={note.id}
		onkeydown={onKey}
	>
		<div class="ip-head">
			<strong id="info-point-title">{infoTitle(note, index)}</strong>
			<button type="button" class="ip-icon" aria-label="Close" title="Close (Esc)" onclick={closeCard}>
				<Icon name="x" size={16} aria-hidden="true" />
			</button>
		</div>
		<div class="ip-body" use:minimalScroll>
			{#if note.picture}<img class="ip-picture" src={note.picture} alt="" />{/if}
			{#if note.text?.trim() && (note.name?.trim() || note.text.trim().includes('\n'))}<p class="ip-text">{note.text}</p>{/if}
		</div>
		<div class="ip-actions">
			{#if note.camera}
				<button
					type="button"
					id="info-point-view"
					class="ip-action"
					disabled={playing}
					title={playing ? 'Pause the game (Esc) to move the camera to this view' : 'Move the camera to the view the author saved'}
					onclick={showView}
				>
					<Icon name="locate-fixed" size={16} aria-hidden="true" /> Show the view
				</button>
			{/if}
			<span class="ip-grow"></span>
			{#if notes.length > 1}
				<button type="button" class="ip-icon" aria-label="Previous info point" title="Previous" onclick={() => stepNote(-1)}>
					<Icon name="chevron-left" size={16} aria-hidden="true" />
				</button>
				<span class="ip-pos" aria-live="polite">{index + 1} / {notes.length}</span>
				<button type="button" class="ip-icon" aria-label="Next info point" title="Next" onclick={() => stepNote(1)}>
					<Icon name="chevron-right" size={16} aria-hidden="true" />
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* the embed chrome's button look (its styles are scoped to EmbedChrome) */
	.ip-trigger {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		min-width: 32px;
		height: 32px;
		padding: 0 8px;
		box-sizing: border-box;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 80%, transparent);
		color: var(--text);
		font: 600 11px/1 system-ui, sans-serif;
		cursor: pointer;
		backdrop-filter: blur(4px);
		touch-action: manipulation;
	}
	.ip-trigger:hover {
		background: color-mix(in srgb, var(--surface-1) 95%, transparent);
	}
	.ip-trigger:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring);
	}
	.ip-count {
		font-variant-numeric: tabular-nums;
	}
	.ip-panel {
		position: fixed;
		left: calc(env(safe-area-inset-left, 0px) + 10px);
		bottom: calc(env(safe-area-inset-bottom, 0px) + 52px);
		z-index: var(--z-hud, 45);
		width: min(340px, calc(100vw - 20px));
		max-height: min(70vh, 520px);
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		border-radius: var(--radius-window);
		border: 1px solid var(--border);
		background: var(--surface-1);
		color: var(--text);
		box-shadow: 0 8px 24px color-mix(in srgb, var(--text) 18%, transparent);
		pointer-events: auto;
		overflow: hidden;
	}
	.ip-panel:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring);
	}
	.ip-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 8px 8px 12px;
		border-bottom: 1px solid var(--border);
	}
	.ip-head strong {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ip-list {
		list-style: none;
		margin: 0;
		padding: 4px;
		overflow-y: auto;
	}
	.ip-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 36px;
		padding: 6px 8px;
		border: 0;
		border-radius: var(--radius-button);
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}
	.ip-item:hover,
	.ip-item:focus-visible {
		background: var(--surface-2);
	}
	.ip-item-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ip-dot {
		width: 10px;
		height: 10px;
		border-radius: var(--radius-pill);
		flex: none;
	}
	.ip-body {
		padding: 10px 12px;
		overflow-y: auto;
	}
	.ip-picture {
		display: block;
		width: 100%;
		max-height: 220px;
		object-fit: contain;
		border-radius: var(--radius-input);
		margin-bottom: 8px;
	}
	.ip-text {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.ip-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px;
		border-top: 1px solid var(--border);
	}
	.ip-grow {
		flex: 1;
	}
	.ip-pos {
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}
	.ip-icon,
	.ip-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-width: 32px;
		min-height: 32px;
		padding: 0 8px;
		border: 1px solid transparent;
		border-radius: var(--radius-button);
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.ip-action {
		border-color: var(--border);
	}
	.ip-icon:hover,
	.ip-action:hover:not(:disabled) {
		background: var(--surface-2);
	}
	.ip-action:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
