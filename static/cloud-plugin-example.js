// theprototype — open-core cloud-plugin EXAMPLE (roadmap #13 batch M1).
//
// A cloud plugin is any ES module exporting `register(cloudApi)`. It is loaded at
// boot by cloudPlugin.js when a URL is configured:
//   - production:  VITE_CLOUD_PLUGIN=<url> at build time
//   - dev:         localStorage.setItem('cloudPluginUrl', '/cloud-plugin-example.js')
//
// This example is intentionally dependency-free (vanilla DOM) so it works as a
// separate build with no coupling to the app's framework. The real closed cloud
// plugin (theprototype.app-cloud, batch M2) implements login, Browse Rooms and role
// enforcement against the same `cloudApi`. Nothing here loads unless you opt in.

export function register(cloudApi) {
	console.log('[cloud-plugin-example] register, api v' + cloudApi.version);

	// 1) Capability gate — receive-side role enforcement. Return false to DROP a
	//    message type from a peer. Here: demo "viewer" peers (id starts with
	//    "viewer") may chat/voice/ping but cannot mutate the scene. Connection /
	//    handshake messages are always allowed by core, so they're safe to omit.
	const VIEWER_ALLOWED = new Set(['sent', 'info', 'ping', 'camera', 'specator']);
	cloudApi.setCapabilityProvider((peerId, msgType) => {
		if (String(peerId).startsWith('viewer')) return VIEWER_ALLOWED.has(msgType);
		return true; // editors/admins: allow everything
	});

	// 2) Auth provider — pre-approve known/authenticated peers (skip the manual
	//    Approve). `authorize` is a synchronous lookup against state the plugin
	//    maintains from its own async login. Demo: auto-approve ids starting "cloud".
	cloudApi.setAuthProvider({
		authorize: (peerId) => String(peerId).startsWith('cloud')
	});

	// 3) UI mount point in the Connect pill (login / Browse Rooms live here). A
	//    mount fn gets a DOM node and returns an optional cleanup fn.
	cloudApi.mountConnect((el) => {
		const btn = document.createElement('button');
		btn.id = 'cloud-login-btn';
		btn.textContent = 'Sign in';
		btn.style.cssText =
			'font-size:12px;padding:2px 8px;border-radius:8px;background:#7c3aed;color:#fff;white-space:nowrap';
		btn.onclick = () => cloudApi.toast('Cloud sign-in would open here.');
		el.appendChild(btn);
		return () => btn.remove();
	});

	// 4) Rebrand the first-run banner (or clear it with appNotice.set(null)).
	cloudApi.appNotice.set({
		text: 'Connected to theprototype cloud (example plugin).',
		ctaLabel: 'Account',
		ctaUrl: 'https://example.com/account'
	});

	// 5) Plugin message channel — the only way a (separately-built) plugin
	//    replicates its OWN state across the mesh (e.g. an admin broadcasting the
	//    roles map). Send with sendCloud(payload); receive with onCloudMessage.
	cloudApi.onCloudMessage((peerId, payload) => {
		console.log('[cloud-plugin-example] cloud message from', peerId, payload);
		// (demo hook for the e2e — the real plugin would apply a roles update here)
		try {
			window.__cloudLastMessage = { peerId, payload };
		} catch {
			/* ignore */
		}
	});
}
