import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@i-enliven/pi-agent-core";
import type { Model } from "@i-enliven/pi-ai";
import { getModel, streamSimple } from "@i-enliven/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@i-enliven/pi-ai/providers/all";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	findInitialModel,
	parseModelPattern,
	resolveCliModel,
	resolveModelScope,
	resolveModelScopeWithDiagnostics,
} from "../src/core/model-resolver.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// Mock models for testing
const mockModels: Model<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "alpha",
		baseUrl: "https://alpha.test",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages", // Using same type for simplicity
		provider: "beta",
		baseUrl: "https://beta.test",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

// Mock gateway models with colons and slashes in model ids
const mockGatewayModels: Model<"anthropic-messages">[] = [
	{
		id: "qwen/qwen3-coder:exacto",
		name: "Qwen3 Coder Exacto",
		api: "anthropic-messages",
		provider: "gateway",
		baseUrl: "https://gateway.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "beta/gpt-4o:extended",
		name: "GPT-4o Extended",
		api: "anthropic-messages",
		provider: "gateway",
		baseUrl: "https://gateway.test/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

const allModels = [...mockModels, ...mockGatewayModels];

describe("parseModelPattern", () => {
	describe("simple patterns without colons", () => {
		test("exact match returns model with undefined thinking level", () => {
			const result = parseModelPattern("claude-sonnet-4-5", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("partial match returns best model with undefined thinking level", () => {
			const result = parseModelPattern("sonnet", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("no match returns undefined model and thinking level", () => {
			const result = parseModelPattern("nonexistent", allModels);
			expect(result.model).toBeUndefined();
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});
	});

	describe("patterns with valid thinking levels", () => {
		test("sonnet:high returns sonnet with high thinking level", () => {
			const result = parseModelPattern("sonnet:high", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBe("high");
			expect(result.warning).toBeUndefined();
		});

		test("gpt-4o:medium returns gpt-4o with medium thinking level", () => {
			const result = parseModelPattern("gpt-4o:medium", allModels);
			expect(result.model?.id).toBe("gpt-4o");
			expect(result.thinkingLevel).toBe("medium");
			expect(result.warning).toBeUndefined();
		});

		test("all valid thinking levels work", () => {
			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
				const result = parseModelPattern(`sonnet:${level}`, allModels);
				expect(result.model?.id).toBe("claude-sonnet-4-5");
				expect(result.thinkingLevel).toBe(level);
				expect(result.warning).toBeUndefined();
			}
		});
	});

	describe("patterns with invalid thinking levels", () => {
		test("sonnet:random returns sonnet with undefined thinking level and warning", () => {
			const result = parseModelPattern("sonnet:random", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});

		test("gpt-4o:invalid returns gpt-4o with undefined thinking level and warning", () => {
			const result = parseModelPattern("gpt-4o:invalid", allModels);
			expect(result.model?.id).toBe("gpt-4o");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
		});
	});

	describe("gateway models with colons in model ids", () => {
		test("qwen3-coder:exacto matches the model with undefined thinking level", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("gateway/qwen/qwen3-coder:exacto matches with provider prefix", () => {
			const result = parseModelPattern("gateway/qwen/qwen3-coder:exacto", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.model?.provider).toBe("gateway");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("qwen3-coder:exacto:high matches model with high thinking level", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:high", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBe("high");
			expect(result.warning).toBeUndefined();
		});

		test("gateway/qwen/qwen3-coder:exacto:high matches with provider and thinking level", () => {
			const result = parseModelPattern("gateway/qwen/qwen3-coder:exacto:high", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.model?.provider).toBe("gateway");
			expect(result.thinkingLevel).toBe("high");
			expect(result.warning).toBeUndefined();
		});

		test("gpt-4o:extended matches the extended model with undefined thinking level", () => {
			const result = parseModelPattern("beta/gpt-4o:extended", allModels);
			expect(result.model?.id).toBe("beta/gpt-4o:extended");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});
	});

	describe("invalid thinking levels with gateway models", () => {
		test("qwen3-coder:exacto:random returns model with undefined thinking level and warning", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:random", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});

		test("qwen3-coder:exacto:high:random returns model with undefined thinking level and warning", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:high:random", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});
	});

	describe("edge cases", () => {
		test("empty pattern matches via partial matching", () => {
			// Empty string is included in all model IDs, so partial matching finds a match
			const result = parseModelPattern("", allModels);
			expect(result.model).not.toBeNull();
			expect(result.thinkingLevel).toBeUndefined();
		});

		test("pattern ending with colon treats empty suffix as invalid", () => {
			const result = parseModelPattern("sonnet:", allModels);
			// Empty string after colon is not a valid thinking level
			// So it tries to match "sonnet:" which won't match, then tries "sonnet"
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.warning).toContain("Invalid thinking level");
		});
	});
});

describe("resolveModelScopeWithDiagnostics", () => {
	test("returns scoped models and structured diagnostics without writing console warnings", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const registry = {
				getAvailable: () => allModels,
			} as unknown as Parameters<typeof resolveModelScopeWithDiagnostics>[1];

			const result = await resolveModelScopeWithDiagnostics(["sonnet:high", "gpt-4o:invalid", "missing"], registry);

			expect(result.scopedModels.map((scoped) => scoped.model.id)).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
			expect(result.scopedModels[0].thinkingLevel).toBe("high");
			expect(result.scopedModels[1].thinkingLevel).toBeUndefined();
			expect(result.diagnostics).toEqual([
				{
					type: "warning",
					message: 'Invalid thinking level "invalid" in pattern "gpt-4o:invalid". Using default instead.',
					code: "invalid-thinking-level",
					pattern: "gpt-4o:invalid",
				},
				{
					type: "warning",
					message: 'No models match pattern "missing"',
					code: "no-match",
					pattern: "missing",
				},
			]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test("resolveModelScope preserves CLI warning output", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const registry = {
				getAvailable: () => allModels,
			} as unknown as Parameters<typeof resolveModelScope>[1];

			const scopedModels = await resolveModelScope(["missing"], registry);

			expect(scopedModels).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0][0]).toContain('Warning: No models match pattern "missing"');
		} finally {
			warn.mockRestore();
		}
	});

	test("resolves bracketed model ids as exact references before glob matching", async () => {
		const bracketedModel: Model<"anthropic-messages"> = {
			id: "bracketed-model[1m]",
			name: "Bracketed Model",
			api: "anthropic-messages",
			provider: "custom",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getAvailable: () => [...allModels, bracketedModel],
		} as unknown as Parameters<typeof resolveModelScopeWithDiagnostics>[1];

		const result = await resolveModelScopeWithDiagnostics(["custom/bracketed-model[1m]"], registry);

		expect(result.scopedModels.map((scoped) => scoped.model.id)).toEqual(["bracketed-model[1m]"]);
		expect(result.diagnostics).toEqual([]);
	});

	test("resolves bracketed model ids with thinking levels as exact references before glob matching", async () => {
		const bracketedModel: Model<"anthropic-messages"> = {
			id: "bracketed-model[1m]",
			name: "Bracketed Model",
			api: "anthropic-messages",
			provider: "custom",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getAvailable: () => [...allModels, bracketedModel],
		} as unknown as Parameters<typeof resolveModelScopeWithDiagnostics>[1];

		const result = await resolveModelScopeWithDiagnostics(["custom/bracketed-model[1m]:high"], registry);

		expect(result.scopedModels.map((scoped) => scoped.model.id)).toEqual(["bracketed-model[1m]"]);
		expect(result.scopedModels[0].thinkingLevel).toBe("high");
		expect(result.diagnostics).toEqual([]);
	});
});

describe("resolveCliModel", () => {
	test("resolves --model provider/id without --provider", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "beta/gpt-4o",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("beta");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("resolves fuzzy patterns within an explicit provider", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "beta",
			cliModel: "4o",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("beta");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("supports --model <pattern>:<thinking> (without explicit --thinking)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "sonnet:high",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("high");
	});

	test("prefers exact model id match over provider inference (gateway-style ids with embedded slashes)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "beta/gpt-4o:extended",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("gateway");
		expect(result.model?.id).toBe("beta/gpt-4o:extended");
	});

	test("does not strip invalid :suffix as thinking level in --model (treat as raw id)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "beta",
			cliModel: "gpt-4o:extended",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("beta");
		expect(result.model?.id).toBe("gpt-4o:extended");
	});

	test("allows custom model ids for explicit providers without double prefixing", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "gateway",
			cliModel: "gateway/vendor/ghost-model",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("gateway");
		expect(result.model?.id).toBe("vendor/ghost-model");
	});

	test("returns a clear error when there are no models", () => {
		const registry = {
			getModels: () => [],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "beta",
			cliModel: "gpt-4o",
			modelRuntime: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});

	test("prefers the sole authenticated provider for an ambiguous bare exact model id", () => {
		const hostAModel: Model<"anthropic-messages"> = {
			...mockModels[1],
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			provider: "host-a",
		};
		const hostBModel: Model<"anthropic-messages"> = {
			...mockModels[1],
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			provider: "host-b",
		};
		const registry = {
			getModels: () => [hostAModel, hostBModel],
			hasConfiguredAuth: (provider: string) => provider === "host-b",
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "gpt-5.6-sol",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("host-b");
		expect(result.model?.id).toBe("gpt-5.6-sol");
	});

	test("requires an explicit provider for an ambiguous bare exact model id without a unique authenticated provider", () => {
		const hostAModel: Model<"anthropic-messages"> = {
			...mockModels[1],
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			provider: "host-a",
		};
		const hostBModel: Model<"anthropic-messages"> = {
			...mockModels[1],
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			provider: "host-b",
		};
		const registry = {
			getModels: () => [hostAModel, hostBModel],
			hasConfiguredAuth: () => false,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "gpt-5.6-sol",
			modelRuntime: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain('Model "gpt-5.6-sol" is ambiguous across providers');
		expect(result.error).toContain("host-a/gpt-5.6-sol");
		expect(result.error).toContain("host-b/gpt-5.6-sol");
		expect(result.error).toContain("Use --provider or provider/model");
	});

	test("prefers provider/model split over aggregator model with matching id", () => {
		// When a user writes "vendor-x/glm-5", and both a vendor-x provider model (id: "glm-5")
		// and an aggregator model (id: "vendor-x/glm-5") exist, prefer the vendor-x provider model.
		const vendorModel: Model<"anthropic-messages"> = {
			id: "glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "vendor-x",
			baseUrl: "https://vendor-x.test",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const aggregatorModel: Model<"anthropic-messages"> = {
			id: "vendor-x/glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "aggregator",
			baseUrl: "https://aggregator.test",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getModels: () => [...allModels, vendorModel, aggregatorModel],
			hasConfiguredAuth: () => true,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "vendor-x/glm-5",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("vendor-x");
		expect(result.model?.id).toBe("glm-5");
	});

	test("prefers an authenticated exact raw model id over an unauthenticated inferred provider", () => {
		const resellerModel: Model<"anthropic-messages"> = {
			id: "vendor-y/model-y",
			name: "Vendor Y via Reseller",
			api: "anthropic-messages",
			provider: "reseller",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const vendorYModel: Model<"anthropic-messages"> = {
			id: "model-y",
			name: "Vendor Y",
			api: "anthropic-messages",
			provider: "vendor-y",
			baseUrl: "https://vendor-y.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getModels: () => [...allModels, resellerModel, vendorYModel],
			hasConfiguredAuth: (provider: string) => provider === "reseller",
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "vendor-y/model-y",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("reseller");
		expect(result.model?.id).toBe("vendor-y/model-y");
	});

	test("resolves provider-prefixed fuzzy patterns (gateway/qwen -> gateway model)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "gateway/qwen",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("gateway");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
	});

	describe("custom model fallback with :thinking suffix (#5552)", () => {
		// Models for a provider that has registered models but the specific model ID
		// is not in the registry (triggers buildFallbackModel path).
		const neuralwattModel: Model<"anthropic-messages"> = {
			id: "some-base-model",
			name: "Some Base Model",
			api: "anthropic-messages",
			provider: "neuralwatt",
			baseUrl: "https://api.neuralwatt.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const modelsWithNeuralwatt = [...allModels, neuralwattModel];

		test("strips :thinking suffix from custom model id in fallback path", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/vendor/GLM-5.1-FP8:high",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			// The :high suffix must NOT leak into the model id sent to the API
			expect(result.model?.id).toBe("vendor/GLM-5.1-FP8");
			expect(result.model?.reasoning).toBe(true);
			expect(result.thinkingLevel).toBe("high");
		});

		test("custom model without thinking suffix works normally in fallback path", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/vendor/GLM-5.1-FP8",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			expect(result.model?.id).toBe("vendor/GLM-5.1-FP8");
			expect(result.thinkingLevel).toBeUndefined();
		});

		test("all valid thinking levels work in fallback path", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
				const result = resolveCliModel({
					cliModel: `neuralwatt/vendor/GLM-5.1-FP8:${level}`,
					modelRuntime: registry,
				});

				expect(result.error).toBeUndefined();
				expect(result.model?.id).toBe("vendor/GLM-5.1-FP8");
				expect(result.thinkingLevel).toBe(level);
			}
		});

		test("invalid thinking suffix on custom model is treated as part of model id", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/vendor/GLM-5.1-FP8:banana",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			// Invalid suffix stays in the id (it's not a thinking level)
			expect(result.model?.id).toBe("vendor/GLM-5.1-FP8:banana");
			expect(result.thinkingLevel).toBeUndefined();
		});

		test("explicit --provider with custom model:thinking strips suffix correctly", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliProvider: "neuralwatt",
				cliModel: "vendor/GLM-5.1-FP8:high",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			expect(result.model?.id).toBe("vendor/GLM-5.1-FP8");
			expect(result.thinkingLevel).toBe("high");
		});

		test("with explicit --thinking, :suffix is kept as part of model id", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/vendor/GLM-5.1-FP8:high",
				cliThinking: "medium",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			// :high is kept as part of the model id since --thinking was explicit
			expect(result.model?.id).toBe("vendor/GLM-5.1-FP8:high");
			expect(result.thinkingLevel).toBeUndefined();
		});
	});
});

describe("default model selection", () => {
	test("built-in providers expose chat models in their generated catalogs", () => {
		for (const provider of getBuiltinProviders()) {
			expect(getBuiltinModels(provider).length, `${provider} has no chat models`).toBeGreaterThan(0);
		}
	});

	test("findInitialModel accepts explicit provider custom model ids", async () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const result = await findInitialModel({
			cliProvider: "gateway",
			cliModel: "gateway/vendor/ghost-model",
			scopedModels: [],
			isContinuing: false,
			modelRuntime: registry,
		});

		expect(result.model?.provider).toBe("gateway");
		expect(result.model?.id).toBe("vendor/ghost-model");
	});

	test("findInitialModel selects the first available model", async () => {
		const aggregatorModel: Model<"anthropic-messages"> = {
			id: "vendor/claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			provider: "aggregator",
			baseUrl: "https://aggregator.test",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
			contextWindow: 200000,
			maxTokens: 8192,
		};

		const registry = {
			getAvailableSnapshot: () => [aggregatorModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: registry,
		});

		expect(result.model?.provider).toBe("aggregator");
		expect(result.model?.id).toBe("vendor/claude-opus-4-6");
	});

	test("findInitialModel ignores an unauthenticated saved default", async () => {
		const savedVendorModel: Model<"anthropic-messages"> = {
			id: "vendor-a-flash",
			name: "Vendor A Flash",
			api: "anthropic-messages",
			provider: "vendor-a",
			baseUrl: "https://vendor-a.test",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const localVendorModel: Model<"anthropic-messages"> = {
			...savedVendorModel,
			provider: "local-host",
			baseUrl: "http://local-host:8000/v1",
		};
		const registry = {
			getModel: (provider: string, modelId: string) =>
				provider === savedVendorModel.provider && modelId === savedVendorModel.id ? savedVendorModel : undefined,
			hasConfiguredAuth: (provider: string) => provider === "local-host",
			getAvailableSnapshot: () => [localVendorModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "vendor-a",
			defaultModelId: "vendor-a-flash",
			modelRuntime: registry,
		});

		expect(result.model?.provider).toBe("local-host");
		expect(result.model?.id).toBe("vendor-a-flash");
	});

	describe("persisted default model scoping", () => {
		const tempDirs: string[] = [];
		const sonnet = getModel("github-copilot", "claude-sonnet-5")!;
		const opus = getModel("github-copilot", "claude-opus-5")!;

		afterEach(() => {
			for (const dir of tempDirs.splice(0)) {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		async function createSession(options: { scoped: boolean; persistedScope?: string[] }) {
			const tempDir = join(tmpdir(), `pi-default-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(tempDir, { recursive: true });
			tempDirs.push(tempDir);

			const settingsManager = SettingsManager.create(tempDir, tempDir);
			if (options.persistedScope) {
				settingsManager.setEnabledModels(options.persistedScope);
			}

			const authStorage = AuthStorage.inMemory({ "github-copilot": { type: "api_key", key: "test-key" } });
			const modelRuntime = getModelRuntime(await createModelRegistry(authStorage, join(tempDir, "models.json")));
			const agent = new Agent({
				initialState: {
					model: sonnet,
					systemPrompt: "test",
					tools: [],
				},
				streamFn: streamSimple,
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir),
				settingsManager,
				cwd: tempDir,
				modelRuntime,
				resourceLoader: createTestResourceLoader(),
				scopedModels: options.scoped ? [{ model: sonnet }] : [],
			});

			return { session, settingsManager };
		}

		test("adds a persisted default to an existing scoped model list", async () => {
			const { session, settingsManager } = await createSession({
				scoped: true,
				persistedScope: [`${sonnet.provider}/${sonnet.id}`],
			});

			await session.setModel(opus, { persist: true });

			expect(settingsManager.getDefaultProvider()).toBe(opus.provider);
			expect(settingsManager.getDefaultModel()).toBe(opus.id);
			expect(session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
				`${sonnet.provider}/${sonnet.id}`,
				`${opus.provider}/${opus.id}`,
			]);
			expect(settingsManager.getEnabledModels()).toEqual([
				`${sonnet.provider}/${sonnet.id}`,
				`${opus.provider}/${opus.id}`,
			]);
		});

		test("does not create a scoped model list when all models are available", async () => {
			const { session, settingsManager } = await createSession({ scoped: false });

			await session.setModel(opus, { persist: true });

			expect(session.scopedModels).toEqual([]);
			expect(settingsManager.getEnabledModels()).toBeUndefined();
		});

		test("keeps session-only model changes out of scope", async () => {
			const { session, settingsManager } = await createSession({
				scoped: true,
				persistedScope: [`${sonnet.provider}/${sonnet.id}`],
			});

			await session.setModel(opus, { persist: false });

			expect(session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
				`${sonnet.provider}/${sonnet.id}`,
			]);
			expect(settingsManager.getEnabledModels()).toEqual([`${sonnet.provider}/${sonnet.id}`]);
		});
	});
});
