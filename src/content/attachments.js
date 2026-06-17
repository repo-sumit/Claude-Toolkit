(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	// ============================================================
	// Composer attachment detection + token estimation.
	//
	// Claude's attachment DOM is not a public contract, so detection is
	// best-effort: we scope to the composer area (never the chat history) and use
	// the layered selector fallbacks in CT.SEL.ATTACHMENT_*. Whatever we can read
	// (filename, a "1.2 MB" size string, a preview text block, an <img> thumbnail)
	// feeds estimateAttachmentTokens, which always reports a confidence so the UI
	// never pretends an unreadable file is weightless.
	// ============================================================

	const sel = (key) => (CT.SEL && CT.SEL[key]) || [];

	// ---- helpers --------------------------------------------------------------
	const countWords = (t) => ((t || '').match(/\S+/g) || []).length;
	const ext = (name) => {
		const m = /\.([a-z0-9]{1,8})$/i.exec((name || '').trim());
		return m ? m[1].toLowerCase() : '';
	};

	// Map a file to a coarse category that drives the estimate strategy.
	function classify(name, mimeType, hasImageEl) {
		const e = ext(name);
		const m = (mimeType || '').toLowerCase();
		if (hasImageEl || m.startsWith('image/') || /^(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?)$/.test(e)) return 'image';
		if (/^(pdf|docx?|pptx?|odt|odp|rtf|pages|key)$/.test(e) || /pdf|msword|wordprocessing|presentation|powerpoint/.test(m)) return 'doc';
		if (/^(xlsx?|ods|tsv|numbers)$/.test(e) || /spreadsheet|excel/.test(m)) return 'sheet';
		if (
			/^(txt|text|md|markdown|mdx|csv|json|jsonl|ya?ml|xml|html?|css|scss|less|js|mjs|cjs|ts|jsx|tsx|py|java|kt|c|cc|cpp|h|hpp|cs|rb|go|rs|php|swift|sh|bash|zsh|sql|toml|ini|cfg|conf|log|tex|r|m|pl|lua|dart|vue|svelte)$/.test(e) ||
			m.startsWith('text/') || /json|csv|xml|yaml|javascript|typescript/.test(m)
		) return 'text';
		return 'unknown';
	}

	function parseSizeBytes(text) {
		const m = /(\d+(?:[.,]\d+)?)\s*(bytes|b|kb|kib|mb|mib|gb|gib)\b/i.exec(text || '');
		if (!m) return null;
		const n = parseFloat(m[1].replace(',', '.'));
		if (!Number.isFinite(n)) return null;
		const u = m[2].toLowerCase();
		const mult = u.startsWith('g') ? 1e9 : u.startsWith('m') ? 1e6 : u.startsWith('k') ? 1e3 : 1;
		return Math.round(n * mult);
	}

	// The composer + its attachment row — scoped so we never count files that
	// appear inside earlier conversation turns.
	function getScope() {
		for (const s of sel('COMPOSER_GRID')) {
			const el = document.querySelector(s);
			if (el) return el.parentElement || el;
		}
		const ed = CT.getComposer && CT.getComposer();
		if (ed) return ed.closest('form') || ed.parentElement?.parentElement || ed.parentElement || null;
		return null;
	}

	function findName(card) {
		for (const s of sel('ATTACHMENT_NAME')) {
			for (const el of card.querySelectorAll(s)) {
				const t = (el.textContent || el.getAttribute('title') || el.getAttribute('alt') || '').trim();
				if (t && /\.[a-z0-9]{1,8}$/i.test(t)) return t.replace(/\s+/g, ' ');
			}
		}
		// title / aria-label on the card or any descendant
		const attrs = [card.getAttribute('title'), card.getAttribute('aria-label')];
		for (const el of card.querySelectorAll('[title],[aria-label],img[alt]')) {
			attrs.push(el.getAttribute('title'), el.getAttribute('aria-label'), el.getAttribute('alt'));
		}
		for (const a of attrs) {
			const m = a && /([^\s/\\:*?"<>|]+\.[a-z0-9]{1,8})\b/i.exec(a);
			if (m) return m[1];
		}
		// any filename-looking token in the card's visible text
		const m = /([^\s/\\:*?"<>|]{1,80}\.[a-z0-9]{1,8})\b/i.exec(card.textContent || '');
		return m ? m[1] : '';
	}

	function findPreview(card) {
		for (const s of sel('ATTACHMENT_PREVIEW')) {
			const el = card.querySelector(s);
			const t = (el?.textContent || '').trim();
			if (t.length >= 40) return t; // only treat substantial blocks as readable content
		}
		return '';
	}

	// ---- public: detect attachments -------------------------------------------
	function getComposerAttachments() {
		const scope = getScope();
		if (!scope) return [];
		const cards = [];
		for (const s of sel('ATTACHMENT_CARD')) {
			let found;
			try {
				found = scope.querySelectorAll(s);
			} catch {
				continue; // skip a selector the browser rejects
			}
			for (const el of found) if (!cards.includes(el)) cards.push(el);
		}
		// Keep only outermost matches (a thumbnail nested inside a card is the same file).
		const outer = cards.filter((c) => !cards.some((o) => o !== c && o.contains(c)));

		const out = [];
		for (const card of outer) {
			const txt = card.textContent || '';
			const hasImageEl = !!card.querySelector('img[src^="blob:"], img[src^="data:"], img[srcset], canvas');
			const name = findName(card);
			const sizeBytes = parseSizeBytes(txt);
			const mimeType = card.querySelector('[type]')?.getAttribute('type') || '';
			const textPreview = findPreview(card);
			out.push({
				name: name || (hasImageEl ? 'image' : 'file'),
				type: classify(name, mimeType, hasImageEl),
				mimeType: mimeType || '',
				sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : null,
				textPreview: textPreview || '',
				source: 'dom',
				confidence: textPreview ? 'estimated' : sizeBytes != null ? 'metadata-only' : 'unknown'
			});
		}
		return out;
	}

	// ---- public: estimate tokens ----------------------------------------------
	// Returns { tokens, words, confidence, attachmentsCount, explanation }.
	function estimateAttachmentTokens(attachments) {
		const list = Array.isArray(attachments) ? attachments : [];
		if (!list.length) {
			return { tokens: 0, words: 0, confidence: 'exact', attachmentsCount: 0, explanation: 'No attachments.' };
		}
		const rank = { exact: 3, estimated: 2, 'metadata-only': 1, unknown: 0 };
		let tokens = 0, words = 0, agg = null;
		const parts = [];

		for (const a of list) {
			const cat = a.type || classify(a.name, a.mimeType);
			const size = typeof a.sizeBytes === 'number' && a.sizeBytes > 0 ? a.sizeBytes : null;
			let t = 0, w = 0, conf;

			if (cat === 'image') {
				// Multimodal cost is roughly fixed; never estimate an image from raw bytes.
				t = 1200;
				conf = 'estimated';
			} else if (a.textPreview && a.textPreview.trim()) {
				t = Math.ceil(a.textPreview.length / 4);
				w = countWords(a.textPreview);
				conf = 'estimated';
			} else if (size) {
				conf = 'metadata-only';
				if (cat === 'text') t = Math.ceil((size * 0.75) / 4);
				else if (cat === 'doc') t = Math.ceil((size * 0.25) / 4);
				else if (cat === 'sheet') t = Math.min(Math.round((size * 0.15) / 4), 50000);
				else t = Math.min(Math.round((size * 0.1) / 4), 20000); // unknown
			} else {
				t = 0;
				conf = 'unknown';
			}

			tokens += t;
			words += w;
			agg = agg === null ? conf : rank[conf] < rank[agg] ? conf : agg;
			parts.push(`${a.name || 'file'} ≈${t.toLocaleString()} tok`);
		}

		return {
			tokens,
			words,
			confidence: agg || 'unknown',
			attachmentsCount: list.length,
			explanation: `${list.length} attachment${list.length > 1 ? 's' : ''}: ${parts.join('; ')}`
		};
	}

	// ---- cached convenience used by the chip + model advisor ------------------
	let cache = null, cacheAt = 0, lastSig = '';
	const CACHE_MS = 400;
	const listeners = new Set();
	let observer = null, debounce = null;

	const signature = (list) => list.map((a) => `${a.name}|${a.sizeBytes || ''}|${a.type}`).join(';');

	function current() {
		const now = Date.now();
		if (cache && now - cacheAt < CACHE_MS) return cache;
		cache = getComposerAttachments();
		cacheAt = now;
		lastSig = signature(cache);
		return cache;
	}

	// Estimate for the current composer; adds `types` (distinct categories) for
	// the model advisor on top of the spec'd estimate shape.
	function estimateForComposer() {
		const list = current();
		const est = estimateAttachmentTokens(list);
		est.types = [...new Set(list.map((a) => a.type))];
		est.list = list; // raw items (name/type/size) for the model engine's file rules
		return est;
	}

	function onChange(cb) {
		listeners.add(cb);
		return () => listeners.delete(cb);
	}
	function notify() {
		for (const cb of listeners) {
			try {
				cb();
			} catch {
				/* a listener throwing must not break the others */
			}
		}
	}

	// One debounced observer; only notifies when the attachment set actually
	// changes (added/removed/renamed) — not on unrelated claude.ai DOM churn.
	function start() {
		if (observer) return;
		observer = new MutationObserver(() => {
			clearTimeout(debounce);
			debounce = setTimeout(() => {
				const list = getComposerAttachments();
				const sig = signature(list);
				if (sig === lastSig) return;
				lastSig = sig;
				cache = list;
				cacheAt = Date.now();
				notify();
			}, 200);
		});
		try {
			observer.observe(document.body, { childList: true, subtree: true });
		} catch {
			/* ignore */
		}
	}
	function invalidate() {
		cache = null;
	}

	CT.attachments = { getComposerAttachments, estimateAttachmentTokens, estimateForComposer, onChange, start, invalidate, classify };
})();
