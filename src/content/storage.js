(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	function area() {
		return globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local || null;
	}

	function get(key) {
		const a = area();
		if (!a) return Promise.resolve({});
		return new Promise((resolve) => {
			try {
				const maybe = a.get(key, (r) => resolve(r || {}));
				if (maybe && typeof maybe.then === 'function') maybe.then((r) => resolve(r || {}));
			} catch {
				resolve({});
			}
		});
	}

	function set(obj) {
		const a = area();
		if (!a) return Promise.resolve();
		return new Promise((resolve) => {
			try {
				const maybe = a.set(obj, () => resolve());
				if (maybe && typeof maybe.then === 'function') maybe.then(() => resolve());
			} catch {
				resolve();
			}
		});
	}

	const KEY = CT.CONST.STORAGE_KEY;
	let cache = null;

	async function load() {
		const data = await get(KEY);
		const stored = data?.[KEY] || {};
		cache = { ...structuredCloneSafe(CT.DEFAULTS), ...stored };
		// Ensure prompts array exists even if stored settings predate it.
		if (!Array.isArray(cache.prompts)) cache.prompts = structuredCloneSafe(CT.DEFAULTS.prompts);
		return cache;
	}

	function structuredCloneSafe(v) {
		try {
			return structuredClone(v);
		} catch {
			return JSON.parse(JSON.stringify(v));
		}
	}

	async function getSettings() {
		if (!cache) await load();
		return cache;
	}

	async function saveSettings(patch) {
		if (!cache) await load();
		cache = { ...cache, ...patch };
		await set({ [KEY]: cache });
		return cache;
	}

	CT.storage = { getSettings, saveSettings };
})();
