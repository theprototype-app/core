<script lang="ts">
	// Floating professional code editor (107): Explorer text files and the
	// custom-node definition editor share this window. Ctrl+S saves; the title
	// carries a dirty dot.
	import { textEditorTarget } from '$lib/fileWindows';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import CodeEditor from './CodeEditor.svelte';

	let code = $state('');
	let dirty = $state(false);
	let openedFor: any = null;

	$effect(() => {
		const target = $textEditorTarget;
		if (target && target !== openedFor) {
			openedFor = target;
			code = target.code;
			dirty = false;
		}
	});

	function save() {
		$textEditorTarget?.onSave(code);
		dirty = false;
	}
	function close() {
		textEditorTarget.set(null);
		openedFor = null;
	}
	function onKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') {
			e.preventDefault();
			save();
		}
	}
</script>

{#if $textEditorTarget}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="text-editor-window"
		class="ui-panel fixed flex flex-col overflow-hidden"
		use:dragWindow={{ key: 'textEditorWin', defaultRect: { left: 220, top: 110 } }}
		use:focusStack
		style="z-index: var(--z-window); width: 620px; height: 440px"
		onkeydown={onKeydown}
	>
		<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
			<span>📝 {$textEditorTarget.title}{dirty ? ' ●' : ''}</span>
			<span class="flex-1"></span>
			<button
				id="text-editor-save"
				class="ui-button-quiet {dirty ? 'bg-primary-700 text-white' : ''}"
				title="Save (Ctrl+S)"
				onclick={save}>💾 Save</button
			>
			<button class="ui-button-quiet" title="Close" onclick={close}>✕</button>
		</div>
		<div class="min-h-0 flex-1 p-1.5">
			<CodeEditor
				value={code}
				onChange={(c) => {
					code = c;
					dirty = true;
				}}
			/>
		</div>
	</div>
{/if}
