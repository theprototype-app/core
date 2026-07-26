<script lang="ts">
	// Phase 146: a themed replacement for the white/OS-styled native <select>.
	// A button + a custom popup list painted from the --dropdown-* theme tokens
	// (feeds 148). The popup is PORTALED to <body> so it never gets clipped by a
	// scrolling panel or offset by a transformed ancestor (the floating-window
	// drag transforms would otherwise break a position:fixed child, see the 124
	// containing-block gotcha). Drop-in for flowbite's <Select>: items:[{value,
	// name}], value (bindable), onchange(value). Keyboard + drop-up + roles.
	import { tick } from 'svelte'

	let {
		items = [],
		value = $bindable(undefined),
		onchange = (/** @type {any} */ _v: any) => {},
		placeholder = 'Select',
		id = undefined,
		disabled = false,
		title = undefined,
		class: klass = ''
	}: {
		items?: Array<{ value: any; name: string }>
		value?: any
		onchange?: (value: any) => void
		placeholder?: string
		id?: string
		disabled?: boolean
		title?: string
		class?: string
	} = $props()

	let open = $state(false)
	let btn: any = $state(null)
	let listEl: any = $state(null)
	let activeIndex = $state(-1)
	let pos = $state({ left: 0, top: 0, width: 0 })

	const eq = (a: any, b: any) => String(a) === String(b)
	let selected = $derived(items.find((it) => eq(it.value, value)))
	let label = $derived(selected ? selected.name : placeholder)

	async function reposition() {
		await tick()
		if (!btn) return
		const r = btn.getBoundingClientRect()
		const listH = Math.min(240, items.length * 30 + 10)
		const up = r.bottom + listH + 6 > window.innerHeight && r.top > listH
		pos = { left: r.left, top: up ? Math.max(4, r.top - listH - 4) : r.bottom + 4, width: r.width }
	}

	function openList() {
		if (disabled) return
		open = true
		activeIndex = items.findIndex((it) => eq(it.value, value))
		reposition()
	}
	function toggle() {
		if (open) open = false
		else openList()
	}
	function pick(item: any) {
		open = false
		if (!eq(item.value, value)) {
			value = item.value
			onchange(item.value)
		}
	}
	function scrollActive() {
		listEl?.children?.[activeIndex]?.scrollIntoView({ block: 'nearest' })
	}
	function onKey(e: KeyboardEvent) {
		if (disabled) return
		if (!open) {
			if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
				e.preventDefault()
				openList()
			}
			return
		}
		if (e.key === 'Escape') {
			open = false
			btn?.focus()
			e.preventDefault()
		} else if (e.key === 'ArrowDown') {
			activeIndex = Math.min(items.length - 1, activeIndex + 1)
			scrollActive()
			e.preventDefault()
		} else if (e.key === 'ArrowUp') {
			activeIndex = Math.max(0, activeIndex - 1)
			scrollActive()
			e.preventDefault()
		} else if (e.key === 'Enter' || e.key === ' ') {
			if (items[activeIndex]) pick(items[activeIndex])
			e.preventDefault()
		}
	}
	function onDocPointer(e: PointerEvent) {
		if (!open) return
		const t = e.target as Node
		if (btn?.contains(t) || listEl?.contains(t)) return
		open = false
	}
	function portal(node: HTMLElement) {
		document.body.appendChild(node)
		return {
			destroy() {
				node.remove()
			}
		}
	}

	$effect(() => {
		if (!open) return
		const on = () => reposition()
		window.addEventListener('scroll', on, true)
		window.addEventListener('resize', on)
		return () => {
			window.removeEventListener('scroll', on, true)
			window.removeEventListener('resize', on)
		}
	})
</script>

<svelte:window onpointerdown={onDocPointer} />

<div class={'ts-wrap ' + klass}>
	<button
		{id}
		{title}
		{disabled}
		type="button"
		class="ts-btn ui-input"
		aria-haspopup="listbox"
		aria-expanded={open}
		bind:this={btn}
		onclick={toggle}
		onkeydown={onKey}
	>
		<span class="ts-label" class:ts-placeholder={!selected}>{label}</span>
		<span class="ts-caret" aria-hidden="true">▾</span>
	</button>
</div>

{#if open}
	<ul
		use:portal
		bind:this={listEl}
		class="ts-list"
		role="listbox"
		tabindex="-1"
		style="left:{pos.left}px; top:{pos.top}px; width:{pos.width}px;"
	>
		{#each items as item, i (item.value)}
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
			<li
				role="option"
				aria-selected={eq(item.value, value)}
				class="ts-opt"
				class:ts-active={i === activeIndex}
				class:ts-selected={eq(item.value, value)}
				onmouseenter={() => (activeIndex = i)}
				onclick={() => pick(item)}
			>
				{item.name}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.ts-wrap {
		position: relative;
		/* a flex column so the button can stretch to the wrap's height when the wrap
		   is itself stretched by a flex row (e.g. beside a taller label box) — keeps
		   the control vertically aligned with its setting label instead of sitting
		   short at the top. Collapses to content height when the wrap isn't stretched. */
		display: flex;
		flex-direction: column;
	}
	.ts-btn {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		width: 100%;
		flex: 1 1 auto;
		min-height: 2.25rem;
		padding: 0.3rem 0.55rem;
		font-size: 0.8rem;
		line-height: 1.2;
		border-radius: 0.375rem;
		border: 1px solid var(--dropdown-border);
		background: var(--dropdown-bg);
		color: var(--dropdown-text);
		cursor: pointer;
	}
	.ts-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ts-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ts-placeholder {
		opacity: 0.6;
	}
	.ts-caret {
		flex-shrink: 0;
		font-size: 0.6rem;
		opacity: 0.7;
	}
	.ts-list {
		position: fixed;
		z-index: 9999;
		max-height: 240px;
		overflow-y: auto;
		margin: 0;
		padding: 0.2rem;
		list-style: none;
		border-radius: 0.375rem;
		border: 1px solid var(--dropdown-border);
		background: var(--dropdown-bg);
		color: var(--dropdown-text);
		box-shadow: 0 10px 28px rgb(0 0 0 / 0.45);
	}
	.ts-opt {
		padding: 0.3rem 0.55rem;
		font-size: 0.8rem;
		border-radius: 0.25rem;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ts-active {
		background: var(--dropdown-hover);
	}
	.ts-selected {
		color: #fff;
		background: var(--dropdown-accent);
	}
	.ts-selected.ts-active {
		background: var(--dropdown-accent);
		filter: brightness(1.12);
	}
</style>
