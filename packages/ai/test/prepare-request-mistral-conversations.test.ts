import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type MistralChatPayload, prepareRequest, stream } from "../src/api/mistral-conversations.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

type MistralRequestMessage = MistralChatPayload["messages"][number];

const TIMESTAMP = 1700000000000;

/** Catalog models carry no `compat`, so the flag under test is always hand-built. */
function makeModel(overrides: Partial<Model<"mistral-conversations">> = {}): Model<"mistral-conversations"> {
	return {
		id: "mistral-large-latest",
		name: "Mistral Large (latest)",
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://api.mistral.ai",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

function textOf(content: MistralRequestMessage["content"]): string[] {
	if (content === undefined) return [];
	if (typeof content === "string") return [content];
	return content.flatMap((chunk) => (chunk.type === "text" ? [chunk.text] : []));
}

/** Cross-provider assistant message: Mistral rewrites its tool call ids on replay. */
function assistantToolCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "get_time", arguments: { tz: "UTC" } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: TIMESTAMP,
	};
}

function transcriptWithToolCall(id: string, withResult: boolean): Context {
	const messages: Context["messages"] = [
		{ role: "user", content: "What time is it?", timestamp: TIMESTAMP },
		assistantToolCall(id),
	];
	if (withResult) {
		messages.push({
			role: "toolResult",
			toolCallId: id,
			toolName: "get_time",
			content: [{ type: "text", text: "12:00" }],
			isError: false,
			timestamp: TIMESTAMP,
		});
	}
	return { messages };
}

describe("prepareRequest (mistral-conversations)", () => {
	it("assembles the base request from the model and transcript", () => {
		const payload = prepareRequest(
			makeModel(),
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: TIMESTAMP }] }),
		);

		expect(payload.model).toBe("mistral-large-latest");
		expect(payload.stream).toBe(true);
		expect(payload.messages).toEqual([{ role: "user", content: "Hello" }]);
	});

	describe("compat", () => {
		const midConvoTranscript = (): Context => ({
			systemPrompt: "Base prompt.",
			messages: [
				{ role: "user", content: "first", timestamp: TIMESTAMP },
				{ role: "system", content: "Section update.", timestamp: TIMESTAMP },
				{ role: "user", content: "second", timestamp: TIMESTAMP },
			],
		});

		it("keeps later system messages in place when supportsMidConvoSystemMessages is true", () => {
			const payload = prepareRequest(
				makeModel({ compat: { supportsMidConvoSystemMessages: true } }),
				normalizeContext(midConvoTranscript()),
			);

			expect(payload.messages.map((message) => message.role)).toEqual(["system", "user", "system", "user"]);
			expect(textOf(payload.messages[2]?.content)).toEqual(["Section update."]);
		});

		it("folds later system messages into the leading one when the compat flag is unset", () => {
			const payload = prepareRequest(makeModel(), normalizeContext(midConvoTranscript()));

			expect(payload.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
			expect(textOf(payload.messages[0]?.content)).toEqual(["Base prompt.\n\nSection update."]);
		});

		it("folds later system messages for catalog models", () => {
			const payload = prepareRequest(
				getModel("mistral", "mistral-large-latest"),
				normalizeContext(midConvoTranscript()),
			);

			expect(payload.messages.filter((message) => message.role === "system")).toHaveLength(1);
		});
	});

	describe("options", () => {
		const context = () => normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: TIMESTAMP }] });

		it("maps temperature, maxTokens and a forced tool choice", () => {
			const payload = prepareRequest(makeModel(), context(), {
				temperature: 0.42,
				maxTokens: 512,
				toolChoice: { type: "function", function: { name: "get_time" } },
			});

			expect(payload.temperature).toBe(0.42);
			expect(payload.maxTokens).toBe(512);
			expect(payload.toolChoice).toEqual({ type: "function", function: { name: "get_time" } });
		});

		it("omits unset options", () => {
			const payload = prepareRequest(makeModel(), context());

			expect("temperature" in payload).toBe(false);
			expect("maxTokens" in payload).toBe(false);
			expect("toolChoice" in payload).toBe(false);
			expect("promptMode" in payload).toBe(false);
			expect("reasoningEffort" in payload).toBe(false);
			expect("promptCacheKey" in payload).toBe(false);
		});

		it('maps the "any" tool choice and the reasoning controls', () => {
			const payload = prepareRequest(makeModel({ reasoning: true }), context(), {
				toolChoice: "any",
				promptMode: "reasoning",
				reasoningEffort: "high",
			});

			expect(payload.toolChoice).toBe("any");
			expect(payload.promptMode).toBe("reasoning");
			expect(payload.reasoningEffort).toBe("high");
		});

		it("uses the session id as prompt cache key unless cache retention is disabled", () => {
			expect(prepareRequest(makeModel(), context(), { sessionId: "session-123" }).promptCacheKey).toBe(
				"session-123",
			);
			expect(
				prepareRequest(makeModel(), context(), { sessionId: "session-123", cacheRetention: "none" }).promptCacheKey,
			).toBeUndefined();
		});
	});

	describe("tools", () => {
		const getTime = {
			name: "get_time",
			description: "Get the current time",
			parameters: Type.Object({ tz: Type.String() }),
		};

		it("sends the transcript tools with strict sampling disabled by default", () => {
			const payload = prepareRequest(
				makeModel(),
				normalizeContext({
					messages: [{ role: "user", content: "Hello", timestamp: TIMESTAMP }],
					tools: [getTime],
				}),
			);

			const tool = payload.tools?.[0];
			expect(payload.tools).toHaveLength(1);
			expect(tool?.type).toBe("function");
			expect(tool?.function.name).toBe("get_time");
			expect(tool?.function.description).toBe("Get the current time");
			expect(tool?.function.strict).toBe(false);
			expect(tool?.function.parameters.required).toEqual(["tz"]);
			expect(Object.getOwnPropertySymbols(tool?.function.parameters ?? {})).toHaveLength(0);
		});

		it("enables strict sampling for tools that require constrained sampling", () => {
			const payload = prepareRequest(
				makeModel(),
				normalizeContext({
					messages: [{ role: "user", content: "Hello", timestamp: TIMESTAMP }],
					tools: [{ ...getTime, constrainedSampling: { type: "json_schema", strict: "require" } }],
				}),
			);

			expect(payload.tools?.[0]?.function.strict).toBe(true);
		});
	});

	describe("transcript transformation", () => {
		it("normalises replayed tool call ids and rewrites the matching tool result", () => {
			const payload = prepareRequest(
				makeModel(),
				normalizeContext(transcriptWithToolCall("call-with-a-very-long-name-1", true)),
			);

			const assistant = payload.messages.find((message) => message.role === "assistant");
			const toolResult = payload.messages.find((message) => message.role === "tool");
			const callId = assistant?.toolCalls?.[0]?.id;

			expect(callId).toMatch(/^[a-zA-Z0-9]{9}$/);
			expect(toolResult?.toolCallId).toBe(callId);
			expect(toolResult?.name).toBe("get_time");
			expect(textOf(toolResult?.content)).toEqual(["12:00"]);
		});

		it("pairs an orphaned tool call with a synthetic error result", () => {
			const payload = prepareRequest(
				makeModel(),
				normalizeContext(transcriptWithToolCall("call-with-a-very-long-name-2", false)),
			);

			const assistant = payload.messages.find((message) => message.role === "assistant");
			const toolResult = payload.messages.find((message) => message.role === "tool");

			expect(toolResult?.toolCallId).toBe(assistant?.toolCalls?.[0]?.id);
			expect(toolResult?.name).toBe("get_time");
			expect(textOf(toolResult?.content)).toEqual(["[tool error] No result provided"]);
		});

		it("replaces images with a placeholder for text-only models", () => {
			const payload = prepareRequest(
				getModel("mistral", "codestral-2508"),
				normalizeContext({
					messages: [
						{
							role: "user",
							content: [
								{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
								{ type: "text", text: "look" },
							],
							timestamp: TIMESTAMP,
						},
					],
				}),
			);

			expect(textOf(payload.messages[0]?.content)).toEqual([
				"(image omitted: model does not support images)",
				"look",
			]);
		});

		it("sends data URLs for image-capable models", () => {
			const payload = prepareRequest(
				getModel("mistral", "pixtral-large-latest"),
				normalizeContext({
					messages: [
						{
							role: "user",
							content: [
								{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
								{ type: "text", text: "look" },
							],
							timestamp: TIMESTAMP,
						},
					],
				}),
			);

			expect(payload.messages[0]?.content).toEqual([
				{ type: "image_url", imageUrl: "data:image/png;base64,aGVsbG8=" },
				{ type: "text", text: "look" },
			]);
		});
	});

	it("hands onPayload exactly the object prepareRequest returns", async () => {
		// No compat flag: later system messages collapse, so the two paths must agree on that too.
		const model = makeModel();
		const transcript = transcriptWithToolCall("call-with-a-very-long-name-3", true);
		const context = normalizeContext({
			...transcript,
			messages: [
				...transcript.messages,
				// Normalisation has to matter here: this is what the two paths must agree on.
				{ role: "system", content: "Section update.", timestamp: TIMESTAMP },
			],
		});
		const options = { apiKey: "test-key", maxTokens: 512, temperature: 0.3 };

		let captured: unknown;
		await stream(model, context, {
			...options,
			fetch: async () => new Response(null, { status: 500 }),
			onPayload: (payload) => {
				captured = payload;
			},
		}).result();

		// The per-request tool-call id normalizer derives ids from the input id, so both paths agree.
		expect(captured).toEqual(prepareRequest(model, context, options));
	});
});
