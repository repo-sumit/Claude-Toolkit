(() => {
	'use strict';

	// ============================================================
	// Pick Model engine — a faithful, *pure* implementation of
	// skills/pick-model/SKILL.md + reference.md.
	//
	// Classifies a task (category → base tier), applies complexity
	// escalators (one tier up, capped at Opus), file/attachment rules,
	// signal words, cost/quality exceptions, and tie-breakers, then emits
	// an explainable recommendation. No DOM, no network — model.js feeds
	// it detected attachments / available models / current model and
	// adapts the result for the existing UI.
	// ============================================================

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	const TIERS = ['haiku', 'sonnet', 'opus'];
	const IDX = { haiku: 0, sonnet: 1, opus: 2 };
	const META = {
		haiku: { displayName: 'Haiku', emoji: '🟢', cost: 'lowest', speed: 'fastest' },
		sonnet: { displayName: 'Sonnet', emoji: '🟡', cost: 'medium', speed: 'medium' },
		opus: { displayName: 'Opus', emoji: '🔴', cost: 'highest', speed: 'slowest' }
	};
	const tierAt = (i) => TIERS[Math.max(0, Math.min(2, i))];
	const up = (tier) => tierAt(IDX[tier] + 1);
	const down = (tier) => tierAt(IDX[tier] - 1);
	const maxTier = (a, b) => tierAt(Math.max(IDX[a], IDX[b]));

	const words = (t) => ((t || '').match(/\S+/g) || []).length;
	const extOf = (name) => {
		const m = /\.([a-z0-9]{1,8})$/i.exec((name || '').trim());
		return m ? m[1].toLowerCase() : '';
	};
	const CODE_EXT = /^(js|mjs|cjs|ts|jsx|tsx|py|java|kt|c|cc|cpp|h|hpp|cs|rb|go|rs|php|swift|sql|vue|svelte|dart|scala|lua|r|pl|m)$/;
	const SHELL_EXT = /^(sh|bash|zsh|ps1|bat)$/;
	const PROSE_EXT = /^(md|markdown|mdx|txt|text|rtf|tex)$/;
	const DATA_EXT = /^(json|jsonl|ya?ml|toml|xml|ini|cfg|conf)$/;
	const has = (lower, words) => words.some((w) => lower.includes(w));

	// ---- task-tier patterns (substrings checked against the lowercased text) ---
	const HAIKU_TASKS = [
		'fix typo', 'typo', 'formatting', 'reformat', 'format ', 'regex', 'rename', 'template',
		'fill in', 'extract', 'extraction', 'convert', 'conversion', 'to markdown', 'to md', 'to pdf',
		'epub', 'summarize', 'summarise', 'summary', 'tl;dr', 'tldr', 'translate', 'translation',
		'status report', 'meeting notes', 'bullet', 'categorize', 'categorise', 'categorization',
		'proofread', 'grammar', 'spelling', 'lint', 'data extraction', 'parse', 'validate', 'factual lookup'
	];
	const SONNET_TASKS = [
		'write', 'create', 'draft', 'blog', 'email', 'documentation', 'docs', 'bug fix', 'fix bug',
		'fix the bug', 'debug', 'code review', 'pr review', 'review', 'single file', 'single-file',
		'unit test', 'write test', 'test writing', 'add test', 'api integration', 'refactor', 'explain',
		'analyze', 'analyse', 'analysis', 'compare', 'comparison', 'competitive analysis', 'brainstorm',
		'persona', 'user research', 'a/b test', 'survey', 'improve', 'synthesize', 'synthesise',
		'proposal', 'marketing copy', 'customer communication', 'research summary', 'feature add',
		'add feature', 'schema design', 'pipeline design', 'implement'
	];
	const OPUS_TASKS = [
		'architecture', 'architect', 'system design', 'database schema', 'schema for', 'design schema',
		'framework migration', 'migration', 'migrate', 'security audit', 'threat model', 'novel algorithm',
		'distributed system', 'strategic plan', 'strategy for', 'business model', 'm&a', 'due diligence',
		'organizational', 'organisational', 'restructur', 'change management', 'market entry',
		'crisis', 'scenario planning', 'strategic foresight', 'competitive strategy',
		'executive presentation', 'long-form report', 'whitepaper', 'thesis', 'multi-region',
		'infrastructure design', 'test strategy', 'retrospective', 'pattern detection', 'across sessions',
		'scamper', 'starbursting', 'multi-framework'
	];

	// ---- signal words (reference.md "Quick Reference") --------------------------
	const HAIKU_SIGNALS = ['quick', 'simple', 'just ', 'only ', 'extract', 'format', 'rename', 'fix typo', 'grammar', 'summarize', 'translate', 'convert', 'bullet', 'template'];
	const SONNET_SIGNALS = ['write', 'create', 'explain', 'review', 'analyze', 'analyse', 'debug', 'single file', 'draft', 'compare', 'improve', 'synthesize'];
	const OPUS_SIGNALS = ['design', 'architect', 'complex', 'multiple files', 'refactor', 'migration', 'strategy', 'nuanced', 'security', 'audit', 'production', 'high-stakes', 'high stakes', 'trade-off', 'tradeoff', 'stakeholder', 'system design', 'root cause', 'ambiguous', 'long-term', 'executive'];

	// ---- category keyword voting ------------------------------------------------
	const CATEGORY_KW = {
		technical: ['code', 'bug', 'debug', 'refactor', 'function', 'class ', 'api', 'endpoint', 'schema', 'database', 'sql', 'server', 'deploy', 'docker', 'kubernetes', 'terraform', 'regex', 'script', 'compile', 'unit test', 'algorithm', 'css', 'html', 'frontend', 'backend', 'migration', 'architecture', 'typescript', 'python', 'javascript'],
		business: ['strategy', 'strategic', 'market', 'revenue', 'proposal', 'stakeholder', 'm&a', 'merger', 'organizational', 'business model', 'customer', 'marketing', 'sales', 'executive', 'kpi', 'roi', 'competitive', 'pricing', 'go-to-market', 'market entry', 'restructur', 'layoff', 'crisis'],
		creative: ['brainstorm', 'story', 'poem', 'creative', 'blog', 'slogan', 'tagline', 'narrative', 'persona', 'product name', 'naming', 'copywriting', 'headline'],
		analysis: ['analyze', 'analyse', 'analysis', 'pattern', 'retrospective', 'survey', 'a/b', 'research', 'bias', 'ethical', 'insight', 'scenario', 'foresight', 'correlat', 'trend']
	};
	function classifyCategory(lower, isCommand) {
		if (isCommand) return 'command';
		let best = 'unknown', bestN = 0;
		for (const [cat, kws] of Object.entries(CATEGORY_KW)) {
			const n = kws.reduce((s, k) => s + (lower.includes(k) ? 1 : 0), 0);
			if (n > bestN) { bestN = n; best = cat; }
		}
		return bestN ? best : 'unknown';
	}

	// ---- complexity escalators (each adds the tier ONCE, capped at Opus) --------
	function detectEscalators(lower, fileFacts) {
		const out = [];
		const add = (name, highStakes = false) => out.push({ name, highStakes });

		// Technical
		if (/\b(ambiguous|unclear|underspecified|not sure|figure out|vague|open[- ]ended|unspecified|tbd)\b/.test(lower)) add('ambiguity');
		if (detectScope(lower) || fileFacts.codeFiles >= 3 || fileFacts.totalFiles >= 4) add('scope');
		if (/\b(production|in prod|prod issue|security|data ?loss|regulat|compliance|hipaa|gdpr|soc ?2|pci|payment|financial|irreversible|mission critical)\b/.test(lower)) add('stakes', true);
		if (/\b(novel|from scratch|greenfield|cutting[- ]edge|new algorithm|novel algorithm|no existing pattern)\b/.test(lower)) add('novelty');

		// Business
		if (/\b(stakeholders|competing interests|multiple teams|cross-team|board|leadership team)\b/.test(lower)) add('multiple-stakeholders', true);
		if (/\b(strategic|long[- ]term|roadmap|company[- ]wide|org[- ]wide|organi[sz]ation[- ]wide|irreversible)\b/.test(lower)) add('strategic-impact', true);
		if (/\b(layoff|restructur|executive comm|crisis|reputation|politically sensitive|sensitive)\b/.test(lower)) add('political-sensitivity', true);
		if (/\b(cross[- ]functional|across teams|tech and business|legal and|ops and|business and legal)\b/.test(lower)) add('cross-functional');

		// Cognitive
		if (/\b(pattern detection|patterns across|across sessions|trends across|correlat)\b/.test(lower)) add('pattern-detection');
		if (/\b(bias|blind ?spot|assumptions|blindspots)\b/.test(lower)) add('bias-identification');
		if (/\b(ethical|ethics|fairness|moral|unintended consequences)\b/.test(lower)) add('ethical-reasoning');
		if (detectMultiFramework(lower)) add('multi-framework');

		return out;
	}
	function detectScope(lower) {
		const m = /\b(\d+)\s*\+?\s*(?:files|modules|services|components|systems|packages|repos|microservices)\b/.exec(lower);
		if (m && parseInt(m[1], 10) >= 3) return true;
		if (/single[- ]file/.test(lower)) return false;
		return /\b(multi[- ]?file|multiple (?:files|systems|services|components|modules|repos|microservices)|several (?:files|modules|services)|many files|across (?:the )?(?:codebase|files|modules|services|systems|components)|entire codebase|whole codebase|3\+ files|cross-(?:file|module|system|service))\b/.test(lower);
	}
	const FRAMEWORKS = ['scamper', 'starbursting', 'swot', 'pestle', 'porter', 'jobs-to-be-done', 'jtbd', 'six thinking hats', 'first principles', 'mece', 'rice', 'moscow', 'eisenhower', 'okr', 'trade-off analysis', 'weighted scoring'];
	function detectMultiFramework(lower) {
		if (/\bmulti[- ]?framework|multiple frameworks|two frameworks\b/.test(lower)) return true;
		const n = FRAMEWORKS.reduce((s, f) => s + (lower.includes(f) ? 1 : 0), 0);
		if (n >= 2) return true;
		// a named framework alongside an explicit "+ ... analysis/scoring"
		return n >= 1 && /\+|and trade-?off|with trade-?off|and weighted/.test(lower);
	}

	// ---- file/attachment facts + rules -----------------------------------------
	function fileFacts(attachments, attachmentTokens) {
		const facts = { totalFiles: attachments.length, codeFiles: 0, proseFiles: 0, dataFiles: 0, shellFiles: 0, docFiles: 0, sheetFiles: 0, imageFiles: 0, unknownFiles: 0, tokens: attachmentTokens || 0, kinds: [] };
		for (const a of attachments) {
			const e = extOf(a.name);
			let kind;
			if (a.type === 'image' || /^(png|jpe?g|gif|webp|bmp|svg|heic|avif|tiff?)$/.test(e)) kind = 'image';
			else if (CODE_EXT.test(e)) kind = 'code';
			else if (SHELL_EXT.test(e)) kind = 'shell';
			else if (DATA_EXT.test(e)) kind = 'data';
			else if (PROSE_EXT.test(e)) kind = 'prose';
			else if (a.type === 'doc') kind = 'doc';
			else if (a.type === 'sheet') kind = 'sheet';
			else if (a.type === 'text') kind = 'prose';
			else kind = 'unknown';
			facts.kinds.push(kind);
			facts[`${kind === 'code' ? 'code' : kind === 'shell' ? 'shell' : kind === 'data' ? 'data' : kind === 'prose' ? 'prose' : kind === 'doc' ? 'doc' : kind === 'sheet' ? 'sheet' : kind === 'image' ? 'image' : 'unknown'}Files`]++;
		}
		return facts;
	}
	// Returns { floor, force } tier strings (force overrides up to Opus).
	function fileRules(f, lower, signalsOut) {
		let floor = 'haiku', force = null;
		if (!f.totalFiles) return { floor: null, force: null };
		const longform = /\b(report|long[- ]form|executive summary|whitepaper|thesis|comprehensive)\b/.test(lower);
		const schemaDesign = /\bschema design|design (?:a )?schema|schema for\b/.test(lower);
		const orchestration = /\borchestrat|pipeline|ci\/cd|deployment pipeline\b/.test(lower);

		if (f.codeFiles >= 3) { force = 'opus'; signalsOut.push(`file:code×${f.codeFiles}`); }
		else if (f.codeFiles >= 1) { floor = maxTier(floor, 'sonnet'); signalsOut.push('file:code'); }

		if (f.shellFiles >= 1) { floor = maxTier(floor, 'sonnet'); if (orchestration) force = 'opus'; signalsOut.push('file:shell'); }

		if (f.proseFiles >= 1) {
			if (longform) { force = 'opus'; signalsOut.push('file:long-form'); }
			else if (/\b(blog|article|docs|documentation|tutorial|guide|post)\b/.test(lower)) { floor = maxTier(floor, 'sonnet'); signalsOut.push('file:prose-write'); }
			else signalsOut.push('file:prose');
		}
		if (f.dataFiles >= 1) {
			if (schemaDesign) { floor = maxTier(floor, 'sonnet'); signalsOut.push('file:schema'); }
			else signalsOut.push('file:data');
		}
		if (f.docFiles >= 1) { floor = maxTier(floor, 'sonnet'); if (longform) force = 'opus'; signalsOut.push('file:doc'); }
		if (f.sheetFiles >= 1) { floor = maxTier(floor, 'sonnet'); signalsOut.push('file:sheet'); }
		if (f.imageFiles >= 1) { floor = maxTier(floor, 'sonnet'); signalsOut.push('file:image'); }
		if (f.unknownFiles >= 1) { floor = maxTier(floor, 'sonnet'); signalsOut.push('file:unknown'); }

		// Many files, or a large multi-file context → escalate.
		if (f.totalFiles >= 3) { floor = maxTier(floor, 'sonnet'); }
		if (f.tokens >= 20000 && (f.totalFiles >= 2 || f.codeFiles >= 1 || f.docFiles >= 1)) { force = 'opus'; signalsOut.push('file:large-context'); }
		else if (f.tokens >= 5000) { floor = maxTier(floor, 'sonnet'); signalsOut.push('file:mid-context'); }

		return { floor, force };
	}

	// ---- exceptions / tie-breakers ----------------------------------------------
	// NB: bare "draft" is excluded — "draft a proposal" means *write* one, not a
	// rough pass. Cost-lowering needs an explicit rough/quick-draft phrase.
	const COST_WORDS = ['quick', 'cheap', 'low cost', 'low-cost', 'rough', 'exploratory', 'first pass', 'first-pass', 'prototype', 'just a', 'rough draft', 'quick draft', 'first draft', 'scratch idea'];
	const QUALITY_WORDS = ['production', 'final', 'executive', 'customer-facing', 'customer facing', 'security', 'compliance', 'irreversible', 'high stakes', 'high-stakes', 'mission critical', 'launch', 'go live', 'go-live'];
	const REASONING_WORDS = ['why', 'explain', 'reason', 'reasoning', 'judgment', 'judgement', 'recommend', 'evaluate', 'decide', 'trade-off', 'tradeoff', 'compare', 'analy', 'consider', 'implications', 'pros and cons', 'should i', 'best way', 'best approach'];

	// ---- the engine -------------------------------------------------------------
	function pick(input = {}) {
		const promptText = input.promptText || input.text || '';
		const selectedText = input.selectedText || '';
		const raw = `${selectedText}\n${promptText}`.trim();
		const lower = raw.toLowerCase();
		const attachments = Array.isArray(input.attachments) ? input.attachments : [];
		const attachmentTokens = Number(input.attachmentTokens) || 0;
		const userPreference = input.userPreference || null;
		const currentModel = normalizeModel(input.currentModel);
		const available = normalizeAvailable(input.availableModels);

		const hasText = !!raw;
		const attachmentCount = attachments.length;
		if (!hasText && !attachmentCount) return null;

		const isCommand = /^\s*(?:\/|command:|skill:|agent:)/i.test(promptText);
		const category = classifyCategory(lower, isCommand);
		const facts = fileFacts(attachments, attachmentTokens);

		const signals = [];
		const tally = (arr, label) => arr.reduce((n, w) => { if (lower.includes(w)) { n++; signals.push(`${label}:${w.trim()}`); } return n; }, 0);

		// 1) base tier from task patterns (highest matched tier; default Sonnet).
		const opusHits = tally(OPUS_TASKS, 'opus-task');
		const sonnetHits = tally(SONNET_TASKS, 'sonnet-task');
		const haikuHits = tally(HAIKU_TASKS, 'haiku-task');
		// signal words (informational + tip the borderline)
		const hSig = tally(HAIKU_SIGNALS, 'sig-haiku');
		const sSig = tally(SONNET_SIGNALS, 'sig-sonnet');
		const oSig = tally(OPUS_SIGNALS, 'sig-opus');

		let base;
		if (opusHits > 0) base = 'opus';
		else if (sonnetHits > 0) base = 'sonnet';
		else if (haikuHits > 0) base = 'haiku';
		else if (oSig > 0 && oSig >= sSig && oSig > hSig) base = 'opus';
		else if (hSig > 0 && hSig > sSig && hSig >= oSig) base = 'haiku';
		else base = 'sonnet'; // default — "most tasks default Sonnet"
		const baseTier = base;
		let tier = base;

		// 2) escalators: any → one tier up (capped). Multiple still = one bump.
		const escObjs = detectEscalators(lower, facts);
		const escalators = escObjs.map((e) => e.name);
		const highStakesEsc = escObjs.some((e) => e.highStakes);
		if (escObjs.length) { tier = up(tier); signals.push('escalator+1'); }

		// 3) file/attachment rules (floors + forced opus for large multi-file sets).
		const fr = fileRules(facts, lower, signals);
		if (fr.floor) tier = maxTier(tier, fr.floor);
		if (fr.force) tier = maxTier(tier, fr.force);

		// 4) tie-breaker: Haiku needing any reasoning/judgment/user-facing quality → Sonnet.
		const reasoningNeed = has(lower, REASONING_WORDS) || /\b(user-facing|customer|public|publish|brand|professional)\b/.test(lower);
		if (tier === 'haiku' && reasoningNeed) { tier = 'sonnet'; signals.push('tiebreak:reasoning→sonnet'); }

		// 5) quality-critical → +1 (capped).
		const qualityCritical = has(lower, QUALITY_WORDS);
		if (qualityCritical) { tier = up(tier); signals.push('quality-critical+1'); }

		// 6) cost-sensitive → -1 (floor Haiku), UNLESS high-stakes escalator/quality words.
		const costSensitive = has(lower, COST_WORDS);
		if (costSensitive && !highStakesEsc && !qualityCritical) {
			const lowered = down(tier);
			if (lowered !== tier) { tier = lowered; signals.push('cost-sensitive-1'); }
		}

		// 7) availability fallback — nearest available tier if recommended is missing.
		let fallbackFrom = null;
		if (available && available.length && !available.includes(tier)) {
			fallbackFrom = tier;
			tier = nearestAvailable(tier, available);
			signals.push(`fallback:${fallbackFrom}→${tier}`);
		}

		const finalTier = tier;

		// ---- confidence -------------------------------------------------------
		const topHits = Math.max(opusHits, sonnetHits, haikuHits);
		const tiersWithHits = [opusHits, sonnetHits, haikuHits].filter((n) => n > 0).length;
		let score = 0.5;
		if (topHits >= 1) score += 0.18;
		if (topHits >= 2) score += 0.08;
		if (tiersWithHits >= 2) score -= 0.12; // conflicting categories
		if (escObjs.length) score -= 0.05; // a bump means it was borderline
		if (facts.totalFiles && (fr.force || fr.floor === 'sonnet')) score += 0.08;
		if (!hasText && attachmentCount) score -= 0.08; // attachment-only, no stated intent
		if (escalators.includes('ambiguity')) score -= 0.15;
		if (fallbackFrom) score -= 0.1;
		score = Math.max(0.35, Math.min(0.95, score));
		const confidence = score >= 0.78 ? 'high' : score >= 0.55 ? 'medium' : 'low';

		// ---- reason / explanation / alternative -------------------------------
		const reason = buildReason(finalTier, { category, escalators, facts, baseTier, costSensitive, qualityCritical, reasoningNeed, hasText, attachmentCount, fallbackFrom });
		const alternative = buildAlternative(finalTier, { escalators, costSensitive });
		const cm = META[finalTier];
		const confLabel = confidence[0].toUpperCase() + confidence.slice(1);
		const explanation =
			`${cm.emoji} ${cm.displayName} — ${reason}\n\n` +
			`Cost: ${cm.cost} | Speed: ${cm.speed}\n` +
			`Confidence: ${confLabel}` +
			(currentModel && currentModel.tier && currentModel.tier !== finalTier ? `\nYou're on ${currentModel.visibleName || META[currentModel.tier].displayName}.` : '') +
			(alternative.model ? `\n\nConsider ${META[alternative.model].displayName} ${alternative.condition}` : '');

		return {
			model: finalTier,
			displayName: cm.displayName,
			emoji: cm.emoji,
			confidence,
			confidenceScore: Math.round(score * 100) / 100,
			reason,
			cost: cm.cost,
			speed: cm.speed,
			category,
			baseTier,
			finalTier,
			escalators,
			signals,
			alternative,
			explanation,
			currentModel,
			fallbackFrom
		};
	}

	function buildReason(tier, ctx) {
		const { category, escalators, facts, costSensitive, fallbackFrom } = ctx;
		const catLabel = { technical: 'technical', business: 'business/strategy', creative: 'creative', analysis: 'analysis', command: 'command/skill', unknown: 'general' }[category] || 'general';
		const escNote = escalators.length ? ` (${escalators.slice(0, 2).join(', ').replace(/-/g, ' ')})` : '';
		const fileNote = facts.totalFiles ? ` with ${facts.totalFiles} file${facts.totalFiles > 1 ? 's' : ''} attached` : '';
		let base;
		if (tier === 'haiku') base = `Lightweight ${catLabel} task — deterministic, low reasoning${fileNote}.`;
		else if (tier === 'sonnet') base = `Balanced ${catLabel} work with moderate reasoning${fileNote}.`;
		else base = `Complex ${catLabel} work needing deep reasoning${escNote}${fileNote}.`;
		if (fallbackFrom) base += ` (nearest available to ${META[fallbackFrom].displayName}.)`;
		else if (costSensitive && tier !== 'opus') base += ' Lowered for a quick/draft pass.';
		return base;
	}

	function buildAlternative(tier, ctx) {
		if (tier === 'opus') return { model: 'sonnet', condition: ctx.escalators.length ? 'if the scope/stakes turn out smaller than they look.' : 'if this is exploratory or a draft.' };
		if (tier === 'sonnet') return { model: 'haiku', condition: 'if this is only formatting, extraction, or a quick lookup.' };
		return { model: 'sonnet', condition: 'if it needs any reasoning, judgment, or user-facing quality.' };
	}

	// ---- model normalization / availability ------------------------------------
	function tierFromName(name) {
		const n = (name || '').toLowerCase();
		if (n.includes('haiku')) return 'haiku';
		if (n.includes('sonnet')) return 'sonnet';
		if (n.includes('opus')) return 'opus';
		return null;
	}
	function normalizeModel(m) {
		if (!m) return null;
		if (typeof m === 'string') { const t = tierFromName(m); return t ? { tier: t, visibleName: m } : null; }
		if (m.tier) return { tier: m.tier, visibleName: m.visibleName || m.name || null };
		const t = tierFromName(m.name || m.visibleName);
		return t ? { tier: t, visibleName: m.visibleName || m.name || null } : null;
	}
	function normalizeAvailable(list) {
		if (!Array.isArray(list) || !list.length) return null;
		const tiers = [];
		for (const m of list) {
			const t = typeof m === 'string' ? (TIERS.includes(m) ? m : tierFromName(m)) : (m && (m.tier || tierFromName(m.name || m.visibleName)));
			if (t && !tiers.includes(t)) tiers.push(t);
		}
		return tiers.length ? tiers : null;
	}
	function nearestAvailable(tier, available) {
		const want = IDX[tier];
		let best = available[0], bestD = Infinity;
		for (const a of available) {
			const d = Math.abs(IDX[a] - want);
			// On a tie prefer the more capable tier (round up for safety).
			if (d < bestD || (d === bestD && IDX[a] > IDX[best])) { best = a; bestD = d; }
		}
		return best;
	}

	CT.pickModel = { pick, classifyCategory, detectEscalators, tierFromName, META };
})();
