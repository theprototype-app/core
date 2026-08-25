<script lang="ts">
	import { Info, UserPlus, Download } from '@lucide/svelte';
    import { cameraPreview, stopCameraPreview, toggleCameraControl, previewLabel } from '$lib/cameraPreview'
    // R22 round 2: the connect-time library offer (see the effect below)
    import { shareAllLocal, pullAllShared, bulkCounts, stashIntoSessions } from '$lib/sharedLibrary'
    // R22 round 7: the offer is for a peer who JOINED somebody — the host's library
    // already is the session's, so there is nothing of anybody else's to adopt
    import { sessionHost } from '$lib/connectionState'
    import { autoDownload } from '$lib/sharedLibrary'
    import { explorerItems } from '$lib/explorer'
    import { projectManifest } from '$lib/projectManifest'
    import { peers, loading, loadingcount, pendingApprovals, waitingForApproval, userdata, toastStore, fixLight, showSidebar, specatorMode, restorePanels, appNotice, connectDrawerOpen, connectDrawerTab, toastsInDrawerOnly, showInfoToast, dismissToastById } from '../../stores/appStore'
    import { restoreAvailable, restoreSnapshot, dismissRestore } from '$lib/autosave'
    import { cancelOutboundRequest } from '$lib/peerApproval'
    import { rolesInfo } from '$lib/cloudHooks'
    import { sceneCommand } from '$lib/commandsHandler.svelte';
	import { objectsGroup, camSave, globalCamera, globalScene } from '../../stores/sceneStore.js';
	import { Progressbar, Toast, Button } from 'flowbite-svelte';
    import { fly } from 'svelte/transition';
    import { untrack } from 'svelte';
    // P2b: watching follows a peer's camera IN THIS WORLD, so it cannot survive them
    // opening another scene. Users.svelte gates STARTING one; this is the other half.
    import { peerScenes } from '$lib/peerScenes';
    import { currentLevel } from '$lib/levels';
    import { showToast } from '../../stores/appStore';

    /**
     * Stop watching and give the camera back. EXTRACTED from the banner button so the
     * automatic stop below cannot drift from the manual one — there is one teardown.
     * The avatar lookup is GUARDED now: by the time this runs the peer may have
     * travelled or left, and the inline version dereferenced it unconditionally.
     */
    function exitSpectate() {
        if (!$specatorMode) return;
        const dolly = $globalScene?.getObjectByName('dolly');
        if (dolly) dolly.attach($globalCamera);
        const avatar = $globalScene?.getObjectByName($specatorMode);
        if (avatar) avatar.visible = true;
        $specatorMode = false;
        // the saved pose is written by `specate`, so the BUTTON always has one. The
        // automatic stop below can fire in states the button cannot reach (a watch that
        // began before a reload, a store poked from outside), and restoring a camera we
        // never saved must be skipped rather than throw inside an $effect.
        if ($camSave) {
            $globalCamera.position.copy($camSave.position)
            $globalCamera.rotation.copy($camSave.rotation)
            $globalCamera.fov = $camSave.fov
            $globalCamera.updateProjectionMatrix()
        }
        //specating has ended send camera position once to appear for peers
        $peers.send({ type: 'camera', peerId: $peers.peer.id, position: $globalCamera.position.toArray(), rotation: $globalCamera.rotation.toArray() });
        $peers.send({ type: 'specator', peerId: $peers.peer.id, watching: 'false' });
        // bring back the panels hidden when spectating started
        restorePanels();
    }

    // …and stop by itself when the peer we are watching opens another scene. ONLY ON
    // EVIDENCE, the same rule the button uses: an absent row means "we have not been
    // told", and no name on our side means there is nothing to compare against.
    $effect(() => {
        const map = $peerScenes;
        // `specatorMode` is declared writable(false) but holds a peer-id STRING when it
        // holds anything — coerce rather than index a boolean
        const watching = typeof $specatorMode === 'string' ? $specatorMode : '';
        const ours = $currentLevel?.name ?? '';
        if (!watching) return;
        const theirs = map?.[watching]?.scene ?? '';
        if (!theirs || !ours || theirs === ours) return;
        untrack(() => {
            exitSpectate();
            showToast('Stopped watching — they opened "' + theirs + '"');
        });
    });


// CN toast routing. The viewport containers are HIDDEN (display:none, not removed —
// so each toast's expiry timer keeps running) and the live toasts instead render in
// the drawer's Toasts tab:
//  - approval requests hide from the viewport when the drawer body is OPEN (they show
//    in the Toasts tab; a "new request" cue appears in the drawer header). When the
//    drawer is closed they always pop in the viewport so they're never missed.
//  - informational toasts hide when the drawer is open OR when the user opted into
//    "toasts in the drawer only".
const hideCritical = $derived($connectDrawerOpen || $toastsInDrawerOnly);
const hideRegular = $derived($connectDrawerOpen || $toastsInDrawerOnly);

// U-3: cap how many generic toasts stack at once (older ones collapse into a
// "+N more" line) so bursts can't fill the screen
const MAX_TOASTS = 4;
// 15-P: a rush of joiners folds the same way — the drawer's Toasts tab lists
// every pending request, so the viewport never fills with approval cards
const MAX_REQUESTS = 3;

// 15-P: STICKY prompts (restore a session, the first-run notice) must never be
// evicted by a burst of ordinary toasts — only the transient ones are capped,
// and the "+N more" count reflects just those. Sticky cards render LAST so they
// hold a stable spot while transients come and go above them.
const stickyToasts = $derived($toastStore.filter((t: any) => t?.sticky));
const transientToasts = $derived($toastStore.filter((t: any) => !t?.sticky));
const hiddenCount = $derived(Math.max(0, transientToasts.length - MAX_TOASTS));
const visibleToasts = $derived([...transientToasts.slice(-MAX_TOASTS), ...stickyToasts]);

$effect(() => {
    if($loading.length > 0)
    if($objectsGroup)
    // Remove loaded UUIDs from the loading array
    // once their corresponding objects are available
    $loading.forEach((uuid) => {
        $objectsGroup.getObjectByProperty('uuid', uuid)
        if ($objectsGroup.getObjectByProperty('uuid', uuid)) {
            $loading.splice($loading.indexOf(uuid, 0), 1);
            $loading = $loading // Trigger reactivity
        }
    })
});

// 15-P2: "Receiving objects" visibility. The old machinery (showToast +
// toastStatus + a re-arming trigger()) fired its "done" branch on EVERY effect
// run once $loading emptied — and $objectsGroup pokes on every scene mutation,
// so the completed toast kept re-showing forever. One state, one rule: visible
// while a transfer runs, then a short grace so the user sees "N/N", then gone
// until the next transfer starts.
let progressVisible = $state(false);
let progressHideTimer: any;
$effect(() => {
    if ($loading.length > 0) {
        clearTimeout(progressHideTimer);
        progressVisible = true;
    } else if (progressVisible) {
        clearTimeout(progressHideTimer);
        progressHideTimer = setTimeout(() => (progressVisible = false), 2500);
    }
});

// Approve an incoming connection request. `role` (cloud roles) optionally grants the
// joiner a role right away — "Approve + edit" makes them an editor instead of the
// default viewer. A 'retry' request just re-establishes an existing whitelisted conn.
function approvePeer(approval, role) {
    $pendingApprovals = $pendingApprovals.filter((p) => p.peerId !== approval.peerId);
    if (approval.status === 'retry') {
        try { $peers.connections[approval.peerId]?.close(); } catch {}
    } else {
        $userdata.push([approval.peerId, '', '']);
    }
    $peers.send({ type: 'userdata', userdata: $userdata });
    $peers.connectToPeer(approval.peerId, true);
    if (role && $rolesInfo?.setRole) $rolesInfo.setRole(approval.peerId, role);
}
function rejectPeer(approval) {
    $pendingApprovals = $pendingApprovals.filter((p) => p.peerId !== approval.peerId);
    try { $peers.connections[approval.peerId]?.close?.(); } catch {}
}

// professional toast card: manual close (✕) + auto-dismiss timer (kept from before)
function dismiss(toast: any) {
    // 15-L: sticky info toasts carry the side effect their old bespoke close
    // button had (persist "seen", drop the restore snapshot)
    try { toast?.onDismiss?.(); } catch {}
    $toastStore = $toastStore.filter((t) => t !== toast);
}
function autoDismiss(node: any, toast: any) {
    if (toast?.sticky) return {}; // 15-L: info prompts wait for the user
    const id = setTimeout(() => dismiss(toast), typeof toast === 'string' ? 5000 : 15000);
    return { destroy() { clearTimeout(id); } };
}

// 15-L: the restore prompt and the first-run notice used to be hand-rolled
// <Toast> blocks — which is why they looked nothing like the other cards and
// never appeared in the drawer's Toasts tab. They are STATE-DRIVEN, so mirror
// each source store into a sticky INFO entry and pull it when the source clears.
// once answered, do not ask again this session: the prompt is a nudge, and one that
// came back every time a file landed would be an interruption instead
let libraryPromptDone = false;
// the inline confirm for the one destructive choice: first press arms it, second acts
let stashArmed = $state(false);

$effect(() => {
    const snap = $restoreAvailable;
    if (snap)
        showInfoToast(
            'restore-session',
            `Restore previous session? ${snap.objects} objects, saved ${new Date(snap.ts).toLocaleTimeString()}`,
            [
                { label: 'Restore', action: () => restoreSnapshot() },
                { label: 'Dismiss', action: () => dismissRestore() }
            ],
            () => dismissRestore()
        );
    else dismissToastById('restore-session');
});
// R22 round 2 (user): WHAT ABOUT THE FILES ALREADY IN MY EXPLORER? Connecting to a
// session with a library full of local files used to say nothing at all — they simply
// stayed invisible to everyone, which is correct behaviour and a terrible first
// impression. So the moment a session exists and there is something to offer, ask.
//
// One sticky INFO card, the restore-prompt shape, with the two halves of the union:
// publish mine, and fetch theirs. Ignoring it leaves everything exactly as it is —
// local files stay local, shared files stay greyed until somebody wants them.
$effect(() => {
    // a SET, not an array (peerHandler) — `.length` here meant the prompt never showed
    // a SET, not an array (peerHandler) — `.length` here meant the prompt never showed
    // ...and only for a JOINER: `sessionHost` is null when we are the host, and a host
    // has nothing to adopt because the project is already theirs
    const connected = ($peers?.openedPeers?.size ?? 0) > 0 && !!$sessionHost;
    // read the stores so the effect re-runs as the library and the index change
    void $explorerItems;
    void $projectManifest;
    const counts = connected ? bulkCounts() : { local: 0, missing: 0 };
    const parts = [];
    if (counts.local) parts.push(`${counts.local} file${counts.local === 1 ? '' : 's'} only on this device`);
    // R22 round 8: only worth mentioning when the app is NOT already fetching them.
    // With auto-download on (the default) this line describes a job in progress, and a
    // button for it would be a button for something already happening.
    if (counts.missing && !$autoDownload)
        parts.push(`${counts.missing} shared file${counts.missing === 1 ? '' : 's'} not downloaded`);
    // R22 round 7 (locked answer): NO SECOND DIALOG. Each button does one thing and says
    // what it costs; the destructive one confirms IN PLACE (its label becomes the
    // question) rather than opening a modal that asks it again. Only "Not now" dismisses
    // the toast — picking an action dismisses it because the action happened, which is
    // the timing bug in the modal version: Cancel closed the toast it came from.
    if (connected && parts.length && !libraryPromptDone)
        showInfoToast(
            'shared-library-offer',
            parts.join(' \u00b7 ') + '.',
            [
                ...(counts.local
                    ? [{ label: 'Share mine', action: () => { libraryPromptDone = true; const n = shareAllLocal(); showToast(`Sharing ${n} file${n === 1 ? '' : 's'} with peers`); dismissToastById('shared-library-offer'); } }]
                    : []),
                ...(counts.missing && !$autoDownload
                    ? [{ label: 'Download theirs', action: () => { libraryPromptDone = true; const n = pullAllShared(); showToast(`Fetching ${n} file${n === 1 ? '' : 's'} from peers`); dismissToastById('shared-library-offer'); } }]
                    : []),
                // R22 round 8: both of these are about YOUR files, so neither belongs on a
                // card that is only telling you about somebody else's. With nothing of your
                // own there is nothing to stash and nothing to decline — the card's own
                // dismiss is enough.
                ...(counts.local
                    ? [
                          stashArmed
                              ? { label: 'Really replace my library?', action: () => { libraryPromptDone = true; void stashIntoSessions(); dismissToastById('shared-library-offer'); } }
                              : { label: 'Stash mine', keepOpen: true, action: () => { stashArmed = true; } },
                          { label: 'Not now', action: () => { libraryPromptDone = true; dismissToastById('shared-library-offer'); } }
                      ]
                    : [])
            ],
            () => { libraryPromptDone = true; }
        );
    else dismissToastById('shared-library-offer');
});

$effect(() => {
    const notice = $appNotice;
    const seen = typeof localStorage !== 'undefined' && !!localStorage.getItem('hasSeenDisclaimer');
    const markSeen = () => {
        try { localStorage.setItem('hasSeenDisclaimer', 'true'); } catch {}
    };
    if (notice && !seen)
        showInfoToast(
            'app-notice',
            notice.text,
            notice.ctaUrl
                ? [{ label: notice.ctaLabel || 'Learn more', action: () => { markSeen(); window.open(notice.ctaUrl, '_blank'); } }]
                : [],
            markSeen
        );
    else dismissToastById('app-notice');
});

</script>
<!-- 15-P: ONE positioning wrapper so the two z-tiers STACK instead of overlapping.
     Both containers used to be `absolute; top:65px; left:50%`, i.e. pinned to the
     same spot — approval cards physically covered the info toasts. The wrapper
     must NOT use transform (that would create a stacking context and trap the
     children's z-index, breaking "approvals above modals"), so it centres with
     auto margins. -->
<div class="toasts-stack">

<!-- 15-P: SPECTATOR banner — a MODE indicator, not a toast. Modes belong in a
     stable, always-visible strip (the recording/impersonation-banner pattern):
     it never queues behind toasts, never shifts when one arrives, and never
     auto-expires. Keeps its red framing + prominent Exit. -->
{#if $specatorMode}
<div class="spectator-banner" transition:fly={{ y: -8, duration: 180 }}>
    <div class="spectator-inner">
        <span class="spectator-dot" aria-hidden="true"></span>
        <div class="inline-flex items-center">
            <p class="spectator-text">
                Watching <strong>{$specatorMode}</strong>
            </p>
            <button
            class="spectator-exit"
            title="Stop watching and return to your own camera"
            onclick={exitSpectate}
            >Exit</button
        >
        </div>
    </div>
</div>
{/if}

<!-- 16-P5: previewing a camera OBJECT is a MODE, so it gets the same always-
     visible strip as "Watching <peer>" (never queues behind toasts, never
     auto-expires). Control hands the camera to the normal viewport navigation
     (WASD + mouse) and writes the pose back onto the marker. -->
{#if $cameraPreview}
<div class="spectator-banner preview-banner" transition:fly={{ y: -8, duration: 180 }}>
    <div class="spectator-inner">
        <span class="spectator-dot" aria-hidden="true"></span>
        <div class="inline-flex items-center">
            <p class="spectator-text">
                Previewing <strong>{previewLabel($cameraPreview.uuid)}</strong>
            </p>
            <button
                class="preview-control"
                class:on={$cameraPreview.controlling}
                title={$cameraPreview.controlling
                    ? 'Stop flying the camera (its new pose is kept, as one undo step)'
                    : 'Fly this camera with WASD + mouse, like the viewport camera'}
                onclick={() => toggleCameraControl()}
                >{$cameraPreview.controlling ? 'Stop control' : 'Control'}</button
            >
            <button
                class="spectator-exit"
                title="Leave the preview and return to your own view"
                onclick={() => stopCameraPreview()}>Exit</button
            >
        </div>
    </div>
</div>
{/if}
<!-- E1: CRITICAL container — connection requests + pending outbound requests stay
     ABOVE modals (--z-toast beats the NON-MODAL dialogs at --z-modal) so an
     approval is never missed while a modal is open. -->
<div class="my-4 toasts-container toasts-critical"
class:cxd-hidden={hideCritical}
style="z-index: var(--z-toast); pointer-events: none;"
>
{#each $pendingApprovals.slice(0, MAX_REQUESTS) as approval}
<div class="my-1 tp-toast tp-toast--req" transition:fly={{ y: -8, duration: 180 }}>
    <div class="tp-toast-body">
        <UserPlus size={16} class="tp-toast-icon" aria-hidden="true" />
        <div class="tp-toast-main">
            <div class="tp-toast-text">
                Connection request <span class="cxreq-id">{String(approval.peerId).slice(0, 6).toUpperCase()}</span>
            </div>
            <div class="tp-toast-actions">
                {#if $rolesInfo}
                    <button class="cxreq-btn cxreq-view" onclick={() => approvePeer(approval, null)} title="Approve as a view-only viewer">View only</button>
                    {#if approval.status !== 'retry'}
                        <button class="cxreq-btn cxreq-editor" onclick={() => approvePeer(approval, 'editor')} title="Approve and grant edit access">Editor access</button>
                    {/if}
                {:else}
                    <button class="cxreq-btn cxreq-editor" onclick={() => approvePeer(approval, null)}>Approve</button>
                {/if}
                <button class="cxreq-btn cxreq-reject" onclick={() => rejectPeer(approval)} title="Decline">Reject</button>
            </div>
        </div>
    </div>
</div>
{/each}
<!-- 15-P: a rush of joiners folds like any other burst — the drawer lists them all -->
{#if $pendingApprovals.length > MAX_REQUESTS}
<div class="my-1 text-center">
    <button
        id="request-overflow-more"
        class="tp-toast-more"
        title="Show all connection requests in the Connect drawer"
        onclick={() => { connectDrawerTab.set('toasts'); connectDrawerOpen.set(true); }}
        >+{$pendingApprovals.length - MAX_REQUESTS} more request{$pendingApprovals.length - MAX_REQUESTS === 1 ? '' : 's'}…</button
    >
</div>
{/if}

<!-- CN: the OUTBOUND "Connection request to peer / pending" toast was removed — the
     Connect pill already shows the "Waiting for approval…" state + a Cancel button, so
     the toast was redundant chrome. Incoming approval requests (above) still toast. -->
</div>

<!-- pointer-events: none lets clicks pass through the (invisible) container area;
     each toast re-enables them for itself. REGULAR container: info/decision toasts
     sit BELOW modals (--z-toast-low) so Settings/Modules/Sessions cover them. -->
<div class="my-4 toasts-container toasts-regular"
class:cxd-hidden={hideRegular}
style="z-index: var(--z-toast-low); pointer-events: none;"
>
{#if progressVisible && $loadingcount > 0}
<!-- 15-P: transfer progress wears the shared card too (it is a notification);
     15-P2: progressVisible hides it 2.5s after the transfer completes -->
<div class="my-1 tp-toast tp-toast--progress" transition:fly={{ y: -8, duration: 180 }}>
	<div class="tp-toast-body">
		<Download size={16} class="tp-toast-icon" aria-hidden="true" />
		<div class="tp-toast-main">
			<div class="tp-toast-text">Receiving objects: {($loadingcount-$loading.length)}/{$loadingcount}</div>
			<Progressbar progress={100 * (($loadingcount-$loading.length) - 0) / ($loadingcount - 0)} color="green" size="h-1.5" class="mt-1.5" />
		</div>
	</div>
</div>
{/if}


<!-- 15-L: the restore prompt + the first-run notice now ride the normal toast
     pipeline as STICKY INFO cards (mirrored into toastStore by the $effects above),
     so they share the card chrome and appear in the Connect drawer Toasts tab. -->


{#if $fixLight}
<div class="my-1">
    <Toast  transition={fly} class="flex items-center gap-3 p-2 rounded-lg dark:bg-gray-700 dark:border-dark-700 border-2 border-red-500" onclose={() => 
        { localStorage.setItem('hasSeenDisclaimer', 'true'); }
        }>
        <div style="position: relative; left: 50%; transform: translate(-25%, -50%);">
    
        </div>
        <div class="mb-1 text-base font-medium text-gray-300 dark:text-brack-500 inline-flex items-center">
            
            <p class="text-sm font-medium text-gray-200 dark:text-gray-200 pr-4 overflow-hidden max-w-80">
                There is no light in the scene<br />
                Click FIX to add hemisphere. 
            </p>
            <Button
            color="primary"
            class="nob rounded-sm bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
            onclick={() => {
                showSidebar('lightProperties');
                sceneCommand('/light hemisphere');
                $fixLight = false;
            }}
            >Fix</Button
        >
        </div>
    
    </Toast>
    </div>
{/if}

{#if hiddenCount > 0}
<!-- 15-L: the overflow line is a BUTTON — the hidden toasts all live in the
     drawer's Toasts tab, so send the user straight there -->
<div class="my-1 text-center">
    <button
        id="toast-overflow-more"
        class="tp-toast-more"
        title="Show all toasts in the Connect drawer"
        onclick={() => { connectDrawerTab.set('toasts'); connectDrawerOpen.set(true); }}
        >+{hiddenCount} more…</button
    >
</div>
{/if}
<!-- keyed by the entry (dedupe keeps plain strings unique; action toasts are
     distinct objects): an UNKEYED each reuses rows here, so a neighbour's expiry
     migrated text across nodes and svelte 5.5x left a stuck duplicate behind -->
{#each visibleToasts as toast (toast)}
<div class="my-1 tp-toast" class:tp-toast--info={toast?.kind === 'info'} transition:fly={{ y: -8, duration: 180 }} use:autoDismiss={toast}>
    {#if !toast?.noClose}
        <button class="tp-toast-x" title="Dismiss" aria-label="Dismiss" onclick={() => dismiss(toast)}>✕</button>
    {/if}
    <div class="tp-toast-body">
        <Info size={16} class="tp-toast-icon" aria-hidden="true" />
        <div class="tp-toast-main">
            <div class="tp-toast-text">{typeof toast === 'string' ? toast : toast.text}</div>
            {#if typeof toast !== 'string' && toast.actions?.length}
                <div class="tp-toast-actions">
                    {#each toast.actions as entry}
						<!-- R22 round 7: `keepOpen` is what makes an INLINE CONFIRM possible. Every
						     action used to dismiss the toast, so a button that arms a second press
						     closed the very card it was arming — which is the timing complaint the
						     modal version had, one layer down. -->
						<button
							class="tp-toast-action"
							onclick={() => {
								entry.action();
								if (!entry.keepOpen) dismiss(toast);
							}}>{entry.label}</button
						>
                    {/each}
                </div>
            {/if}
        </div>
    </div>
</div>
{/each}

</div>
</div><!-- /toasts-stack -->

<style>
    /* toasts stay clickable while the empty container area passes clicks through */
    :global(.toasts-container > div) {
        pointer-events: auto;
    }
    /* 15-P: the two z-tiers live in ONE wrapper so they STACK (critical first,
       then regular) instead of being pinned to the same coordinates and
       overlapping. Centred with auto margins — a transform here would create a
       stacking context and trap the children's z-index, which is what keeps
       approvals above modals and regular toasts below them. */
    .toasts-stack {
        position: absolute;
        top: 65px;
        left: 0;
        right: 0;
        margin-inline: auto;
        width: min(500px, 94vw);
        pointer-events: none;
    }
    .toasts-container {
        position: relative;
        width: 100%;
    }
    /* the stack owns the top offset now; the containers just flow inside it */
    .toasts-critical:empty,
    .toasts-regular:empty {
        display: none;
    }
    .cxd-hidden {
        display: none !important;
    }
    /* connection-request card — 15-P: the card CHROME is now .tp-toast--req (shared
       with every other toast); only the role-coloured buttons + the peer-id chip
       remain bespoke (viewer=gray, editor=blue, reject=outlined red). */
    .cxreq-id { font-size: 11px; color: #9ca3af; font-family: ui-monospace, monospace; }
    .cxreq-btn { font-size: 11px; padding: 4px 10px; border-radius: 7px; border: 0; cursor: pointer; color: #fff; white-space: nowrap; }
    .cxreq-view { background: #6b7280; }
    .cxreq-view:hover { background: #7b8494; }
    .cxreq-editor { background: #2563eb; }
    .cxreq-editor:hover { background: #1d4ed8; }
    .cxreq-reject { background: transparent; border: 1px solid rgb(248 113 113 / 0.4); color: #f87171; }
    .cxreq-reject:hover { background: rgb(220 38 38 / 0.15); }
    /* professional notification toast (replaces the flowbite green toast) */
    .tp-toast {
        pointer-events: auto;
        position: relative;
        width: min(420px, 94vw);
        margin: 0 auto;
        background: var(--color-form, rgb(31 41 55 / 0.98));
        border: 1px solid rgb(255 255 255 / 0.1);
        border-left: 3px solid #60a5fa;
        border-radius: 12px;
        padding: 10px 32px 10px 12px;
        box-shadow: 0 12px 30px rgb(0 0 0 / 0.4);
        backdrop-filter: blur(6px);
    }
    .tp-toast-body { display: flex; align-items: flex-start; gap: 9px; }
    /* the icon is a lucide component's svg (outside this component's scope hash) */
    .tp-toast-body :global(.tp-toast-icon) { color: #60a5fa; margin-top: 1px; flex: 0 0 auto; }
    .tp-toast-main { min-width: 0; flex: 1 1 auto; }
    .tp-toast-text { font-size: 12.5px; color: #e5e7eb; line-height: 1.4; }
    .tp-toast-actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; }
    .tp-toast-action { font-size: 11px; color: #93c5fd; background: transparent; border: 0; cursor: pointer; padding: 0; text-decoration: underline; }
    .tp-toast-action:hover { color: #bfdbfe; }
    .tp-toast-x {
        position: absolute; top: 7px; right: 7px; width: 20px; height: 20px;
        border: 0; background: transparent; color: rgb(156 163 175); cursor: pointer;
        font-size: 11px; line-height: 1; border-radius: 6px;
    }
    .tp-toast-x:hover { color: #fff; background: rgb(255 255 255 / 0.08); }
    /* 15-L: INFO variant — the standing, informational prompts (restore a
       session, the first-run notice). Teal reads as "system info" against the
       blue default notification and the amber approval card; the icon needs
       :global because it is a lucide component's own svg. */
    /* 15-P: connection requests + transfer progress wear the same card, so the
       whole stack reads as one system. Amber = needs a decision; the progress
       card keeps the neutral blue of an ordinary notification. */
    .tp-toast--req { border-left-color: #f59e0b; }
    .tp-toast--req :global(.tp-toast-icon) { color: #f59e0b; }
    .tp-toast--req .tp-toast-actions { gap: 8px; margin-top: 8px; }
    .tp-toast--progress { border-left-color: #22c55e; }
    .tp-toast--progress :global(.tp-toast-icon) { color: #22c55e; }
    .tp-toast--info { border-left-color: #2dd4bf; background: var(--color-form, rgb(31 41 55 / 0.98)); }
    .tp-toast--info :global(.tp-toast-icon) { color: #2dd4bf; }
    .tp-toast--info .tp-toast-action { color: #5eead4; }
    .tp-toast--info .tp-toast-action:hover { color: #99f6e4; }
    /* 15-P: SPECTATOR mode banner. A mode is not a notification: it gets its own
       fixed strip so it can never be queued behind toasts or shifted when one
       arrives (the user's complaint), never expires, and stays exactly centred.
       Red framing + a live dot + a prominent Exit, the recording-banner pattern. */
    .spectator-banner {
        /* FIRST child of the stack, so it owns a fixed spot: toasts flow BELOW
           it and can never displace it (the old version was a toast in the
           queue, so every new toast shoved it). Not `fixed` — top-centre is the
           Connect pill's, and the banner would collide with it. */
        position: relative;
        z-index: var(--z-toast);
        display: flex;
        justify-content: center;
        margin-bottom: 6px;
        pointer-events: none;
    }
    .spectator-inner {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 8px 6px 12px;
        border-radius: 999px;
        background: rgb(31 41 55 / 0.97);
        border: 1px solid rgb(239 68 68 / 0.55);
        box-shadow: 0 10px 26px rgb(0 0 0 / 0.4);
        backdrop-filter: blur(6px);
    }
    .spectator-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #ef4444;
        box-shadow: 0 0 0 3px rgb(239 68 68 / 0.2);
        animation: spectator-pulse 1.8s ease-in-out infinite;
    }
    @keyframes spectator-pulse {
        50% { opacity: 0.35; }
    }
    .spectator-text {
        font-size: 12.5px;
        color: #e5e7eb;
        margin: 0;
        white-space: nowrap;
    }
    .spectator-text strong { color: #fff; font-weight: 650; }
    .spectator-exit {
        margin-left: 10px;
        font-size: 11.5px;
        font-weight: 600;
        padding: 5px 14px;
        border-radius: 999px;
        border: 0;
        cursor: pointer;
        background: #ef4444;
        color: #fff;
    }
    .spectator-exit:hover { background: #dc2626; }
    /* 16-P5: preview banner reuses the strip, in a calmer blue */
    .preview-banner .spectator-inner {
        border-color: rgb(138 180 248 / 0.5);
        background: rgb(30 41 59 / 0.92);
    }
    .preview-banner .spectator-dot { background: #8ab4f8; }
    .preview-control {
        margin-left: 10px;
        border-radius: 6px;
        padding: 2px 10px;
        font-size: 11px;
        font-weight: 600;
        color: #e5e7eb;
        background: rgb(148 163 184 / 0.25);
    }
    .preview-control:hover { background: rgb(148 163 184 / 0.4); }
    .preview-control.on {
        color: #0b1220;
        background: #8ab4f8;
    }
    @media (prefers-reduced-motion: reduce) {
        .spectator-dot { animation: none; }
    }
    /* the "+N more" overflow line is a button into the drawer's Toasts tab */
    .tp-toast-more {
        pointer-events: auto;
        border: 0; background: transparent; cursor: pointer;
        font-size: 11px; color: rgb(156 163 175); padding: 2px 8px; border-radius: 6px;
    }
    .tp-toast-more:hover { color: #e5e7eb; background: rgb(255 255 255 / 0.08); text-decoration: underline; }
    /* narrow: full-width connect bar (row 1) + logo/profile (row 2) sit above; keep
       toasts below both */
    @media (max-width: 640px) {
        .toasts-stack {
            top: 124px;
        }
    }
</style>