import { describe, expect, it } from "vitest";
import { prepareRequest } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

interface ResponsesPayload {
	max_output_tokens?: number;
	temperature?: number;
	prompt_cache_retention?: string;
	prompt_cache_options?: { mode?: string; ttl?: string };
}

function payloadFor(apiKey: string, requestModel: Model<"openai-responses"> = model): ResponsesPayload {
	return prepareRequest(requestModel, context, {
		apiKey,
		maxTokens: 1000,
		temperature: 0.5,
		cacheRetention: "long",
	}) as ResponsesPayload;
}

describe("OpenAI Responses with Sign in with ChatGPT", () => {
	it("omits request fields that token sharing rejects", () => {
		const payload = payloadFor("chatgpt-access-token");

		expect(payload).not.toHaveProperty("max_output_tokens");
		expect(payload).not.toHaveProperty("temperature");
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("omits prompt_cache_options on models with explicit prompt cache mode", () => {
		const explicitCacheModel = { ...model, compat: { supportsExplicitPromptCacheMode: true } };

		const signInPayload = payloadFor("chatgpt-access-token", explicitCacheModel);
		const apiKeyPayload = payloadFor("sk-proj-test", explicitCacheModel);

		expect(signInPayload.prompt_cache_options).toBeUndefined();
		expect(apiKeyPayload.prompt_cache_options).toEqual({ ttl: "30m" });
	});

	it.each([
		{ name: "OpenAI API keys", apiKey: "sk-proj-test", requestModel: model },
		{
			name: "other OpenAI-compatible endpoints",
			apiKey: "gateway-key",
			requestModel: { ...model, baseUrl: "https://gateway.example.com/v1" },
		},
	])("keeps those fields for $name", ({ apiKey, requestModel }) => {
		const payload = payloadFor(apiKey, requestModel);

		expect(payload.max_output_tokens).toBe(1000);
		expect(payload.temperature).toBe(0.5);
		expect(payload.prompt_cache_retention).toBe("24h");
	});
});
