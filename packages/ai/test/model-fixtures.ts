import type { Model } from "../src/types.ts";

/**
 * Synthetic OpenAI-compatible chat model fixtures.
 *
 * API-implementation tests need a `Model` carrying endpoint compatibility flags, not a built-in
 * catalog entry. Built-in catalogs only describe vendors pi ships; a `models.json` endpoint can set
 * the same `compat` fields, so these fixtures keep that behaviour under test without a vendor.
 */
export function openAICompletionsModel(
	id: string,
	overrides: Partial<Omit<Model<"openai-completions">, "id" | "api">> = {},
): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "compatible",
		baseUrl: "https://compatible.example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	};
}

/** Synthetic OpenAI Responses chat model fixture. See {@link openAICompletionsModel}. */
export function openAIResponsesModel(
	id: string,
	overrides: Partial<Omit<Model<"openai-responses">, "id" | "api">> = {},
): Model<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "compatible",
		baseUrl: "https://compatible.example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	};
}
