<script>
	// 38 R8 (NOTES-38 #14) — THE COMMAND PALETTE (Ctrl+K, the `help.palette` registry row).
	// One search over tools and shortcuts, windows, the menu and every Settings row; what it
	// lists is commandPalette.js, how it ranks is commandRank.js. A pick closes the palette
	// FIRST and then runs the command, so a command that opens a modal never fights it.
	// ↑/↓ move, Enter runs, Esc (or a click outside) closes. Built fresh on every open, so a
	// shortcut rebound or a tool that is unavailable right now is always current.
	import { tick } from 'svelte';
	import { commandPaletteOpen } from '../../stores/appStore';
	import { buildCommands } from '$lib/commandPalette';
	import { rankCommands } from '$lib/commandRank';

	/** @type {import('$lib/commandRank').Command[]} */
	let commands = $state([]);
	let query = $state('');
	let active = $state(0);
	/** @type {HTMLInputElement | null} */
	let input = $state(null);
	/** @type {HTMLElement | null} */
	let list = $state(null);

	const results = $derived(rankCommands(commands, query, 60));
	const KIND = { tool: 'Tool', window: 'Window', menu: 'Menu', setting: 'Setting' };

	$effect(() => {
		if (!$commandPaletteOpen) return;
		commands = buildCommands();
		query = '';
		active = 0;
		tick().then(() => input?.focus());
	});
	$effect(() => {
		void query;
		active = 0;
	});

	function close() {
		commandPaletteOpen.set(false);
	}
	/** @param {import('$lib/commandRank').Command | undefined} cmd */
	function run(cmd) {
		if (!cmd) return;
		close();
		// after the palette has gone: a command that opens a modal or moves focus owns the page
		tick().then(() => cmd.run());
	}
	/** @param {number} i */
	function scrollTo(i) {
		list?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
	}
	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const n = results.length;
			if (!n) return;
			active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
			scrollTo(active);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			run(results[active]);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
		// the palette's keys are its own — no window handler (Escape deselects) sees them
		e.stopPropagation();
	}
</script>

{#if $commandPaletteOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="cp-scrim" onclick={close}></div>
	<div id="command-palette" class="tp-ui cp" role="dialog" aria-label="Command palette">
		<div class="cp-search">
			<input
				bind:this={input}
				bind:value={query}
				id="command-palette-input"
				class="cp-input"
				type="text"
				autocomplete="off"
				spellcheck="false"
				placeholder="Search tools, windows, menus and settings…"
				aria-label="Search commands"
				aria-controls="command-palette-list"
				aria-activedescendant={results[active] ? 'cp-item-' + active : undefined}
				onkeydown={onKey}
			/>
			<kbd class="cp-kbd">Esc</kbd>
		</div>
		<div id="command-palette-list" class="cp-list" role="listbox" bind:this={list}>
			{#each results as cmd, i (cmd.id)}
				<button
					type="button"
					id={'cp-item-' + i}
					class="cp-item"
					role="option"
					aria-selected={i === active}
					data-index={i}
					data-kind={cmd.kind}
					data-command={cmd.id}
					onmousemove={() => (active = i)}
					onclick={() => run(cmd)}
				>
					<span class="cp-kind">{KIND[/** @type {'tool'} */ (cmd.kind)] ?? cmd.kind}</span>
					<span class="cp-main">
						<span class="cp-label">{cmd.label}</span>
						{#if cmd.detail}<span class="cp-detail">{cmd.detail}</span>{/if}
					</span>
					{#if cmd.keys}<span class="cp-keys">{cmd.keys}</span>{/if}
				</button>
			{:else}
				<div class="cp-empty">Nothing matches “{query}”.</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.cp-scrim {
		position: fixed;
		inset: 0;
		z-index: var(--z-menu);
		background: var(--scrim);
	}
	.cp {
		position: fixed;
		top: 14vh;
		left: 50%;
		transform: translateX(-50%);
		z-index: calc(var(--z-menu) + 1);
		width: min(600px, calc(100vw - 24px));
		max-height: 64vh;
		display: flex;
		flex-direction: column;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-modal);
		box-shadow: var(--shadow-window);
		color: var(--text);
		font-family: var(--font-ui);
		overflow: hidden;
	}
	.cp-search {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 14px;
		border-bottom: 1px solid var(--border);
	}
	.cp-input {
		flex: 1;
		min-width: 0;
		height: 52px;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text);
		font-size: var(--fs-panel-title);
	}
	.cp-input::placeholder {
		color: var(--text-faint);
	}
	.cp-kbd,
	.cp-keys {
		font: 500 11px var(--font-ui-mono);
		color: var(--text-faint);
	}
	.cp-kbd {
		padding: 1px 6px;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
	}
	.cp-list {
		overflow-y: auto;
		padding: 6px;
		scrollbar-width: thin;
		scrollbar-color: var(--border-strong) transparent;
	}
	.cp-item {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: calc(var(--row-h) + 4px); /* follows Compact density (NOTES-38 #19) */
		padding: 6px 10px;
		border: 0;
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}
	.cp-item[aria-selected='true'] {
		background: var(--accent-soft);
	}
	.cp-kind {
		flex: 0 0 56px;
		font-size: var(--fs-badge);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.cp-main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.cp-label {
		font-size: var(--fs-body);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cp-detail {
		font-size: var(--fs-badge);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cp-empty {
		padding: 18px 12px;
		text-align: center;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	@media (pointer: coarse) {
		.cp-item {
			min-height: 48px;
		}
		.cp-input {
			font-size: 16px;
		}
	}
</style>
