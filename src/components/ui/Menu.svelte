<script>
	// 38 R3 — ONE menu style (SPEC §4: context menus, the Add menu, the viewport menu):
	// 32px items (48 on touch), icon 16, the shortcut in mono right-aligned, section labels in
	// faint uppercase, separators. This is the menu's LOOK and keyboard model only — where it
	// opens, what dismisses it and what an item does stay with the caller (SPEC §0: the
	// existing menus keep their open/close/focus rules; their lane maps them onto this).
	//   items   [{label, icon?, shortcut?, value?, submenu?, disabled?, warn?, dot?, id?},
	//            {separator: true}, {section: 'Tools & view'}]
	//   onselect(item)   an item was chosen (click / Enter / Space)
	// role="menu" with role="menuitem" items; ArrowUp/Down / Home / End move a roving focus
	// over enabled items. `highlight` (an index into items) is the kit's forced hover.
	import Icon from './Icon.svelte';

	/** @typedef {{label?: string, icon?: string, shortcut?: string, value?: string, submenu?: boolean, disabled?: boolean, warn?: boolean, dot?: boolean, id?: string, separator?: boolean, section?: string}} MenuItem */
	/** @type {{items?: MenuItem[], label?: string, highlight?: number, onselect?: (item: MenuItem) => void} & Record<string, any>} */
	let { items = [], label = '', highlight = -1, onselect = () => {}, ...rest } = $props();

	/** @type {HTMLElement[]} */
	const buttons = [];
	const isItem = (/** @type {MenuItem} */ it) => !it.separator && !it.section;
	const enabled = $derived(items.map((it, i) => (isItem(it) && !it.disabled ? i : -1)).filter((i) => i >= 0));

	/** @param {KeyboardEvent} e @param {number} i */
	function onKey(e, i) {
		const at = enabled.indexOf(i);
		let next = -1;
		if (e.key === 'ArrowDown') next = enabled[(at + 1) % enabled.length];
		else if (e.key === 'ArrowUp') next = enabled[(at - 1 + enabled.length) % enabled.length];
		else if (e.key === 'Home') next = enabled[0];
		else if (e.key === 'End') next = enabled[enabled.length - 1];
		if (next === undefined || next < 0) return;
		e.preventDefault();
		buttons[next]?.focus();
	}
</script>

<div class="tp-ui menu" role="menu" aria-label={label || undefined} {...rest}>
	{#each items as it, i (i)}
		{#if it.separator}
			<div class="menu-sep" role="separator"></div>
		{:else if it.section}
			<div class="menu-label" role="presentation">{it.section}</div>
		{:else}
			<button
				bind:this={buttons[i]}
				type="button"
				role="menuitem"
				id={it.id}
				class="menu-item"
				class:menu-warn={it.warn}
				class:menu-hl={i === highlight}
				tabindex={i === enabled[0] ? 0 : -1}
				disabled={it.disabled}
				aria-haspopup={it.submenu ? 'menu' : undefined}
				onclick={() => onselect(it)}
				onkeydown={(e) => onKey(e, i)}
			>
				<span class="menu-icon" aria-hidden="true">{#if it.icon}<Icon name={it.icon} size={16} />{/if}</span>
				<span class="menu-text">{it.label}</span>
				{#if it.dot}<span class="menu-dot" aria-hidden="true"></span>{/if}
				{#if it.value}<span class="menu-value">{it.value}</span>{/if}
				{#if it.shortcut}<kbd class="menu-kbd">{it.shortcut}</kbd>{/if}
				{#if it.submenu}<span class="menu-chev" aria-hidden="true"><Icon name="chevron-right" size={16} /></span>{/if}
			</button>
		{/if}
	{/each}
</div>

<style>
	.menu {
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		min-width: 220px;
		padding: 5px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow-window);
		color: var(--text);
	}
	.menu-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		height: 32px;
		padding: 0 10px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: var(--fs-desc);
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}
	.menu-item:hover:not(:disabled),
	.menu-item:focus-visible,
	.menu-hl {
		background: var(--surface-hover);
		outline: none;
	}
	.menu-item:disabled {
		color: var(--text-faint);
		cursor: default;
	}
	.menu-icon {
		display: inline-flex;
		width: 16px;
		flex-shrink: 0;
		color: var(--text-muted);
	}
	.menu-warn,
	.menu-warn .menu-icon {
		color: var(--warn-text);
	}
	.menu-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.menu-value {
		font-size: var(--fs-section);
		color: var(--text-faint);
	}
	.menu-kbd {
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		color: var(--text-faint);
		background: none;
		border: 0;
		padding: 0;
	}
	.menu-chev {
		display: inline-flex;
		color: var(--text-faint);
	}
	.menu-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
	}
	.menu-label {
		padding: 8px 10px 4px;
		font-size: var(--fs-badge);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.menu-sep {
		height: 1px;
		margin: 5px 4px;
		background: var(--border);
	}
	@media (max-width: 639.98px) {
		.menu-item {
			height: 48px;
			font-size: var(--fs-body);
		}
	}
</style>
