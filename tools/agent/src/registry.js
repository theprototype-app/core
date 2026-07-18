// A lightweight scene registry the agent maintains WITHOUT parsing GLTF. It is
// fed by (a) the agent's own outgoing mutations and (b) messages observed on the
// inbound conns from other peers. GLTF 'object' sync messages become uuid-only
// stubs (tracked:'stub') so list_scene can flag what it doesn't fully know.

export class Registry {
	constructor() {
		/** @type {Map<string, any>} */
		this.objects = new Map();
	}

	/** @param {string} id @param {Partial<any>} patch @param {string} [fidelity] */
	upsert(id, patch, fidelity) {
		if (!id) return;
		const prev = this.objects.get(id) || { uuid: id, tracked: fidelity || 'full' };
		const next = { ...prev, ...patch };
		if (fidelity) next.tracked = fidelity;
		this.objects.set(id, next);
	}

	/** @param {string} id */
	remove(id) {
		this.objects.delete(id);
	}

	/** @returns {any[]} */
	list() {
		return [...this.objects.values()];
	}

	get size() {
		return this.objects.size;
	}

	/** Parse a "/create Box 2 2 2" or "/light point" command for the primitive/name. */
	static primitiveOf(command) {
		if (typeof command !== 'string') return null;
		const parts = command.trim().split(/\s+/);
		return parts[1] || null;
	}

	/**
	 * Record the agent's OWN outgoing message so list_scene reflects it immediately.
	 * @param {any} msg
	 */
	observeOutgoing(msg) {
		this.observe(msg, 'self');
	}

	/**
	 * Update the registry from a protocol message (own or observed).
	 * @param {any} msg @param {string} [origin]
	 */
	observe(msg, origin) {
		if (!msg || typeof msg !== 'object') return;
		const by = origin || 'peer';
		switch (msg.type) {
			case 'create':
				this.upsert(msg.uuid, { kind: 'primitive', primitive: Registry.primitiveOf(msg.command), name: Registry.primitiveOf(msg.command), by }, 'full');
				break;
			case 'light':
				this.upsert(msg.uuid, { kind: 'light', light: Registry.primitiveOf(msg.command), name: Registry.primitiveOf(msg.command), by }, 'full');
				break;
			case 'group':
				if (msg.command) this.upsert(msg.uuid, { kind: 'group', name: Registry.primitiveOf(msg.command), by }, 'full');
				else if (msg.group) this.upsert(msg.uuid, { parent: msg.group === 'up' ? null : msg.group }, undefined); // reparent
				break;
			case 'name':
				this.upsert(msg.uuid, { name: msg.name }, undefined);
				break;
			case 'move':
				this.upsert(msg.uuid, { pos: msg.pos, rot: msg.rot, scale: msg.scale }, undefined);
				break;
			case 'color':
				if (msg.uuid !== 'background' && msg.uuid !== 'fog') this.upsert(msg.uuid, { color: msg.color }, undefined);
				break;
			case 'objectParameters':
				if (msg.parameter === 'visible') this.upsert(msg.uuid, { visible: msg.visible }, undefined);
				else if (msg.parameter === 'material') this.upsert(msg.uuid, { materialType: msg.material }, undefined);
				break;
			case 'delete':
				this.remove(msg.uuid);
				break;
			case 'object':
				// GLTF full-object sync from a peer — we don't parse it; stub it so
				// list_scene shows it exists but flags limited knowledge.
				if (msg.uuids) for (const id of msg.uuids) this.upsert(id, { by }, 'stub');
				break;
			case 'clearscene':
				this.objects.clear();
				break;
			default:
				break;
		}
	}
}
