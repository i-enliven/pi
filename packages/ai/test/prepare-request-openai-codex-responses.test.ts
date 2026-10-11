import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { prepareRequest, type RequestBody } from "../src/api/openai-codex-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, JsonObject, Message, Model, Tool, TranscriptContext, Usage } from "../src/types.ts";

/** Input item view, narrowed to the fields under test. */
interface CodexInputItem {
	type?: string;
	role?: string;
	content?: unknown;
	id?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
	output?: unknown;
}

interface CodexToolPayload {
	type?: string;
	name?: string;
	strict?: boolean | null;
	format?: { type?: string; syntax?: string; definition?: string };
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function codexModel(overrides: Partial<Model<"openai-codex-responses">> = {}): Model<"openai-codex-responses"> {
	return {
		id: "codex-test-model",
		name: "Codex Test Model",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
		...overrides,
	};
}

function prepare(
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options?: Parameters<typeof prepareRequest>[2],
): RequestBody {
	return prepareRequest(model, context, options);
}

/** Input items narrowed to the shape under test. */
function inputItems(body: RequestBody): CodexInputItem[] {
	return (body.input ?? []) as CodexInputItem[];
}

/** Tool declarations narrowed to the shape under test. */
function toolItems(body: RequestBody): CodexToolPayload[] {
	return (body.tools ?? []) as CodexToolPayload[];
}

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 1000 };
}

function assistantToolCall(toolCallId: string, name: string, args: JsonObject): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "codex-test-model",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp: 2000,
	};
}

function toolResult(toolCallId: string, toolName: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3000,
	};
}

const grammarTool: Tool = {
	name: "spell",
	description: "Spell a word",
	parameters: Type.Object({ word: Type.String() }),
	constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[a-z]+/", openai_regex: "[a-z]+" } },
};

const plainTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
};

describe("openai-codex-responses prepareRequest", () => {
	it("builds the Codex envelope and moves the leading system prompt to instructions", () => {
		const payload = prepare(
			codexModel(),
			normalizeContext({ systemPrompt: "Base prompt.", messages: [userMessage("Hello")] }),
		);

		expect(payload).toMatchObject({
			model: "codex-test-model",
			store: false,
			stream: true,
			instructions: "Base prompt.",
			tool_choice: "auto",
			parallel_tool_calls: true,
			text: { verbosity: "low" },
			include: ["reasoning.encrypted_content"],
		});
		expect(payload.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Hello" }] }]);
	});

	it("falls back to the default instructions when the transcript has no system prompt", () => {
		const payload = prepare(codexModel(), normalizeContext({ messages: [userMessage("Hello")] }));

		expect(payload.instructions).toBe("You are a helpful assistant.");
	});

	it("emits grammar tools as custom grammar items only when compat supports OpenAI grammar tools", () => {
		const context = normalizeContext({
			systemPrompt: "Base prompt.",
			messages: [userMessage("Spell it")],
			tools: [grammarTool],
		});

		const grammarCapable = prepare(getModel("openai-codex", "gpt-5.3-codex-spark"), context);
		expect(grammarCapable.tools?.[0]).toMatchObject({
			type: "custom",
			name: "spell",
			format: { type: "grammar", syntax: "lark", definition: "start: /[a-z]+/" },
		});

		const grammarIncapable = prepare(codexModel({ compat: { supportsOpenAIGrammarTools: false } }), context);
		expect(grammarIncapable.tools?.[0]).toMatchObject({ type: "function", name: "spell", strict: null });
		expect(toolItems(grammarIncapable)[0]?.format).toBeUndefined();
	});

	it("omits the strict field when compat disables strict mode", () => {
		const context = normalizeContext({
			systemPrompt: "Base prompt.",
			messages: [userMessage("Read it")],
			tools: [plainTool],
		});

		expect(prepare(codexModel(), context).tools?.[0]).toMatchObject({ type: "function", name: "read", strict: null });

		const noStrict = prepare(codexModel({ compat: { supportsStrictMode: false } }), context).tools?.[0];
		expect(noStrict).toMatchObject({ type: "function", name: "read" });
		expect("strict" in (noStrict ?? {})).toBe(false);
	});

	it("maps reasoning effort through the model thinking level map", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const context = normalizeContext({ messages: [userMessage("Hello")] });

		expect(prepare(model, context, { reasoningEffort: "minimal" }).reasoning).toEqual({
			effort: "low",
			summary: "auto",
		});
		expect(prepare(model, context, { reasoningEffort: "xhigh", reasoningSummary: "detailed" }).reasoning).toEqual({
			effort: "xhigh",
			summary: "detailed",
		});
		expect(prepare(model, context, { reasoningEffort: "none" }).reasoning).toEqual({
			effort: "none",
			summary: "auto",
		});
		// No explicit effort: the model's `off` mapping is used, without a summary field.
		expect(prepare(model, context).reasoning).toEqual({ effort: "none" });
	});

	it("omits reasoning when the model thinking level map disables it", () => {
		const payload = prepare(
			codexModel({ thinkingLevelMap: { off: null } }),
			normalizeContext({ messages: [userMessage("Hello")] }),
		);

		expect("reasoning" in payload).toBe(false);
	});

	it("forwards sampling, tier, verbosity and tool choice options only when set", () => {
		const context = normalizeContext({ messages: [userMessage("Hello")] });

		const defaults = prepare(codexModel(), context);
		expect("temperature" in defaults).toBe(false);
		expect("service_tier" in defaults).toBe(false);
		expect(defaults.tool_choice).toBe("auto");

		const tuned = prepare(codexModel(), context, {
			temperature: 0.25,
			serviceTier: "priority",
			textVerbosity: "high",
			toolChoice: "required",
		});
		expect(tuned.temperature).toBe(0.25);
		expect(tuned.service_tier).toBe("priority");
		expect(tuned.text).toEqual({ verbosity: "high" });
		expect(tuned.tool_choice).toBe("required");
	});

	it("clamps the session id into prompt_cache_key and drops it when cache retention is none", () => {
		const context = normalizeContext({ messages: [userMessage("Hello")] });
		const sessionId = "s".repeat(80);

		expect(prepare(codexModel(), context, { sessionId }).prompt_cache_key).toBe("s".repeat(64));
		expect(prepare(codexModel(), context, { sessionId, cacheRetention: "none" }).prompt_cache_key).toBeUndefined();
	});

	it("collapses mid-conversation system messages unless compat allows them", () => {
		const context = normalizeContext({
			systemPrompt: "Base prompt.",
			messages: [
				userMessage("Hello"),
				{ role: "system", content: "", sections: { env: "Working directory is /tmp" }, timestamp: 1500 },
				userMessage("Continue"),
			],
		});

		const midConvoModel = getModel("openai-codex", "gpt-5.5");
		const replayed = prepare(midConvoModel, context);
		expect(replayed.instructions).toBe("Base prompt.");
		expect(replayed.input).toContainEqual({
			role: "developer",
			content: 'Updated system prompt section "env":\n\nWorking directory is /tmp',
		});

		const collapsed = prepare(codexModel({ compat: { supportsMidConvoSystemMessages: false } }), context);
		expect(collapsed.instructions).toBe("Base prompt.\n\nWorking directory is /tmp");
		expect(inputItems(collapsed).filter((item) => item.role === "developer" || item.role === "system")).toEqual([]);
	});

	it("pairs tool calls with their results and synthesises missing ones", () => {
		const context = normalizeContext({
			messages: [
				userMessage("Read a.txt"),
				assistantToolCall("call_1|fc_item_1", "read", { path: "a.txt" }),
				toolResult("call_1|fc_item_1", "read", "file body"),
				assistantToolCall("call_2|fc_item_2", "read", { path: "b.txt" }),
			],
		});

		const input = inputItems(prepare(codexModel(), context));

		expect(input.map((item) => item.type ?? item.role)).toEqual([
			"user",
			"function_call",
			"function_call_output",
			"function_call",
			"function_call_output",
		]);
		expect(input).toContainEqual({
			type: "function_call",
			id: "fc_item_1",
			call_id: "call_1",
			name: "read",
			arguments: '{"path":"a.txt"}',
		});
		expect(input).toContainEqual({ type: "function_call_output", call_id: "call_1", output: "file body" });
		// The unanswered call gets a synthetic error result so the pair stays valid.
		expect(input).toContainEqual({ type: "function_call_output", call_id: "call_2", output: "No result provided" });
	});

	it("replaces images with a placeholder for text-only models", () => {
		const context = normalizeContext({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", data: "Zm9v", mimeType: "image/png" },
					],
					timestamp: 1000,
				},
			],
		});

		expect(prepare(codexModel(), context).input).toEqual([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "look" },
					{ type: "input_text", text: "(image omitted: model does not support images)" },
				],
			},
		]);

		expect(prepare(codexModel({ input: ["text", "image"] }), context).input).toEqual([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "look" },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,Zm9v" },
				],
			},
		]);
	});
});
