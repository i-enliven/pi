import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRequest, stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Model, OpenAIResponsesCompat, Usage } from "../src/types.ts";

interface InstructionItem {
	role: string;
	content: string;
}

function withCompat(
	model: Model<"azure-openai-responses">,
	compat: OpenAIResponsesCompat,
): Model<"azure-openai-responses"> {
	return { ...model, compat: { ...model.compat, ...compat } };
}

function instructions(payload: { input?: unknown }): InstructionItem[] {
	const input = payload.input as InstructionItem[];
	return input.filter((item) => item.role === "developer" || item.role === "system");
}

const userTurn = { role: "user" as const, content: "hi", timestamp: 1 };

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A grammar-constrained tool plus its replayed call and result. */
function grammarTranscript() {
	return normalizeContext({
		messages: [
			{ role: "user", content: "compute", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "calc", arguments: { expression: "1 + 1" } }],
				api: "azure-openai-responses",
				provider: "azure",
				model: "gpt-5.2",
				usage: emptyUsage,
				stopReason: "toolUse",
				timestamp: 2,
			},
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

describe("azure-openai-responses prepareRequest", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const model = getModel("azure", "gpt-5.2");

	it("resolves the deployment name without a client", () => {
		const context = normalizeContext({ messages: [userTurn] });

		expect(prepareRequest(model, context, {}).model).toBe("gpt-5.2");
		expect(prepareRequest(model, context, { azureDeploymentName: "explicit-deployment" }).model).toBe(
			"explicit-deployment",
		);
		expect(
			prepareRequest(model, context, {
				env: { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5.2=env-deployment" },
			}).model,
		).toBe("env-deployment");
	});

	it("clamps max_output_tokens to the provider minimum", () => {
		const context = normalizeContext({ messages: [userTurn] });

		expect(prepareRequest(model, context, { maxTokens: 8 }).max_output_tokens).toBe(16);
		expect(prepareRequest(model, context, { maxTokens: 1024 }).max_output_tokens).toBe(1024);
	});

	it("sends strict tool schemas only when compat allows it", () => {
		const context = normalizeContext({
			messages: [userTurn],
			tools: [
				{
					name: "structured",
					description: "Structured",
					parameters: Type.Object({ value: Type.String() }),
					constrainedSampling: { type: "json_schema", strict: "prefer" },
				},
			],
		});

		expect(prepareRequest(model, context, {}).tools).toEqual([
			expect.objectContaining({ name: "structured", strict: true }),
		]);
		expect(prepareRequest(withCompat(model, { supportsStrictMode: false }), context, {}).tools).toEqual([
			expect.not.objectContaining({ strict: expect.anything() }),
		]);
	});

	it("forwards tool choice and session affinity", () => {
		const payload = prepareRequest(model, normalizeContext({ messages: [userTurn] }), {
			toolChoice: "required",
			sessionId: "session-1",
		});

		expect(payload.tool_choice).toBe("required");
		expect(payload.prompt_cache_key).toBe("session-1");
	});

	it("collapses the mid-conversation system message when compat rejects it", () => {
		const context = normalizeContext({
			systemPrompt: "base prompt",
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "system", content: "later instruction", timestamp: 2 },
			],
		});

		expect(instructions(prepareRequest(model, context, {}))).toEqual([
			{ role: "developer", content: "base prompt\n\nlater instruction" },
		]);
	});

	it("keeps the mid-conversation system message in place when compat allows it", () => {
		const context = normalizeContext({
			systemPrompt: "base prompt",
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "system", content: "later instruction", timestamp: 2 },
			],
		});
		const allowed = withCompat(model, { supportsMidConvoSystemMessages: true });

		expect(instructions(prepareRequest(allowed, context, {}))).toEqual([
			{ role: "developer", content: "base prompt" },
			{ role: "developer", content: "later instruction" },
		]);
	});

	it("sends grammar tools as custom tools only when compat enables them", () => {
		const context = grammarTranscript();

		// The Azure catalog sets supportsOpenAIGrammarTools, so the call replays as a custom tool call.
		const grammar = prepareRequest(model, context, {});
		expect(grammar.tools).toEqual([
			expect.objectContaining({
				type: "custom",
				name: "calc",
				format: { type: "grammar", syntax: "lark", definition: 'expr: /"1"/' },
			}),
		]);
		expect(inputItems(grammar)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "custom_tool_call", call_id: "call-1", name: "calc", input: "1 + 1" }),
				expect.objectContaining({ type: "custom_tool_call_output", call_id: "call-1" }),
			]),
		);

		const plain = prepareRequest(withCompat(model, { supportsOpenAIGrammarTools: false }), context, {});
		expect(plain.tools).toEqual([expect.objectContaining({ type: "function", name: "calc" })]);
		// Without the grammar input property map the same call replays as JSON-encoded arguments.
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
		const context = normalizeContext({
			systemPrompt: "base prompt",
			messages: [
				userTurn,
				// Normalisation has to matter here: this is what the two paths must agree on.
				{ role: "system", content: "later instruction", timestamp: 2 },
			],
			tools: [{ name: "ping", description: "Ping", parameters: Type.Object({ value: Type.String() }) }],
		});
		const options = {
			apiKey: "test-key",
			azureBaseUrl: "https://example.openai.azure.com",
			azureDeploymentName: "explicit-deployment",
			maxTokens: 1024,
			temperature: 0.5,
			sessionId: "session-1",
			toolChoice: "required" as const,
		};

		let captured: unknown;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const request = streamAzure(model, context, {
			...options,
			onPayload: (payload) => {
				captured = payload;
			},
		});
		await request.result();

		expect(captured).toEqual(prepareRequest(model, context, options));
	});
});
