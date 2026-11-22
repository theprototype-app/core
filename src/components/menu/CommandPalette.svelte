<script>
	import { backClose } from '$lib/backStack.js'; // phone-polish: Android Back closes it
	// 38 R8 (NOTES-38 #14) — THE COMMAND PALETTE (Ctrl+K, the `help.palette` registry row).
	// One search over tools and shortcuts, windows, the menu and every Settings row; what it
	// lists is commandPalette.js, how it ranks is commandRank.js. A pick closes the palette
	// FIRST and then runs the command, so a command that opens a modal never fights it.
	// ↑/↓ move, Enter runs, Esc (or a click outside) closes. Built fresh on every open, so a
	// shortcut rebound or a tool that is unavailable right now is always current.
	//
	// 103 H14 (owner, 22 Nov). A LAZY chunk now (App mounts it on open, warmed while idle), so none of this is boot.
	//   - Phones: the palette is the main menu's sheet (the same SheetGrip gesture and remembered height, swipe down
	//     closes, the fade the menu uses), the search on top, above the on-screen keyboard; no key column, no editing.
	//   - Desktop: change a shortcut in place. A row's key chip (or "Add shortcut", faint, on hover / the active row),
	//     its right-click menu ▸ Change shortcut, or F2 on the active row (the footer says so) turn the chip into a
	//     capture: press the keys, Enter saves, Esc cancels, Backspace leaves it with no key. A taken key shows in the
	//     row ("Used by Rotate · Replace / Cancel"). The right-click menu also resets the row to the active keymap's
	//     own key and opens Settings ▸ Shortcuts on that row. Every write is shortcuts.js's (rebindShortcut /
	//     takeConflictingKeys / clearShortcut / resetShortcut): the same code and storage as Settings. A fixed row
	//     shows its key greyed, the reason on hover. The palette stays open and says what changed.
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { tick, onDestroy } from 'svelte';
	import { fade } from 'svelte/transition';
	import { motionMs } from '$lib/motion';
	import { autofocusOk } from '$lib/inputDevice';
	import { commandPaletteOpen, settingsOpen, settingsSection, settingsSearchSeed } from '../../stores/appStore';
	import { buildCommands } from '$lib/commandPalette';
	import { rankCommands } from '$lib/commandRank';
	import { phoneShellActive, phoneSheetMaxH } from '$lib/ui/phoneShell.js';
	import { readSheetH, saveSheetH } from '$lib/ui/sheetDrag.js';
	import { shortcuts, comboOf, rebindShortcut, takeConflictingKeys, clearShortcut, resetShortcut, presetDefaultOf, setShortcutCapture } from '$lib/shortcuts';
	import SheetGrip from '../ui/SheetGrip.svelte';
	import KeyChips from '../ui/KeyChips.svelte';
	import Icon from '../ui/Icon.svelte';
	import ContextMenu from '../ContextMenu.svelte';

	/** the key that starts the capture on the active row (QUESTIONS-103-menu-palette 1) */
	const CAPTURE_KEY = 'F2';

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
	const phone = $derived($phoneShellActive);

	/** the row listening for keys: `pending` null = nothing pressed yet, '' = Backspace (no key)
	 * @type {{ cmdId: string, shortcutId: string, pending: string | null } | null} */
	let capture = $state(null);
	/** a refused change, in its row @type {{ cmdId: string, shortcutId: string, keys: string, otherId: string, otherLabel: string } | null} */
	let conflict = $state(null);
	/** what the last change did ("Shortcut for Move set to G"), read out politely */
	let status = $state('');
	/** @type {{ x: number, y: number, cmd: import('$lib/commandRank').Command } | null} */
	let menu = $state(null);

	// phones: the main menu's sheet height rules (40 F1) under its own remembered key
	let sheetH = $state(readSheetH('paletteSheetH', 0));
	const sheetShown = $derived(Math.min(sheetH || $phoneSheetMaxH, $phoneSheetMaxH || 9999));
	/** @param {number} h @param {boolean} done */
	function sheetResize(h, done) {
		sheetH = Math.round(h);
		if (done) saveSheetH('paletteSheetH', sheetH);
	}

	$effect(() => {
		if (!$commandPaletteOpen) return;
		commands = buildCommands();
		query = '';
		active = 0;
		status = '';
		// phone-polish item 2: on touch the keyboard would cover the list the user opened this for
		if (autofocusOk()) tick().then(() => input?.focus());
	});
	$effect(() => {
		void query;
		active = 0;
	});

	/** @param {string} id */
	const rowOf = (id) => shortcuts.find((s) => s.id === id);
	/** @param {import('$lib/commandRank').Command | undefined} cmd */
	const editable = (cmd) => !phone && !!cmd?.shortcutId && !cmd.locked && !!rowOf(cmd.shortcutId);

	function close() {
		stopCapture();
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

	/** rebuild the list after a change (keys moved), keeping the query and the active row */
	function refresh() {
		const keep = results[active]?.id;
		commands = buildCommands();
		tick().then(() => {
			const i = results.findIndex((c) => c.id === keep);
			if (i >= 0) active = i;
		});
	}

	/* ---------------------------------------------------------------- the capture -- */

	/** @param {KeyboardEvent} e */
	function onCaptureKey(e) {
		if (!capture) return;
		// a bare modifier is the person still BUILDING the combo
		if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return;
		// capture phase on window: the first listener in the app to see the press (the Settings rule) — the palette's
		// own Enter / Escape and every app key stand down for it
		e.preventDefault();
		e.stopPropagation();
		const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
		if (plain && e.key === 'Escape') return stopCapture();
		if (plain && e.key === 'Backspace') return void (capture = { ...capture, pending: '' });
		if (plain && e.key === 'Enter') return commitCapture();
		capture = { ...capture, pending: comboOf(e) };
	}

	/** @param {import('$lib/commandRank').Command | undefined} cmd */
	function startCapture(cmd) {
		if (!cmd || !editable(cmd) || !cmd.shortcutId) return;
		stopCapture();
		conflict = null;
		menu = null;
		capture = { cmdId: cmd.id, shortcutId: cmd.shortcutId, pending: null };
		// the registry stands down for the press we are about to record
		setShortcutCapture(true);
		window.addEventListener('keydown', onCaptureKey, true);
		const i = results.findIndex((c) => c.id === cmd.id);
		if (i >= 0) active = i;
		input?.focus();
	}

	function stopCapture() {
		if (typeof window !== 'undefined') window.removeEventListener('keydown', onCaptureKey, true);
		setShortcutCapture(false);
		capture = null;
	}

	/** @param {string} id */
	const labelOf = (id) => rowOf(id)?.label ?? id;
	/** "Move" from "Move — pick the move tool": the status line names the command, not its whole description @param {string} id */
	const shortName = (id) => labelOf(id).split(/\s+[—–]\s+/)[0];

	function commitCapture() {
		const c = capture;
		if (!c) return;
		if (c.pending === null) return; // Enter before any key: keep listening
		stopCapture();
		if (c.pending === '') {
			clearShortcut(c.shortcutId);
			status = `${shortName(c.shortcutId)} has no shortcut now`;
			return refresh();
		}
		const result = rebindShortcut(c.shortcutId, c.pending);
		if (!result.ok && result.conflict) {
			conflict = { cmdId: c.cmdId, shortcutId: c.shortcutId, keys: c.pending, otherId: result.conflict.id, otherLabel: shortName(result.conflict.id) };
			return;
		}
		if (!result.ok) {
			status = result.reason ? `Not changed: ${result.reason}` : 'That key cannot be used';
			return;
		}
		status = `Shortcut for ${shortName(c.shortcutId)} set to ${c.pending}` + (result.meshEdit ? ' (it does nothing while Edit Mesh is open)' : '');
		refresh();
	}

	function replaceConflict() {
		const c = conflict;
		if (!c) return;
		takeConflictingKeys(c.shortcutId, c.keys, c.otherId, 'replace');
		conflict = null;
		status = `Shortcut for ${shortName(c.shortcutId)} set to ${c.keys} · ${c.otherLabel} has no shortcut now`;
		refresh();
		input?.focus();
	}

	/** @param {import('$lib/commandRank').Command} cmd */
	function resetRow(cmd) {
		if (!cmd.shortcutId) return;
		resetShortcut(cmd.shortcutId);
		const keys = presetDefaultOf(cmd.shortcutId);
		status = keys ? `Shortcut for ${shortName(cmd.shortcutId)} reset to ${keys}` : `${shortName(cmd.shortcutId)} reset: no shortcut by default`;
		refresh();
	}

	/** Settings ▸ Shortcuts, filtered to this row @param {import('$lib/commandRank').Command} cmd */
	function openInSettings(cmd) {
		const label = cmd.shortcutId ? labelOf(cmd.shortcutId) : cmd.label;
		close();
		settingsSection.set(/** @type {any} */ ('shortcuts'));
		settingsSearchSeed.set(label);
		settingsOpen.set(true);
	}

	/** @param {MouseEvent} e @param {import('$lib/commandRank').Command} cmd @param {number} i */
	function openMenu(e, cmd, i) {
		if (phone) return;
		e.preventDefault();
		active = i;
		menu = { x: e.clientX, y: e.clientY, cmd };
	}
	/** @param {import('$lib/commandRank').Command} cmd */
	function menuItems(cmd) {
		const row = cmd.shortcutId ? rowOf(cmd.shortcutId) : null;
		const can = editable(cmd);
		const atDefault = !!row && row.keys === presetDefaultOf(row.id);
		return [
			{ label: 'Run', icon: 'play', action: () => run(cmd) },
			{ separator: true },
			{ label: 'Change shortcut', icon: 'keyboard', hint: CAPTURE_KEY, disabled: !can, tooltip: cmd.locked || (row ? '' : 'This command has no shortcut row'), action: () => tick().then(() => startCapture(cmd)) },
			{ label: 'Reset to default', icon: 'rotate-ccw', disabled: !can || atDefault, tooltip: row ? 'Back to ' + (presetDefaultOf(row.id) || 'no key') + ' (the active keymap)' : '', action: () => resetRow(cmd) },
			{ label: 'Open in Settings ▸ Shortcuts', icon: 'settings', disabled: !row, action: () => openInSettings(cmd) }
		];
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			conflict = null;
			const n = results.length;
			if (!n) return;
			active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
			scrollTo(active);
		} else if (e.key === CAPTURE_KEY && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			startCapture(results[active]);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (conflict) replaceConflict();
			else run(results[active]);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			if (menu) menu = null;
			else if (conflict) conflict = null;
			else close();
		}
		// the palette's keys are its own — no window handler (Escape deselects) sees them
		e.stopPropagation();
	}

	onDestroy(stopCapture);
</script>

{#if $commandPaletteOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="cp-scrim" class:cp-scrim-sheet={phone} onclick={close}></div>
	<div
		id="command-palette"
		class="tp-ui cp"
		class:cp-sheet={phone}
		data-layout={phone ? 'sheet' : 'window'}
		style={phone ? `--cp-sheet-h: ${sheetShown}px` : ''}
		use:backClose={close}
		role="dialog"
		aria-label="Command palette"
		transition:fade|global={{ duration: phone ? motionMs(130) : 0 }}
	>
		{#if phone}
			<SheetGrip class="cp-grip" label="command palette" height={sheetShown} onresize={sheetResize} onclose={close} />
		{/if}
		<div class="cp-search">
			<Icon name="search" size={16} aria-hidden="true" />
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
			{#if !phone}<kbd class="cp-kbd">Esc</kbd>{/if}
		</div>
		<div id="command-palette-list" class="cp-list" role="listbox" bind:this={list} use:minimalScroll>
			{#each results as cmd, i (cmd.id)}
				{@const capturing = capture?.cmdId === cmd.id}
				{@const clash = conflict?.cmdId === cmd.id ? conflict : null}
				<!-- svelte-ignore a11y_click_events_have_key_events (the field owns the keys: ↑/↓, Enter, F2) -->
				<div
					id={'cp-item-' + i}
					class="cp-item"
					class:cp-item-capturing={capturing}
					role="option"
					tabindex="-1"
					aria-selected={i === active}
					data-index={i}
					data-kind={cmd.kind}
					data-command={cmd.id}
					data-shortcut={cmd.shortcutId}
					onmousemove={() => (active = i)}
					onclick={() => (capture || conflict ? ((conflict = null), stopCapture(), input?.focus()) : run(cmd))}
					oncontextmenu={(e) => openMenu(e, cmd, i)}
				>
					<span class="cp-line">
						<span class="cp-kind">{KIND[/** @type {'tool'} */ (cmd.kind)] ?? cmd.kind}</span>
						<span class="cp-main">
							<span class="cp-label">{cmd.label}</span>
							{#if cmd.detail}<span class="cp-detail">{cmd.detail}</span>{/if}
						</span>
						{#if !phone}
							<span class="cp-keycol">
								{#if capturing}
									<span class="cp-capture" role="status">
										{#if capture?.pending}<KeyChips keys={capture.pending} />{:else if capture?.pending === ''}<span class="cp-capture-none">No key</span>{:else}<span class="cp-capture-wait">Press keys</span>{/if}
									</span>
								{:else if cmd.locked}
									<span class="cp-keys cp-keys-locked" title={cmd.locked}><KeyChips keys={cmd.keys || ''} muted /></span>
								{:else if cmd.keys && editable(cmd)}
									<button type="button" class="cp-keys cp-chip-btn" title="Change shortcut ({CAPTURE_KEY})" aria-label={'Change shortcut for ' + cmd.label + ', now ' + cmd.keys} onclick={(e) => (e.stopPropagation(), startCapture(cmd))}><KeyChips keys={cmd.keys} /></button>
								{:else if cmd.keys}
									<span class="cp-keys"><KeyChips keys={cmd.keys} /></span>
								{:else if editable(cmd)}
									<button type="button" class="cp-add" aria-label={'Add a shortcut for ' + cmd.label} onclick={(e) => (e.stopPropagation(), startCapture(cmd))}>Add shortcut</button>
								{/if}
							</span>
						{/if}
					</span>
					{#if clash}
						<span class="cp-conflict" role="alert">
							<span class="cp-conflict-text"><KeyChips keys={clash.keys} /> Used by {clash.otherLabel}</span>
							<button type="button" class="cp-conflict-btn cp-replace" onclick={(e) => (e.stopPropagation(), replaceConflict())}>Replace</button>
							<button type="button" class="cp-conflict-btn cp-cancel" onclick={(e) => (e.stopPropagation(), (conflict = null), input?.focus())}>Cancel</button>
						</span>
					{/if}
				</div>
			{:else}
				<div class="cp-empty">Nothing matches “{query}”.</div>
			{/each}
		</div>
		{#if !phone}
			<div class="cp-foot">
				<span class="cp-status" role="status" aria-live="polite">{status}</span>
				{#if capture}
					<span class="cp-hints"><span><kbd>Enter</kbd> saves</span><span><kbd>Esc</kbd> cancels</span><span><kbd>Backspace</kbd> no key</span></span>
				{:else if editable(results[active])}
					<button type="button" class="cp-hint-btn" id="command-palette-change-key" title="Change the shortcut of the highlighted command" onclick={() => startCapture(results[active])}><kbd>{CAPTURE_KEY}</kbd> Change shortcut</button>
				{/if}
			</div>
		{/if}
	</div>
	{#if menu}
		<ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.cmd)} sizeKey="command-palette-row" onclose={() => (menu = null)} />
	{/if}
{/if}

<style>
	.cp-scrim {
		position: fixed;
		inset: 0;
		z-index: var(--z-portal);
		background: var(--scrim);
	}
	.cp {
		position: fixed;
		top: 14vh;
		left: 50%;
		transform: translateX(-50%);
		z-index: calc(var(--z-portal) + 1);
		width: min(600px, calc(100vw - 24px));
		max-height: 64vh;
		display: flex;
		/* showhide-v8 §5: these were stranded inside the keyboard rule below by a merge, so without the on-screen
		   keyboard the palette had no panel and laid its field and list out side by side (the owner's shots) */
		flex-direction: column;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-modal);
		box-shadow: var(--shadow-window);
		color: var(--text);
		font-family: var(--font-ui);
		overflow: hidden;
	}
	/* phone-polish item 2: the on-screen keyboard covers the lower half — the palette takes the top
	   of what stays visible, and its list scrolls inside */
	:global(:root.kb-open) .cp:not(.cp-sheet) {
		top: calc(var(--kb-top, 0px) + 8px);
		max-height: calc(100dvh - var(--kb-inset, 0px) - var(--kb-top, 0px) - 16px);
	}
	/* 103 H14 row 3: on a phone, the main menu's sheet (phone.css #sidebar70): full width above the bottom bar, the
	   remembered height, 18 px top corners — and above the on-screen keyboard while it is up, never taller than what
	   it leaves */
	.cp.cp-sheet {
		top: auto;
		left: 0;
		right: 0;
		bottom: max(var(--ps-bar-h, 0px), var(--kb-inset, 0px));
		transform: none;
		width: auto;
		height: min(var(--cp-sheet-h, 70vh), calc(100dvh - max(var(--ps-bar-h, 0px), var(--kb-inset, 0px)) - var(--kb-top, 0px) - 8px));
		max-height: var(--ps-sheet-max, 92vh);
		padding: 0 8px;
		border-radius: 18px 18px 0 0;
		border-bottom: 0;
	}
	.cp-scrim-sheet {
		background: transparent;
	}
	.cp-sheet :global(.cp-grip) {
		margin: 0 -8px;
	}
	.cp-search {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 14px;
		border-bottom: 1px solid var(--border);
		color: var(--text-faint);
		flex: 0 0 auto;
	}
	.cp-sheet .cp-search {
		padding: 0 6px;
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
	/* the forms plugin paints a ring + border on a focused text input; the palette's field
	   is the whole header, so its focus is the open palette itself */
	.cp-input:focus {
		outline: none;
		box-shadow: none;
		border-color: transparent;
	}
	.cp-input::placeholder {
		color: var(--text-faint);
	}
	.cp-kbd,
	.cp-foot kbd {
		font: 500 var(--fs-badge) var(--font-ui-mono);
		color: var(--text-faint);
		padding: 1px 6px;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
	}
	.cp-list {
		overflow-y: auto;
		min-height: 0; /* shrinks with the palette (the keyboard rule above) */
		flex: 1 1 auto;
		padding: 6px;
	}
	.cp-sheet .cp-list {
		padding: 6px 0;
	}
	/* 103 row 8: one row height for the palette, the main menu and Settings ▸ Shortcuts (--key-row-h), the label and
	   its detail on ONE line (the label truncates before it pushes the key column), the keys in one right column */
	.cp-item {
		display: flex;
		flex-direction: column;
		justify-content: center;
		width: 100%;
		min-height: var(--key-row-h, 32px);
		padding: 0 10px;
		border-radius: var(--radius-button);
		color: var(--text);
		text-align: left;
		cursor: pointer;
		outline: none;
	}
	.cp-line {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: var(--key-row-h, 32px);
		min-width: 0;
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
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
	}
	.cp-label {
		flex: 0 1 auto;
		min-width: 0;
		font-size: var(--fs-body);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cp-detail {
		flex: 0 10000 auto;
		min-width: 0;
		font-size: var(--fs-badge);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* the key column: one width for every row, right-aligned, a fixed gutter to the label */
	.cp-keycol {
		flex: 0 0 auto;
		min-width: var(--key-col-w, 112px);
		display: inline-flex;
		justify-content: flex-end;
		align-items: center;
		margin-left: 8px;
	}
	.cp-chip-btn,
	.cp-add {
		display: inline-flex;
		align-items: center;
		height: 24px;
		padding: 0 4px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		cursor: pointer;
	}
	.cp-chip-btn:hover,
	.cp-chip-btn:focus-visible {
		border-color: var(--accent);
	}
	.cp-add {
		padding: 0 8px;
		font-size: var(--fs-badge);
		color: var(--text-faint);
		visibility: hidden;
	}
	.cp-item:hover .cp-add,
	.cp-item[aria-selected='true'] .cp-add,
	.cp-add:focus-visible {
		visibility: visible;
	}
	.cp-add:hover {
		border-color: var(--border-strong);
		color: var(--text);
	}
	.cp-keys-locked {
		cursor: help;
	}
	.cp-capture {
		display: inline-flex;
		align-items: center;
		height: 24px;
		padding: 0 8px;
		border: 1px solid var(--accent);
		border-radius: 6px;
		background: var(--surface-inset);
		font-size: var(--fs-badge);
		color: var(--accent-text);
	}
	.cp-capture-none {
		color: var(--text-muted);
	}
	.cp-conflict {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		padding: 0 0 6px;
		font-size: var(--fs-desc);
		color: var(--warn-text);
		cursor: default;
	}
	.cp-conflict-text {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.cp-conflict-btn {
		height: 26px;
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface-1);
		font: inherit;
		color: var(--text);
		cursor: pointer;
	}
	.cp-conflict-btn:hover {
		background: var(--surface-hover);
	}
	.cp-empty {
		padding: 18px 12px;
		text-align: center;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.cp-foot {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 32px;
		padding: 0 14px;
		border-top: 1px solid var(--border);
		font-size: var(--fs-badge);
		color: var(--text-muted);
		flex: 0 0 auto;
	}
	.cp-status {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
	}
	.cp-hints {
		display: inline-flex;
		gap: 12px;
		white-space: nowrap;
	}
	.cp-hint-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 24px;
		padding: 0 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		font: inherit;
		color: var(--text-muted);
		white-space: nowrap;
		cursor: pointer;
	}
	.cp-hint-btn:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	/* 53 A1: at a large UI scale a command's name WRAPS rather than ellipsising (no text clipped) */
	:global(:root[data-ui-large]) .cp-label,
	:global(:root[data-ui-large]) .cp-detail {
		white-space: normal;
		overflow-wrap: anywhere;
	}
	:global(:root[data-ui-large]) .cp-main {
		flex-wrap: wrap;
	}
	:global(:root[data-ui-large]) .cp-kind {
		flex-basis: auto;
	}
	@media (pointer: coarse) {
		.cp-item,
		.cp-line {
			min-height: 48px;
		}
		.cp-input {
			font-size: 16px;
		}
	}
</style>
