import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { prepareRequest } from "../src/api/openai-completions.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Model, ToolCall, Usage } from "../src/types.ts";

/** Subset of the assembled Chat Completions payload that these assertions read. */
interface Payload {
	model: string;
	messages: PayloadMessage[];
	stream: boolean;
	stream_options?: { include_usage?: boolean };
	store?: boolean;
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
	temperature?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
	tool_choice?: unknown;
	tools?: PayloadTool[];
}

interface PayloadMessage {
	role: string;
	content?: unknown;
	tool_calls?: PayloadToolCall[];
	tool_call_id?: string;
}

interface PayloadToolCall {
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
	custom?: { name?: string; input?: string };
}

interface PayloadTool {
	type?: string;
	cache_control?: { type?: string; ttl?: string };
	function?: { name?: string; strict?: boolean; parameters?: Record<string, unknown> };
	custom?: {
		name?: string;
		description?: string;
		format?: { type?: string; grammar?: { syntax?: string; definition?: string } };
	};
}

interface ContentPart {
	type?: string;
	text?: string;
	cache_control?: { type?: string; ttl?: string };
	image_url?: { url?: string };
}

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createModel(
	compat?: Model<"openai-completions">["compat"],
	overrides?: Partial<Model<"openai-completions">>,
): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "test-openai-completions",
		baseUrl: "https://my-proxy.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
		...overrides,
	};
}

/** OpenAI Chat Completions model with a real OpenAI catalog entry. */
function createOpenAIModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("github-copilot", "gpt-5.4-mini");
	return { ...baseModel, api: "openai-completions", provider: "openai", baseUrl: "https://api.openai.com/v1" };
}

function assemble(
	model: Model<"openai-completions">,
	context: Parameters<typeof prepareRequest>[1],
	options?: Parameters<typeof prepareRequest>[2],
): Payload {
	return prepareRequest(model, context, options) as Payload;
}

function simpleContext(): Parameters<typeof prepareRequest>[1] {
	return normalizeContext({
		systemPrompt: "base prompt",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
	});
}

function assistantToolCall(name: string, args: ToolCall["arguments"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name, arguments: args }],
		api: "openai-completions",
		provider: "test-openai-completions",
		model: "test-model",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp,
	};
}

describe("prepareRequest (openai-completions)", () => {
	it("assembles the base payload without options", () => {
		const payload = assemble(createModel(), simpleContext());

		expect(payload.model).toBe("test-model");
		expect(payload.stream).toBe(true);
		expect(payload.store).toBe(false);
		expect(payload.stream_options).toEqual({ include_usage: true });
		expect(payload.messages).toEqual([
			{ role: "system", content: "base prompt" },
			{ role: "user", content: "hello" },
		]);
	});

	it("omits stream_options when supportsUsageInStreaming is false", () => {
		const payload = assemble(createModel({ supportsUsageInStreaming: false }), simpleContext());

		expect(payload.stream_options).toBeUndefined();
		expect(payload.store).toBe(false);
	});

	it("sends max_completion_tokens by default and max_tokens when compat.maxTokensField says so", () => {
		const options = { maxTokens: 512 };

		const defaultPayload = assemble(createModel(), simpleContext(), options);
		expect(defaultPayload.max_completion_tokens).toBe(512);
		expect(defaultPayload).not.toHaveProperty("max_tokens");

		const maxTokensPayload = assemble(createModel({ maxTokensField: "max_tokens" }), simpleContext(), options);
		expect(maxTokensPayload.max_tokens).toBe(512);
		expect(maxTokensPayload).not.toHaveProperty("max_completion_tokens");
	});

	it("carries temperature and tool choice from options", () => {
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
		});

		const payload = assemble(createModel({ supportsStrictMode: true }), context, {
			temperature: 0.3,
			toolChoice: { type: "function", function: { name: "read" } },
		});

		expect(payload.temperature).toBe(0.3);
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "read" } });
		expect(payload.tools?.[0]?.function?.name).toBe("read");
	});

	it("sets prompt cache fields from cacheRetention and compat.supportsLongCacheRetention", () => {
		const model = createModel();
		const context = simpleContext();

		// Proxy endpoint: the session key is only sent for long retention.
		const short = assemble(model, context, { sessionId: "session-1" });
		expect(short.prompt_cache_key).toBeUndefined();
		expect(short.prompt_cache_retention).toBeUndefined();

		const long = assemble(model, context, { sessionId: "session-1", cacheRetention: "long" });
		expect(long.prompt_cache_key).toBe("session-1");
		expect(long.prompt_cache_retention).toBe("24h");

		const none = assemble(model, context, { sessionId: "session-1", cacheRetention: "none" });
		expect(none.prompt_cache_key).toBeUndefined();
		expect(none.prompt_cache_retention).toBeUndefined();

		const unsupported = assemble(createModel({ supportsLongCacheRetention: false }), context, {
			sessionId: "session-1",
			cacheRetention: "long",
		});
		expect(unsupported.prompt_cache_key).toBeUndefined();
		expect(unsupported.prompt_cache_retention).toBeUndefined();
	});

	it("keeps prompt_cache_key for OpenAI endpoints but drops it when cacheRetention is none", () => {
		const model = createOpenAIModel();

		const cached = assemble(model, simpleContext(), { sessionId: "session-2" });
		expect(cached.prompt_cache_key).toBe("session-2");

		const uncached = assemble(model, simpleContext(), { sessionId: "session-2", cacheRetention: "none" });
		expect(uncached.prompt_cache_key).toBeUndefined();
	});

	it("marks tools strict only when compat supports strict mode", () => {
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: Type.Object({ path: Type.String() }),
					constrainedSampling: { type: "json_schema", strict: "prefer" },
				},
			],
		});

		const withoutStrict = assemble(createModel(), context);
		expect(withoutStrict.tools?.[0]?.function).toBeDefined();
		expect(withoutStrict.tools?.[0]?.function).not.toHaveProperty("strict");

		const withStrict = assemble(createModel({ supportsStrictMode: true }), context);
		expect(withStrict.tools?.[0]?.function?.strict).toBe(true);
		expect(withStrict.tools?.[0]?.function?.parameters).toMatchObject({
			additionalProperties: false,
			required: ["path"],
		});
	});

	it("sends grammar tools as custom tools only when compat enables them", () => {
		const grammarTool = {
			name: "calc",
			description: "Evaluate an expression",
			parameters: Type.Object({ expression: Type.String() }),
			constrainedSampling: { type: "grammar" as const, variants: { openai_lark: 'expr: /"1"/' } },
		};
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "compute", timestamp: 1 },
				assistantToolCall("calc", { expression: "1 + 1" }, 2),
			],
			tools: [grammarTool],
		});

		const plain = assemble(createModel(), context);
		expect(plain.tools?.[0]?.type).toBe("function");
		expect(plain.messages.find((message) => message.role === "assistant")?.tool_calls).toEqual([
			{
				id: "call-1",
				type: "function",
				function: { name: "calc", arguments: '{"expression":"1 + 1"}' },
			},
		]);

		const grammar = assemble(createModel({ supportsOpenAIGrammarTools: true }), context);
		expect(grammar.tools?.[0]).toEqual({
			type: "custom",
			custom: {
				name: "calc",
				description: "Evaluate an expression",
				format: { type: "grammar", grammar: { syntax: "lark", definition: 'expr: /"1"/' } },
			},
		});
		// The grammar input property comes from createGrammarToolInputProperties(), so the
		// replayed call carries the raw grammar input instead of JSON-encoded arguments.
		expect(grammar.messages.find((message) => message.role === "assistant")?.tool_calls).toEqual([
			{ id: "call-1", type: "custom", custom: { name: "calc", input: "1 + 1" } },
		]);
	});

	it("collapses mid-conversation system messages unless compat keeps them", () => {
		const context = normalizeContext({
			systemPrompt: "base prompt",
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "system", content: "new instructions", timestamp: 2 },
				{ role: "user", content: "second", timestamp: 3 },
			],
		});

		const collapsed = assemble(createModel(), context);
		expect(collapsed.messages).toEqual([
			{ role: "system", content: "base prompt\n\nnew instructions" },
			{ role: "user", content: "first" },
			{ role: "user", content: "second" },
		]);

		const kept = assemble(createModel({ supportsMidConvoSystemMessages: true }), context);
		expect(kept.messages).toEqual([
			{ role: "system", content: "base prompt" },
			{ role: "user", content: "first" },
			{ role: "system", content: "new instructions" },
			{ role: "user", content: "second" },
		]);
	});

	it("pairs assistant tool calls with tool result messages", () => {
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "read both", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
					],
					api: "openai-completions",
					provider: "test-openai-completions",
					model: "test-model",
					usage: emptyUsage,
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-a",
					toolName: "read",
					content: [{ type: "text", text: "a" }],
					isError: false,
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "call-b",
					toolName: "read",
					content: [{ type: "text", text: "b" }],
					isError: false,
					timestamp: 4,
				},
			],
		});

		const payload = assemble(createModel(), context);

		expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"]);
		expect(payload.messages[1]?.tool_calls?.map((call) => call.id)).toEqual(["call-a", "call-b"]);
		expect(payload.messages[2]).toEqual({
			role: "tool",
			content: "a",
			tool_call_id: "call-a",
		});
		expect(payload.messages[3]).toEqual({
			role: "tool",
			content: "b",
			tool_call_id: "call-b",
		});
	});

	it("strips tool result images for text-only models and keeps them for vision models", () => {
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "read",
			content: [
				{ type: "text" as const, text: "screenshot" },
				{ type: "image" as const, data: "ZmFrZQ==", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 3,
		};
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "screenshot", timestamp: 1 },
				assistantToolCall("read", { path: "shot.png" }, 2),
				toolResult,
			],
		});

		const textOnly = assemble(createModel(), context);
		expect(textOnly.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
		expect(textOnly.messages[2]?.content).toBe("screenshot\n(tool image omitted: model does not support images)");

		const vision = assemble(createModel(undefined, { input: ["text", "image"] }), context);
		expect(vision.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
		const imageParts = (vision.messages[3]?.content as ContentPart[]).filter((part) => part.type === "image_url");
		expect(imageParts).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } }]);
	});

	it("applies anthropic cache control markers per compat and cacheRetention", () => {
		const model = createModel({ cacheControlFormat: "anthropic" });
		const context = normalizeContext({
			systemPrompt: "base prompt",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
		});

		const short = assemble(model, context, { sessionId: "session-3" });
		expect((short.messages[0]?.content as ContentPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect((short.messages[1]?.content as ContentPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(short.tools?.[0]?.cache_control).toEqual({ type: "ephemeral" });

		const long = assemble(model, context, { sessionId: "session-3", cacheRetention: "long" });
		expect((long.messages[0]?.content as ContentPart[])[0]?.cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});

		const none = assemble(model, context, { sessionId: "session-3", cacheRetention: "none" });
		expect(none.messages[0]?.content).toBe("base prompt");
		expect(none.tools?.[0]).not.toHaveProperty("cache_control");
	});
});
