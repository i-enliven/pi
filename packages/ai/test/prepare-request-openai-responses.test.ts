import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRequest, stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Model, OpenAIResponsesCompat, ToolCall, Usage } from "../src/types.ts";

interface InstructionItem {
	role: string;
	content: string;
}

function withCompat(model: Model<"openai-responses">, compat: OpenAIResponsesCompat): Model<"openai-responses"> {
	return { ...model, compat: { ...model.compat, ...compat } };
}

function instructions(payload: { input?: unknown }): InstructionItem[] {
	const input = payload.input as InstructionItem[];
	return input.filter((item) => item.role === "developer" || item.role === "system");
}

const userTurn = { role: "user" as const, content: "hi", timestamp: 1 };

function transcriptWithMidConversationSystemPrompt() {
	return normalizeContext({
		systemPrompt: "base prompt",
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "system", content: "later instruction", timestamp: 2 },
			{ role: "user", content: "second", timestamp: 3 },
		],
	});
}

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantToolCall(name: string, args: ToolCall["arguments"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
		api: "openai-responses",
		provider: "custom-openai",
		model: "gpt-5.4",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp,
	};
}

/** A grammar-constrained tool plus its replayed call and result. */
function grammarTranscript() {
	return normalizeContext({
		messages: [
			{ role: "user", content: "compute", timestamp: 1 },
			assistantToolCall("calc", { expression: "1 + 1" }, 2),
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "calc",
				content: [{ type: "text", text: "2" }],
				isError: false,
				timestamp: 3,
			},
		],
		tools: [
			{
				name: "calc",
				description: "Evaluate an expression",
				parameters: Type.Object({ expression: Type.String() }),
				constrainedSampling: { type: "grammar", variants: { openai_lark: 'expr: /"1"/' } },
			},
		],
	});
}

function inputItems(payload: { input?: unknown }): Record<string, unknown>[] {
	return payload.input as Record<string, unknown>[];
}

describe("openai-responses prepareRequest", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("sends max_output_tokens only when compat allows it", () => {
		const model = getModel("github-copilot", "gpt-5.4");
		const context = normalizeContext({ messages: [userTurn] });

		expect(prepareRequest(model, context, { maxTokens: 1024 }).max_output_tokens).toBe(1024);
		expect(
			prepareRequest(withCompat(model, { supportsMaxOutputTokens: false }), context, { maxTokens: 1024 })
				.max_output_tokens,
		).toBeUndefined();
	});

	it("clamps max_output_tokens to the provider minimum", () => {
		const payload = prepareRequest(
			getModel("github-copilot", "gpt-5.4"),
			normalizeContext({ messages: [userTurn] }),
			{
				maxTokens: 8,
			},
		);

		expect(payload.max_output_tokens).toBe(16);
	});

	it("forwards options into the payload", () => {
		const payload = prepareRequest(
			getModel("github-copilot", "gpt-5.4"),
			normalizeContext({
				messages: [userTurn],
				tools: [{ name: "ping", description: "Ping", parameters: Type.Object({ value: Type.String() }) }],
			}),
			{ toolChoice: "required", temperature: 0.3, sessionId: "session-1" },
		);

		expect(payload.tool_choice).toBe("required");
		expect(payload.temperature).toBe(0.3);
		expect(payload.prompt_cache_key).toBe("session-1");
		expect(payload.tools).toEqual([expect.objectContaining({ name: "ping" })]);
	});

	it("omits cache fields when cacheRetention is none", () => {
		const payload = prepareRequest(
			withCompat(getModel("github-copilot", "gpt-5.6-sol"), { supportsExplicitPromptCacheMode: true }),
			normalizeContext({ messages: [userTurn] }),
			{
				cacheRetention: "none",
				sessionId: "session-1",
			},
		);

		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.prompt_cache_options).toEqual({ mode: "explicit" });
	});

	it("collapses the mid-conversation system message when compat rejects it", () => {
		const model = withCompat(getModel("github-copilot", "gpt-5.4"), { supportsMidConvoSystemMessages: false });

		expect(instructions(prepareRequest(model, transcriptWithMidConversationSystemPrompt(), {}))).toEqual([
			{ role: "developer", content: "base prompt\n\nlater instruction" },
		]);
	});

	it("keeps the mid-conversation system message in place when compat allows it", () => {
		const model = withCompat(getModel("github-copilot", "gpt-5.4"), { supportsMidConvoSystemMessages: true });

		expect(instructions(prepareRequest(model, transcriptWithMidConversationSystemPrompt(), {}))).toEqual([
			{ role: "developer", content: "base prompt" },
			{ role: "developer", content: "later instruction" },
		]);
	});

	it("sends grammar tools as custom tools only when compat enables them", () => {
		const model = getModel("github-copilot", "gpt-5.4");
		const context = grammarTranscript();

		// The OpenAI catalog sets supportsOpenAIGrammarTools, so the call replays as a custom tool call.
		const grammar = prepareRequest(model, context, {});
		expect(grammar.tools).toEqual([
			expect.objectContaining({
				type: "custom",
				name: "calc",
				format: { type: "grammar", syntax: "lark", definition: 'expr: /"1"/' },
			}),
		]);
		// The replayed call carries the raw grammar input instead of JSON-encoded arguments.
		expect(inputItems(grammar)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "custom_tool_call", call_id: "call-1", name: "calc", input: "1 + 1" }),
				expect.objectContaining({ type: "custom_tool_call_output", call_id: "call-1" }),
			]),
		);

		const plain = prepareRequest(withCompat(model, { supportsOpenAIGrammarTools: false }), context, {});
		expect(plain.tools).toEqual([expect.objectContaining({ type: "function", name: "calc" })]);
		expect(inputItems(plain)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "function_call",
					call_id: "call-1",
					name: "calc",
					arguments: '{"expression":"1 + 1"}',
				}),
				expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
			]),
		);
	});

	it("hands onPayload exactly the object prepareRequest returns", async () => {
		const model = getModel("github-copilot", "gpt-5.4");
		const context = normalizeContext({
			systemPrompt: "base prompt",
			messages: [userTurn],
			tools: [{ name: "ping", description: "Ping", parameters: Type.Object({ value: Type.String() }) }],
		});
		const options = {
			apiKey: "sk-test-key",
			maxTokens: 1024,
			temperature: 0.5,
			sessionId: "session-1",
			toolChoice: "required" as const,
			reasoningEffort: "high" as const,
		};

		let captured: unknown;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const stream = streamOpenAIResponses(model, context, {
			...options,
			onPayload: (payload) => {
				captured = payload;
			},
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(captured).toEqual(prepareRequest(model, context, options));
	});
});
