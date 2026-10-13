import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

// Live-network tests against GitHub Copilot are opt-in via a token in the environment.
const copilotToken = process.env.COPILOT_GITHUB_TOKEN;

async function expectResponseId<TApi extends Api>(model: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [{ role: "user", content: "Reply with exactly: response id test", timestamp: Date.now() }],
	};

	const response = await complete(model, context, options);

	expect(response.stopReason, response.errorMessage).not.toBe("error");
	expect(response.responseId).toBeTruthy();
	expect(typeof response.responseId).toBe("string");
}

describe("responseId E2E Tests", () => {
	describe("GitHub Copilot Provider", () => {
		it.skipIf(!copilotToken)(
			"openai-responses path should expose responseId",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-5.3-codex");
				await expectResponseId(llm, { apiKey: copilotToken });
			},
		);

		it.skipIf(!copilotToken)(
			"anthropic-messages path should expose responseId",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await expectResponseId(llm, { apiKey: copilotToken });
			},
		);
	});
});
