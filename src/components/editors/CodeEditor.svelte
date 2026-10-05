<script>
	import { onMount, onDestroy } from 'svelte';

	// Lazy CodeMirror 6 wrapper: loads the editor bundle on first mount.
	// One-way flow: `value` seeds/refreshes the doc, edits go out via onChange.
	// 36-code (the code workspace) adds four OPTIONAL props, all inert when absent so every
	// older caller is byte-unchanged: `readOnly`, `onSave` (Ctrl/Cmd+S INSIDE the editor —
	// CodeMirror owns the key while it has focus), `reveal` ({line, token}: scroll to and put
	// the cursor on a line, once per token) and `diagnostic` ({line, message} | null: the
	// error underline + gutter mark on that line).

	export let value = '';
	export let onChange = (/** @type {string} */ code) => {};
	export let readOnly = false;
	/** @type {null | (() => void)} */
	export let onSave = null;
	/** @type {null | {line: number, token: number}} */
	export let reveal = null;
	/** @type {null | {line: number, message: string}} */
	export let diagnostic = null;

	/** @type {any} */ let host;
	/** @type {any} */ let view = null;
	let lastEmitted = value;
	/** @type {any} */ let cm = null;
	let revealed = 0;

	onMount(async () => {
		const [{ EditorView, basicSetup }, { javascript }, state, viewMod, lint] = await Promise.all([
			import('codemirror'),
			import('@codemirror/lang-javascript'),
			import('@codemirror/state'),
			import('@codemirror/view'),
			import('@codemirror/lint')
		]);
		cm = { EditorView, state, lint };
		const saveKeys = viewMod.keymap.of([
			{
				key: 'Mod-s',
				preventDefault: true,
				run: () => {
					if (!onSave) return false;
					onSave();
					return true;
				}
			}
		]);
		view = new EditorView({
			doc: value,
			parent: host,
			extensions: [
				state.Prec.highest(saveKeys),
				basicSetup,
				javascript(),
				lint.lintGutter(),
				state.EditorState.readOnly.of(!!readOnly),
				EditorView.editable.of(!readOnly),
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

	/** @param {number} line */
	function lineRange(line) {
		const doc = view.state.doc;
		const n = Math.min(Math.max(1, Math.floor(line) || 1), doc.lines);
		return doc.line(n);
	}

	$: if (view && reveal && reveal.token !== revealed) {
		revealed = reveal.token;
		const l = lineRange(reveal.line);
		view.dispatch({ selection: { anchor: l.from }, effects: cm.EditorView.scrollIntoView(l.from, { y: 'center' }) });
		view.focus();
	}

	$: if (view && cm) {
		const l = diagnostic ? lineRange(diagnostic.line) : null;
		view.dispatch(
			cm.lint.setDiagnostics(view.state, l ? [{ from: l.from, to: l.to, severity: 'error', message: diagnostic?.message ?? '' }] : [])
		);
	}

	onDestroy(() => view?.destroy());
</script>

<div bind:this={host} class="h-full overflow-auto rounded-sm border border-gray-600 bg-gray-900 text-left"></div>
