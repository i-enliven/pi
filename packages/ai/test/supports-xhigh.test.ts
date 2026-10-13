import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

describe("getSupportedThinkingLevels", () => {
	it("includes max but not xhigh for Claude Sonnet 4.6 on the anthropic-messages API", () => {
		const model = getModel("github-copilot", "claude-sonnet-4.6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toContain("max");
		expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
	});

	it("includes xhigh and max for Claude Opus 4.8 on the anthropic-messages API", () => {
		const model = getModel("github-copilot", "claude-opus-4.8");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
	});

	it("includes xhigh and max for Claude Opus 5 on the anthropic-messages API", () => {
		const model = getModel("github-copilot", "claude-opus-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
	});

	it("includes Claude Opus 5.5 with its always-on effort levels and official pricing", () => {
		const model = getModel("github-copilot", "claude-opus-5.5");
		expect(model).toMatchObject({
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: {
				forceAdaptiveThinking: true,
				supportsMidConvoSystemMessages: true,
				supportsTemperature: false,
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("includes Claude Sonnet 5.5 with managed effort levels and official pricing", () => {
		const model = getModel("github-copilot", "claude-sonnet-5.5");
		expect(model).toMatchObject({
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: {
				forceAdaptiveThinking: true,
				supportsMidConvoSystemMessages: true,
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("includes xhigh and max for Claude Sonnet 5 on the anthropic-messages API", () => {
		const model = getModel("github-copilot", "claude-sonnet-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
	});

	it("includes xhigh and max but not off for Claude Fable 5 on the anthropic-messages API", () => {
		const model = getModel("github-copilot", "claude-fable-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
		expect(getSupportedThinkingLevels(model)).not.toContain("off");
	});

	it.each([
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-6-astra",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-6.1-sol",
	] as const)("includes xhigh for GitHub Copilot %s models on the openai-responses API", (modelId) => {
		const model = getModel("github-copilot", modelId);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna"] as const)(
		"excludes thinking off or includes it per model for %s",
		(modelId) => {
			const model = getModel("github-copilot", modelId);
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model)).toContain("max");
			expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		},
	);

	it("does not support off for GPT-6.1 Sol", () => {
		const model = getModel("github-copilot", "gpt-6.1-sol");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(model.thinkingLevelMap?.off).toBeNull();
	});

	it("includes official metadata for GitHub Copilot GPT-6 Sol", () => {
		const model = getModel("github-copilot", "gpt-6-sol");
		expect(model).toMatchObject({
			input: ["text", "image"],
			cost: {
				input: 2,
				output: 10,
				cacheRead: 0.2,
				cacheWrite: 2.5,
				tiers: [
					{
						inputTokensAbove: 272000,
						input: 4,
						output: 15,
						cacheRead: 0.4,
						cacheWrite: 5,
					},
				],
			},
			contextWindow: 1000000,
			maxTokens: 128000,
			compat: {
				supportsAdditionalTools: true,
				supportsMidConvoSystemMessages: true,
				supportsOpenAIGrammarTools: true,
			},
		});
		expect(model.compat).not.toHaveProperty("supportsToolSearch");
	});
});
