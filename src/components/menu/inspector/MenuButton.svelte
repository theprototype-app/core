<script>
	// 38 R5 — a button that opens the shared Menu under itself ("+ Light ▾", "Presets ▾").
	// Menu is look + keyboard only, so the open/close lives here: the button toggles it,
	// choosing an item, Escape, or a press outside closes it. Each item's action is the one
	// its old standalone button ran (the caller's `onselect`), and items keep their ids.
	import { tick } from 'svelte';
	import Button from '../../ui/Button.svelte';
	import Menu from '../../ui/Menu.svelte';

	/** @type {{text?: string, icon?: string, label?: string, items?: any[], full?: boolean, align?: 'start'|'end', id?: string, onselect?: (item: any) => void}} */
	let { text = '', icon = '', label = '', items = [], full = false, align = 'start', id = undefined, onselect = () => {} } = $props();

	let open = $state(false);
	/** @type {HTMLElement | null} */ let root = $state(null);

	async function toggle() {
		open = !open;
		if (open) {
			await tick();
			/** @type {HTMLElement | null | undefined} */ (root?.querySelector('[role="menuitem"]:not(:disabled)'))?.focus();
		}
	}

	/** @param {any} item */
	function choose(item) {
		open = false;
		onselect(item);
	}

	/** @param {PointerEvent} e */
	function outside(e) {
		if (open && root && !root.contains(/** @type {Node} */ (e.target))) open = false;
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (open && e.key === 'Escape') {
			e.stopPropagation();
			open = false;
		}
	}
</script>

<svelte:window onpointerdown={outside} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tp-ui mb" class:mb-full={full} bind:this={root} onkeydown={onKey}>
	<Button variant="outline" size="sm" {icon} iconRight="chevron-down" {full} {id} aria-haspopup="menu" aria-expanded={open} title={label || undefined} onclick={toggle}>{text}</Button>
	{#if open}
		<div class="mb-pop" class:mb-end={align === 'end'}>
			<Menu {items} label={label || text} onselect={choose} />
		</div>
	{/if}
</div>

<style>
	.mb {
		position: relative;
		display: inline-flex;
	}
	.mb-full {
		display: flex;
		flex: 1;
	}
	.mb-pop {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 20;
		min-width: 100%;
	}
	.mb-end {
		left: auto;
		right: 0;
	}
</style>
