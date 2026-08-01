<script>
	import { onMount, onDestroy } from 'svelte';

	// Lazy CodeMirror 6 wrapper: loads the editor bundle on first mount.
	// One-way flow: `value` seeds/refreshes the doc, edits go out via onChange.

	export let value = '';
	export let onChange = (/** @type {string} */ code) => {};

	let host;
	let view = null;
	let lastEmitted = value;

	onMount(async () => {
		const [{ EditorView, basicSetup }, { javascript }] = await Promise.all([
			import('codemirror'),
			import('@codemirror/lang-javascript')
		]);
		view = new EditorView({
			doc: value,
			parent: host,
			extensions: [
				basicSetup,
				javascript(),
				EditorView.updateListener.of((update) => {
					if (!update.docChanged) return;
					lastEmitted = update.state.doc.toString();
					onChange(lastEmitted);
				}),
				// dark professional theme from the ui tokens (107) — the stock
				// white box looked pasted-in on every dark panel
				EditorView.theme(
					{
						'&': { fontSize: '12px', height: '100%', backgroundColor: '#111827', color: '#e5e7eb' },
						'.cm-scroller': { fontFamily: 'ui-monospace, Consolas, monospace' },
						'.cm-gutters': { backgroundColor: '#1f2937', color: '#6b7280', border: 'none' },
						'.cm-activeLine': { backgroundColor: 'rgba(59, 130, 246, 0.08)' },
						'.cm-activeLineGutter': { backgroundColor: 'rgba(59, 130, 246, 0.12)' },
						'.cm-content': { caretColor: '#f97316' },
						'.cm-cursor': { borderLeftColor: '#f97316' },
						'&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
							backgroundColor: 'rgba(59, 130, 246, 0.28) !important'
						}
					},
					{ dark: true }
				)
			]
		});
	});

	// external updates (a peer edited the same node) replace the doc — but not
	// our own edits echoing back, that would fight the cursor
	$: if (view && value !== lastEmitted && value !== view.state.doc.toString()) {
		lastEmitted = value;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
	}

	onDestroy(() => view?.destroy());
</script>

<div bind:this={host} class="h-full overflow-auto rounded-sm border border-gray-600 bg-gray-900 text-left"></div>
