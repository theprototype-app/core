<script>
	// 18-C1: a collapsible section inside a ToolboxWindow.
	//
	// It renders NO wrapper element around its children, deliberately: the
	// toolbox body is a grid, and its content contract works by having each row
	// span it (`.tbx-label` / `.tbx-row` use `grid-column: 1 / -1`). A wrapper
	// div would make the whole section ONE grid cell and every row inside it
	// would lose that span — so the header is a grid child and the children stay
	// grid children, exactly as if the section were not there.
	//
	// The open/closed state is a LOCAL preference (localStorage, per section
	// key): which sections a user keeps open is workflow, not scene data.
	import { ChevronRight } from '@lucide/svelte';

	/** @type {{ key: string, label: string, open?: boolean, forceOpen?: boolean,
	 *   id?: string, children: any }} */
	let { key, label, open = false, forceOpen = false, id = undefined, children } = $props();

	const storeKey = $derived('tbx:sec:' + key);
	/** set once the user toggles in this session; until then the stored pref wins */
	let override = $state(/** @type {string | null} */ (null));
	// forceOpen wins (a collider session's own section has nothing to collapse to)
	const isOpen = $derived.by(() => {
		if (forceOpen) return true;
		const saved =
			override ?? (typeof localStorage !== 'undefined' ? localStorage.getItem(storeKey) : null);
		return saved === null ? open : saved === 'open';
	});

	function toggle() {
		override = isOpen ? 'closed' : 'open';
		try {
			localStorage.setItem(storeKey, override);
		} catch {}
	}
</script>

<button
	{id}
	type="button"
	class="tbx-sec-head"
	aria-expanded={isOpen}
	onclick={toggle}
	disabled={forceOpen}
>
	<ChevronRight size={11} class="tbx-sec-chev" aria-hidden="true" />
	{label}
</button>
{#if isOpen}
	{@render children()}
{/if}
