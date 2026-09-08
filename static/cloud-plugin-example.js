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

	// 3b) cloudApi v2 mount points (roadmap #14): the profile dropdown (account /
	//     preferences) and the Connect info-drawer (room / host settings). Guarded so
	//     the example still works against a v1 host.
	if (typeof cloudApi.mountProfile === 'function') {
		cloudApi.mountProfile((el) => {
			const b = document.createElement('button');
			b.id = 'cloud-profile-signin';
			b.textContent = 'Sign in to cloud';
			b.style.cssText = 'font-size:12px;padding:4px 8px;border-radius:8px;background:#7c3aed;color:#fff;width:100%';
			el.appendChild(b);
			return () => b.remove();
		});
	}
	if (typeof cloudApi.mountConnectDrawer === 'function') {
		cloudApi.mountConnectDrawer((el) => {
			const d = document.createElement('div');
			d.id = 'cloud-drawer-section';
			d.style.cssText = 'font-size:11px;color:#9ca3af';
			d.textContent = 'Room settings would appear here.';
			el.appendChild(d);
			return () => d.remove();
		});
	}

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

	// 6) Community (example) — cloudApi v3 (roadmap #28-A): publish · play · remix.
	//    Everything below is typeof-probed so the example still registers on a v2 host.
	//    A LOCAL provider that lists the bundled template index stands in for a real
	//    backend: it is the OSS-visible proof that the seams work and the fixture the
	//    community-seams e2e drives. A real plugin swaps the fetch for its own API.
	if (typeof cloudApi.setCommunityProvider === 'function') {
		cloudApi.setCommunityProvider({
			// the rows: gallery-shaped, plus the optional provider-only fields a card
			// renders when present (id / href / likeCount / remixOf)
			list: async () => {
				const res = await fetch('/templates/index.json');
				const data = await res.json();
				return (data.templates || []).map((t, i) => ({
					...t,
					id: 'example-' + t.slug,
					href: 'https://example.com/s/' + t.slug,
					likeCount: (i + 1) * 3,
					remixOf: i === 1 ? { id: 'example-' + data.templates[0].slug, title: data.templates[0].title } : null
				}));
			},
			// a card click: the provider decides, and here it simply loads the file
			load: (entry) => cloudApi.loadRemoteScene({ sceneUrl: entry.sceneUrl, title: entry.title, slug: entry.slug }),
			// ONE quiet row above the grid
			notice: () => ({ text: 'Community (example): these are the bundled templates, listed through a provider.', href: 'https://example.com/community' }),
			// replaces "Submit yours on GitHub"
			submit: { label: 'Publish from the app (example)', action: () => cloudApi.toast('The publish dialog would open here.') }
		});
	}

	// 6b) The row under Save. A plain `.side-row` button — the sidebar's row look
	//     reaches the slot, so it reads as a native row. Its click exercises
	//     buildSceneBundle, and stashes the result for the e2e to read.
	if (typeof cloudApi.mountSidebar === 'function') {
		cloudApi.mountSidebar((el) => {
			const btn = document.createElement('button');
			btn.id = 'cloud-publish-row';
			btn.className = 'side-row';
			btn.type = 'button';
			const ico = document.createElement('span');
			ico.className = 'side-ico';
			ico.textContent = '\u2601';
			const label = document.createElement('span');
			label.style.cssText = 'flex:1;white-space:nowrap';
			label.textContent = 'Publish (example)';
			btn.append(ico, label);
			btn.onclick = async () => {
				const bundle = await cloudApi.buildSceneBundle({ assets: true, flow: true });
				try {
					window.__cloudLastBundle = bundle;
				} catch {
					/* ignore */
				}
				cloudApi.toast(
					'Bundle ready: ' + bundle.meta.objectCount + ' object(s), ' + Math.round(bundle.meta.bytes / 1024) + ' KB' +
						(bundle.meta.hasFlow ? ', flow' : '') + (bundle.meta.hasAudio ? ', audio' : '') + (bundle.meta.hasGame ? ', game' : '')
				);
			};
			el.appendChild(btn);
			return () => btn.remove();
		});
	}

	// 6c) The api itself, for the e2e (a real plugin keeps it private).
	try {
		window.__cloudApi = cloudApi;
	} catch {
		/* ignore */
	}
}
