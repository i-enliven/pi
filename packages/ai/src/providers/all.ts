import { MODELS } from "../models.generated.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import type { AnyModel, Api, Model } from "../types.ts";
import modelDataManifest from "./data/.manifest.json" with { type: "json" };
import { githubCopilotProvider } from "./github-copilot.ts";

/** Providers present in the generated catalog. `KnownProvider` additionally
 * includes purely dynamic providers that have no static catalog entry. */
export type BuiltinProvider = keyof typeof MODELS;

type BuiltinChatModelId<TProvider extends BuiltinProvider> = keyof (typeof MODELS)[TProvider];
/** API ids of catalog entries. Built-in getters return `Model<Api>` shapes, not literal entry types. */
type CatalogApi<TEntry> = TEntry extends { api: infer TApi extends string } ? TApi : never;

/** Typed read of one generated built-in chat model. */
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends BuiltinChatModelId<TProvider>>(
	provider: TProvider,
	modelId: TModelId,
): Model<CatalogApi<(typeof MODELS)[TProvider][TModelId]>> {
	return (MODELS as Record<string, Record<string, Model<Api>> | undefined>)[provider]?.[modelId as string] as Model<
		CatalogApi<(typeof MODELS)[TProvider][TModelId]>
	>;
}

export function getBuiltinProviders(): BuiltinProvider[] {
	return Object.keys(MODELS) as BuiltinProvider[];
}

/** Generation timestamp shared by all built-in provider catalogs. */
export function getBuiltinModelDataGeneratedAt(): number | undefined {
	const generatedAt = Date.parse(modelDataManifest.generatedAt);
	return Number.isNaN(generatedAt) ? undefined : generatedAt;
}

export function getBuiltinModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): Model<CatalogApi<(typeof MODELS)[TProvider][BuiltinChatModelId<TProvider>]>>[] {
	const models = (MODELS as Record<string, Record<string, Model<Api>> | undefined>)[provider];
	return Object.values(models ?? {}) as Model<CatalogApi<(typeof MODELS)[TProvider][BuiltinChatModelId<TProvider>]>>[];
}

export function getAllBuiltinModels<TProvider extends BuiltinProvider>(provider: TProvider): AnyModel[] {
	return getBuiltinModels(provider);
}

/** All built-in providers, freshly constructed. */
export function builtinProviders(): Provider[] {
	return [githubCopilotProvider()];
}

/** A `Models` collection with every built-in provider registered. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = createModels(options);
	for (const provider of builtinProviders()) {
		models.setProvider(provider);
	}
	return models;
}
