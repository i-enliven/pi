import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { prepareRequest, stream } from "../src/api/google-vertex.ts";
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

function userContext() {
	return normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
}

const gemini25 = getModel("google-vertex", "gemini-2.5-flash") as Model<"google-vertex">;
const gemini3 = getModel("google-vertex", "gemini-3-flash-preview") as Model<"google-vertex">;

describe("google-vertex prepareRequest", () => {
	it("strictens tool schemas only on models that validate them", () => {
		const context = normalizeContext({
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

		const strict = payloadOf(prepareRequest(gemini3, context, {}));
		const lenient = payloadOf(prepareRequest(gemini25, context, {}));

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
		expect(
			payloadOf(prepareRequest(gemini25, userContext(), { thinking: { enabled: true, budgetTokens: 2048 } })).config
				?.thinkingConfig,
		).toEqual({ includeThoughts: true, thinkingBudget: 2048 });
		expect(
			payloadOf(prepareRequest(gemini25, userContext(), { thinking: { enabled: false } })).config?.thinkingConfig,
		).toEqual({ thinkingBudget: 0 });
		expect(
			payloadOf(prepareRequest(gemini3, userContext(), { thinking: { enabled: false } })).config?.thinkingConfig,
		).toEqual({ thinkingLevel: "MINIMAL" });
	});

	it("keeps client-only options out of the payload", () => {
		const context = normalizeContext({
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [{ name: "lookup", description: "Lookup", parameters: Type.Object({ query: Type.String() }) }],
		});
		const payload = payloadOf(
			prepareRequest(gemini25, context, {
				temperature: 0.2,
				maxTokens: 256,
				toolChoice: "none",
				project: "my-project",
				location: "us-central1",
				apiKey: "vertex-api-key",
			}),
		);

		expect(payload.model).toBe("gemini-2.5-flash");
		expect(payload.config?.temperature).toBe(0.2);
		expect(payload.config?.maxOutputTokens).toBe(256);
		expect(payload.config?.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
	});

	it("threads the abort signal into the config only when one is given", () => {
		const controller = new AbortController();

		expect(prepareRequest(gemini25, userContext(), { signal: controller.signal }).config?.abortSignal).toBe(
			controller.signal,
		);
		expect(prepareRequest(gemini25, userContext(), {}).config).not.toHaveProperty("abortSignal");
	});

	it("keeps transcript normalisation failures synchronous out of stream()", () => {
		const malformed = {
			messages: [{ role: "system", content: undefined, timestamp: 0 }],
		} as unknown as TranscriptContext;

		expect(() => stream(gemini25, malformed, { apiKey: "test-key" })).toThrow();
	});

	it("collapses mid-conversation system messages into the system instruction", () => {
		const context = normalizeContext({
			systemPrompt: "base prompt",
			messages: [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "system", content: "later instruction", timestamp: 2 },
			],
		});

		expect(payloadOf(prepareRequest(gemini25, context, {})).config?.systemInstruction).toBe(
			"base prompt\n\nlater instruction",
		);
	});
});
