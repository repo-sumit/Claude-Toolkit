(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});
	const ROOT = '00000000-0000-4000-8000-000000000000';

	function stableStringify(value) {
		const seen = new WeakSet();
		const norm = (v) => {
			if (v === null || typeof v !== 'object') return v;
			if (seen.has(v)) return '[Circular]';
			seen.add(v);
			if (Array.isArray(v)) return v.map(norm);
			const o = {};
			for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
			return o;
		};
		try {
			return JSON.stringify(norm(value));
		} catch {
			return '';
		}
	}

	function buildTrunk(conversation) {
		const msgs = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
		const byId = new Map();
		for (const m of msgs) if (m?.uuid) byId.set(m.uuid, m);
		const leaf = conversation?.current_leaf_message_uuid;
		if (!leaf) return msgs.slice();
		const trunk = [];
		let id = leaf;
		while (id && id !== ROOT) {
			const m = byId.get(id);
			if (!m) break;
			trunk.push(m);
			id = m.parent_message_uuid;
		}
		trunk.reverse();
		return trunk;
	}

	function isCountable(item) {
		if (!item || typeof item !== 'object' || typeof item.type !== 'string') return false;
		if (item.type === 'thinking' || item.type === 'redacted_thinking') return false;
		if (item.type === 'image' || item.type === 'document') return false;
		return true;
	}

	function countableText(message) {
		const parts = [];
		for (const item of Array.isArray(message?.content) ? message.content : []) {
			if (!isCountable(item)) continue;
			if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
			else if (item.type === 'tool_use') parts.push(stableStringify({ id: item.id, name: item.name, input: item.input }));
			else if (item.type === 'tool_result') parts.push(stableStringify({ tool_use_id: item.tool_use_id, is_error: item.is_error, content: item.content }));
			else if (typeof item.text === 'string') parts.push(item.text);
			else if (typeof item.content === 'string') parts.push(item.content);
		}
		for (const a of Array.isArray(message?.attachments) ? message.attachments : []) {
			if (typeof a?.extracted_content === 'string' && a.extracted_content) parts.push(a.extracted_content);
		}
		return parts.join('\n');
	}

	function readableText(message) {
		const parts = [];
		for (const item of Array.isArray(message?.content) ? message.content : []) {
			if (!item || typeof item.type !== 'string') continue;
			if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
			else if (item.type === 'tool_use') parts.push(`> 🔧 used **${item.name || 'tool'}**`);
			else if (item.type === 'tool_result') parts.push('> 📎 (tool result)');
		}
		for (const a of Array.isArray(message?.attachments) ? message.attachments : []) {
			if (a?.file_name) parts.push(`> 📎 attachment: ${a.file_name}`);
		}
		return parts.join('\n\n').trim();
	}

	function firstLabel(message) {
		for (const item of Array.isArray(message?.content) ? message.content : []) {
			if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) return item.text;
		}
		const atts = Array.isArray(message?.attachments) ? message.attachments : [];
		if (atts.length) return `📎 ${atts.length} attachment(s)`;
		for (const item of Array.isArray(message?.content) ? message.content : []) {
			if (item?.type === 'tool_use') return `🔧 ${item.name || 'tool'}`;
		}
		return '';
	}

	const norm = (t) => t.replace(/\s+/g, ' ').trim();
	const snippet = (t, n = 90) => {
		const s = norm(t);
		return s.length > n ? `${s.slice(0, n)}…` : s;
	};

	function computeMap(conversation) {
		const trunk = buildTrunk(conversation);
		const items = [];
		let total = 0;
		let max = 0;
		let lastAssistantMs = null;

		trunk.forEach((msg, index) => {
			const ms = msg?.created_at ? Date.parse(msg.created_at) : null;
			if (msg?.sender === 'assistant' && ms && (!lastAssistantMs || ms > lastAssistantMs)) lastAssistantMs = ms;
			const tokens = CT.tokenizer.countTokens(countableText(msg));
			total += tokens;
			if (tokens > max) max = tokens;
			const label = firstLabel(msg);
			items.push({
				index,
				sender: msg?.sender === 'assistant' ? 'assistant' : 'human',
				tokens,
				time: ms,
				timeLabel: ms ? CT.u.fmtTime(ms) : '',
				label: snippet(label) || (msg?.sender === 'assistant' ? '(Claude)' : '(You)'),
				searchKey: norm(label).slice(0, 80).toLowerCase()
			});
		});

		return {
			items,
			total,
			max,
			count: items.length,
			lastAssistantMs,
			cachedUntil: lastAssistantMs ? lastAssistantMs + CT.CONST.CACHE_WINDOW_MS : null,
			name: typeof conversation?.name === 'string' ? conversation.name : ''
		};
	}

	CT.conversation = { buildTrunk, countableText, readableText, computeMap };
})();
