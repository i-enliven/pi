import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleOptions } from "../src/api/google-generative-ai.ts";
import { prepareRequest, stream } from "../src/api/google-generative-ai.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Model, TranscriptContext } from "../src/types.ts";

interface FunctionDeclaration {
	name?: string;
	parametersJsonSchema?: Record<string, unknown>;
}

interface GooglePayload {
	model: string;
	contents: unknown[];
	config?: {
		systemInstruction?: string;
		temperature?: number;
		maxOutputTokens?: number;
		thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: string };
		toolConfig?: { functionCallingConfig?: { mode?: string } };
		tools?: Array<{ functionDeclarations?: FunctionDeclaration[] }>;
	};
}

function payloadOf(payload: unknown): GooglePayload {
	return payload as unknown as GooglePayload;
}

function toolContext() {
	return normalizeContext({
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
		tools: [
			{
				name: "lookup",
				description: "Lookup",
				parameters: Type.Object({ query: Type.String() }),
				constrainedSampling: { type: "json_schema", strict: "prefer" },
			},
		],
	});
}

function midConversationTranscript() {
	return normalizeContext({
		systemPrompt: "base prompt",
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "system", content: "later instruction", timestamp: 2 },
		],
	});
}

const gemini25 = getModel("google", "gemini-2.5-flash") as Model<"google-generative-ai">;
const gemini3 = getModel("google", "gemini-3-flash-preview") as Model<"google-generative-ai">;

describe("google-generative-ai prepareRequest", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	it("strictens tool schemas only on models that validate them", () => {
		const strict = payloadOf(prepareRequest(gemini3, toolContext(), {}));
		const lenient = payloadOf(prepareRequest(gemini25, toolContext(), {}));

		expect(strict.config?.tools?.[0]?.functionDeclarations?.[0]).toEqual(expect.objectContaining({ name: "lookup" }));
		expect(strict.config?.tools?.[0]?.functionDeclarations?.[0]?.parametersJsonSchema).toEqual(
			expect.objectContaining({ additionalProperties: false }),
		);
		expect(strict.config?.toolConfig?.functionCallingConfig?.mode).toBe("VALIDATED");

		expect(lenient.config?.tools?.[0]?.functionDeclarations?.[0]?.parametersJsonSchema).not.toHaveProperty(
			"additionalProperties",
		);
		expect(lenient.config?.toolConfig).toBeUndefined();
	});

	it("maps thinking options per model capability", () => {
		const budgeted = payloadOf(
			prepareRequest(gemini25, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }), {
				thinking: { enabled: true, budgetTokens: 1024 },
			}),
		);
		const disabledOnBudgetModel = payloadOf(
			prepareRequest(gemini25, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }), {
				thinking: { enabled: false },
			}),
		);
		const disabledOnLevelModel = payloadOf(
			prepareRequest(gemini3, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }), {
				thinking: { enabled: false },
			}),
		);

		expect(budgeted.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1024 });
		expect(disabledOnBudgetModel.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
		expect(disabledOnLevelModel.config?.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
	});

	it("forwards sampling options and tool choice", () => {
		const payload = payloadOf(
			prepareRequest(
				gemini25,
				normalizeContext({
					messages: [{ role: "user", content: "hi", timestamp: 1 }],
					tools: [{ name: "lookup", description: "Lookup", parameters: Type.Object({ query: Type.String() }) }],
				}),
				{ temperature: 0.7, maxTokens: 512, toolChoice: "any" } satisfies GoogleOptions,
			),
		);

		expect(payload.model).toBe("gemini-2.5-flash");
		expect(payload.config?.temperature).toBe(0.7);
		expect(payload.config?.maxOutputTokens).toBe(512);
		expect(payload.config?.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
	});

	it("collapses mid-conversation system messages into the system instruction", () => {
		const payload = payloadOf(prepareRequest(gemini25, midConversationTranscript(), {}));

		expect(payload.config?.systemInstruction).toBe("base prompt\n\nlater instruction");
	});

	it("threads the abort signal into the config only when one is given", () => {
		const controller = new AbortController();
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

		expect(prepareRequest(gemini25, context, { signal: controller.signal }).config?.abortSignal).toBe(
			controller.signal,
		);
		expect(prepareRequest(gemini25, context, {}).config).not.toHaveProperty("abortSignal");
	});

	it("keeps transcript normalisation failures synchronous out of stream()", () => {
		const malformed = {
			messages: [{ role: "system", content: undefined, timestamp: 0 }],
		} as unknown as TranscriptContext;

		expect(() => stream(gemini25, malformed, { apiKey: "test-key" })).toThrow();
	});

	it("hands onPayload exactly the object prepareRequest returns", async () => {
		const context = normalizeContext({
			systemPrompt: "base prompt",
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				// Normalisation has to matter here: this is what the two paths must agree on.
				{ role: "system", content: "later instruction", timestamp: 2 },
			],
		});
		const options = {
			apiKey: "test-key",
			temperature: 0.5,
			maxTokens: 512,
			toolChoice: "any" as const,
			maxRetries: 0,
		};

		let captured: unknown;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		await stream(gemini25, context, {
			...options,
			onPayload: (payload) => {
				captured = payload;
			},
		}).result();

		expect(captured).toEqual(prepareRequest(gemini25, context, options));
	});
});
