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
				EditorView.theme({
					'&': { fontSize: '12px', height: '100%' },
					'.cm-scroller': { fontFamily: 'monospace' }
				})
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

<div bind:this={host} class="h-full overflow-auto rounded border border-gray-600 bg-white text-left"></div>
