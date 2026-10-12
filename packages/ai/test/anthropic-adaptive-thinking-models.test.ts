import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

const EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS = [
	"github-copilot/claude-fable-5",
	"github-copilot/claude-fable-5.1",
	"github-copilot/claude-haiku-5.5",
	"github-copilot/claude-opus-4.7",
	"github-copilot/claude-opus-4.8",
	"github-copilot/claude-opus-5",
	"github-copilot/claude-opus-5.5",
	"github-copilot/claude-sonnet-4.6",
	"github-copilot/claude-sonnet-5",
	"github-copilot/claude-sonnet-5.5",
];

function getAllModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
}

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks built-in Anthropic Messages models that use adaptive thinking", () => {
		const flaggedModels = getAllModels()
			.filter((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages")
			.filter((model) => model.compat?.forceAdaptiveThinking === true)
			.map((model) => `${model.provider}/${model.id}`)
			.sort();

		expect(flaggedModels).toEqual(EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS.slice().sort());
		// The flag is catalog metadata on Claude model ids only, never inferred from the API.
		expect(flaggedModels).toEqual(
			flaggedModels.filter((modelId) => /(claude-(opus|sonnet|haiku|fable))/.test(modelId)),
		);
	});
});
