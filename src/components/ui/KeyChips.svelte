<script>
	// 103 row 8 — ONE way to draw a shortcut: each key a chip in one style, one separator between them, used by Ctrl+K,
	// Settings ▸ Shortcuts and the main menu. The text content stays the combo string ("Ctrl+Shift+S": the separator IS
	// the "+", no whitespace in the markup), so a reader of textContent sees what it always saw.
	//   keys    the combo ('Ctrl+Shift+S'); a display label with spaces ('W A S D', 'V (hold)') is one chip
	//   muted   a greyed chip (a key that cannot be changed here)
	/** @type {{ keys: string, muted?: boolean, class?: string } & Record<string, any>} */
	let { keys, muted = false, class: cls = '', ...rest } = $props();

	/** @param {string} combo @returns {string[]} */
	function parts(combo) {
		const text = String(combo || '');
		if (!text) return [];
		if (/\s/.test(text)) return [text];
		// 'Ctrl++' = Ctrl and the plus key
		const out = text.split('+');
		while (out.length > 1 && out[out.length - 1] === '' && out[out.length - 2] === '') {
			out.splice(out.length - 2, 2, '+');
		}
		return out.filter((p, i) => p !== '' || i === out.length - 1).map((p) => p || '+');
	}
	const list = $derived(parts(keys));
</script>

<span class="kc {cls}" class:kc-muted={muted} {...rest}>{#each list as key, i (i)}{#if i}<span class="kc-sep" aria-hidden="true">+</span>{/if}<kbd class="kc-key">{key}</kbd>{/each}</span>

<style>
	.kc {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		flex: 0 0 auto;
		white-space: nowrap;
		line-height: 1;
	}
	.kc-key {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		min-width: 20px;
		height: 20px;
		padding: 0 5px;
		border: 1px solid var(--border-strong);
		border-bottom-width: 2px;
		border-radius: 4px;
		background: var(--surface-inset);
		color: var(--text-2);
		font: 500 var(--fs-badge) / 1 var(--font-ui-mono);
	}
	.kc-sep {
		color: var(--text-faint);
		font: 500 var(--fs-badge) / 1 var(--font-ui-mono);
	}
	.kc-muted .kc-key {
		border-color: var(--border);
		background: transparent;
		color: var(--text-faint);
	}
</style>
