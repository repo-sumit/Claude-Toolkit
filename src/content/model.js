(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	const REASON = {
		haiku: 'fast enough for this lightweight task',
		sonnet: 'best balance of speed and quality for this task',
		opus: 'use for deep reasoning / high-stakes complexity'
	};

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

	// ---- Suggestion engine ----------------------------------------------------
	// Accepts a string or { text, contextPct, hasAttachment }.
	function suggestModel(input) {
		const text = (typeof input === 'string' ? input : input?.text) || '';
		const t = text.trim();
		if (!t) return null;
		const lower = t.toLowerCase();
		const tokens = CT.tokenizer.countTokens(t);
		const contextPct = (typeof input === 'object' && Number(input?.contextPct)) || 0;
		const hasAttachment = !!(typeof input === 'object' && input?.hasAttachment);
		const hasCode = /```|\bfunction\b|\bclass\b|=>|;\s*$|\bdef \b|\bimport \b|SELECT .* FROM|console\.|<\/?[a-z][\w-]*>/im.test(t);

		const signals = [];
		let score = 0; // higher → more capable model

		const hit = (pairs, label) => {
			for (const [kw, w] of pairs) {
				if (lower.includes(kw)) {
					score += w;
					signals.push(`${label}:${kw.trim()}`);
				}
			}
		};
		// Opus-leaning (high-stakes / deep)
		hit([
			['architecture', 3], ['security', 3], ['scalab', 2], ['production', 2], ['prod issue', 2],
			['threat model', 3], ['distributed', 2], ['concurren', 2], ['legal', 3], ['financ', 2],
			['compliance', 2], ['think deeply', 3], ['deep reasoning', 3], ['rigorous', 2], ['prove', 2],
			['derive', 2], ['multi-step', 2], ['high-stakes', 3], ['mission critical', 3], ['optimize', 1],
			['performance', 1]
		], 'heavy');
		// Sonnet-leaning (balanced reasoning)
		hit([
			['prd', 2], ['product requirement', 2], ['analyz', 2], ['analysis', 2], ['debug', 2],
			['code review', 2], ['refactor', 2], ['strategy', 2], ['evaluate', 1], ['compare', 1],
			['insight', 1], ['edge case', 1], ['trade-off', 1], ['tradeoff', 1], ['design ', 1],
			['explain', 1], ['plan ', 1], ['review', 1], ['metrics', 1]
		], 'medium');
		// Haiku-leaning (light)
		hit([
			['summar', -3], ['tl;dr', -3], ['tldr', -3], ['rewrite', -3], ['rephrase', -3], ['grammar', -3],
			['spelling', -3], ['proofread', -3], ['fix typo', -3], ['bullet', -2], ['format', -2],
			['action item', -2], ['extract', -1], ['brainstorm', -2], ['name idea', -3], ['names', -1],
			['title', -2], ['quick', -3], ['simple', -2], ['translate', -2], ['shorten', -2],
			['concise', -2], ['tone', -2], ['email', -1]
		], 'light');

		if (tokens < 120) { score -= 1; signals.push('short-draft'); }
		else if (tokens >= 500) { score += 2; signals.push('long-draft'); }
		else signals.push('medium-draft');

		if (hasCode) { score += 2; signals.push('code-block'); }
		if (hasAttachment) { score += 2; signals.push('attachment'); }
		if (contextPct >= 70) { score += 2; signals.push('high-context'); }
		else if (contextPct >= 40) { score += 1; signals.push('mid-context'); }
		if (/(comprehensive|in[- ]depth|detailed|thorough|exhaustive|step[- ]by[- ]step|production[- ]ready)/i.test(lower)) {
			score += 1;
			signals.push('long-output');
		}

		const hasLight = signals.some((s) => s.startsWith('light:'));
		let tier;
		// Clear light intent on a contained task → Haiku, even if a medium word appears.
		if (hasLight && score <= -2 && !hasAttachment && !hasCode && tokens < 600 && contextPct < 60) tier = 'haiku';
		else if (score >= 4) tier = 'opus';
		else if (score >= 1) tier = 'sonnet';
		else if (score <= -1) tier = 'haiku';
		else tier = 'sonnet'; // ambiguous medium default

		const confidence = Math.max(0.5, Math.min(0.95, 0.55 + Math.abs(score) * 0.07));
		return {
			tier,
			model: { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }[tier],
			confidence: Math.round(confidence * 100) / 100,
			reason: REASON[tier],
			signals,
			detectedAvailableModelName: availableModelNameForTier(tier)
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
