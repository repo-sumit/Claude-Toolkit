(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	function getRuntime() {
		return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
	}
	function rid() {
		return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	}

	class BridgeClient {
		constructor() {
			this._pending = new Map();
			this._listeners = new Map();
			window.addEventListener('message', (event) => {
				if (event.source !== window) return;
				const d = event.data;
				if (!d || d.ct !== CT.CONST.MARKER) return;
				if (d.type === 'ct:response') {
					const p = this._pending.get(d.requestId);
					if (!p) return;
					this._pending.delete(d.requestId);
					clearTimeout(p.t);
					d.ok ? p.resolve(d.payload) : p.reject(new Error(d.error || 'Bridge request failed'));
					return;
				}
				const ls = this._listeners.get(d.type);
				if (ls) for (const fn of ls) fn(d.payload);
			});
		}
		on(type, fn) {
			if (!this._listeners.has(type)) this._listeners.set(type, new Set());
			this._listeners.get(type).add(fn);
			return () => this._listeners.get(type)?.delete(fn);
		}
		request(kind, payload, timeoutMs = 20000) {
			const requestId = rid();
			return new Promise((resolve, reject) => {
				const t = setTimeout(() => {
					this._pending.delete(requestId);
					reject(new Error(`Bridge timed out (${kind})`));
				}, timeoutMs);
				this._pending.set(requestId, { resolve, reject, t });
				window.postMessage({ ct: CT.CONST.MARKER, type: 'ct:request', requestId, kind, payload }, '*');
			});
		}
		requestUsage(orgId) {
			return this.request('usage', { orgId }, 15000);
		}
		requestConversation(orgId, conversationId) {
			return this.request('conversation', { orgId, conversationId });
		}
	}

	let ready = null;
	function injectBridgeOnce() {
		if (ready) return ready;
		const runtime = getRuntime();
		if (!runtime) return Promise.resolve(false);
		if (document.getElementById(CT.CONST.BRIDGE_SCRIPT_ID)) return Promise.resolve(true);
		ready = new Promise((resolve) => {
			const s = document.createElement('script');
			s.id = CT.CONST.BRIDGE_SCRIPT_ID;
			s.src = runtime.getURL('src/injected/bridge.js');
			s.onload = () => resolve(true);
			s.onerror = () => resolve(false);
			(document.head || document.documentElement).appendChild(s);
		});
		return ready;
	}

	CT.bridge = new BridgeClient();
	CT.injectBridgeOnce = injectBridgeOnce;
})();
