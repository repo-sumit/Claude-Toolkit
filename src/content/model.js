(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	// ---- Detect available model names from Claude's selector ------------------
	const seen = new Set();
	function tierFromName(name) {
		const n = (name || '').toLowerCase();
		if (n.includes('haiku')) return 'haiku';
		if (n.includes('sonnet')) return 'sonnet';
		if (n.includes('opus')) return 'opus';
		return null;
	}
	function collectVisibleModelNames() {
		// Cheap: matches only when a model menu is actually open.
		for (const sel of CT.SEL.MENU_ITEM) {
			for (const el of document.querySelectorAll(sel)) {
				const txt = (el.textContent || '').trim();
				if (txt && tierFromName(txt)) seen.add(txt.replace(/\s+/g, ' ').slice(0, 40));
			}
		}
	}
	function currentModelName() {
		for (const sel of CT.SEL.MODEL_TRIGGER) {
			const el = document.querySelector(sel);
			const txt = (el?.textContent || '').trim();
			if (txt && tierFromName(txt)) return txt.replace(/\s+/g, ' ').slice(0, 40);
		}
		return null;
	}
	function availableModelNameForTier(tier) {
		collectVisibleModelNames();
		const cur = currentModelName();
		if (cur && tierFromName(cur) === tier) return cur;
		for (const n of seen) if (tierFromName(n) === tier) return n;
		return null;
	}
	// Tiers we've actually seen offered in the picker (only populated once a model
	// menu has been opened). null = unknown → the engine assumes all are available.
	function detectAvailableTiers() {
		collectVisibleModelNames();
		const tiers = [];
		const cur = currentModelName();
		if (cur) { const t = tierFromName(cur); if (t) tiers.push(t); }
		for (const n of seen) { const t = tierFromName(n); if (t && !tiers.includes(t)) tiers.push(t); }
		return tiers.length ? tiers : null;
	}

	// ---- Suggestion engine (delegates to the Pick Model engine) ---------------
	// Public, backward-compatible entry point. Accepts a string or the existing
	// { text, contextPct, hasAttachment, attachmentCount, attachmentTokens,
	//   attachmentTypes, attachments } shape, builds the engine's input (adding
	//   detected current/available models), and adapts the rich result so the
	//   existing UI keeps working: `model` stays the display name and `confidence`
	//   stays a 0-1 number. The full Pick Model fields ride along.
	function suggestModel(input) {
		const legacy = typeof input === 'string' ? { text: input } : (input || {});
		const text = legacy.text || legacy.promptText || '';

		let attachments = Array.isArray(legacy.attachments) ? legacy.attachments : [];
		// Older callers may pass only counts/types — synthesize minimal items so
		// the engine's per-file rules still have something to read.
		if (!attachments.length && Number(legacy.attachmentCount) > 0) {
			const types = Array.isArray(legacy.attachmentTypes) ? legacy.attachmentTypes : [];
			attachments = Array.from({ length: Number(legacy.attachmentCount) }, (_, i) => ({ name: '', type: types[i] || types[0] || 'unknown' }));
		}

		if (!CT.pickModel || typeof CT.pickModel.pick !== 'function') return null;
		const r = CT.pickModel.pick({
			promptText: text,
			selectedText: legacy.selectedText || '',
			attachments,
			attachmentTokens: Number(legacy.attachmentTokens) || 0,
			conversationContext: { contextPct: Number(legacy.contextPct) || 0, map: CT.state?.map || null },
			currentModel: currentModelName(),
			availableModels: detectAvailableTiers(),
			usageState: CT.state?.usage || null,
			platform: 'claude.ai'
		});
		if (!r) return null;

		return {
			...r,
			tier: r.finalTier,
			model: r.displayName,          // legacy UI expects the display name here
			confidence: r.confidenceScore, // legacy UI expects a 0-1 number here
			confidenceLabel: r.confidence, // 'high' | 'medium' | 'low'
			detectedAvailableModelName: availableModelNameForTier(r.finalTier)
		};
	}

	// ---- Apply (best-effort; drives claude.ai's own menu) ---------------------
	function pick(selectors) {
		for (const s of selectors) {
			const el = document.querySelector(s);
			if (el) return el;
		}
		return null;
	}
	function waitFor(testFn, timeoutMs = 1500) {
		return new Promise((resolve) => {
			const found = testFn();
			if (found) return resolve(found);
			const obs = new MutationObserver(() => {
				const f = testFn();
				if (f) {
					obs.disconnect();
					resolve(f);
				}
			});
			obs.observe(document.body, { childList: true, subtree: true });
			setTimeout(() => {
				obs.disconnect();
				resolve(testFn() || null);
			}, timeoutMs);
		});
	}
	async function applyModel(tierOrLabel) {
		try {
			const key = String(tierOrLabel);
			const trigger = pick(CT.SEL.MODEL_TRIGGER);
			if (!trigger) return false;
			trigger.click();
			const re = new RegExp(key, 'i');
			const menu = await waitFor(() => {
				const items = [];
				for (const sel of CT.SEL.MENU_ITEM) items.push(...document.querySelectorAll(sel));
				return items.length ? items : null;
			});
			if (!menu) return false;
			collectVisibleModelNames();
			const hit = Array.from(menu).find((el) => re.test(el.textContent || ''));
			if (!hit) {
				document.body.click();
				return false;
			}
			hit.click();
			return true;
		} catch {
			return false;
		}
	}

	let toastEl = null;
	function toast(msg) {
		if (!toastEl) {
			toastEl = document.createElement('div');
			toastEl.className = 'ct-toast';
			toastEl.setAttribute('role', 'status');
			document.body.appendChild(toastEl);
		}
		CT.a11y?.decorate(toastEl);
		toastEl.textContent = msg;
		toastEl.classList.add('ct-toast--show');
		CT.a11y?.announce(msg);
		clearTimeout(toastEl._t);
		toastEl._t = setTimeout(() => toastEl.classList.remove('ct-toast--show'), 2400);
	}

	CT.model = { suggestModel, applyModel, toast, tierFromName, currentModelName };
})();
