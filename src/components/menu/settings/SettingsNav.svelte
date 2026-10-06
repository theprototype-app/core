<script lang="ts">
	// 36 B14 — the Settings sidebar: one row per REGISTERED section (settingsNav), each row rendering
	// the section's own `header` snippet — so a section is named once, where it is written (and an id
	// or data-tour it carries, e.g. Touch controls' tour target, lives on the visible row).
	//
	// 37-settings (R21): GROUPED under small uppercase headers — General (Interface, Controls, Input,
	// Touch controls, Shortcuts) · Workspace (Scene, Explorer, Node types, Export) · Devices & services
	// (VR, AI, Connection) — with "About & what's new" pinned to the bottom and an unread dot after an
	// update ($lib/settings/categories.js; an unknown section another lane adds lands under "More").
	//   layout="list"  the desktop sidebar
	//   layout="home"  a phone's first screen: the same groups as 52 px NavRows with chevrons
	// While searching, rows for sections with no match are hidden and a click scrolls to the section;
	// otherwise a click shows that section alone. ↑/↓ walk the rows (in the order shown).
	import { tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { settingsSection } from '../../../stores/appStore.js';
	import { sectionKeyOf } from '$lib/settingsNav';
	import { groupSections } from '$lib/settings/categories.js';
	import { whatsNewUnseen } from '$lib/whatsNew';
	import Icon from '../../ui/Icon.svelte';

	let { nav, layout = 'list' }: { nav: any; layout?: 'list' | 'home' } = $props();

	// deliberate one-time reads: `nav` is created once by Settings.svelte and never replaced
	// svelte-ignore state_referenced_locally
	const { entries, active, searching } = nav;
	/** bumped when a label resolves or the search filter shows or hides a section */
	let filterTick = $state(0);
	/** the rows' buttons, by entry */
	const buttons = new Map<any, HTMLButtonElement>();

	const keyOf = (e: any) => sectionKeyOf(e.label);
	const grouped = $derived.by(() => {
		void filterTick;
		const list: any[] = $entries;
		const byKey = new Map(list.map((e) => [keyOf(e), e]));
		const groups = groupSections(list.map(keyOf)).map((g) => ({ group: g.group, items: g.keys.map((k) => byKey.get(k)).filter(Boolean) }));
		const about = list.find((e) => keyOf(e).startsWith('about'));
		return { groups, about };
	});
	/** every row in the order shown, for the arrow keys */
	const order = $derived([...grouped.groups.flatMap((g) => g.items), ...(grouped.about ? [grouped.about] : [])]);

	/** svelte action: remember the button, read the label once the header snippet rendered */
	function row(node: HTMLButtonElement, e: any) {
		buttons.set(e, node);
		void tick().then(() => {
			const text = node.querySelector('.sn-label')?.textContent?.trim();
			if (text && e.label !== text) {
				e.label = text;
				filterTick++;
			}
		});
		return {
			destroy() {
				if (buttons.get(e) === node) buttons.delete(e);
			}
		};
	}

	// once every row exists, pick the section
	$effect(() => {
		void $entries;
		void tick().then(() => untrack(() => nav.resolve(get(settingsSection))));
	});

	// a deep link while Settings is already open (the Connect drawer's "Connection settings")
	$effect(() => {
		const key = $settingsSection;
		if (key) untrack(() => nav.activateKey(key));
	});

	// the search filter writes `display` on the section pages; watch for it
	$effect(() => {
		const root = document.getElementById('settings-sections');
		if (!root) return;
		const observer = new MutationObserver(() => filterTick++);
		observer.observe(root, { attributes: true, attributeFilter: ['style'], subtree: true, childList: true });
		return () => observer.disconnect();
	});

	function matches(e: any, _tick: number, on: boolean) {
		if (!on) return true;
		const el = e.el();
		return !!el && el.style.display !== 'none';
	}

	function onKey(ev: KeyboardEvent, e: any) {
		if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
		ev.preventDefault();
		const step = ev.key === 'ArrowDown' ? 1 : -1;
		const list = order;
		for (let j = list.indexOf(e) + step; j >= 0 && j < list.length; j += step) {
			if (!matches(list[j], filterTick, $searching)) continue;
			nav.activate(list[j]);
			buttons.get(list[j])?.focus();
			return;
		}
	}
</script>

{#snippet navRow(e: any, about: boolean)}
	<button
		use:row={e}
		type="button"
		class="sn-row"
		class:sn-active={layout === 'list' && !$searching && $active === e}
		hidden={!matches(e, filterTick, $searching)}
		aria-current={layout === 'list' && !$searching && $active === e ? 'page' : undefined}
		data-section={e.label}
		onclick={() => nav.activate(e)}
		onkeydown={(ev) => onKey(ev, e)}
	>
		<span class="sn-label">{@render e.header?.()}</span>
		{#if about && $whatsNewUnseen}<span class="sn-dot" aria-hidden="true"></span><span class="sr-only">(new)</span>{/if}
		{#if layout === 'home'}<span class="sn-chev" aria-hidden="true"><Icon name="chevron-right" size={16} strokeWidth={1.75} /></span>{/if}
	</button>
{/snippet}

<nav id={layout === 'list' ? 'settings-nav' : 'settings-home'} class="tp-ui sn sn-{layout}" aria-label="Settings sections">
	<div class="sn-groups">
		{#each grouped.groups as g (g.group.id)}
			<div class="sn-group" data-group={g.group.id}>
				<div class="sn-group-label">{g.group.label}</div>
				<div class="sn-group-rows">
					{#each g.items as e (e)}{@render navRow(e, false)}{/each}
				</div>
			</div>
		{/each}
	</div>
	{#if grouped.about}
		<div class="sn-group sn-about">
			<div class="sn-group-rows">{@render navRow(grouped.about, true)}</div>
		</div>
	{/if}
</nav>

<style>
	.sn {
		display: flex;
		flex-direction: column;
		min-height: 100%;
		box-sizing: border-box;
	}
	.sn-list {
		padding: 14px 10px 12px;
		gap: 14px;
	}
	.sn-groups {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.sn-group-label {
		padding: 0 10px 4px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.sn-group-rows {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.sn-list .sn-about {
		margin-top: auto;
		padding-top: 10px;
		border-top: 1px solid var(--border);
	}
	.sn-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 34px;
		padding: 6px 10px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		font: inherit;
		font-size: var(--fs-body);
		text-align: left;
		color: var(--text-2);
		cursor: pointer;
	}
	.sn-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sn-row:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.sn-active,
	.sn-active:hover {
		background: var(--accent-soft);
		color: var(--accent-soft-text);
		font-weight: 500;
	}
	.sn-row[hidden] {
		display: none;
	}
	.sn-dot {
		flex-shrink: 0;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
	}
	.sn-chev {
		display: inline-flex;
		color: var(--text-faint);
	}

	/* a phone's first screen: grouped cards of 52 px NavRows */
	.sn-home {
		gap: 22px;
	}
	.sn-home .sn-groups {
		gap: 22px;
	}
	.sn-home .sn-group-label {
		padding: 0 4px 8px;
		font-size: var(--fs-section);
	}
	.sn-home .sn-group-rows {
		gap: 0;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-window);
		overflow: hidden;
	}
	.sn-home .sn-row {
		min-height: 52px;
		padding: 10px 16px;
		border-radius: 0;
		font-size: var(--fs-body);
		font-weight: 500;
		color: var(--text);
	}
	.sn-home .sn-row + .sn-row {
		border-top: 1px solid var(--border);
	}
	.sn-home .sn-row:not([hidden]) ~ .sn-row[hidden] + .sn-row {
		border-top: 1px solid var(--border);
	}
	/* Compact density (the kit's token switch) tightens the desktop menu with the rows */
	:global(:root[data-density='compact']) .sn-list .sn-row {
		min-height: 28px;
		padding-top: 4px;
		padding-bottom: 4px;
	}
</style>
