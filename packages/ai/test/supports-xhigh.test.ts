import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";
import { openAICompletionsModel } from "./model-fixtures.ts";

describe("getSupportedThinkingLevels", () => {
	it("returns only off for non-reasoning models", () => {
		expect(getSupportedThinkingLevels(openAICompletionsModel("plain", { reasoning: false }))).toEqual(["off"]);
	});

	it("lists xhigh and max only when the thinking level map maps them", () => {
		const withoutExtended = openAICompletionsModel("base", { thinkingLevelMap: { off: "none", high: "high" } });
		expect(getSupportedThinkingLevels(withoutExtended)).toEqual(["off", "minimal", "low", "medium", "high"]);

		const withExtended = openAICompletionsModel("extended", {
			thinkingLevelMap: { off: "none", high: "high", xhigh: "xhigh", max: "max" },
		});
		expect(getSupportedThinkingLevels(withExtended)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("drops levels the thinking level map marks unsupported", () => {
		const model = openAICompletionsModel("no-off", {
			thinkingLevelMap: { off: null, low: "low", high: "high", xhigh: "xhigh", max: null },
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
	});

	it("reads the built-in GitHub Copilot catalog", () => {
		// gpt-5.4 maps off and max to null, xhigh to a value.
		expect(getSupportedThinkingLevels(getModel("github-copilot", "gpt-5.4"))).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);

		// claude-opus-5.5 maps every effort level and rejects thinking off.
		expect(getSupportedThinkingLevels(getModel("github-copilot", "claude-opus-5.5"))).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);

		// claude-sonnet-4.6 maps max but not xhigh.
		const sonnet = getModel("github-copilot", "claude-sonnet-4.6");
		expect(getSupportedThinkingLevels(sonnet)).toContain("max");
		expect(getSupportedThinkingLevels(sonnet)).not.toContain("xhigh");
	});
});
