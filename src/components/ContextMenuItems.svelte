<script lang="ts">
	// Recursive item list for ContextMenu — nested `children` open as submenus
	// on hover to any depth (77 needs Add ▸ Mesh ▸ …). Legacy-mode component so
	// <svelte:self> keeps the recursion simple.
	// Submenus render position:FIXED at coordinates measured from their row
	// (103): they escape the scrollable menu container entirely, so long menus
	// can overflow-y without ever growing a horizontal scrollbar.
	//
	// 15-Q redesign — items may additionally carry:
	//   { header: { title, badge?, locked? } }  a target strip (name + type badge
	//                                           + optional "locked by X" line)
	//   { section: 'Edit' }                     a quiet uppercase section label
	//   icon: 'copy'                            lucide kebab name (ui/Icon.svelte)
	//   hint: 'Ctrl+D'                          dimmed right-aligned shortcut hint
	// Functionality is unchanged: action/disabled/tooltip/danger/children as before.
	import Icon from './ui/Icon.svelte';
	export let items: any[] = [];
	export let onrun: (item: any) => void;

	let openSub: string | null = null;
	// the hovered row's rect — the submenu positions itself against it, then clamps
	let anchorRect: DOMRect | null = null;

	// 15-Q hover-intent: opening waits 120ms (a diagonal pass over a row no longer
	// flashes its submenu open) and closing waits 150ms (grazing a leaf on the way
	// INTO an open submenu no longer slams it shut). A new open cancels the close.
	let openTimer: any = null;
	let closeTimer: any = null;

	function openSubmenu(e: MouseEvent, item: any) {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		clearTimeout(closeTimer);
		clearTimeout(openTimer);
		if (openSub === item.label) return; // already open — just cancel any close
		openTimer = setTimeout(() => {
			anchorRect = rect;
			openSub = item.label;
		}, 120);
	}
	function scheduleSubmenuClose() {
		clearTimeout(openTimer);
		clearTimeout(closeTimer);
		if (openSub === null) return;
		closeTimer = setTimeout(() => (openSub = null), 150);
	}

	// icon column: reserve the slot for EVERY row of a level when any sibling has
	// an icon, so labels align into one column instead of ragged starts
	$: hasIcons = items.some((item) => item?.icon);

	// Position the submenu by MEASURING it (no width guess): prefer to the right of
	// the row, flip to the left if it would cross the right edge, and if it still
	// won't fit (narrow screen) clamp it fully into the viewport — even if that
	// covers the parent menu, which is better than running off-screen. Vertically
	// it aligns to the row then clamps; too-tall submenus cap + scroll (.ctx-scroll).
	function placeSubmenu(node: HTMLElement) {
		const reposition = () => {
			const a = anchorRect;
			if (!a) return;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			node.style.maxHeight = vh - 8 + 'px';
			const w = node.offsetWidth;
			const h = node.offsetHeight;
			let left = a.right; // prefer right of the row
			if (left + w > vw - 4) left = a.left - w; // flip to the left of the row
			if (left < 4 || left + w > vw - 4) left = Math.max(4, vw - w - 4); // clamp (may cover parent)
			let top = Math.min(a.top, vh - h - 4);
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

	const itemClass =
		'cursor-pointer px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-600 whitespace-nowrap';
	const disabledClass =
		'cursor-default px-3 py-1.5 text-gray-400 dark:text-gray-500 whitespace-nowrap';
</script>

{#each items as item}
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
			class="relative {itemClass}"
			role="menuitem"
			on:mouseenter={(e) => openSubmenu(e, item)}
			on:mouseleave={scheduleSubmenuClose}
		>
			<span class="flex items-center gap-2">
				{#if hasIcons}
					<span class="ctx-ico">{#if item.icon}<Icon name={item.icon} size={15} />{/if}</span>
				{/if}
				<span class="flex-1">{item.label}</span>
				<span class="text-[10px] text-gray-400">▸</span>
			</span>
			{#if openSub === item.label}
				<!-- NOTE: deliberately NO role attribute — the menu suites locate submenu
				     containers by "fixed div without a role" -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					use:placeSubmenu
					on:mouseenter={() => clearTimeout(closeTimer)}
					class="ctx-scroll fixed min-w-36 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-700"
					style="z-index: calc(var(--z-menu) + 2);"
				>
					<svelte:self items={item.children} {onrun} />
				</div>
			{/if}
		</div>
	{:else}
		<div
			class="{item.disabled ? disabledClass : itemClass} {item.danger && !item.disabled ? 'text-red-500' : ''}"
			role="menuitem"
			title={item.tooltip ?? ''}
			on:mouseenter={scheduleSubmenuClose}
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
			</span>
		</div>
	{/if}
{/each}

<style>
	.ctx-header {
		padding: 6px 12px 5px;
		margin-bottom: 3px;
		border-bottom: 1px solid rgb(148 163 184 / 0.25);
		font-size: 12px;
		max-width: 240px;
	}
	.ctx-badge {
		flex: 0 0 auto;
		font-size: 9px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		padding: 1px 6px;
		border-radius: 999px;
		background: rgb(148 163 184 / 0.18);
		color: rgb(148 163 184);
	}
	.ctx-locked {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 2px;
		font-size: 10px;
		color: #f59e0b;
	}
	.ctx-section {
		margin-top: 4px;
		padding: 5px 12px 2px;
		border-top: 1px solid rgb(148 163 184 / 0.2);
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgb(148 163 184 / 0.9);
		cursor: default;
	}
	.ctx-divider {
		margin: 4px 0 3px;
		border-top: 1px solid rgb(148 163 184 / 0.2);
	}
	.ctx-ico {
		flex: 0 0 auto;
		width: 15px;
		display: inline-flex;
		color: rgb(148 163 184);
	}
	.ctx-hint {
		flex: 0 0 auto;
		margin-left: 12px;
		font-family: ui-monospace, monospace;
		font-size: 10px;
		color: rgb(148 163 184 / 0.8);
	}
</style>
