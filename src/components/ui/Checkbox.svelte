<script>
	// 38 R3 — a checkbox, ONLY for picking items in a list (multi-select: files to export,
	// peers to invite). Every on/off SETTING is a Toggle (SPEC §2). A real <input
	// type="checkbox"> under a drawn box, so forms, labels and keyboard behave natively; the
	// accent fill when checked, a dash when `indeterminate`.
	import Icon from './Icon.svelte';

	/** @type {{checked?: boolean, indeterminate?: boolean, disabled?: boolean, label?: string, id?: string, onchange?: (next: boolean) => void} & Record<string, any>} */
	let {
		checked = $bindable(false),
		indeterminate = false,
		disabled = false,
		label = '',
		id = undefined,
		onchange = () => {},
		...rest
	} = $props();

	/** @param {Event & {currentTarget: HTMLInputElement}} e */
	function onChange(e) {
		checked = e.currentTarget.checked;
		onchange(checked);
	}
</script>

<span class="tp-ui cb" class:cb-on={checked || indeterminate} class:cb-disabled={disabled}>
	<input
		{id}
		class="cb-input"
		type="checkbox"
		{checked}
		{indeterminate}
		{disabled}
		aria-label={label || undefined}
		onchange={onChange}
		{...rest}
	/>
	<span class="cb-box" aria-hidden="true">
		{#if indeterminate}<Icon name="minus" size={12} strokeWidth={3} snap={false} />{:else if checked}<Icon name="check" size={12} strokeWidth={3} snap={false} />{/if}
	</span>
</span>

<style>
	.cb {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
		width: 16px;
		height: 16px;
	}
	/* the native input stays the hit area and the focus target, just invisible */
	.cb-input {
		position: absolute;
		inset: -6px;
		width: calc(100% + 12px);
		height: calc(100% + 12px);
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.cb-box {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		border: 1.5px solid var(--border-strong);
		border-radius: 4px;
		background: var(--surface-inset);
		color: var(--on-accent);
		pointer-events: none;
	}
	.cb-on .cb-box {
		border-color: var(--accent);
		background: var(--accent);
	}
	.cb-input:focus-visible + .cb-box {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.cb-disabled {
		opacity: 0.45;
	}
	.cb-disabled .cb-input {
		cursor: not-allowed;
	}
	@media (max-width: 639.98px) {
		.cb {
			width: 20px;
			height: 20px;
		}
		.cb-input {
			inset: -12px;
			width: calc(100% + 24px);
			height: calc(100% + 24px);
		}
	}
</style>
