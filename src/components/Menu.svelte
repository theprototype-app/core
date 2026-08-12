<script lang="ts">
	import Chat from './menu/Chat.svelte';
	import AiAssistant from './menu/AiAssistant.svelte';
	import MeshGenModal from './menu/MeshGenModal.svelte';
	import MeshJobsCard from './menu/MeshJobsCard.svelte';
	import Toasts from './menu/Toasts.svelte';
	import FramingGuide from './menu/FramingGuide.svelte';
	import CameraPipWindow from './menu/CameraPipWindow.svelte';
	import Connect from './menu/Connect.svelte';
	import Controls from './menu/Controls.svelte';
	import Inspector from './menu/Inspector.svelte';
	import MenuSidebar from './menu/Sidebar.svelte';
	import MenuSettings from './menu/Settings.svelte';
	import SessionsManager from './menu/SessionsManager.svelte';
	import TemplatesModal from './menu/TemplatesModal.svelte';
	import CharacterModal from './menu/CharacterModal.svelte';
	import ViewportMenu from './menu/ViewportMenu.svelte';
	import MeshEditPopup from './menu/MeshEditPopup.svelte';
	import MarqueeOverlay from './menu/MarqueeOverlay.svelte';
	import AddMenu from './menu/AddMenu.svelte';
	import ObjectSearch from './menu/ObjectSearch.svelte';
	import TabStrips from './menu/TabStrips.svelte';
	import VoiceChat from './menu/VoiceChat.svelte';
	import AnnotationPopover from './menu/AnnotationPopover.svelte';
	import AnnotationMarkers from './menu/AnnotationMarkers.svelte';
	import KnifeOverlay from './menu/KnifeOverlay.svelte';
	import NotesDrawer from './menu/NotesDrawer.svelte';
	import Library from './menu/Library.svelte';
	import { DarkMode } from 'flowbite-svelte';
	import Users from './menu/Users.svelte';
	// RW: replaced the gutted News.svelte stub (empty body, inverted hasSeenModal flag)
	import Welcome from './menu/Welcome.svelte';
	import WhatsNew from './menu/WhatsNew.svelte';

	import { isLocked } from '../stores/sceneStore'
</script>

<Chat />
<AiAssistant />
<MeshGenModal />
<MeshJobsCard />

<div class={$isLocked ? 'hidden' : ''}>
<Welcome />
<WhatsNew />
<Connect />
<Controls />
<Inspector />
<MenuSidebar />
<MenuSettings />
<SessionsManager />
<TemplatesModal />
<CharacterModal />
<ViewportMenu />
<MeshEditPopup />
<MarqueeOverlay />
<AddMenu />
<ObjectSearch />
<TabStrips />
<VoiceChat />
<!-- screen-space note markers (badge + leader line); VR uses the in-scene pins -->
<AnnotationMarkers />
<KnifeOverlay />
<AnnotationPopover />
<NotesDrawer />
<Library />
<Toasts />
<Users />
<!-- 16-P5: letterbox bars while previewing a camera at a fixed aspect -->
<FramingGuide />
<!-- 16-Q4: live preview window for the selected camera (chrome only — the image
     is an inset viewport drawn by the render loop) -->
<CameraPipWindow />
</div>

<div class="dark-mode hidden"><DarkMode /></div>
