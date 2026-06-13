(() => {
	'use strict';

	// Runs in claude.ai's main world. Wraps window.fetch to READ (never alter)
	// the API traffic claude.ai already produces, and relays it to the content
	// script via postMessage. Nothing is sent anywhere off-page.

	const MARKER = 'ClaudeToolkit';
	const originalFetch = window.fetch;

	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);
	history.pushState = function (...a) {
		const r = originalPushState(...a);
		window.dispatchEvent(new CustomEvent('ct:urlchange'));
		return r;
	};
	history.replaceState = function (...a) {
		const r = originalReplaceState(...a);
		window.dispatchEvent(new CustomEvent('ct:urlchange'));
		return r;
	};

	window.fetch = async (...args) => {
		const url = toAbs(args[0]);
		const opts = args[1] || {};

		if (url && opts.method === 'POST' && (url.includes('/completion') || url.includes('/retry_completion'))) {
			post('ct:generation_start', {});
		}

		const response = await originalFetch.apply(window, args);

		const ct = response.headers.get('content-type') || '';
		if (ct.includes('event-stream')) readEventStream(response);

		if (url && url.includes('/chat_conversations/') && url.includes('tree=')) {
			const meta = convMeta(url);
			if (meta) relayConversation(meta, response);
		}
		return response;
	};

	function post(type, payload) {
		window.postMessage({ ct: MARKER, type, payload }, '*');
	}
	function postResponse(requestId, ok, payload, error) {
		window.postMessage({ ct: MARKER, type: 'ct:response', requestId, ok, payload, error }, '*');
	}

	function toAbs(input) {
		if (typeof input === 'string') return input.startsWith('/') ? `https://claude.ai${input}` : input;
		if (input instanceof URL) return input.href;
		if (input instanceof Request) return input.url;
		return '';
	}
	function convMeta(url) {
		const m = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
		return m ? { orgId: m[1], conversationId: m[2] } : null;
	}

	async function relayConversation({ orgId, conversationId }, response) {
		try {
			const data = await response.clone().json();
			post('ct:conversation', { orgId, conversationId, data });
		} catch {
			/* ignore */
		}
	}

	async function readEventStream(response) {
		try {
			const reader = response.clone().body?.getReader?.();
			if (!reader) return;
			const decoder = new TextDecoder();
			let buf = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split(/\r\n|\r|\n/);
				buf = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data:')) continue;
					const raw = line.slice(5).trim();
					if (!raw) continue;
					try {
						const json = JSON.parse(raw);
						if (json?.type === 'message_limit' && json.message_limit) post('ct:message_limit', json.message_limit);
					} catch {
						/* ignore */
					}
				}
			}
		} catch {
			/* best-effort */
		}
	}

	window.addEventListener('message', async (event) => {
		if (event.source !== window) return;
		const d = event.data;
		if (!d || d.ct !== MARKER || d.type !== 'ct:request') return;

		const { requestId, kind, payload } = d;
		try {
			if (kind === 'usage') {
				const { orgId } = payload || {};
				if (!orgId) throw new Error('Missing orgId');
				const res = await originalFetch(`https://claude.ai/api/organizations/${orgId}/usage`, { method: 'GET', credentials: 'include' });
				postResponse(requestId, true, await res.json(), null);
				return;
			}
			if (kind === 'conversation') {
				const { orgId, conversationId } = payload || {};
				if (!orgId || !conversationId) throw new Error('Missing orgId/conversationId');
				const u = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
				const res = await originalFetch(u, { method: 'GET', credentials: 'include' });
				const json = await res.json();
				post('ct:conversation', { orgId, conversationId, data: json });
				postResponse(requestId, true, json, null);
				return;
			}
			throw new Error(`Unknown request kind: ${kind}`);
		} catch (e) {
			postResponse(requestId, false, null, e?.message || String(e));
		}
	});
})();
