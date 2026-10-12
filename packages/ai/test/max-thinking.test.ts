import { describe, expect, it } from "vitest";
import { streamSimple as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels, normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

describe("max thinking level", () => {
	it("is opt-in for ordinary reasoning models", () => {
		const model: Model<"openai-completions"> = {
			id: "ordinary-reasoning",
			name: "Ordinary Reasoning",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(clampThinkingLevel(model, "max")).toBe("high");
	});

	it.each(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const)(
		"exposes xhigh and max for github-copilot/%s",
		(modelId) => {
			const model = getModel("github-copilot", modelId);
			expect(model.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
			expect(getSupportedThinkingLevels(model)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
		},
	);

	it("supports a hole between high and max", () => {
		const model: Model<"openai-completions"> = {
			id: "high-and-max",
			name: "High and Max",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			thinkingLevelMap: { xhigh: null, max: "max" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "max"]);
		expect(clampThinkingLevel(model, "xhigh")).toBe("max");
	});

	it.each(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"] as const)(
		"sends max to the Responses API for %s",
		async (modelId) => {
			const model = getModel("github-copilot", modelId);
			const context = normalizeContext({
				systemPrompt: "You are a helpful assistant.",
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			});
			let payload: unknown;

			await streamOpenAIResponses(model, context, {
				apiKey: "test-key",
				reasoning: "max",
				onPayload: (request) => {
					payload = request;
					throw new Error("payload captured");
				},
			}).result();

			expect(payload).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });
		},
	);
});
