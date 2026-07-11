<script lang="ts">
	import Chat from './menu/Chat.svelte';
	import Toasts from './menu/Toasts.svelte';
	import Connect from './menu/Connect.svelte';
	import Controls from './menu/Controls.svelte';
	import Inspector from './menu/Inspector.svelte';
	import MenuSidebar from './menu/Sidebar.svelte';
	import MenuSettings from './menu/Settings.svelte';
	import SessionsManager from './menu/SessionsManager.svelte';
	import CharacterModal from './menu/CharacterModal.svelte';
	import ViewportMenu from './menu/ViewportMenu.svelte';
	import MeshEditPopup from './menu/MeshEditPopup.svelte';
	import MarqueeOverlay from './menu/MarqueeOverlay.svelte';
	import AddMenu from './menu/AddMenu.svelte';
	import ObjectSearch from './menu/ObjectSearch.svelte';
	import TabStrips from './menu/TabStrips.svelte';
	import VoiceChat from './menu/VoiceChat.svelte';
	import AnnotationPopover from './menu/AnnotationPopover.svelte';
	import Library from './menu/Library.svelte';
	import { DarkMode } from 'flowbite-svelte';
	import Users from './menu/Users.svelte';
	import News from './menu/News.svelte';

	import { isLocked } from '../stores/sceneStore'
</script>

<Chat />

<div class={$isLocked ? 'hidden' : ''}>
<News />
<Connect />
<Controls />
<Inspector />
<MenuSidebar />
<MenuSettings />
<SessionsManager />
<CharacterModal />
<ViewportMenu />
<MeshEditPopup />
<MarqueeOverlay />
<AddMenu />
<ObjectSearch />
<TabStrips />
<VoiceChat />
<AnnotationPopover />
<Library />
<Toasts />
<Users />
</div>

<div class="dark-mode hidden"><DarkMode /></div>
