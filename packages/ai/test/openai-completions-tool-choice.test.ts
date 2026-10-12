import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { normalizeContext, stream, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Model, SimpleStreamOptions, Tool, ToolResultMessage } from "../src/types.ts";
import { openAICompletionsModel } from "./model-fixtures.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	chunks: undefined as
		| Array<null | {
				id?: string;
				choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null; usage?: unknown }>;
				usage?: {
					prompt_tokens: number;
					completion_tokens: number;
					prompt_tokens_details: { cached_tokens: number; cache_write_tokens?: number };
					completion_tokens_details: { reasoning_tokens: number };
				};
		  }>
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							const chunks = mockState.chunks ?? [
								{
									choices: [{ delta: {}, finish_reason: "stop" }],
									usage: {
										prompt_tokens: 1,
										completion_tokens: 1,
										prompt_tokens_details: { cached_tokens: 0 },
										completion_tokens_details: { reasoning_tokens: 0 },
									},
								},
							];
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

const localOpenAICompletionsModel = {
	api: "openai-completions",
	provider: "local-vllm",
	baseUrl: "http://localhost:8000/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
} satisfies Omit<Model<"openai-completions">, "id" | "name" | "compat">;

/**
 * Endpoint compatibility fixtures. Each mirrors a `models.json` configuration: the host drives
 * URL auto-detection, `compat` carries what only a vendor catalog used to know.
 */
const zaiStyleModel = openAICompletionsModel("glm-5.2", {
	baseUrl: "https://api.z.ai/api/paas/v4",
	compat: { zaiToolStream: true, supportsReasoningEffort: true },
	thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
});
const deepSeekStyleModel = openAICompletionsModel("deepseek-v4-pro", {
	baseUrl: "https://api.deepseek.com",
});
const openRouterStyleModel = (id: string): Model<"openai-completions"> =>
	openAICompletionsModel(id, { baseUrl: "https://openrouter.ai/api/v1" });
const antLingRingModel = openAICompletionsModel("Ring-2.6-1T", {
	baseUrl: "https://api.ant-ling.com/v1",
	compat: { supportsStrictMode: true },
	thinkingLevelMap: { high: "high", max: "max" },
});

type CapturedParams = {
	chat_template_kwargs?: Record<string, unknown>;
	thinking?: unknown;
	reasoning_effort?: string;
};

async function captureSimpleParams(
	model: Model<"openai-completions">,
	reasoning?: SimpleStreamOptions["reasoning"],
): Promise<CapturedParams> {
	let payload: unknown;

	await streamSimple(
		model,
		{
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		},
		{
			apiKey: "test",
			reasoning,
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();

	return (payload ?? mockState.lastParams) as CapturedParams;
}

describe("openai-completions tool_choice", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = undefined;
	});

	it("forwards toolChoice from simple options to payload", async () => {
		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				toolChoice: "required",
				onPayload: (params: unknown) => {
					payload = params;
				},
			} as unknown as Parameters<typeof streamSimple>[2],
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_choice?: string; tools?: unknown[] };
		expect(params.tool_choice).toBe("required");
		expect(Array.isArray(params.tools)).toBe(true);
		expect(params.tools?.length ?? 0).toBeGreaterThan(0);
	});

	it("includes toolChoice when no tools are provided", async () => {
		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Summarize the conversation", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				toolChoice: "none",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_choice?: string; tools?: unknown[] };
		expect(params.tool_choice).toBe("none");
		expect(params).not.toHaveProperty("tools");
	});

	it("omits strict when compat disables strict mode", async () => {
		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false, compat: { supportsStrictMode: false } });
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			} as unknown as Parameters<typeof streamSimple>[2],
		).result();

		const params = (payload ?? mockState.lastParams) as { tools?: Array<{ function?: Record<string, unknown> }> };
		const tool = params.tools?.[0]?.function;
		expect(tool).toBeTruthy();
		expect(tool?.strict).toBeUndefined();
		expect("strict" in (tool ?? {})).toBe(false);
	});

	it("defaults unknown OpenAI-compatible endpoints to non-strict tools", async () => {
		// Regression test for #9816.
		const model = {
			...localOpenAICompletionsModel,
			id: "local-model",
			name: "Local Model",
		} satisfies Model<"openai-completions">;
		const tool: Tool = {
			name: "ping",
			description: "Ping tool",
			parameters: Type.Object({
				required: Type.String(),
				optional: Type.Optional(Type.String()),
			}),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		};
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Call ping", timestamp: Date.now() }],
				tools: [tool],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			tools?: Array<{ function?: { strict?: boolean; parameters?: { required?: string[] } } }>;
		};
		const functionTool = params.tools?.[0]?.function;
		expect(functionTool).not.toHaveProperty("strict");
		expect(functionTool?.parameters?.required).toEqual(["required"]);
	});

	it("preserves strict tools for endpoints declaring strict tool support", async () => {
		const model = openAICompletionsModel("gpt-oss-20b", { compat: { supportsStrictMode: true } });
		const tool: Tool = {
			name: "ping",
			description: "Ping tool",
			parameters: Type.Object({
				required: Type.String(),
				optional: Type.Optional(Type.String()),
			}),
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		};
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Call ping", timestamp: Date.now() }],
				tools: [tool],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			tools?: Array<{ function?: { strict?: boolean; parameters?: { required?: string[] } } }>;
		};
		const functionTool = params.tools?.[0]?.function;
		expect(functionTool?.strict).toBe(true);
		expect(functionTool?.parameters?.required).toEqual(["required", "optional"]);
	});

	it("maps thinking level map entries onto reasoning_effort", async () => {
		const model = openAICompletionsModel("qwen3.6-27b", { thinkingLevelMap: { medium: "default" } });
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				reasoning: "medium",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { reasoning_effort?: string };
		expect(params.reasoning_effort).toBe("default");
	});

	it("keeps the requested reasoning_effort without a thinking level map", async () => {
		const model = openAICompletionsModel("gpt-oss-20b");
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				reasoning: "medium",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { reasoning_effort?: string };
		expect(params.reasoning_effort).toBe("medium");
	});

	it("enables tool_stream for endpoints declaring zaiToolStream with tools", async () => {
		const model = zaiStyleModel;
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBe(true);
	});

	it("maps clamped thinking levels through the thinking level map", async () => {
		const model = zaiStyleModel;
		const cases = [
			{ reasoning: "low", effort: "high" },
			{ reasoning: "medium", effort: "high" },
			{ reasoning: "high", effort: "high" },
			{ reasoning: "max", effort: "max" },
		] as const;

		for (const testCase of cases) {
			let payload: unknown;

			await streamSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: "Hi",
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: "test",
					reasoning: testCase.reasoning,
					onPayload: (params: unknown) => {
						payload = params;
					},
				},
			).result();

			const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
			expect(params.thinking).toEqual({ type: "enabled", clear_thinking: false });
			expect(params.reasoning_effort).toBe(testCase.effort);
		}
	});

	it("preserves thinking when replaying reasoning_content", async () => {
		const model = zaiStyleModel;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "compatible",
			model: "glm-5.2",
			content: [
				{ type: "thinking", thinking: "prior reasoning", thinkingSignature: "reasoning_content" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: Date.now(),
		};
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "Read README.md", timestamp: Date.now() },
					assistantMessage,
					toolResult,
					{ role: "user", content: "Continue", timestamp: Date.now() },
				],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			messages?: Array<Record<string, unknown>>;
			thinking?: unknown;
		};
		const replayedAssistant = params.messages?.find((message) => message.role === "assistant");
		expect(replayedAssistant).toMatchObject({ reasoning_content: "prior reasoning" });
		expect(params.thinking).toEqual({ type: "enabled", clear_thinking: false });
	});

	it("omits reasoning_effort when thinking is off", async () => {
		const model = zaiStyleModel;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("respects explicit tool_stream compat override", async () => {
		const model = openAICompletionsModel("glm-5.2", {
			baseUrl: "https://api.z.ai/api/paas/v4",
			compat: { zaiToolStream: true },
		});
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Call ping with ok=true",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBe(true);
	});

	it("omits tool_stream when no tools are provided", async () => {
		const model = zaiStyleModel;
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { tool_stream?: boolean };
		expect(params.tool_stream).toBeUndefined();
	});

	it("maps non-standard provider finish_reason values to stopReason error", async () => {
		mockState.chunks = [
			{
				choices: [{ delta: { content: "partial" }, finish_reason: null }],
			},
			{
				choices: [{ delta: {}, finish_reason: "network_error" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const model = openAICompletionsModel("glm-5.2");
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("Provider finish_reason: network_error");
	});

	it("ignores null stream chunks from openai-compatible providers", async () => {
		mockState.chunks = [
			null,
			{
				id: "chatcmpl-test",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-test",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 3,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with exactly OK",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("stop");
		expect(response.errorMessage).toBeUndefined();
		expect(response.responseId).toBe("chatcmpl-test");
		expect(response.usage.totalTokens).toBe(4);
		expect(response.content).toEqual([{ type: "text", text: "OK" }]);
	});

	it("errors when a stream ends after only null finish_reason chunks", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-truncated",
				choices: [{ delta: { content: "partial answer" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-truncated",
				choices: [{ delta: { content: "partial answer" }, finish_reason: null }],
			},
		];

		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with a longer sentence",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("Stream ended without finish_reason");
	});

	it("accepts streams without finish_reason when compat disables it", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-no-finish-reason",
				choices: [{ delta: { content: "complete answer" }, finish_reason: null }],
			},
		];

		const model = openAICompletionsModel("gpt-4o-mini", {
			reasoning: false,
			compat: { supportsFinishReason: false },
		});
		const response = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Reply with a complete answer", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("stop");
		expect(response.errorMessage).toBeUndefined();
		expect(response.content).toEqual([{ type: "text", text: "complete answer" }]);
	});

	it("ignores empty custom objects on function tool call deltas", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-empty-custom",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: '{"path":"README.md"}' },
									custom: {},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		];

		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		const tool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
		};
		const response = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Read README.md", timestamp: Date.now() }],
				tools: [tool],
			},
			{ apiKey: "test" },
		).result();

		expect(response.content).toEqual([
			{
				type: "toolCall",
				id: "call_1",
				name: "read",
				arguments: { path: "README.md" },
			},
		]);
	});

	it("coalesces tool call deltas by stable index when provider mutates ids mid-stream", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-kimi-bad-stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "functions.read:0",
									type: "function",
									function: { name: "read", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-kimi-bad-stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "chatcmpl-tool-a",
									type: "function",
									function: { name: null, arguments: '{"path":"README' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-kimi-bad-stream",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "chatcmpl-tool-b",
									type: "function",
									function: { name: null, arguments: '.md"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		const tool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({
				path: Type.String(),
			}),
		};
		const s = streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Read README.md",
						timestamp: Date.now(),
					},
				],
				tools: [tool],
			},
			{ apiKey: "test" },
		);

		const toolCallContentIndexes: number[] = [];
		for await (const event of s) {
			if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
				toolCallContentIndexes.push(event.contentIndex);
			}
		}

		const response = await s.result();
		expect(response.stopReason).toBe("toolUse");
		expect(toolCallContentIndexes).toEqual([0, 0, 0, 0, 0]);
		expect(response.content).toHaveLength(1);
		const toolCall = response.content[0];
		expect(toolCall.type).toBe("toolCall");
		if (toolCall.type !== "toolCall") {
			throw new Error("Expected toolCall content");
		}
		expect(toolCall.id).toBe("functions.read:0");
		expect(toolCall.name).toBe("read");
		expect(toolCall.arguments).toEqual({ path: "README.md" });
		expect(toolCall).not.toHaveProperty("streamIndex");
		expect(toolCall).not.toHaveProperty("partialArgs");
	});

	it("accumulates mixed content, reasoning, and parallel tool call deltas independently", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-mixed-deltas",
				choices: [
					{
						delta: {
							content: "answer 1",
							reasoning_content: "think 1",
							tool_calls: [
								{
									index: 0,
									id: "tc_read_initial",
									type: "function",
									function: { name: "read", arguments: '{"path":"README' },
								},
								{
									index: 1,
									id: "tc_grep_initial",
									type: "function",
									function: { name: "grep", arguments: '{"pattern":"TODO' },
								},
								{
									id: "tc_list_no_index",
									type: "function",
									function: { name: "list", arguments: '{"path":"packages' },
								},
								{
									id: "tc_write_no_index",
									type: "function",
									function: { name: "write", arguments: '{"path":"out' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-mixed-deltas",
				choices: [
					{
						delta: {
							content: " answer 2",
							tool_calls: [
								{
									index: 1,
									id: "tc_grep_changed",
									type: "function",
									function: { arguments: '","path":"src' },
								},
								{
									id: "tc_write_no_index",
									type: "function",
									function: { arguments: '.txt","content":"ok"}' },
								},
								{
									id: "tc_list_no_index",
									type: "function",
									function: { arguments: '/ai"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-mixed-deltas",
				choices: [
					{
						delta: {
							content: "\n",
							reasoning_content: " think 2",
							tool_calls: [
								{
									index: 0,
									id: "tc_read_changed",
									type: "function",
									function: { arguments: '.md"}' },
								},
								{
									index: 1,
									type: "function",
									function: { arguments: '"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 8,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 2 },
				},
			},
		];

		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		const tools: Tool[] = [
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({ path: Type.String() }),
			},
			{
				name: "grep",
				description: "Search a file",
				parameters: Type.Object({ pattern: Type.String(), path: Type.String() }),
			},
			{
				name: "list",
				description: "List a directory",
				parameters: Type.Object({ path: Type.String() }),
			},
			{
				name: "write",
				description: "Write a file",
				parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			},
		];
		const s = streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Think, answer, and use tools.",
						timestamp: Date.now(),
					},
				],
				tools,
			},
			{ apiKey: "test" },
		);

		const eventTypes: string[] = [];
		const toolEventsByContentIndex = new Map<number, string[]>();
		for await (const event of s) {
			eventTypes.push(event.type);
			if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
				const events = toolEventsByContentIndex.get(event.contentIndex) ?? [];
				events.push(event.type);
				toolEventsByContentIndex.set(event.contentIndex, events);
			}
		}

		const response = await s.result();
		expect(response.stopReason).toBe("toolUse");
		expect(eventTypes.filter((type) => type === "text_start")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "text_delta")).toHaveLength(3);
		expect(eventTypes.filter((type) => type === "text_end")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "thinking_start")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "thinking_delta")).toHaveLength(2);
		expect(eventTypes.filter((type) => type === "thinking_end")).toHaveLength(1);
		expect(eventTypes.filter((type) => type === "toolcall_start")).toHaveLength(4);
		expect(eventTypes.filter((type) => type === "toolcall_delta")).toHaveLength(9);
		expect(eventTypes.filter((type) => type === "toolcall_end")).toHaveLength(4);
		expect(toolEventsByContentIndex.get(2)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(toolEventsByContentIndex.get(3)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(toolEventsByContentIndex.get(4)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(toolEventsByContentIndex.get(5)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);

		expect(response.content).toHaveLength(6);
		expect(response.content[0]).toEqual({ type: "text", text: "answer 1 answer 2\n" });
		expect(response.content[1]).toEqual({
			type: "thinking",
			thinking: "think 1 think 2",
			thinkingSignature: "reasoning_content",
		});
		const readCall = response.content[2];
		const grepCall = response.content[3];
		const listCall = response.content[4];
		const writeCall = response.content[5];
		expect(readCall.type).toBe("toolCall");
		expect(grepCall.type).toBe("toolCall");
		expect(listCall.type).toBe("toolCall");
		expect(writeCall.type).toBe("toolCall");
		if (
			readCall.type !== "toolCall" ||
			grepCall.type !== "toolCall" ||
			listCall.type !== "toolCall" ||
			writeCall.type !== "toolCall"
		) {
			throw new Error("Expected toolCall content");
		}
		expect(readCall.id).toBe("tc_read_initial");
		expect(readCall.name).toBe("read");
		expect(readCall.arguments).toEqual({ path: "README.md" });
		expect(readCall).not.toHaveProperty("streamIndex");
		expect(readCall).not.toHaveProperty("partialArgs");
		expect(grepCall.id).toBe("tc_grep_initial");
		expect(grepCall.name).toBe("grep");
		expect(grepCall.arguments).toEqual({ pattern: "TODO", path: "src" });
		expect(grepCall).not.toHaveProperty("streamIndex");
		expect(grepCall).not.toHaveProperty("partialArgs");
		expect(listCall.id).toBe("tc_list_no_index");
		expect(listCall.name).toBe("list");
		expect(listCall.arguments).toEqual({ path: "packages/ai" });
		expect(listCall).not.toHaveProperty("streamIndex");
		expect(listCall).not.toHaveProperty("partialArgs");
		expect(writeCall.id).toBe("tc_write_no_index");
		expect(writeCall.name).toBe("write");
		expect(writeCall.arguments).toEqual({ path: "out.txt", content: "ok" });
		expect(writeCall).not.toHaveProperty("streamIndex");
		expect(writeCall).not.toHaveProperty("partialArgs");
	});

	it("uses system messages for non-OpenAI/Anthropic OpenRouter-style reasoning models", async () => {
		const model = openRouterStyleModel("deepseek/deepseek-v4-pro");
		let payload: unknown;

		await streamSimple(
			model,
			{
				systemPrompt: "Follow instructions.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = payload as { messages?: Array<{ role?: string }> };
		expect(params.messages?.[0]?.role).toBe("system");
	});

	it("keeps developer messages for OpenAI and Anthropic OpenRouter-style instructions", async () => {
		for (const model of [
			openRouterStyleModel("openai/gpt-5.2-codex"),
			openRouterStyleModel("anthropic/claude-fable-5.1:batch"),
		]) {
			let payload: unknown;

			await streamSimple(
				model,
				{
					systemPrompt: "Follow instructions.",
					messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test",
					onPayload: (params: unknown) => {
						payload = params;
					},
				},
			).result();

			const params = payload as { messages?: Array<{ role?: string }> };
			expect(params.messages?.[0]?.role).toBe("developer");
		}
	});

	it("keeps developer messages for OpenAI reasoning model instructions", async () => {
		const model = openAICompletionsModel("gpt-5.5");
		let payload: unknown;

		await streamSimple(
			model,
			{
				systemPrompt: "Follow instructions.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = payload as { messages?: Array<{ role?: string }> };
		expect(params.messages?.[0]?.role).toBe("developer");
	});

	it("replays assistant tool calls with empty reasoning_content when thinking is missing", async () => {
		const model = openAICompletionsModel("mimo-v2.5-pro", {
			compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
		});
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "compatible",
			model: "mimo-v2.5-pro",
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: Date.now(),
		};
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "Read README.md", timestamp: Date.now() },
					assistantMessage,
					toolResult,
				],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			messages?: Array<Record<string, unknown>>;
			thinking?: { type?: string };
			reasoning_effort?: string;
		};
		const replayedAssistant = params.messages?.find((message) => message.role === "assistant");
		expect(replayedAssistant).toMatchObject({ role: "assistant", reasoning_content: "" });
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBe("high");
	});

	it("keeps reasoning deltas on the field that carried them", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-reasoning",
				choices: [{ delta: { reasoning: "think" }, finish_reason: "stop" }],
			},
		];

		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		const response = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Use reasoning.", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		expect(response.content).toEqual([
			{
				type: "thinking",
				thinking: "think",
				thinkingSignature: "reasoning",
			},
		]);
	});

	it("replays thinking blocks through the reasoning field named by their signature", () => {
		const model = openAICompletionsModel("kimi-k3", { baseUrl: "https://opencode.ai/zen/v1" });
		const messages = convertMessages(
			model,
			normalizeContext({
				messages: [
					{
						role: "assistant",
						api: "openai-completions",
						provider: "compatible",
						model: "kimi-k3",
						content: [
							{ type: "thinking", thinking: "think", thinkingSignature: "reasoning" },
							{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
						],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				],
			}),
			{
				...model.compat,
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				supportsUsageInStreaming: true,
				supportsFinishReason: true,
				maxTokensField: "max_completion_tokens",
				requiresToolResultName: false,
				requiresAssistantAfterToolResult: false,
				requiresThinkingAsText: false,
				requiresReasoningContentOnAssistantMessages: false,
				thinkingFormat: "openai",
				openRouterRouting: {},
				vercelGatewayRouting: {},
				chatTemplateKwargs: {},
				chatTemplateArgs: {},
				zaiToolStream: false,
				supportsStrictMode: true,
				supportsOpenAIGrammarTools: false,
				sendSessionAffinityHeaders: false,
				sessionAffinityFormat: "openai",
				supportsLongCacheRetention: true,
			},
		);

		expect(messages[0]).toMatchObject({ role: "assistant", reasoning: "think" });
		expect(messages[0]).not.toHaveProperty("reasoning_content");
	});

	it("sends thinking disabled for deepseek-format endpoints when thinking is off", async () => {
		const model = openAICompletionsModel("kimi-k2.6", { compat: { thinkingFormat: "deepseek" } });
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("sends thinking enabled for deepseek-format endpoints when thinking is enabled", async () => {
		const model = openAICompletionsModel("kimi-k2.6", {
			compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
		});
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("omits disabled thinking when the thinking level map marks off as unsupported", async () => {
		const cases = [
			openAICompletionsModel("kimi-k2.7-code", {
				compat: { thinkingFormat: "deepseek" },
				thinkingLevelMap: { off: null },
			}),
		];

		for (const model of cases) {
			let payload: unknown;

			await streamSimple(
				model,
				{
					messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test",
					onPayload: (params: unknown) => {
						payload = params;
					},
				},
			).result();

			const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
			expect(params.thinking).toBeUndefined();
			expect(params.reasoning_effort).toBeUndefined();
		}
	});

	it("keeps disabled thinking when the thinking level map leaves off unmapped", async () => {
		const model = openAICompletionsModel("kimi-k2.6", { compat: { thinkingFormat: "deepseek" } });
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { thinking?: unknown; reasoning_effort?: string };
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("sends max_tokens for endpoints using the max_tokens field", async () => {
		const cases = [
			openAICompletionsModel("kimi-k3", { compat: { maxTokensField: "max_tokens" } }),
			openAICompletionsModel("kimi-k2.6", { compat: { maxTokensField: "max_tokens" } }),
		] as const;

		for (const model of cases) {
			let payload: unknown;

			await streamSimple(
				model,
				{
					messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test",
					maxTokens: 123,
					onPayload: (params: unknown) => {
						payload = params;
					},
				},
			).result();

			const params = (payload ?? mockState.lastParams) as { max_tokens?: number; max_completion_tokens?: number };
			expect(params.max_tokens).toBe(123);
			expect(params.max_completion_tokens).toBeUndefined();
		}
	});

	it("sends max_tokens for DeepSeek-style endpoints", async () => {
		const customModel = {
			...localOpenAICompletionsModel,
			id: "custom-deepseek-model",
			name: "Custom DeepSeek Model",
			provider: "custom-deepseek",
			baseUrl: "https://api.deepseek.com",
		} satisfies Model<"openai-completions">;
		const customUppercaseModel = {
			...customModel,
			id: "custom-uppercase-deepseek-model",
			name: "Custom Uppercase DeepSeek Model",
			baseUrl: "https://API.DeepSeek.COM",
		} satisfies Model<"openai-completions">;
		const cases = [deepSeekStyleModel, customModel, customUppercaseModel] as const;

		for (const model of cases) {
			let payload: unknown;

			await streamSimple(
				model,
				{
					messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test",
					maxTokens: 123,
					onPayload: (params: unknown) => {
						payload = params;
					},
				},
			).result();

			const params = (payload ?? mockState.lastParams) as { max_tokens?: number; max_completion_tokens?: number };
			expect(params.max_tokens).toBe(123);
			expect(params.max_completion_tokens).toBeUndefined();
		}
	});

	it("sends max_tokens for Z.AI-style endpoints", async () => {
		const cases = [
			openAICompletionsModel("glm-5-turbo", { baseUrl: "https://api.z.ai/api/paas/v4" }),
			zaiStyleModel,
		] as const;

		for (const model of cases) {
			let payload: unknown;

			await streamSimple(
				model,
				{
					messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test",
					maxTokens: 123,
					onPayload: (params: unknown) => {
						payload = params;
					},
				},
			).result();

			const params = (payload ?? mockState.lastParams) as { max_tokens?: number; max_completion_tokens?: number };
			expect(params.max_tokens).toBe(123);
			expect(params.max_completion_tokens).toBeUndefined();
		}
	});

	it("omits reasoning effort for endpoints without reasoning effort support", async () => {
		const model = openAICompletionsModel("grok-build-0.1", { compat: { supportsReasoningEffort: false } });
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as { reasoning_effort?: string };
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("does not double-count reasoning tokens in completion usage", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-reasoning-usage",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 33,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 21 },
				},
			},
		];

		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Use reasoning.",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.usage.input).toBe(10);
		expect(response.usage.output).toBe(33);
		expect(response.usage.totalTokens).toBe(43);
	});

	it("preserves prompt_tokens_details cache read/write fields from chunk usage", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-cache-write",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-cache-write",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with exactly OK",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		// cached_tokens is documented as cache reads; cache_write_tokens is separate.
		expect(response.usage.input).toBe(20);
		expect(response.usage.cacheRead).toBe(50);
		expect(response.usage.cacheWrite).toBe(30);
		expect(response.usage.totalTokens).toBe(105);
	});

	it("preserves prompt_tokens_details cache read/write fields from choice usage fallback", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-cache-write-choice",
				choices: [{ delta: { content: "OK" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-cache-write-choice",
				choices: [
					{
						delta: {},
						finish_reason: "stop",
						usage: {
							prompt_tokens: 100,
							completion_tokens: 5,
							prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
							completion_tokens_details: { reasoning_tokens: 0 },
						},
					},
				],
			},
		];

		const model = openAICompletionsModel("gpt-4o-mini", { reasoning: false });
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with exactly OK",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		// cached_tokens is documented as cache reads; cache_write_tokens is separate.
		expect(response.usage.input).toBe(20);
		expect(response.usage.cacheRead).toBe(50);
		expect(response.usage.cacheWrite).toBe(30);
		expect(response.usage.totalTokens).toBe(105);
	});

	it("uses the OpenRouter reasoning object instead of reasoning_effort", async () => {
		const model = openRouterStyleModel("deepseek/deepseek-r1");
		let payload: unknown;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Hi",
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			reasoning?: { effort?: string };
			reasoning_effort?: string;
		};
		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("uses configurable chat template boolean thinking kwargs", async () => {
		const model = {
			...localOpenAICompletionsModel,
			id: "deepseek-ai/DeepSeek-V3.1",
			name: "DeepSeek V3.1 via vLLM",
			compat: {
				thinkingFormat: "chat-template",
				supportsReasoningEffort: false,
				chatTemplateKwargs: { thinking: { $var: "thinking.enabled" } },
			},
		} satisfies Model<"openai-completions">;

		for (const testCase of [
			{ reasoning: "high" as const, expected: true },
			{ reasoning: undefined, expected: false },
		]) {
			const params = await captureSimpleParams(model, testCase.reasoning);

			expect(params.chat_template_kwargs).toEqual({ thinking: testCase.expected });
			expect(params.thinking).toBeUndefined();
			expect(params.reasoning_effort).toBeUndefined();
		}
	});

	it("uses qwen chat template thinking kwargs", async () => {
		const model = {
			...localOpenAICompletionsModel,
			id: "Qwen/Qwen3-Coder",
			name: "Qwen3 Coder via vLLM",
			compat: {
				thinkingFormat: "qwen-chat-template",
				supportsReasoningEffort: false,
			},
		} satisfies Model<"openai-completions">;

		for (const testCase of [
			{ reasoning: "high" as const, expected: true },
			{ reasoning: undefined, expected: false },
		]) {
			const params = await captureSimpleParams(model, testCase.reasoning);

			expect(params.chat_template_kwargs).toEqual({
				enable_thinking: testCase.expected,
				preserve_thinking: true,
			});
			expect(params.reasoning_effort).toBeUndefined();
		}
	});

	it("uses configurable chat template effort kwargs with static kwargs", async () => {
		const model = {
			...localOpenAICompletionsModel,
			id: "unsloth/gpt-oss-120b-GGUF",
			name: "GPT OSS via vLLM",
			thinkingLevelMap: { xhigh: "max" },
			compat: {
				thinkingFormat: "chat-template",
				supportsReasoningEffort: false,
				chatTemplateKwargs: {
					preserve_thinking: true,
					reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
				},
			},
		} satisfies Model<"openai-completions">;

		const params = await captureSimpleParams(model, "xhigh");

		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true, reasoning_effort: "max" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("uses Ant Ling compatibility metadata", async () => {
		const model = antLingRingModel;
		let payload: unknown;

		await streamSimple(
			model,
			{
				systemPrompt: "Follow instructions.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				maxTokens: 123,
				reasoning: "high",
				cacheRetention: "long",
				sessionId: "ant-ling-session",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		const params = (payload ?? mockState.lastParams) as {
			max_tokens?: number;
			max_completion_tokens?: number;
			messages?: Array<{ role?: string }>;
			reasoning?: { effort?: string };
			reasoning_effort?: string;
			store?: boolean;
			prompt_cache_key?: string;
			prompt_cache_retention?: string;
		};
		expect(params.max_tokens).toBe(123);
		expect(params.max_completion_tokens).toBeUndefined();
		expect(params.messages?.[0]?.role).toBe("system");
		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.store).toBeUndefined();
		expect(params.prompt_cache_key).toBeUndefined();
		expect(params.prompt_cache_retention).toBeUndefined();
	});

	it("omits Ant Ling reasoning for unmapped direct reasoning efforts and non-reasoning models", async () => {
		const ring = antLingRingModel;
		let payload: unknown;

		await stream(
			ring,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoningEffort: "medium",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		expect((payload ?? mockState.lastParams) as { reasoning?: unknown }).not.toHaveProperty("reasoning");

		const ling = openAICompletionsModel("Ling-2.6-flash", {
			baseUrl: "https://api.ant-ling.com/v1",
			reasoning: false,
		});
		await streamSimple(
			ling,
			{
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test",
				reasoning: "high",
				onPayload: (params: unknown) => {
					payload = params;
				},
			},
		).result();

		expect((payload ?? mockState.lastParams) as { reasoning?: unknown }).not.toHaveProperty("reasoning");
	});
});
