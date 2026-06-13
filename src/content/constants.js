(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	CT.CONST = Object.freeze({
		CONTEXT_LIMIT_TOKENS: 200000,
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		BRIDGE_SCRIPT_ID: 'ct-bridge-script',
		MARKER: 'ClaudeToolkit',
		STORAGE_KEY: 'claudeToolkit.v1'
	});

	// ---- Selectors most likely to drift on a claude.ai redesign --------------
	CT.SEL = Object.freeze({
		TURNS: [
			'[data-testid="user-message"], .font-claude-message',
			'div[data-test-render-count] .font-claude-message, div[data-test-render-count] [data-testid="user-message"]',
			'div[data-test-render-count]'
		],
		ASSISTANT: ['.font-claude-message', '[data-testid="assistant-message"]'],
		COMPOSER: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]'],
		// The composer "card" container — used to dock the strip natively below it.
		COMPOSER_GRID: ['[data-testid="chat-input-grid-container"]', '[data-testid="chat-input-grid-area"]'],
		MODEL_TRIGGER: [
			'[data-testid="model-selector-dropdown"]',
			'button[aria-haspopup="menu"][data-testid*="model"]',
			'button[aria-haspopup="listbox"]'
		],
		MENU_ITEM: ['[role="menuitem"]', '[role="option"]'],
		ATTACHMENT: ['[data-testid="file-thumbnail"]', '[data-testid*="attachment" i]', 'div[aria-label*="attachment" i]']
	});

	CT.MODELS = Object.freeze([
		{ tier: 'haiku', label: 'Haiku', blurb: 'fast / cheap / light' },
		{ tier: 'sonnet', label: 'Sonnet', blurb: 'balanced / default / reasoning' },
		{ tier: 'opus', label: 'Opus', blurb: 'maximum reasoning / deep work' }
	]);

	// ---- SVG icon set (Claude-native: 24-grid stroke icons, currentColor) -----
	const ICON_PATHS = {
		sparkles: '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M19 15l.7 1.9L21.5 17.5l-1.8.6L19 20l-.6-1.9L16.5 17.5l1.9-.6z"/>',
		panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
		share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>',
		copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
		download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
		braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 1 2 2 2 2 0 0 1-2 2v5a2 2 0 0 1-2 2h-1"/>',
		printer: '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		chevron: '<path d="m6 9 6 6 6-6"/>',
		dots: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
		refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
		info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'
	};
	CT.icon = (name, size = 16) =>
		`<svg class="ct-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

	CT.DEFAULTS = Object.freeze({
		enablePalette: true,
		showAdvisor: true,
		autoApplyModel: false,
		panelSide: 'right',
		// bottom strip
		showBottomBar: true,
		bottomBarCompact: false,
		showModelSuggestion: true,
		showCacheCountdown: true,
		enableQuickTools: true,
		// latest-reply export action + lightweight reply metadata
		showInlineExport: true,
		showReplyMeta: true,
		// usage warnings
		usageWarnings: true,
		warningThreshold70: true,
		warningThreshold85: true,
		warningThreshold95: true,
		// a11y
		reducedMotion: false,
		highContrast: false,
		defaultPromptCategory: 'All',
		prompts: [
			{ id: 'p_sum', name: 'Summarize', keyword: 'sum', category: 'General', body: 'Summarize the following in {{number of points}} concise bullet points:\n\n{{text}}' },
			{ id: 'p_eli5', name: 'Explain simply', keyword: 'eli5', category: 'Learning', body: 'Explain {{topic}} simply, as if to a smart 12-year-old. Use one everyday analogy.' },
			{ id: 'p_improve', name: 'Improve writing', keyword: 'improve', category: 'Writing', body: 'Improve the clarity and flow of the text below without changing its meaning. Return only the rewrite.\n\n{{text}}' },
			{ id: 'p_debug', name: 'Debug code', keyword: 'debug', category: 'Engineering', body: 'Here is code that is misbehaving. Find the bug, explain the root cause, and give a corrected version.\n\n```\n{{code}}\n```' }
		]
	});

	CT.PROMPT_PACKS = Object.freeze({
		Writing: [
			{ name: 'Blog outline', keyword: 'blog', body: 'Create a detailed blog post outline about {{topic}} for {{audience}}. Include a hook, 4-6 sections with key points, and a closing CTA.' },
			{ name: 'Plain English', keyword: 'plain', body: 'Rewrite the following in plain, simple English a non-expert can follow. Keep all facts.\n\n{{text}}' },
			{ name: 'Proofread', keyword: 'proof', body: 'Proofread the text below. Return the corrected text first, then a short list of the changes you made.\n\n{{text}}' }
		],
		'Product Management': [
			{ name: 'User story', keyword: 'story', body: 'Write user stories with acceptance criteria for this feature: {{feature}}. Format: As a…, I want…, so that…; then Given/When/Then.' },
			{ name: 'Competitive teardown', keyword: 'teardown', body: 'Do a structured competitive teardown of {{product}} vs {{competitor}}: positioning, strengths, gaps, pricing, and 3 takeaways for us.' },
			{ name: 'Launch checklist', keyword: 'launch', body: 'Create a launch checklist for {{feature}} covering: readiness, docs, comms, metrics, rollback plan, and owners.' }
		],
		Engineering: [
			{ name: 'Write tests', keyword: 'tests', body: 'Write thorough unit tests for the code below. Cover edge cases and failure modes. Use the idiomatic test framework for the language.\n\n```\n{{code}}\n```' },
			{ name: 'Explain regex', keyword: 'regex', body: 'Explain this regex token by token, what it matches, and give 3 example matches and 2 non-matches: {{regex}}' },
			{ name: 'Refactor', keyword: 'refactor', body: 'Refactor the code below for readability and maintainability without changing behavior. Explain each change briefly.\n\n```\n{{code}}\n```' }
		],
		'Data Analysis': [
			{ name: 'Analyze dataset', keyword: 'analyze', body: 'I will paste tabular data. Profile it: columns, types, missing values, outliers, 5 key insights, and 3 chart suggestions.\n\n{{data}}' },
			{ name: 'SQL query', keyword: 'sql', body: 'Write a SQL query for: {{goal}}. Schema:\n{{schema}}\nExplain the query line by line after.' },
			{ name: 'Chart advice', keyword: 'chart', body: 'Given this data and goal, recommend the best chart type and why, plus axis/encoding choices: {{description}}' }
		],
		Learning: [
			{ name: 'Feynman explain', keyword: 'feynman', body: 'Explain {{topic}} using the Feynman technique: simple terms, an analogy, where my understanding likely breaks, then a 3-question self-test.' },
			{ name: 'Quiz me', keyword: 'quiz', body: 'Quiz me on {{topic}} with {{count}} questions, one at a time. Wait for my answer before revealing the solution and the next question.' },
			{ name: 'Study plan', keyword: 'plan', body: 'Build a {{weeks}}-week study plan for {{topic}}, {{hours}} hours/week: weekly goals, resources, practice tasks, and checkpoints.' }
		]
	});

	// ---- Shared helpers -------------------------------------------------------
	const u = {};
	u.fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
	u.heatColor = (ratio) => `hsl(${Math.round((1 - Math.max(0, Math.min(1, ratio))) * 140)}, 65%, 46%)`;
	u.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	u.makeId = (p = 'p') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	u.fmtCountdown = (ms) => {
		const d = ms - Date.now();
		if (d <= 0) return '0m';
		const min = Math.round(d / 60000);
		if (min < 60) return `${min}m`;
		const h = Math.floor(min / 60), m = min % 60;
		if (h < 24) return `${h}h${m ? ` ${m}m` : ''}`;
		return `${Math.floor(h / 24)}d ${h % 24}h`;
	};
	u.fmtClock = (ms) => {
		const d = Math.max(0, ms - Date.now());
		const s = Math.floor(d / 1000);
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	};
	u.fmtTime = (ms) => {
		if (!ms) return '';
		const d = new Date(ms), now = new Date();
		const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		if (d.toDateString() === now.toDateString()) return time;
		return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
	};
	CT.u = u;

	CT.state = CT.state || { conversation: null, map: null, usage: null };
	CT.theme = CT.theme || { dark: false };
	CT.ui = CT.ui || { panelOpen: false };
})();
