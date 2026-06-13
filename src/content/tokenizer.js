(() => {
	'use strict';

	const CT = (globalThis.ClaudeToolkit = globalThis.ClaudeToolkit || {});

	function exact(text) {
		const t = globalThis.GPTTokenizer_o200k_base;
		if (t?.countTokens) {
			try {
				return t.countTokens(text);
			} catch {
				/* fall through */
			}
		}
		return null;
	}
	function heuristic(text) {
		const words = (text.match(/\S+/g) || []).length;
		return Math.max(words, Math.round(text.length / 4));
	}

	let approximate = false;
	function countTokens(text) {
		if (!text) return 0;
		const e = exact(text);
		if (e !== null) return e;
		approximate = true;
		return heuristic(text);
	}

	CT.tokenizer = { countTokens, isApproximate: () => approximate };
})();
