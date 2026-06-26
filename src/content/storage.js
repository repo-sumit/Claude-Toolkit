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

	// ---- session-start timestamp (local estimate fallback) ----
	// Persisted separately from settings so a page reload mid-session keeps the
	// estimated 5h reset. Only used when the usage API hasn't surfaced an exact
	// session reset yet.
	const SESSION_KEY = 'ct_usage_session_started_at';

	async function getSessionStart() {
		const data = await get(SESSION_KEY);
		const v = data?.[SESSION_KEY];
		return Number.isFinite(v) ? v : null;
	}
	function setSessionStart(ms) {
		return set({ [SESSION_KEY]: ms });
	}
	function clearSessionStart() {
		const a = area();
		if (!a) return Promise.resolve();
		return new Promise((resolve) => {
			try {
				const maybe = a.remove(SESSION_KEY, () => resolve());
				if (maybe && typeof maybe.then === 'function') maybe.then(() => resolve());
			} catch {
				resolve();
			}
		});
	}

	CT.storage = { getSettings, saveSettings, getSessionStart, setSessionStart, clearSessionStart };
})();
