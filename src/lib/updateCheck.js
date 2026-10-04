// V8 (versioning): live update check — the build emits static/version.json
// (vite emitVersionJson plugin) and the running app polls it. When the deployed
// version differs from the one this page was built with, show ONE reload toast
// per browser session. No modal, no peer blocking, no backup nag; dev skips.
import { APP_VERSION, IS_DEV } from './version.js';
import { exportMode } from './export/exportBoot.js';
import { showToast } from '../stores/appStore.js';
import { markContentStale } from './contentBase.js';

const SHOWN_KEY = 'updateToastShown';
const POLL_MS = 15 * 60 * 1000;

async function poll() {
	try {
		if (sessionStorage.getItem(SHOWN_KEY)) return;
		// cache-busted: CDNs/proxies love to hold small JSON
		const res = await fetch('/version.json?t=' + Date.now(), { cache: 'no-store' });
		if (!res.ok) return;
		const remote = await res.json();
		if (!remote?.version || remote.version === APP_VERSION) return;
		// 1.19.1: a deploy usually ships with new content — drop the index memos so the
		// General tab / packs / Browse re-fetch on next open even before the user reloads
		markContentStale();
		sessionStorage.setItem(SHOWN_KEY, 'true');
		showToast('New version ' + remote.version + ' available — reload to update.', [
			{ label: 'Reload', action: () => location.reload() }
		]);
	} catch {
		/* offline / file:// — stay silent, try again next tick */
	}
}

/** Start polling (called once from App.svelte). The page is fresh at boot, so the
 * first check waits a full interval; a tab coming back to focus checks early. */
export function startUpdateCheck() {
	// 36-export: an export has no version.json to poll and nothing to reload into
	if (IS_DEV || exportMode || typeof window === 'undefined') return;
	setInterval(poll, POLL_MS);
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) poll();
	});
}
