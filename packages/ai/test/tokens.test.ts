import { describe, expect, it } from "vitest";
import { getModel, stream } from "../src/compat.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

// Live-network tests against GitHub Copilot are opt-in via a token in the environment.
const copilotToken = process.env.COPILOT_GITHUB_TOKEN;

async function testTokensOnAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Write a long poem with 20 stanzas about the beauty of nature.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text_delta" || event.type === "thinking_delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();

	expect(msg.stopReason).toBe("aborted");

	// openai-completions and openai-responses only send usage in the final chunk, so an aborted
	// request has no token stats. anthropic-messages reports usage early in the stream.
	if (llm.api === "anthropic-messages") {
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBeGreaterThan(0);

		// Some catalog entries have zero cost rates.
		if (llm.cost.input > 0) {
			expect(msg.usage.cost.input).toBeGreaterThan(0);
			expect(msg.usage.cost.total).toBeGreaterThan(0);
		}
	} else {
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	}
}

describe("Token Statistics on Abort", () => {
	// =========================================================================

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!copilotToken)(
			"claude-haiku-4.5 - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-haiku-4.5");
				await testTokensOnAbort(llm, { apiKey: copilotToken });
			},
		);

		it.skipIf(!copilotToken)(
			"claude-sonnet-4.6 - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await testTokensOnAbort(llm, { apiKey: copilotToken });
			},
		);
	});
});
