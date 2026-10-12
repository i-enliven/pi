import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const githubCopilotToken = await resolveApiKey("github-copilot");

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
		it.skipIf(!githubCopilotToken)("OpenAI path should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			const llm = getModel("github-copilot", "gpt-5.3-codex");
			await expectResponseId(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)(
			"Anthropic path should expose responseId",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await expectResponseId(llm, { apiKey: githubCopilotToken });
			},
		);
	});
});
