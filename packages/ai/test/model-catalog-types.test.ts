import { expect, expectTypeOf, it } from "vitest";
import { GITHUB_COPILOT_MODELS } from "../src/providers/github-copilot.models.ts";

it("routes GitHub Copilot Grok 4.5 through the Responses API", () => {
	expectTypeOf(GITHUB_COPILOT_MODELS["grok-4.5"].api).toEqualTypeOf<"openai-responses">();
	expect(GITHUB_COPILOT_MODELS["grok-4.5"].api).toBe("openai-responses");
});

// Regression test for https://github.com/earendil-works/pi/issues/9209
it("routes all GitHub Copilot GPT models through the Responses API", () => {
	const gptModels = Object.values(GITHUB_COPILOT_MODELS).filter((model) => model.id.startsWith("gpt-"));
	expect(gptModels.length).toBeGreaterThan(0);
	expect(gptModels.every((model) => model.api === "openai-responses")).toBe(true);
	expectTypeOf(GITHUB_COPILOT_MODELS["gpt-6-astra"].api).toEqualTypeOf<"openai-responses">();
	for (const modelId of ["gpt-6-sol", "gpt-6-luna"] as const) {
		const model = GITHUB_COPILOT_MODELS[modelId];
		expectTypeOf(model.api).toEqualTypeOf<"openai-responses">();
		expect(model).toMatchObject({
			api: "openai-responses",
			contextWindow: 1000000,
			maxTokens: 128000,
			thinkingLevelMap: { off: "none", max: "max" },
		});
	}
});
