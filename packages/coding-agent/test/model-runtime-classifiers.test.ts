import { type ClassifierModel, createProvider, InMemoryModelsStore } from "@i-enliven/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const context = {
	state: { text: "Looks good" },
	questions: {
		approved: {
			type: "bool" as const,
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

const classifierModel: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "jev-latest",
	name: "Jev",
	api: "typesafe-system-one",
	provider: "jev",
	baseUrl: "https://jev.example.invalid/v1/systemone",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64_000,
};

function jevProvider(): ReturnType<typeof createProvider> {
	return createProvider({
		id: "jev",
		auth: {
			apiKey: {
				name: "Jev",
				resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
			},
		},
		models: [classifierModel],
		classifiers: {
			"typesafe-system-one": {
				classify: async (model, _context, options) => ({
					api: model.api,
					provider: model.provider,
					model: model.id,
					answers: { approved: { type: "bool", probability: options?.apiKey === "sk-jev" ? 0.8 : 0.1 } },
					stopReason: "stop",
					timestamp: Date.now(),
				}),
			},
		},
	});
}

describe("ModelRuntime classifiers", () => {
	it("lists classifier models separately and classifies with runtime-resolved auth", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(jevProvider());

		const jev = runtime.getModelOfType("classifier", "jev", "jev-latest")!;
		expect(jev.type).toBe("classifier");
		// The classifier entry does not shadow the chat lookup.
		expect(runtime.getModel("jev", "jev-latest")).toBeUndefined();

		const unconfigured = await runtime.classify(jev, context);
		expect(unconfigured.stopReason).toBe("error");
		expect(unconfigured.errorMessage).toContain("not configured");

		await runtime.setRuntimeApiKey("jev", "sk-jev");
		expect(await runtime.getAvailableOfType("classifier", "jev")).toEqual([jev]);

		const result = await runtime.classify(jev, context);
		// The runtime resolves the provider key and dispatches to the provider's classifier.
		expect(result.stopReason).toBe("stop");
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
	});
});
