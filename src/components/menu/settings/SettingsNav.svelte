<script lang="ts">
	// 36 B14 — the Settings sidebar: one row per REGISTERED section (settingsNav), in the order
	// Settings.svelte declares them, each row rendering the section's own `header` snippet — so
	// a section is named once, where it is written. `layout="chips"` is the same list as a
	// horizontal strip for narrow screens (the sidebar would leave the rows no room).
	// While searching, rows for sections with no match are hidden and a click scrolls to the
	// section; otherwise a click shows that section alone. ↑/↓ walk the rows.
	import { tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { settingsSection } from '../../../stores/appStore.js';

	let { nav, layout = 'list' }: { nav: any; layout?: 'list' | 'chips' } = $props();

	// deliberate one-time reads: `nav` is created once by Settings.svelte and never replaced
	// svelte-ignore state_referenced_locally
	const { entries, active, searching } = nav;
	let buttons: (HTMLButtonElement | null)[] = $state([]);
	/** bumped when the search filter shows or hides a section */
	let filterTick = $state(0);

	// the labels are the rendered header snippets; once every row exists, pick the section
	$effect(() => {
		const list = $entries;
		void tick().then(() => {
			list.forEach((e: any, i: number) => {
				const text = buttons[i]?.textContent?.trim();
				if (text) e.label = text;
			});
			untrack(() => nav.resolve(get(settingsSection)));
		});
	});

	// a deep link while Settings is already open (the Connect drawer's "Connection settings")
	$effect(() => {
		const key = $settingsSection;
		if (key) untrack(() => nav.activateKey(key));
	});

	// the search filter writes `display` on the section headers; watch for it
	$effect(() => {
		const root = document.getElementById('settings-sections');
		if (!root) return;
		const observer = new MutationObserver(() => filterTick++);
		observer.observe(root, { attributes: true, attributeFilter: ['style'], subtree: true, childList: true });
		return () => observer.disconnect();
	});

	/** @param {any} e */
	function matches(e: any, _tick: number, on: boolean) {
		if (!on) return true;
		const el = e.el();
		return !!el && el.style.display !== 'none';
	}

	function onKey(ev: KeyboardEvent, i: number) {
		if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
		if (layout === 'list' && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) return;
		ev.preventDefault();
		const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : -1;
		const list = $entries;
		for (let j = i + step; j >= 0 && j < list.length; j += step) {
			if (!matches(list[j], filterTick, $searching)) continue;
			nav.activate(list[j]);
			buttons[j]?.focus();
			return;
		}
	}
</script>

<nav id={layout === 'list' ? 'settings-nav' : 'settings-nav-chips'} class="sn sn-{layout}" aria-label="Settings sections">
	{#each $entries as e, i (e)}
		<button
			bind:this={buttons[i]}
			class="sn-row"
			class:sn-active={!$searching && $active === e}
			hidden={!matches(e, filterTick, $searching)}
			aria-current={!$searching && $active === e ? 'page' : undefined}
			aria-expanded={e.isOpen()}
			data-section={e.label}
			onclick={() => nav.activate(e)}
			onkeydown={(ev) => onKey(ev, i)}
		>
			{@render e.header?.()}
		</button>
	{/each}
</nav>

<style>
	.sn {
		display: flex;
		gap: 2px;
	}
	.sn-list {
		flex-direction: column;
		padding: 8px 6px;
	}
	.sn-chips {
		flex-direction: row;
		overflow-x: auto;
		scrollbar-width: none;
		padding: 2px 0 6px;
	}
	.sn-chips::-webkit-scrollbar {
		display: none;
	}
	.sn-row {
		display: block;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 6px 10px;
		border-radius: 6px;
		font-size: 0.85rem;
		color: var(--text-2, rgb(203 213 225));
		background: transparent;
		cursor: pointer;
	}
	.sn-chips .sn-row {
		flex-shrink: 0;
		padding: 4px 10px;
		border: 1px solid var(--border, rgb(55 65 81));
		border-radius: 999px;
	}
	.sn-row:hover {
		background: var(--hover, rgb(55 65 81));
		color: var(--text, rgb(229 231 235));
	}
	.sn-row:focus-visible {
		outline: 2px solid var(--accent, rgb(96 165 250));
		outline-offset: -2px;
	}
	.sn-active,
	.sn-active:hover {
		background: var(--accent-fill, rgb(37 99 235));
		color: var(--on-accent, #fff);
	}
	.sn-row[hidden] {
		display: none;
	}
</style>
