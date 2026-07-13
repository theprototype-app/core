<script lang="ts">
	// Floating professional code editor (107): Explorer text files and the
	// custom-node definition editor share this window. Ctrl+S saves; the title
	// carries a dirty dot. Esc / ✕ close, prompting to save unsaved edits via an
	// in-window dialog (219). Closing calls the opener's onClose (218 refocus).
	import { textEditorTarget } from '$lib/fileWindows';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import CodeEditor from './CodeEditor.svelte';

	let code = $state('');
	let dirty = $state(false);
	let showSavePrompt = $state(false);
	let openedFor: any = null;

	$effect(() => {
		const target = $textEditorTarget;
		if (target && target !== openedFor) {
			openedFor = target;
			code = target.code;
			dirty = false;
			showSavePrompt = false;
		}
	});

	function save() {
		$textEditorTarget?.onSave(code);
		dirty = false;
	}
	function close() {
		showSavePrompt = false;
		$textEditorTarget?.onClose?.(); // 218: let the opener (Explorer) refocus
		textEditorTarget.set(null);
		openedFor = null;
	}
	// close, but ask first if there are unsaved edits (219)
	function requestClose() {
		if (dirty) showSavePrompt = true;
		else close();
	}
	function onKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') {
			e.preventDefault();
			save();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			if (showSavePrompt) showSavePrompt = false; // Esc cancels the prompt
			else requestClose();
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
			<button class="ui-button-quiet" title="Close" onclick={requestClose}>✕</button>
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

		<!-- 219: in-window unsaved-changes dialog (was a toast) -->
		{#if showSavePrompt}
			<div class="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
				<div class="ui-panel w-72 rounded-lg p-4 text-sm shadow-2xl">
					<p class="mb-3 font-semibold text-gray-100">Save changes to {$textEditorTarget.title}?</p>
					<p class="mb-4 text-xs text-gray-400">Your edits will be lost if you don't save them.</p>
					<div class="flex justify-end gap-2">
						<button
							id="text-editor-cancel"
							class="ui-button-quiet"
							onclick={() => (showSavePrompt = false)}>Cancel</button
						>
						<button id="text-editor-discard" class="ui-button-quiet text-red-300" onclick={close}
							>Don't save</button
						>
						<button
							id="text-editor-savenclose"
							class="ui-button-quiet bg-primary-700 text-white"
							onclick={() => {
								save();
								close();
							}}>Save</button
						>
					</div>
				</div>
			</div>
		{/if}
	</div>
{/if}
