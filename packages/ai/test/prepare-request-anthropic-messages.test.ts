import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type AnthropicOptions, prepareRequest } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, Tool, Usage } from "../src/types.ts";

/** Wire shape of the assembled payload, narrowed to the fields these tests assert on. */
interface WireBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
	content?: string;
	is_error?: boolean;
	tool_use_id?: string;
	source?: { type: string; media_type: string; data: string };
	cache_control?: { type: string; ttl?: string };
	tool?: { type: string; name?: string; definition?: { name: string } };
}

interface WireMessage {
	role: string;
	content: string | WireBlock[];
	output_config?: { effort?: string };
}

interface WireTool {
	name: string;
	defer_loading?: boolean;
	strict?: boolean;
	eager_input_streaming?: boolean;
	input_schema?: Record<string, unknown>;
	cache_control?: { type: string; ttl?: string };
}

interface WirePayload {
	model: string;
	messages: WireMessage[];
	system?: Array<{ type: string; text: string; cache_control?: { type: string; ttl?: string } }>;
	tools?: WireTool[];
	tool_choice?: { type: string; name?: string };
	thinking?: {
		type: string;
		budget_tokens?: number;
		display?: string;
		block_binding?: { prefix_mismatch_behavior?: string };
	};
	output_config?: { effort?: string };
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
	betas?: string[];
}

const baseModel: Model<"anthropic-messages"> = {
	id: "test-anthropic-model",
	name: "Test Anthropic Model",
	api: "anthropic-messages",
	provider: "test-anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
};

function testModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return { ...baseModel, ...overrides };
}

function tool(name: string, constrainedSampling?: Tool["constrainedSampling"]): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: Type.Object({ value: Type.String() }),
		...(constrainedSampling ? { constrainedSampling } : {}),
	};
}

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function simpleContext(): Context {
	return { systemPrompt: "sys", messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
}

function toolContext(tools: Tool[]): Context {
	return { messages: [{ role: "user", content: "Use the tool", timestamp: 1 }], tools };
}

/** Transcript with a leading system prompt and a later system update that changes tools. */
function toolChangeContext(): Context {
	return {
		messages: [
			{ role: "system", content: "base prompt", toolsAdded: [tool("base_tool")], timestamp: 0 },
			{ role: "user", content: "before", timestamp: 1 },
			{
				role: "system",
				content: "updated guidance",
				toolsRemoved: [{ name: "base_tool" }],
				toolsAdded: [tool("late_tool")],
				timestamp: 2,
			},
		],
	};
}

function blocksOf(message: WireMessage | undefined): WireBlock[] {
	if (!message) throw new Error("Expected message");
	if (typeof message.content === "string") throw new Error(`Expected block content, got string: ${message.content}`);
	return message.content;
}

function payloadOf(model: Model<"anthropic-messages">, context: Context, options?: AnthropicOptions): WirePayload {
	return prepareRequest(model, normalizeContext(context), options) as unknown as WirePayload;
}

describe("prepareRequest (anthropic-messages)", () => {
	it("assembles the payload without an API key", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const params = prepareRequest(model, normalizeContext(simpleContext()));

		expect(params.model).toBe("claude-haiku-4-5");
		expect(params.stream).toBe(true);
		expect(params.max_tokens).toBe(model.maxTokens);
		expect(params.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
		expect(params.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }] },
		]);
	});

	describe("varies by model compat", () => {
		it("cache ttl follows supportsLongCacheRetention", () => {
			const model = testModel();
			expect(payloadOf(model, simpleContext(), { cacheRetention: "long" }).system?.[0].cache_control).toEqual({
				type: "ephemeral",
				ttl: "1h",
			});
			expect(
				payloadOf(testModel({ compat: { supportsLongCacheRetention: false } }), simpleContext(), {
					cacheRetention: "long",
				}).system?.[0].cache_control,
			).toEqual({ type: "ephemeral" });
		});

		it("eager tool input streaming and the fine-grained beta follow supportsEagerToolInputStreaming", () => {
			const context = toolContext([tool("lookup")]);
			const supported = payloadOf(testModel(), context);
			expect(supported.tools?.[0].eager_input_streaming).toBe(true);
			expect(supported.tools?.[0].cache_control).toEqual({ type: "ephemeral" });
			expect(supported.betas).toBeUndefined();

			const unsupported = payloadOf(testModel({ compat: { supportsEagerToolInputStreaming: false } }), context);
			expect(unsupported.tools?.[0]).not.toHaveProperty("eager_input_streaming");
			expect(unsupported.betas).toContain("fine-grained-tool-streaming-2025-05-14");
		});

		it("strict tools follow supportsStrictTools", () => {
			const context = toolContext([tool("lookup", { type: "json_schema", strict: "prefer" })]);
			const supported = payloadOf(getModel("anthropic", "claude-haiku-4-5"), context);
			expect(supported.tools?.[0].strict).toBe(true);
			expect(supported.tools?.[0].input_schema).toMatchObject({ type: "object", required: ["value"] });

			const unsupported = payloadOf(testModel({ compat: { supportsStrictTools: false } }), context);
			expect(unsupported.tools?.[0]).not.toHaveProperty("strict");
			expect(unsupported.tools?.[0].input_schema).toMatchObject({ type: "object", required: ["value"] });
		});

		it("managed-effort models force adaptive thinking and carry per-message effort", () => {
			const params = payloadOf(getModel("anthropic", "claude-opus-5"), simpleContext(), {
				cacheRetention: "none",
				thinkingEnabled: true,
				effort: "xhigh",
				temperature: 0.5,
			});

			expect(params.thinking).toEqual({
				type: "adaptive",
				display: "summarized",
				block_binding: { prefix_mismatch_behavior: "drop_block" },
			});
			// The request-level effort is pinned; history effort rides on the inserted system messages.
			expect(params.output_config).toEqual({ effort: "high" });
			expect(params.messages[params.messages.length - 1]).toEqual({
				role: "system",
				content: [],
				output_config: { effort: "xhigh" },
			});
			expect(params).not.toHaveProperty("temperature");
			expect(params.betas).toContain("mid-conversation-output-config-2026-07-01");
			expect(params.betas).toContain("thinking-binding-controls-2026-08-01");
		});

		it("drops temperature for models that reject it", () => {
			expect(payloadOf(testModel(), simpleContext(), { temperature: 0.5 }).temperature).toBe(0.5);
			expect(
				payloadOf(getModel("anthropic", "claude-opus-4-7"), simpleContext(), { temperature: 0.5 }),
			).not.toHaveProperty("temperature");
		});
	});

	describe("varies by options", () => {
		it("budget thinking uses thinkingBudgetTokens with a 1024 floor", () => {
			const model = testModel();
			expect(
				payloadOf(model, simpleContext(), {
					cacheRetention: "none",
					thinkingEnabled: true,
					thinkingBudgetTokens: 4096,
				}).thinking,
			).toEqual({ type: "enabled", budget_tokens: 4096, display: "summarized" });
			expect(payloadOf(model, simpleContext(), { cacheRetention: "none", thinkingEnabled: true }).thinking).toEqual({
				type: "enabled",
				budget_tokens: 1024,
				display: "summarized",
			});
			expect(payloadOf(model, simpleContext(), { cacheRetention: "none", thinkingEnabled: true }).betas).toContain(
				"interleaved-thinking-2025-05-14",
			);
		});

		it("adaptive thinking uses effort and thinkingDisplay", () => {
			const model = testModel({ compat: { forceAdaptiveThinking: true } });
			expect(
				payloadOf(model, simpleContext(), { cacheRetention: "none", thinkingEnabled: true, effort: "xhigh" }),
			).toEqual(
				expect.objectContaining({
					thinking: { type: "adaptive", display: "summarized" },
					output_config: { effort: "xhigh" },
				}),
			);
			expect(
				payloadOf(model, simpleContext(), {
					cacheRetention: "none",
					thinkingEnabled: true,
					thinkingDisplay: "omitted",
				}).thinking,
			).toEqual({ type: "adaptive", display: "omitted" });
			expect(
				payloadOf(model, simpleContext(), { cacheRetention: "none", thinkingEnabled: true }),
			).not.toHaveProperty("output_config");
		});

		it("disables thinking unless the model has no off level", () => {
			expect(payloadOf(testModel(), simpleContext(), { thinkingEnabled: false }).thinking).toEqual({
				type: "disabled",
			});
			expect(
				payloadOf(testModel({ thinkingLevelMap: { off: null } }), simpleContext(), { thinkingEnabled: false }),
			).not.toHaveProperty("thinking");
		});

		it("maps toolChoice", () => {
			const context = toolContext([tool("lookup")]);
			expect(payloadOf(testModel(), context, { toolChoice: "any" }).tool_choice).toEqual({ type: "any" });
			expect(payloadOf(testModel(), context, { toolChoice: { type: "tool", name: "lookup" } }).tool_choice).toEqual({
				type: "tool",
				name: "lookup",
			});
			expect(payloadOf(testModel(), context)).not.toHaveProperty("tool_choice");
		});

		it("cacheRetention none removes every cache breakpoint", () => {
			const context: Context = { ...simpleContext(), tools: [tool("lookup")] };
			const params = payloadOf(testModel(), context, { cacheRetention: "none" });
			expect(params.system?.[0]).not.toHaveProperty("cache_control");
			expect(params.tools?.[0]).not.toHaveProperty("cache_control");
			expect(params.messages[0].content).toBe("Hello");

			const cached = payloadOf(testModel(), context);
			expect(cached.tools?.[0].cache_control).toEqual({ type: "ephemeral" });
			expect(blocksOf(cached.messages[0])).toEqual([
				{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
			]);
		});

		it("adds Claude Code identity only for Anthropic OAuth credentials", () => {
			const model = testModel();
			const context: Context = { ...simpleContext(), tools: [tool("read")] };
			const oauth = payloadOf(model, context, { apiKey: "sk-ant-oat01-fake", cacheRetention: "none" });
			expect(oauth.system?.map((block) => block.text)).toEqual([
				"You are Claude Code, Anthropic's official CLI for Claude.",
				"sys",
			]);
			expect(oauth.betas).toContain("claude-code-20250219");
			expect(oauth.betas).toContain("oauth-2025-04-20");
			expect(oauth.tools?.[0].name).toBe("Read");

			// A pre-built client owns its auth, and Copilot uses a GitHub token: no Claude Code identity.
			// Assembly only checks that a client was supplied, so a stub stands in for the SDK client.
			const prebuilt = payloadOf(model, context, {
				apiKey: "sk-ant-oat01-fake",
				client: {} as unknown as Anthropic,
				cacheRetention: "none",
			});
			expect(prebuilt.system?.map((block) => block.text)).toEqual(["sys"]);
			expect(prebuilt.tools?.[0].name).toBe("read");
			expect(prebuilt.betas).toBeUndefined();

			const copilot = payloadOf(testModel({ provider: "github-copilot" }), context, {
				apiKey: "sk-ant-oat01-fake",
				cacheRetention: "none",
			});
			expect(copilot.system?.map((block) => block.text)).toEqual(["sys"]);
			expect(copilot.tools?.[0].name).toBe("read");
		});
	});

	describe("transcript transformations", () => {
		it("collapses mid-conversation system messages when the model rejects them", () => {
			const params = payloadOf(testModel(), toolChangeContext(), { cacheRetention: "none" });

			expect(params.system?.[0].text).toBe("base prompt\n\nupdated guidance");
			expect(params.messages.some((message) => message.role === "system")).toBe(false);
			expect(params.tools?.map((entry) => entry.name)).toEqual(["late_tool"]);
		});

		it("keeps mid-conversation system messages and sends the current tools when tool changes are not native", () => {
			const params = payloadOf(
				testModel({ compat: { supportsMidConvoSystemMessages: true } }),
				toolChangeContext(),
				{
					cacheRetention: "none",
				},
			);

			expect(params.system?.[0].text).toBe("base prompt");
			expect(params.tools?.map((entry) => entry.name)).toEqual(["late_tool"]);
			const update = params.messages[params.messages.length - 1];
			expect(update.role).toBe("system");
			expect(blocksOf(update)).toEqual([{ type: "text", text: "updated guidance" }]);
			expect(params.betas).toBeUndefined();
		});

		it("expresses tool changes as native add/remove blocks behind a deferred placeholder", () => {
			const params = payloadOf(getModel("anthropic", "claude-opus-4-8"), toolChangeContext(), {
				cacheRetention: "none",
			});

			expect(params.tools?.map((entry) => entry.name)).toEqual(["base_tool", "__pi_deferred_placeholder__"]);
			expect(params.tools?.[1].defer_loading).toBe(true);

			const update = params.messages[params.messages.length - 1];
			expect(update.role).toBe("system");
			expect(blocksOf(update)).toEqual([
				{ type: "text", text: "updated guidance" },
				{ type: "tool_removal", tool: { type: "tool_reference", name: "base_tool" } },
				{
					type: "tool_addition",
					tool: { type: "tool_definition", definition: expect.objectContaining({ name: "late_tool" }) },
				},
			]);
			expect(params.betas).toContain("inline-tools-2026-09-15");
		});

		it("pairs consecutive tool results into one user message and normalizes tool call ids", () => {
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call|1", name: "lookup", arguments: { value: "a" } },
					{ type: "toolCall", id: "call_2", name: "lookup", arguments: { value: "b" } },
				],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-5.4",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: 2,
			};
			const context: Context = {
				messages: [
					{ role: "user", content: "hi", timestamp: 1 },
					assistant,
					{
						role: "toolResult",
						toolCallId: "call|1",
						toolName: "lookup",
						content: [{ type: "text", text: "first" }],
						isError: false,
						timestamp: 3,
					},
					{
						role: "toolResult",
						toolCallId: "call_2",
						toolName: "lookup",
						content: [{ type: "text", text: "second" }],
						isError: true,
						timestamp: 4,
					},
				],
			};

			const params = payloadOf(testModel(), context, { cacheRetention: "none" });
			expect(params.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
			expect(blocksOf(params.messages[1]).map((block) => block.id)).toEqual(["call_1", "call_2"]);
			expect(blocksOf(params.messages[2])).toEqual([
				{ type: "tool_result", tool_use_id: "call_1", content: "first", is_error: false },
				{ type: "tool_result", tool_use_id: "call_2", content: "second", is_error: true },
			]);
		});

		it("strips images for text-only models", () => {
			const context: Context = {
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "look" },
							{ type: "image", data: "AA==", mimeType: "image/png" },
						],
						timestamp: 1,
					},
				],
			};

			const textOnly = payloadOf(testModel({ input: ["text"] }), context, { cacheRetention: "none" });
			expect(blocksOf(textOnly.messages[0])).toEqual([
				{ type: "text", text: "look" },
				{ type: "text", text: "(image omitted: model does not support images)" },
			]);

			const vision = payloadOf(testModel(), context, { cacheRetention: "none" });
			expect(blocksOf(vision.messages[0])).toEqual([
				{ type: "text", text: "look" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
			]);
		});
	});
});
