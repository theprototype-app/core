<script lang="ts">
	// 41 G15 — THE BREADCRUMB BAR (a kit primitive). One line, in the layout flow, so it can
	// never sit on top of what it describes: the node editor's old "Scene > Angelfish 1 —
	// object flow" chips floated over the graph and wrapped into a tower on a phone
	// (node-graph-text.jpg).
	//
	//   - every crumb ELLIPSIZES; ancestors give way before the current crumb does (flex-shrink 3
	//     against 1), so the place you are stays readable longest;
	//   - the FULL name is the crumb's `title` (hover) and, on touch, a LONG PRESS shows it in a
	//     bubble (a phone has no hover) — the lift after that hold does not open the list;
	//   - a click/tap opens the crumb's SIBLINGS (`siblings()` -> ContextMenu rows, the current one
	//     `checked`) to jump to. On a phone ContextMenu is the bottom action sheet, so the list is
	//     thumb-sized for free;
	//   - `actions` renders at the right end and never shrinks (an Add button must stay reachable).
	import type { Snippet } from 'svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import Icon from './Icon.svelte';
	import { touchHold } from '$lib/ui/touchHold.js';

	type Crumb = {
		/** stable id, also `data-crumb` on the button */
		key: string;
		label: string;
		/** the full name (hover / long press); defaults to the label */
		title?: string;
		icon?: string;
		/** the rows of this crumb's dropdown: its siblings, the current one `checked` */
		siblings?: () => any[];
	};
	let {
		crumbs,
		id = undefined,
		label = 'Breadcrumb',
		menuKey = 'crumbs',
		actions = undefined
	}: { crumbs: Crumb[]; id?: string; label?: string; menuKey?: string; actions?: Snippet } = $props();

	let menu = $state<{ x: number; y: number; items: any[]; key: string } | null>(null);
	let tip = $state<{ text: string; x: number; y: number } | null>(null);
	let heldAt = -Infinity;
	let tipTimer = 0;

	function open(c: Crumb, el: HTMLElement) {
		// the lift that ends a long press is the tooltip's, not a tap
		if (performance.now() - heldAt < 800) return;
		if (menu?.key === c.key) {
			menu = null;
			return;
		}
		const items = c.siblings?.() ?? [];
		if (!items.length) return;
		const r = el.getBoundingClientRect();
		menu = { x: Math.round(r.left), y: Math.round(r.bottom + 2), items, key: c.key };
	}
	function hold(c: Crumb, x: number, y: number) {
		heldAt = performance.now();
		menu = null;
		const w = typeof window === 'undefined' ? 400 : window.innerWidth;
		tip = { text: c.title || c.label, x: Math.min(Math.max(x, 96), w - 96), y };
		clearTimeout(tipTimer);
		tipTimer = window.setTimeout(() => (tip = null), 3500);
	}
	/** the bubble lives in <body>: a dock is its own stacking context, and the selection toolbar
	 *  above the dock covered a bubble drawn inside it */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}
	// a tip goes with the next press anywhere (a phone has no "mouse leaves")
	$effect(() => {
		if (!tip) return;
		const off = () => (tip = null);
		const t = window.setTimeout(() => window.addEventListener('pointerdown', off, true), 0);
		return () => {
			clearTimeout(t);
			window.removeEventListener('pointerdown', off, true);
		};
	});
</script>

<nav {id} class="tp-crumbs" aria-label={label}>
	<ol class="tp-crumbs-list">
		{#each crumbs as c, i (c.key)}
			{#if i > 0}
				<li class="tp-crumb-sep" aria-hidden="true"><Icon name="chevron-right" size={16} /></li>
			{/if}
			<li class="tp-crumb-li" class:tp-crumb-current={i === crumbs.length - 1}>
				<button
					type="button"
					class="tp-crumb"
					data-crumb={c.key}
					title={c.title || c.label}
					aria-current={i === crumbs.length - 1 ? 'location' : undefined}
					aria-haspopup="menu"
					aria-expanded={menu?.key === c.key}
					onclick={(e) => open(c, e.currentTarget as HTMLElement)}
					use:touchHold={{ onhold: (x, y) => hold(c, x, y) }}
				>
					{#if c.icon}<Icon name={c.icon} size={16} aria-hidden="true" />{/if}
					<span class="tp-crumb-text">{c.label}</span>
				</button>
			</li>
		{/each}
	</ol>
	{#if actions}
		<div class="tp-crumbs-actions">{@render actions()}</div>
	{/if}
</nav>

{#if tip}
	<div use:portal class="tp-crumb-tip" role="tooltip" style:left="{tip.x}px" style:top="{tip.y}px">{tip.text}</div>
{/if}
{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} sizeKey={menuKey} onclose={() => (menu = null)} />
{/if}

<style>
	.tp-crumbs {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		/* sized by its tallest control (a kit sm button: 32 desktop, 44 touch), never wrapped */
		min-height: 34px;
		padding: 1px 4px;
		white-space: nowrap;
		background: var(--surface-1);
		border-bottom: 1px solid var(--border);
	}
	.tp-crumbs-list {
		display: flex;
		align-items: center;
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
		padding: 0;
		list-style: none;
		overflow: hidden;
	}
	.tp-crumb-li {
		display: flex;
		min-width: 1.75rem;
		flex: 0 3 auto;
	}
	.tp-crumb-li.tp-crumb-current {
		flex: 0 1 auto;
	}
	.tp-crumb-sep {
		display: flex;
		flex: 0 0 auto;
		color: var(--text-faint);
	}
	.tp-crumb {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		max-width: 16rem;
		height: 24px;
		padding: 0 6px;
		border-radius: var(--radius-button);
		font-size: var(--fs-desc);
		color: var(--text-2);
		background: transparent;
	}
	.tp-crumb:hover,
	.tp-crumb[aria-expanded='true'] {
		background: var(--surface-hover);
		color: var(--text);
	}
	.tp-crumb-current .tp-crumb {
		font-weight: 600;
		color: var(--text);
	}
	.tp-crumb :global(svg) {
		flex: 0 0 auto;
	}
	.tp-crumb-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tp-crumbs-actions {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: 0 0 auto;
	}
	.tp-crumb-tip {
		position: fixed;
		z-index: var(--z-menu);
		transform: translate(-50%, calc(-100% - 18px));
		max-width: min(80vw, 22rem);
		padding: 6px 10px;
		border-radius: var(--radius-button);
		border: 1px solid var(--border-strong);
		background: var(--surface-2);
		color: var(--text);
		font-size: var(--fs-desc);
		white-space: normal;
		overflow-wrap: anywhere;
		pointer-events: none;
		box-shadow: 0 4px 14px color-mix(in srgb, var(--bg-app) 45%, transparent);
	}
	/* a finger needs a taller target than a mouse */
	@media (pointer: coarse) {
		.tp-crumbs {
			min-height: 40px;
		}
		.tp-crumb {
			height: 32px;
			padding: 0 8px;
		}
	}
</style>
