(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});
	const registry = [];

	function register(tool) {
		if (!tool?.id || registry.some((t) => t.id === tool.id)) return;
		registry.push(tool);
	}
	const all = () => registry.slice();
	const get = (id) => registry.find((t) => t.id === id) || null;
	const categories = () => [...new Set(registry.map((t) => t.category))];

	// ---- Context handed to every tool's run() --------------------------------
	function buildCtx() {
		return {
			selection: (window.getSelection?.()?.toString() || '').trim(),
			composerText: (CT.getComposer?.()?.textContent || '').trim(),
			conversation: CT.state?.conversation || null,
			map: CT.state?.map || null,
			insert: (text) => CT.insertIntoComposer?.(text),
			fill: (template, choices) => CT.popover.fillPlaceholders(template, choices),
			copy: async (text) => {
				try {
					await navigator.clipboard.writeText(text);
					return true;
				} catch {
					return false;
				}
			},
			toast: (m) => CT.model.toast(m)
		};
	}

	async function run(id) {
		const tool = get(id);
		if (!tool) return;
		try {
			await tool.run(buildCtx());
		} catch {
			CT.model.toast(`Couldn't run "${tool.name}"`);
		}
	}

	// Source text = selection, else current composer draft.
	const src = (ctx) => ctx.selection || ctx.composerText;

	// Most tools: wrap source text in a prompt; if no source, open the fill
	// form so the user pastes it there. Keeps everything local + one flow.
	function promptTool(def) {
		register({
			...def,
			inputMode: def.inputMode || 'selection/composer',
			run: async (ctx) => {
				const s = src(ctx);
				if (s) {
					const t = def.template.replace(/\{\{(text|code|notes|data|error|diff|json)\}\}/g, () => s);
					const filled = await ctx.fill(t, def.choices || {});
					if (filled != null) ctx.insert(filled);
				} else {
					const filled = await ctx.fill(def.template, def.choices || {});
					if (filled != null) ctx.insert(filled);
				}
			}
		});
	}

	// Tools that just insert a fixed conversation-aware prompt.
	function insertTool(def, prompt) {
		register({ ...def, inputMode: 'none', run: (ctx) => ctx.insert(prompt) });
	}

	// ============================ WRITING ======================================
	promptTool({
		id: 't_improve', name: 'Improve Writing', category: 'Writing', shortcut: 'I',
		description: 'Rewrite for clarity and flow, same meaning.',
		template: 'Improve the clarity and flow of the following text without changing its meaning. Return only the rewrite.\n\n"""\n{{text}}\n"""'
	});
	promptTool({
		id: 't_concise', name: 'Make Concise', category: 'Writing', shortcut: 'C',
		description: 'Shorten ~40% without losing meaning.',
		template: 'Make the following about 40% shorter without losing any key meaning. Return only the shortened version.\n\n"""\n{{text}}\n"""'
	});
	promptTool({
		id: 't_tone', name: 'Change Tone', category: 'Writing', shortcut: 'T',
		description: 'Rewrite in a chosen tone.',
		template: 'Rewrite the following in a {{tone}} tone. Keep the meaning intact and return only the rewrite.\n\n"""\n{{text}}\n"""',
		choices: { tone: ['professional', 'friendly', 'executive', 'simple', 'persuasive'] }
	});
	promptTool({
		id: 't_grammar', name: 'Fix Grammar', category: 'Writing', shortcut: 'G',
		description: 'Correct grammar and spelling only.',
		template: 'Fix grammar, spelling, and punctuation in the following. Change nothing else. Return only the corrected text.\n\n"""\n{{text}}\n"""'
	});
	promptTool({
		id: 't_email', name: 'Convert to Email', category: 'Writing',
		description: 'Turn notes into a professional email.',
		template: 'Convert these notes into a professional, concise email with a subject line. Audience: {{audience}}.\n\nNotes:\n"""\n{{text}}\n"""'
	});
	promptTool({
		id: 't_bullets', name: 'Convert to Bullets', category: 'Writing',
		description: 'Turn prose into crisp bullet points.',
		template: 'Convert the following into crisp bullet points, grouped logically with short bold labels where useful.\n\n"""\n{{text}}\n"""'
	});

	// ========================== PRODUCTIVITY ===================================
	promptTool({
		id: 't_actions', name: 'Extract Action Items', category: 'Productivity', shortcut: 'A',
		description: 'Pull tasks, owners, dates, risks from text.',
		template: 'Extract all action items from the following as a table with columns: Task, Owner, Due date, Risk/Blocker. Add an "Unassigned / unclear" section for anything ambiguous.\n\n"""\n{{notes}}\n"""'
	});
	promptTool({
		id: 't_meeting', name: 'Meeting Notes Formatter', category: 'Productivity',
		description: 'Structure raw notes into a clean summary.',
		template: 'Format these raw meeting notes into:\n## Summary\n## Decisions\n## Action items (task — owner — due)\n## Open questions\n## Risks\n\nNotes:\n"""\n{{notes}}\n"""'
	});
	promptTool({
		id: 't_decision', name: 'Decision Log', category: 'Productivity',
		description: 'Write a structured decision record.',
		template: 'Write a decision record from the following:\n## Context\n## Options considered\n## Decision\n## Rationale\n## Follow-ups\n\nInput:\n"""\n{{notes}}\n"""'
	});
	promptTool({
		id: 't_prd', name: 'PRD Assistant', category: 'Productivity',
		description: 'Draft a PRD from an idea.',
		template: 'Draft a PRD for: {{product idea}}\n\nSections: Problem, Users, Jobs to be done, Goals, Non-goals, User stories, Edge cases, Success metrics, Rollout plan. Be specific and concise.'
	});

	// ============================ DEVELOPER ====================================
	promptTool({
		id: 't_debug', name: 'Debug Code', category: 'Developer', shortcut: 'D',
		description: 'Find the bug, explain root cause, fix it.',
		template: 'Here is code that is misbehaving. Find the bug, explain the root cause, and give a corrected version.\n\nWhat happens: {{what goes wrong}}\n\n```\n{{code}}\n```'
	});
	promptTool({
		id: 't_error', name: 'Explain Error', category: 'Developer', shortcut: 'E',
		description: 'Explain an error and propose fixes.',
		template: 'Explain this error: what it means, the most likely causes ranked, and concrete fixes for each.\n\n```\n{{error}}\n```'
	});
	promptTool({
		id: 't_commit', name: 'Generate Commit Message', category: 'Developer',
		description: 'Conventional commit from a diff/description.',
		template: 'Write a conventional commit message (type(scope): subject, then body bullets) for this change:\n\n```\n{{diff}}\n```'
	});
	promptTool({
		id: 't_review', name: 'Code Review Checklist', category: 'Developer',
		description: 'Review for bugs, security, perf, readability.',
		template: 'Review this code like a strict senior engineer. Report issues grouped by Bugs, Security, Performance, Readability — each with severity (high/med/low), the line(s), and a suggested fix.\n\n```\n{{code}}\n```'
	});
	promptTool({
		id: 't_json', name: 'JSON Formatter Prompt', category: 'Developer',
		description: 'Validate, prettify, and explain JSON.',
		template: 'Validate this JSON. If invalid, show exactly where and why, then a fixed version. If valid, prettify it and explain its structure briefly.\n\n```json\n{{json}}\n```'
	});

	// =========================== CONVERSATION ==================================
	register({
		id: 't_copy_answer', name: 'Copy Last Claude Answer', category: 'Conversation', shortcut: 'L',
		description: 'Copy the latest assistant reply as Markdown.', inputMode: 'conversation',
		run: async (ctx) => {
			const md = CT.exporter.lastAssistantMarkdown(ctx.conversation);
			if (!md) return ctx.toast('No Claude answer found — open a conversation');
			ctx.toast((await ctx.copy(md)) ? 'Copied last answer ✓' : 'Clipboard blocked');
		}
	});
	register({
		id: 't_copy_code', name: 'Copy Last Code Block', category: 'Conversation', shortcut: 'K',
		description: 'Copy the most recent code block in the chat.', inputMode: 'conversation',
		run: async (ctx) => {
			const blk = CT.exporter.lastCodeBlock(ctx.conversation);
			if (!blk) return ctx.toast('No code block found in this conversation');
			ctx.toast((await ctx.copy(blk.code)) ? `Copied ${blk.lang || 'code'} block ✓` : 'Clipboard blocked');
		}
	});
	insertTool(
		{ id: 't_sum_chat', name: 'Summarize Current Chat', category: 'Conversation', shortcut: 'S', description: 'Insert a prompt to summarize this branch.' },
		'Summarize our conversation so far: key points, decisions made, and where we left off — in under 10 bullets.'
	);
	insertTool(
		{ id: 't_reqs', name: 'Extract Requirements', category: 'Conversation', description: 'Pull requirements out of this conversation.' },
		'From our conversation above, extract every requirement (explicit and implied) as a checklist, grouped by Must-have / Nice-to-have / Unclear.'
	);
	insertTool(
		{ id: 't_openq', name: 'Find Open Questions', category: 'Conversation', description: 'List unresolved questions from this chat.' },
		'List all unresolved or open questions from our conversation above, each with why it matters and a suggested next step to resolve it.'
	);

	// Surfaced first in the launcher when no search query is active.
	const FREQUENT = ['t_improve', 't_concise', 't_grammar', 't_email', 't_actions', 't_meeting', 't_prd', 't_debug', 't_error', 't_copy_answer', 't_copy_code'];

	// ---- Launcher popover (bottom bar button / Ctrl+Shift+K / panel) ----------
	// anchorRect anchors it near the trigger; triggerEl wires aria + toggle.
	function openLauncher(anchorRect, triggerEl) {
		if (CT.settingsRef && CT.settingsRef.enableQuickTools === false) {
			return CT.model.toast('Quick Tools are disabled in Settings');
		}
		return CT.popover.show({
			title: 'Quick Tools',
			kind: 'tools',
			anchorRect,
			triggerEl,
			modal: !anchorRect,
			width: 360,
			build: (body, api) => {
				const search = document.createElement('input');
				search.className = 'ct-input';
				search.type = 'search';
				search.placeholder = 'Search tools…';
				search.setAttribute('aria-label', 'Search tools');
				body.appendChild(search);

				const listEl = document.createElement('div');
				listEl.className = 'ct-toollist';
				body.appendChild(listEl);

				let buttons = [];
				let active = -1;
				const setActive = (i) => {
					if (!buttons.length) return;
					active = (i + buttons.length) % buttons.length;
					buttons.forEach((b, idx) => b.classList.toggle('ct-tool--active', idx === active));
					buttons[active].scrollIntoView({ block: 'nearest' });
				};

				const addTool = (t) => {
					const b = document.createElement('button');
					b.className = 'ct-tool';
					b.type = 'button';
					b.innerHTML = `<span class="ct-tool__name">${CT.u.esc(t.name)}</span><span class="ct-tool__desc">${CT.u.esc(t.description)}</span>`;
					b.addEventListener('click', () => {
						api.close();
						run(t.id);
					});
					listEl.appendChild(b);
					buttons.push(b);
				};
				const addHeader = (label) => {
					const h = document.createElement('div');
					h.className = 'ct-toollist__cat';
					h.textContent = label;
					listEl.appendChild(h);
				};

				const render = () => {
					const q = search.value.trim().toLowerCase();
					listEl.replaceChildren();
					buttons = [];
					active = -1;
					if (!q) {
						addHeader('Popular');
						for (const id of FREQUENT) {
							const t = get(id);
							if (t) addTool(t);
						}
					}
					for (const cat of categories()) {
						const tools = registry.filter(
							(t) => t.category === cat && (!q || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q))
						);
						if (!tools.length) continue;
						addHeader(cat);
						for (const t of tools) addTool(t);
					}
					if (!buttons.length) {
						const e = document.createElement('div');
						e.className = 'ct-empty';
						e.textContent = 'No tools match.';
						listEl.appendChild(e);
					} else {
						setActive(0);
					}
				};
				search.addEventListener('input', render);
				// Arrow keys move the highlight; Enter runs it; Escape handled globally.
				search.addEventListener('keydown', (e) => {
					if (e.key === 'ArrowDown') {
						e.preventDefault();
						setActive(active + 1);
					} else if (e.key === 'ArrowUp') {
						e.preventDefault();
						setActive(active - 1);
					} else if (e.key === 'Enter') {
						e.preventDefault();
						if (active >= 0 && buttons[active]) buttons[active].click();
					}
				});
				render();
				api.place();
			}
		});
	}

	CT.tools = { register, all, get, run, categories, openLauncher, FREQUENT };
})();
