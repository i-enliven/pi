import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BedrockOptions, prepareRequest, stream } from "../src/api/bedrock-converse-stream.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Context, Message, Model, Tool, TranscriptContext, Usage } from "../src/types.ts";

/** Structural view of the assembled ConverseStream command input, narrowed for assertions. */
interface CommandInputLike {
	modelId: string;
	messages?: Array<{ role: string; content?: ContentBlockLike[] }>;
	system?: ContentBlockLike[];
	inferenceConfig?: { maxTokens?: number; temperature?: number };
	toolConfig?: {
		tools?: Array<{ toolSpec?: { name?: string; strict?: boolean; inputSchema?: { json?: unknown } } }>;
		toolChoice?: Record<string, unknown>;
	};
	additionalModelRequestFields?: Record<string, unknown>;
	requestMetadata?: Record<string, string>;
}

interface ContentBlockLike {
	text?: string;
	cachePoint?: { type: string; ttl?: string };
	image?: { source: { bytes: Uint8Array }; format: string };
	toolUse?: { toolUseId: string; name: string; input: unknown };
	toolResult?: { toolUseId: string; content: Array<{ text?: string }>; status: string };
}

const baseModel: Model<"bedrock-converse-stream"> = {
	id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
	name: "Claude Sonnet 4.5",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 64000,
	compat: { supportsStrictMode: true },
};

/** Nova has no prompt-cache support and no strict-tool compat. */
const novaModel: Model<"bedrock-converse-stream"> = {
	...baseModel,
	id: "amazon.nova-lite-v1:0",
	name: "Nova Lite",
	reasoning: false,
	compat: undefined,
};

const textOnlyModel: Model<"bedrock-converse-stream"> = { ...baseModel, input: ["text"] };

const lookupTool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};

const extraTool: Tool = {
	name: "extra",
	description: "Extra tool",
	parameters: Type.Object({ note: Type.String() }),
};

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function prepare(
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options?: BedrockOptions,
): CommandInputLike {
	return prepareRequest(model, normalizeContext(context), options) as unknown as CommandInputLike;
}

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantToolCalls(ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: baseModel.id,
		content: ids.map((id) => ({ type: "toolCall", id, name: "lookup", arguments: { value: id } })),
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(toolCallId: string, text: string, isError: boolean): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "lookup",
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	};
}

/** Env vars that would otherwise leak into cache, GovCloud, and retention decisions. */
const AMBIENT_ENV = ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_BEDROCK_FORCE_CACHE", "PI_CACHE_RETENTION"];

describe("prepareRequest (bedrock-converse-stream)", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const name of AMBIENT_ENV) {
			savedEnv[name] = process.env[name];
			delete process.env[name];
		}
	});

	afterEach(() => {
		for (const name of AMBIENT_ENV) {
			if (savedEnv[name] === undefined) delete process.env[name];
			else process.env[name] = savedEnv[name];
		}
	});

	it("sends the model id and caps output tokens from the model for Claude models", () => {
		const context: Context = { systemPrompt: "Be terse.", messages: [userMessage("Hello")] };

		const claudePayload = prepare(baseModel, context, { cacheRetention: "none" });
		expect(claudePayload.modelId).toBe(baseModel.id);
		expect(claudePayload.system).toEqual([{ text: "Be terse." }]);
		expect(claudePayload.inferenceConfig).toEqual({ maxTokens: 64000 });

		// Non-Claude models have no catalog maxTokens default, so the field stays absent.
		const novaPayload = prepare(novaModel, context, { cacheRetention: "none" });
		expect(novaPayload.inferenceConfig).toEqual({});
	});

	it("takes maxTokens and temperature from options", () => {
		const context: Context = { messages: [userMessage("Hello")] };
		const payload = prepare(baseModel, context, { maxTokens: 1024, temperature: 0.3, cacheRetention: "none" });

		expect(payload.system).toBeUndefined();
		expect(payload.inferenceConfig).toEqual({ maxTokens: 1024, temperature: 0.3 });
	});

	it("gates strict tool schemas on model.compat.supportsStrictMode", () => {
		const context: Context = { messages: [userMessage("Use the tool")], tools: [lookupTool] };

		const strictPayload = prepare(baseModel, context, { cacheRetention: "none" });
		expect(strictPayload.toolConfig?.tools?.[0]?.toolSpec?.strict).toBe(true);

		const nonStrictPayload = prepare({ ...baseModel, compat: undefined }, context, { cacheRetention: "none" });
		expect(nonStrictPayload.toolConfig?.tools?.[0]?.toolSpec?.strict).toBeUndefined();
		expect(nonStrictPayload.toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json).toEqual(lookupTool.parameters);
	});

	it("maps toolChoice to the Bedrock tool choice", () => {
		const context: Context = { messages: [userMessage("Use the tool")], tools: [lookupTool] };

		expect(prepare(baseModel, context, { cacheRetention: "none" }).toolConfig?.toolChoice).toBeUndefined();
		expect(
			prepare(baseModel, context, { cacheRetention: "none", toolChoice: "auto" }).toolConfig?.toolChoice,
		).toEqual({ auto: {} });
		expect(prepare(baseModel, context, { cacheRetention: "none", toolChoice: "any" }).toolConfig?.toolChoice).toEqual(
			{
				any: {},
			},
		);
		expect(
			prepare(baseModel, context, {
				cacheRetention: "none",
				toolChoice: { type: "tool", name: "lookup" },
			}).toolConfig?.toolChoice,
		).toEqual({ tool: { name: "lookup" } });
		// "none" drops the tool configuration entirely.
		expect(prepare(baseModel, context, { cacheRetention: "none", toolChoice: "none" }).toolConfig).toBeUndefined();
	});

	it("anchors cache points on the system prompt and last user message for Claude models", () => {
		const context: Context = { systemPrompt: "Be terse.", messages: [userMessage("Hello")] };

		const short = prepare(baseModel, context, { cacheRetention: "short" });
		expect(short.system?.[1]).toEqual({ cachePoint: { type: "default" } });
		expect(short.messages?.[0]?.content?.[1]).toEqual({ cachePoint: { type: "default" } });

		const long = prepare(baseModel, context, { cacheRetention: "long" });
		expect(long.system?.[1]).toEqual({ cachePoint: { type: "default", ttl: "1h" } });
		expect(long.messages?.[0]?.content?.[1]).toEqual({ cachePoint: { type: "default", ttl: "1h" } });

		const none = prepare(baseModel, context, { cacheRetention: "none" });
		expect(none.system).toEqual([{ text: "Be terse." }]);
		expect(none.messages?.[0]?.content).toEqual([{ text: "Hello" }]);

		// Nova has automatic caching, so it never gets explicit cache points.
		const nova = prepare(novaModel, context, { cacheRetention: "long" });
		expect(nova.system).toEqual([{ text: "Be terse." }]);
		expect(nova.messages?.[0]?.content).toEqual([{ text: "Hello" }]);
	});

	it("collapses mid-conversation system messages into the leading system prompt", () => {
		const payload = prepare(
			baseModel,
			{
				systemPrompt: "Base prompt.",
				messages: [
					userMessage("First"),
					{ role: "system", content: "Later instruction.", toolsAdded: [extraTool], timestamp: 2 },
					userMessage("Second"),
				],
				tools: [lookupTool],
			},
			{ cacheRetention: "none" },
		);

		expect(payload.system).toEqual([{ text: "Base prompt.\n\nLater instruction." }]);
		// Bedrock carries no system role in the message list: both system messages are gone.
		expect(payload.messages?.map((message) => message.role)).toEqual(["user", "user"]);
		// The collapsed head also carries the replayed tool state.
		expect(payload.toolConfig?.tools?.map((tool) => tool.toolSpec?.name)).toEqual(["lookup", "extra"]);
	});

	it("merges consecutive tool results into a single user message", () => {
		const payload = prepare(
			baseModel,
			{
				messages: [
					assistantToolCalls(["call-1", "call-2"]),
					toolResult("call-1", "first result", false),
					toolResult("call-2", "second result", true),
				],
			},
			{ cacheRetention: "none" },
		);

		expect(payload.messages?.map((message) => message.role)).toEqual(["assistant", "user"]);
		expect(payload.messages?.[0]?.content).toEqual([
			{ toolUse: { toolUseId: "call-1", name: "lookup", input: { value: "call-1" } } },
			{ toolUse: { toolUseId: "call-2", name: "lookup", input: { value: "call-2" } } },
		]);
		expect(payload.messages?.[1]?.content).toEqual([
			{ toolResult: { toolUseId: "call-1", content: [{ text: "first result" }], status: "success" } },
			{ toolResult: { toolUseId: "call-2", content: [{ text: "second result" }], status: "error" } },
		]);
	});

	it("sends image bytes for vision models and a placeholder for text-only models", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Look" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		};

		const vision = prepare(baseModel, context, { cacheRetention: "none" });
		const image = vision.messages?.[0]?.content?.[1]?.image;
		expect(image?.format).toBe("png");
		expect(Array.from(image?.source.bytes ?? [])).toEqual([104, 101, 108, 108, 111]);

		const textOnly = prepare(textOnlyModel, context, { cacheRetention: "none" });
		expect(textOnly.messages?.[0]?.content).toEqual([
			{ text: "Look" },
			{ text: "(image omitted: model does not support images)" },
		]);
	});

	it("builds reasoning fields per model family and honours thinkingBudgets", () => {
		const context: Context = { messages: [userMessage("Think")] };

		// Budget-based Claude: token budget plus the interleaved-thinking beta.
		const budgeted = prepare(baseModel, context, { cacheRetention: "none", reasoning: "high" });
		expect(budgeted.additionalModelRequestFields?.thinking).toEqual({
			type: "enabled",
			budget_tokens: 16384,
			display: "summarized",
		});
		expect(budgeted.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);

		const customBudget = prepare(baseModel, context, {
			cacheRetention: "none",
			reasoning: "high",
			thinkingBudgets: { high: 2048 },
		});
		expect(customBudget.additionalModelRequestFields?.thinking).toMatchObject({ budget_tokens: 2048 });

		// Adaptive-thinking Claude: effort instead of a token budget.
		const adaptive = prepare(getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1"), context, {
			cacheRetention: "none",
			reasoning: "xhigh",
		});
		expect(adaptive.additionalModelRequestFields?.thinking).toMatchObject({
			type: "adaptive",
			display: "summarized",
		});
		expect(adaptive.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });

		// gpt-oss takes a flat reasoning_effort and clamps extended levels.
		const gptOss = prepare(getModel("amazon-bedrock", "openai.gpt-oss-120b"), context, {
			cacheRetention: "none",
			reasoning: "xhigh",
		});
		expect(gptOss.additionalModelRequestFields).toEqual({ reasoning_effort: "high" });

		// No reasoning request means no additional fields at all.
		expect(prepare(baseModel, context, { cacheRetention: "none" }).additionalModelRequestFields).toBeUndefined();
	});

	it("passes requestMetadata through only when provided", () => {
		const context: Context = { messages: [userMessage("Hello")] };

		expect("requestMetadata" in prepare(baseModel, context, { cacheRetention: "none" })).toBe(false);
		expect(
			prepare(baseModel, context, { cacheRetention: "none", requestMetadata: { team: "pi" } }).requestMetadata,
		).toEqual({ team: "pi" });
	});

	it("keeps transcript normalisation failures synchronous out of stream()", () => {
		const malformed = {
			messages: [{ role: "system", content: undefined, timestamp: 0 }],
		} as unknown as TranscriptContext;

		expect(() => stream(baseModel, malformed, { cacheRetention: "none" })).toThrow();
	});
});
