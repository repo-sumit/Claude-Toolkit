(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	function safeName(name) {
		const base = (name || 'claude-conversation').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, '-').slice(0, 80);
		return base || 'claude-conversation';
	}

	function metaLines(conversation, trunk) {
		const approx = CT.tokenizer.isApproximate();
		let tokens = 0;
		for (const m of trunk) tokens += CT.tokenizer.countTokens(CT.conversation.countableText(m));
		const model = conversation?.model || conversation?.settings?.model || null;
		const out = [
			`> Exported from claude.ai · ${new Date().toLocaleString()}`,
			`> Messages: ${trunk.length} · Tokens: ${approx ? '~' : ''}${tokens.toLocaleString()}${model ? ` · Model: ${model}` : ''}`
		];
		return out.join('\n');
	}

	// buildMarkdown(conversation, { who: 'all'|'human'|'assistant', from?, to?, withMeta? })
	// from/to are 1-based positions on the branch, inclusive.
	function buildMarkdown(conversation, opts = {}) {
		const { who = 'all', from = null, to = null, withMeta = true } = opts;
		let trunk = CT.conversation.buildTrunk(conversation);
		const total = trunk.length;
		if (from || to) {
			const a = Math.max(1, from || 1);
			const b = Math.min(total, to || total);
			trunk = trunk.slice(a - 1, b);
		}
		if (who !== 'all') trunk = trunk.filter((m) => (m?.sender === 'assistant' ? 'assistant' : 'human') === who);

		const title = conversation?.name || 'Claude conversation';
		const lines = [`# ${title}`];
		if (withMeta) lines.push('', metaLines(conversation, trunk));
		lines.push('');
		for (const msg of trunk) {
			const speaker = msg?.sender === 'assistant' ? 'Claude' : 'You';
			const body = CT.conversation.readableText(msg);
			if (!body) continue;
			lines.push(`## ${speaker}`, '', body, '');
		}
		return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
	}

	const buildJSON = (c) => JSON.stringify(c, null, 2);

	function download(text, filename, mime) {
		const blob = new Blob([text], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 4000);
	}

	async function copyText(text) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return false;
		}
	}

	const copyMarkdown = (c, opts) => copyText(buildMarkdown(c, opts));
	const downloadMarkdown = (c, opts, suffix = '') => download(buildMarkdown(c, opts), `${safeName(c?.name)}${suffix}.md`, 'text/markdown');
	const downloadJSON = (c) => download(buildJSON(c), `${safeName(c?.name)}.json`, 'application/json');

	// ---- Conversation pieces ---------------------------------------------------
	function lastAssistantMarkdown(conversation) {
		if (!conversation) return null;
		const trunk = CT.conversation.buildTrunk(conversation);
		for (let i = trunk.length - 1; i >= 0; i--) {
			if (trunk[i]?.sender === 'assistant') {
				const t = CT.conversation.readableText(trunk[i]);
				if (t) return t;
			}
		}
		return null;
	}

	// Most recent fenced code block anywhere on the branch (any sender).
	function lastCodeBlock(conversation) {
		if (!conversation) return null;
		const trunk = CT.conversation.buildTrunk(conversation);
		for (let i = trunk.length - 1; i >= 0; i--) {
			const text = CT.conversation.readableText(trunk[i]);
			if (!text) continue;
			const re = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
			let m, last = null;
			while ((m = re.exec(text))) last = m;
			if (last) return { lang: last[1] || '', code: last[2].replace(/\n$/, '') };
		}
		return null;
	}

	const summaryPrompt = () =>
		'Create a clean summary of this conversation for sharing: a 3-sentence overview, key decisions, action items, and open questions.';

	const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

	// Print view ("PDF" via browser Save-as-PDF). Preserves code/line formatting.
	function printView(conversation) {
		const trunk = CT.conversation.buildTrunk(conversation);
		const title = conversation?.name || 'Claude conversation';
		const approx = CT.tokenizer.isApproximate();
		let tokens = 0;
		for (const m of trunk) tokens += CT.tokenizer.countTokens(CT.conversation.countableText(m));
		const rows = trunk
			.map((msg) => {
				const who = msg?.sender === 'assistant' ? 'Claude' : 'You';
				const body = CT.conversation.readableText(msg);
				if (!body) return '';
				return `<section class="${who === 'Claude' ? 'a' : 'u'}"><h3>${who}</h3><div class="b">${esc(body)}</div></section>`;
			})
			.join('');
		const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
 body{font:14px/1.65 ui-sans-serif,system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 18px;color:#1f1e1c;}
 h1{font-size:22px;margin:0 0 4px;} .meta{color:#6b6a66;font-size:12px;margin-bottom:22px;border-bottom:1px solid #e3e1d8;padding-bottom:12px;}
 section{padding:12px 16px;border-radius:10px;margin:10px 0;border:1px solid #eceae2;}
 section.u{background:#f0f5ff;border-color:#dde7fb;} section.a{background:#faf9f5;}
 h3{margin:0 0 6px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#6b6a66;}
 .b{white-space:pre-wrap;word-wrap:break-word;font-variant-ligatures:none;}
 @media print{ section{break-inside:avoid;} body{margin:10mm auto;} }
</style></head><body>
 <h1>${esc(title)}</h1>
 <div class="meta">Exported from claude.ai · ${esc(new Date().toLocaleString())} · ${trunk.length} messages · ${approx ? '~' : ''}${tokens.toLocaleString()} tokens</div>
 ${rows}
 <script>window.onload=function(){setTimeout(function(){window.print();},300);};<\/script>
</body></html>`;
		const w = window.open('', '_blank');
		if (!w) return false;
		w.document.open();
		w.document.write(html);
		w.document.close();
		return true;
	}

	CT.exporter = {
		buildMarkdown,
		copyMarkdown,
		copyText,
		downloadMarkdown,
		downloadJSON,
		printView,
		lastAssistantMarkdown,
		lastCodeBlock,
		summaryPrompt
	};
})();
