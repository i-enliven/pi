import type { AssistantMessage } from "../types.ts";

/**
 * Regex patterns to detect context overflow errors from different providers.
 *
 * These patterns match error messages returned when the input exceeds
 * the model's context window.
 *
 * Error text shapes matched (with example error messages):
 *
 * - Anthropic-compatible: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic-compatible: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - OpenAI-compatible: "Your input exceeds the context window of this model"
 * - OpenAI-compatible proxy: "Requested token count exceeds the model's maximum context length of 131072 tokens"
 * - OpenAI-compatible: "Input length (265330) exceeds model's maximum context length (262144)."
 * - OpenAI-compatible server: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - OpenAI-compatible server: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - OpenAI-compatible: "Please reduce the length of the messages or completion"
 * - OpenAI-compatible gateway: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - OpenAI-compatible: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - OpenAI-compatible: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - OpenAI-compatible local server: "the request exceeds the available context size, try increasing it"
 * - OpenAI-compatible local server: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - OpenAI-compatible gateway: "invalid params, context window exceeds limit"
 * - OpenAI-compatible gateway: "Your request exceeded model token limit: X (requested: Y)"
 * - OpenAI-compatible server: "Prompt has X tokens, but the configured context size is Y tokens"
 * - OpenAI-compatible: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - Anthropic-compatible: `{"code":"1261","message":"Prompt too long"}`, `{"code":"1261","message":"Prompt exceeds max length"}`, or silent overflow via usage.input > contextWindow
 * - Truncating server: fills the input to the contextWindow exactly, then returns finish_reason
 *   "length" with output=0 (no room left to generate). Detected via stopReason "length" + zero
 *   output + input filling the context window.
 * - OpenAI-compatible: "Range of input length should be [1, X]" (HTTP 400 invalid_parameter_error)
 * - OpenAI-compatible local server: some deployments truncate silently, others return errors like "prompt too long; exceeded max context length by X tokens"
 */
const OVERFLOW_PATTERNS = [
	/prompt (?:is )?too long/i, // Anthropic-compatible token overflow
	/prompt exceeds max length/i, // Anthropic-compatible token overflow, alternate wording
	/request_too_large/i, // Anthropic-compatible request byte-size overflow (HTTP 413)
	/input is too long for requested model/i, // explicit input-too-long error
	/exceeds the context window/i, // OpenAI-compatible (completions & responses)
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies
	/input token count.*exceeds the maximum/i, // OpenAI-compatible server, input token count overflow
	/maximum prompt length is \d+/i, // OpenAI-compatible server, maximum prompt length overflow
	/reduce the length of the messages/i, // OpenAI-compatible server
	/maximum context length is \d+ tokens/i, // OpenAI-compatible gateways
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenAI-compatible server
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // OpenAI-compatible server
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // OpenAI-compatible local server
	/greater than the context length/i, // OpenAI-compatible local server, prompt-prefix overflow
	/context window exceeds limit/i, // OpenAI-compatible gateway, token-limit overflow wording
	/exceeded model token limit/i, // OpenAI-compatible gateway, token-limit overflow wording
	/too large for model with \d+ maximum context length/i, // OpenAI-compatible server
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // OpenAI-compatible server, configured context size overflow
	/model_context_window_exceeded/i, // Anthropic-compatible server, non-standard finish_reason surfaced as error text
	/prompt too long; exceeded (?:max )?context length/i, // OpenAI-compatible local server
	/range of input length should be/i, // OpenAI-compatible server
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
];

/**
 * Patterns that indicate non-overflow errors (e.g. rate limiting, server errors).
 * Error messages matching any of these are excluded from overflow detection
 * even if they also match an OVERFLOW_PATTERN.
 *
 * Example: some servers format throttling errors as "ThrottlingException: Too many tokens,
 * please wait before trying again." which would match the /too many tokens/i overflow
 * pattern without this exclusion.
 */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i, // throttling / service-unavailable prefixes emitted by some servers
	/rate limit/i, // Generic rate limiting
	/too many requests/i, // Generic HTTP 429 style
];

/**
 * Check if an assistant message represents a context overflow error.
 *
 * This handles three cases:
 * 1. Error-based overflow: Most providers return stopReason "error" with a
 *    specific error message pattern.
 * 2. Silent overflow: Some providers accept overflow requests and return
 *    successfully. For these, we check if usage.input exceeds the context window.
 * 3. Length-stop overflow: some servers return "length" with zero output when
 *    the input fills the context window.
 *
 * ## Reliability by server
 *
 * **Reliable detection (returns error with detectable message):**
 * - Anthropic-compatible: "prompt is too long: X tokens > Y maximum" or "request_too_large"
 * - OpenAI-compatible: "exceeds the context window", "exceeds the model's maximum context length of X tokens", or "exceeds model's maximum context length (X)"
 * - OpenAI-compatible server: "input token count exceeds the maximum"
 * - OpenAI-compatible server: "maximum prompt length is X but request contains Y"
 * - OpenAI-compatible: "reduce the length of the messages"
 * - OpenAI-compatible: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - OpenAI-compatible gateways: "maximum context length is X tokens"
 * - OpenAI-compatible: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - OpenAI-compatible: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - OpenAI-compatible local server: "exceeds the available context size"
 * - OpenAI-compatible local server: "greater than the context length"
 * - OpenAI-compatible gateway: "exceeded model token limit: X (requested: Y)"
 * - OpenAI-compatible server: "Prompt has X tokens, but the configured context size is Y tokens"
 * - OpenAI-compatible: "Range of input length should be [1, X]"
 * - Anthropic-compatible: "Prompt too long"
 *
 * **Unreliable detection:**
 * - Some Anthropic-compatible servers: sometimes accept overflow silently (detectable via
 *   usage.input > contextWindow), sometimes return rate limit errors. Pass contextWindow param
 *   to detect silent overflow.
 * - Truncating servers: truncate input to fit contextWindow then return stopReason "length" with
 *   output=0. Pass contextWindow param to detect via the "filled context + zero output" signal.
 * - Some OpenAI-compatible local servers: may truncate input silently for some setups, but may
 *   also return explicit overflow errors that match the patterns above. Silent truncation still
 *   cannot be detected here because we do not know the expected token count.
 *
 * ## Custom Providers
 *
 * If you've added custom models via settings.json, this function may not detect
 * overflow errors from those providers. To add support:
 *
 * 1. Send a request that exceeds the model's context window
 * 2. Check the errorMessage in the response
 * 3. Create a regex pattern that matches the error
 * 4. The pattern should be added to OVERFLOW_PATTERNS in this file, or
 *    check the errorMessage yourself before calling this function
 *
 * @param message - The assistant message to check
 * @param contextWindow - Optional context window size for detecting silent overflow
 * @returns true if the message indicates a context overflow
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// Case 1: Check error message patterns
	if (message.stopReason === "error" && message.errorMessage) {
		// Skip messages matching known non-overflow patterns (e.g. throttling / rate-limit)
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow) {
			if (OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
				return true;
			}
		}
	}

	// Case 2: Silent overflow - server accepted the request but usage exceeds the context window
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// Case 3: Length-stop overflow - server truncates oversized input
	// to fit the context window, leaving no room for output. Returns stopReason "length"
	// with output=0 and input+cacheRead filling the context window.
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}

/**
 * Check whether a length stop ended below the caller or model's intended output limit.
 * Such responses may be caused by context pressure or provider-side truncation, so callers
 * can make one bounded compact-and-retry attempt. `desiredMaxOutput` must be the original
 * limit before any context-based clamping.
 */
export function isRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
	return message.stopReason === "length" && desiredMaxOutput > 0 && message.usage.output < desiredMaxOutput;
}

/**
 * Get the overflow patterns for testing purposes.
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
