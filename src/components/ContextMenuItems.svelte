<script lang="ts">
	// Recursive item list for ContextMenu — nested `children` open as submenus
	// on hover to any depth (77 needs Add ▸ Mesh ▸ …). Legacy-mode component so
	// <svelte:self> keeps the recursion simple.
	// Submenus render position:FIXED at coordinates measured from their row
	// (103): they escape the scrollable menu container entirely, so long menus
	// can overflow-y without ever growing a horizontal scrollbar.
	//
	// 15-Q — items may additionally carry:
	//   { header: { title, badge?, locked? } }  a target strip (name + type badge
	//                                           + optional "locked by X" line)
	//   { section: 'Edit' }                     a quiet uppercase section label
	//   icon: 'copy'                            lucide kebab name (ui/Icon.svelte)
	//   hint: 'Ctrl+D'                          dimmed right-aligned shortcut hint
	// 16-P3 adds `checked: true` — the ACTIVE choice of a group (bold + accent),
	// which replaced the old '● ' label prefix.
	//
	// W1 adds two more:
	//   keepOpen: true      the row's action runs and the menu STAYS UP (owned by
	//                       ContextMenu's `run`, documented there)
	//   rowActions: [{ icon, label, tooltip?, disabled?, run }]
	//                       small trailing controls INSIDE the row — the toolbar's
	//                       Customize list needs a reorder pair beside each button, and
	//                       a row that both toggles and reorders cannot say that with a
	//                       label. They are inline CONTROLS, not menu commands: the
	//                       click never reaches the row (stopPropagation) and never
	//                       closes the menu, so `keepOpen` does not apply to them.
	//                       `label` is both the tooltip and the accessible name.
	//
	// W8b adds one:
	//   key: 'move'         a STABLE identity for a row in a list that REORDERS itself.
	//                       The each block below is keyed on it, so when a `keepOpen`
	//                       action rewrites the array into a new order svelte MOVES each
	//                       row's DOM node instead of rewriting the labels in place. That
	//                       is what makes a per-row reorder control usable: the button
	//                       you just pressed travels with its row, stays focused, and a
	//                       second press walks the same item another slot. Without it the
	//                       node stays put, the row under your finger becomes a DIFFERENT
	//                       item, and pressing again undoes what you just did.
	//                       Optional and namespaced against the index fallback, so every
	//                       menu that passes no key is keyed by position — byte-identical
	//                       to the unkeyed block this replaces.
	//
	// 16-P1: which submenu is open (`openPath`) and where the keyboard cursor sits
	// (`navPath` + `highlight`) are owned by ContextMenu — ONE truth shared by mouse
	// and keyboard. Hover-intent lives here: 120ms to open, 150ms to close.
	import { tick } from 'svelte';
	import Icon from './ui/Icon.svelte';
	export let items: any[] = [];
	export let onrun: (item: any) => void;
	/** this level's submenu chain from the root ([] at the top level) */
	export let path: string[] = [];
	/** full chain of OPEN submenus */
	export let openPath: string[] = [];
	/** level the keyboard cursor is on (usually === openPath) */
	export let navPath: string[] = [];
	/** highlighted selectable index at navPath's level */
	export let highlight: number = -1;
	/** ask the owner to open/close a submenu chain */
	export let onopen: (next: string[]) => void = () => {};
	/** pointer moved onto a row: move the keyboard cursor here too */
	export let onhover: (levelPath: string[], index: number) => void = () => {};

	let openTimer: any = null;
	let closeTimer: any = null;

	/** W8b: run a row's inline control and KEEP THE KEYBOARD ON IT.
	 *
	 *  A reorder control rewrites the list it lives in, and the keyed each block then
	 *  RELOCATES this row's node to its new slot — which Chromium treats as a blur, so
	 *  the control you just pressed silently stops being focused and a repeat press has
	 *  nowhere to go. The node survives (that is what the key buys); only the focus does
	 *  not. Re-focusing it by its own accessible NAME is what makes "press again to move
	 *  it again" true for the keyboard as well as the mouse — the label names the BUTTON,
	 *  so it follows the item wherever the move put it, and a control that has become
	 *  disabled at an end of the list is simply not re-focused. */
	async function runRowAction(act: any, host: HTMLElement) {
		act.run?.();
		await tick();
		const root = host.closest('[role="menu"]') ?? document;
		const again = root.querySelector<HTMLButtonElement>(
			`button.ctx-act[aria-label="${String(act.label).replace(/"/g, '\\"')}"]`
		);
		if (again && !again.disabled) again.focus({ preventScroll: true });
	}

	/** the child submenu open at THIS level (null = none) */
	$: openChild = openPath.length > path.length ? openPath[path.length] : null;
	/** is the keyboard cursor on this level? */
	$: atNav = navPath.length === path.length && navPath.every((label, i) => label === path[i]);

	// selectable index per row (section labels + the header strip don't count)
	$: indexOf = (() => {
		const map = new Map<any, number>();
		let index = 0;
		for (const item of items ?? []) {
			if (!item || item.section || item.header) continue;
			map.set(item, index++);
		}
		return map;
	})();

	function hoverRow(item: any, index: number) {
		clearTimeout(openTimer);
		onhover(path, index);
		if (item.children) {
			clearTimeout(closeTimer);
			if (openChild === item.label) return; // already open — just cancel any close
			openTimer = setTimeout(() => onopen([...path, item.label]), 120);
		} else if (openChild) {
			// grazing a leaf on the way INTO an open submenu must not slam it shut
			clearTimeout(closeTimer);
			closeTimer = setTimeout(() => onopen(path), 150);
		}
	}
	function leaveRow() {
		clearTimeout(openTimer);
		if (!openChild) return;
		clearTimeout(closeTimer);
		closeTimer = setTimeout(() => onopen(path), 150);
	}

	// Position the submenu by MEASURING it (no width guess): prefer to the right of
	// the row, flip to the left if it would cross the right edge, and if it still
	// won't fit (narrow screen) clamp it fully into the viewport — even if that
	// covers the parent menu, which is better than running off-screen. Vertically
	// it aligns to the row then clamps; too-tall submenus cap + scroll (.ctx-scroll).
	// The anchor is the submenu's own parent element — the ROW it belongs to — so a
	// keyboard-opened submenu places itself exactly like a hovered one.
	function placeSubmenu(node: HTMLElement) {
		const reposition = () => {
			const anchor = node.parentElement?.getBoundingClientRect();
			if (!anchor) return;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			node.style.maxHeight = vh - 8 + 'px';
			const w = node.offsetWidth;
			const h = node.offsetHeight;
			let left = anchor.right; // prefer right of the row
			if (left + w > vw - 4) left = anchor.left - w; // flip to the left of the row
			if (left < 4 || left + w > vw - 4) left = Math.max(4, vw - w - 4); // clamp (may cover parent)
			let top = Math.min(anchor.top, vh - h - 4);
			top = Math.max(4, top);
			node.style.left = left + 'px';
			node.style.top = top + 'px';
			node.style.right = 'auto';
			node.style.bottom = 'auto';
		};
		reposition();
		requestAnimationFrame(reposition); // re-measure once content/scrollbar settle
		window.addEventListener('resize', reposition);
		return { destroy: () => window.removeEventListener('resize', reposition) };
	}

	// icon column: reserve the slot for EVERY row of a level when any sibling has
	// an icon, so labels align into one column instead of ragged starts
	$: hasIcons = items.some((item) => item?.icon);

	// 38 R6: the row's box (32px, 6px corners) lives in .ctx-row below — one menu style
	const itemClass = 'cursor-pointer whitespace-nowrap';
	const disabledClass = 'ctx-disabled cursor-default whitespace-nowrap';
</script>

{#each items as item, rowAt (item?.key != null ? 'k:' + item.key : 'i:' + rowAt)}
	{#if item.header}
		<!-- 15-Q: target strip — WHAT this menu acts on (kills the counted-label
		     ambiguity); locked state lives here instead of scattered tooltips -->
		<div class="ctx-header" role="presentation">
			<div class="flex min-w-0 items-center gap-2">
				<span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">{item.header.title}</span>
				{#if item.header.badge}
					<span class="ctx-badge">{item.header.badge}</span>
				{/if}
			</div>
			{#if item.header.locked}
				<div class="ctx-locked"><Icon name="lock" size={11} /> locked by {item.header.locked}</div>
			{/if}
		</div>
	{:else if item.section}
		{#if item.section.trim()}
			<!-- quiet uppercase section label over a thin rule -->
			<div class="ctx-section" role="presentation">{item.section}</div>
		{:else}
			<!-- a blank section = a plain divider (used before Delete) -->
			<div class="ctx-divider" role="presentation"></div>
		{/if}
	{:else if item.children}
		<div
			class="relative {itemClass} ctx-row"
			class:ctx-active={atNav && indexOf.get(item) === highlight}
			class:ctx-open={openChild === item.label}
			data-ctx-active={atNav && indexOf.get(item) === highlight}
			role="menuitem"
			on:mouseenter={() => hoverRow(item, indexOf.get(item) ?? -1)}
			on:mouseleave={leaveRow}
		>
			<span class="flex items-center gap-2">
				{#if hasIcons}
					<span class="ctx-ico">{#if item.icon}<Icon name={item.icon} size={15} />{/if}</span>
				{/if}
				<span class="flex-1">{item.label}</span>
				{#if item.hint}
					<span class="ctx-hint">{item.hint}</span>
				{/if}
				<span class="ctx-chev" aria-hidden="true">▸</span>
			</span>
			{#if openChild === item.label}
				<!-- NOTE: deliberately NO role attribute — the menu suites locate submenu
				     containers by "fixed div without a role" -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					use:placeSubmenu
					on:mouseenter={() => clearTimeout(closeTimer)}
					class="ctx-scroll tp-ui tp-menu fixed min-w-36 overflow-y-auto overflow-x-hidden"
					style="z-index: calc(var(--z-menu) + 2);"
				>
					<svelte:self
						items={item.children}
						{onrun}
						path={[...path, item.label]}
						{openPath}
						{navPath}
						{highlight}
						{onopen}
						{onhover}
					/>
				</div>
			{/if}
		</div>
	{:else}
		<div
			class="{item.disabled ? disabledClass : itemClass} ctx-row {item.danger && !item.disabled ? 'ctx-danger' : ''}"
			class:ctx-active={atNav && indexOf.get(item) === highlight}
			class:ctx-checked={item.checked}
			data-ctx-active={atNav && indexOf.get(item) === highlight}
			role="menuitem"
			title={item.tooltip ?? ''}
			aria-label={item.rowActions ? item.label : undefined}
			on:mouseenter={() => hoverRow(item, indexOf.get(item) ?? -1)}
			on:mouseleave={leaveRow}
			on:click={() => onrun(item)}
		>
			<span class="flex items-center gap-2">
				{#if hasIcons}
					<span class="ctx-ico">{#if item.icon}<Icon name={item.icon} size={15} />{/if}</span>
				{/if}
				<span class="flex-1">{item.label}</span>
				{#if item.hint}
					<span class="ctx-hint">{item.hint}</span>
				{/if}
				{#if item.rowActions}
					<span class="ctx-actions">
						{#each item.rowActions as act}
							<button
								type="button"
								class="ctx-act"
								title={act.tooltip ?? act.label}
								aria-label={act.label}
								disabled={act.disabled}
								on:click|stopPropagation={(e) => runRowAction(act, e.currentTarget)}
							>
								<Icon name={act.icon} size={13} />
							</button>
						{/each}
					</span>
				{/if}
			</span>
		</div>
	{/if}
{/each}

<style>
	/* 38 R6 — ONE menu style (SPEC §4, ui/Menu): 32px rows with 6px corners, a 16px icon
	   column, the shortcut in mono right-aligned, section labels in faint uppercase. The
	   container (.tp-menu) is in src/styles/windows.css. Look only: hover-intent, the
	   keyboard cursor, submenu placement and every handler above are unchanged. */
	.ctx-row {
		display: flex;
		align-items: center;
		min-height: 32px;
		padding: 0 10px;
		border-radius: var(--radius-input);
		color: var(--text);
	}
	.ctx-row > span:first-child {
		flex: 1 1 auto;
		min-width: 0;
		gap: 10px;
	}
	@media (max-width: 639.98px) {
		.ctx-row {
			min-height: 44px;
		}
	}
	.ctx-disabled {
		color: var(--text-faint);
	}
	.ctx-danger,
	.ctx-danger .ctx-ico {
		color: var(--warn-text);
	}
	/* ONE highlight for mouse and keyboard — they can never disagree (16-P1) */
	.ctx-row.ctx-active,
	.ctx-row.ctx-open {
		background-color: var(--surface-hover);
	}
	/* 16-P3: the ACTIVE choice of a group — bold on the accent tint (SPEC §1: one accent) */
	.ctx-checked {
		font-weight: 600;
		color: var(--text);
		background-color: var(--accent-soft);
	}
	.ctx-header {
		padding: 6px 10px 8px;
		margin-bottom: 4px;
		border-bottom: 1px solid var(--border);
		font-size: var(--fs-desc);
		color: var(--text);
		max-width: 260px;
	}
	.ctx-badge {
		flex: 0 0 auto;
		font-size: var(--fs-badge);
		padding: 1px 8px;
		border-radius: var(--radius-pill);
		background: var(--badge-bg);
		color: var(--badge-text);
	}
	.ctx-locked {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 3px;
		font-size: var(--fs-badge);
		color: var(--warn-text);
	}
	.ctx-section {
		margin-top: 4px;
		padding: 8px 10px 4px;
		font-size: var(--fs-badge);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
		cursor: default;
	}
	.ctx-divider {
		height: 1px;
		margin: 5px 4px;
		background: var(--border);
	}
	.ctx-ico {
		flex: 0 0 auto;
		width: 16px;
		display: inline-flex;
		color: var(--text-muted);
	}
	.ctx-chev {
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	/* W1: inline controls at the end of a row (the Customize list's reorder pair).
	   Muted until hovered so the row still reads as its label first. */
	.ctx-actions {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		gap: 2px;
		margin-left: 10px;
	}
	.ctx-act {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border-radius: var(--radius-input);
		color: var(--text-muted);
		background: transparent;
	}
	.ctx-act:hover:not(:disabled) {
		color: var(--text);
		background: var(--surface-active);
	}
	.ctx-act:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.ctx-hint {
		flex: 0 0 auto;
		margin-left: 16px;
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
</style>
