import {
	type AnyModel,
	getModelType,
	isModelType,
	type ModelsStoreEntry,
	type ModelType,
	type Provider,
} from "@i-enliven/pi-ai";
import { VERSION } from "../config.ts";
import { fetchWithRetry } from "../utils/management-http.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getUpdateRepo } from "../utils/version-check.ts";

/** Catalog file committed to the fork repository, served raw from its default branch. */
const FORK_CATALOG_PATH = "nix/model-catalog/models.all.json";
const FORK_CATALOG_ATTEMPT_TIMEOUT_MS = 10_000;
export const FORK_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Reuse a just-fetched catalog for the providers of one refresh instead of refetching per provider. */
const FORK_CATALOG_SHARE_WINDOW_MS = 60_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
/** Model types this client can consume from the catalog. */
export const FORK_CATALOG_MODEL_TYPES: readonly ModelType[] = ["chat", "image", "classifier"];

/** URL of the fork's model catalog, overridable with PI_MODEL_CATALOG_URL. */
export function getForkCatalogUrl(): string {
	const override = process.env.PI_MODEL_CATALOG_URL?.trim();
	if (override) return override;
	return `https://raw.githubusercontent.com/${getUpdateRepo()}/main/${FORK_CATALOG_PATH}`;
}

function isSupportedModelType(model: { type?: unknown }): boolean {
	return (
		model.type === undefined ||
		(typeof model.type === "string" && FORK_CATALOG_MODEL_TYPES.includes(model.type as ModelType))
	);
}

function parseCatalogProvider(providerId: string, value: unknown): AnyModel[] {
	if (!Array.isArray(value)) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return value
		.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && "id" in entry)
		.filter(isSupportedModelType)
		.map((model) => ({ ...model, provider: providerId }) as AnyModel);
}

interface ParsedCatalog {
	/** Provider ID to models. */
	providers: Record<string, AnyModel[]>;
	/** Generation timestamp from the catalog's meta key, or the download time when absent. */
	generatedAt: number;
}

function parseCatalog(bytes: string): ParsedCatalog {
	const parsed: unknown = JSON.parse(bytes);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Model catalog must be an object keyed by provider");
	}
	const { "@generated": generated, ...providers } = parsed as Record<string, unknown>;
	const catalog: Record<string, AnyModel[]> = {};
	for (const [providerId, value] of Object.entries(providers)) {
		catalog[providerId] = parseCatalogProvider(providerId, value);
	}
	const parsedGenerated = typeof generated === "string" ? Date.parse(generated) : Number.NaN;
	return { providers: catalog, generatedAt: Number.isNaN(parsedGenerated) ? Date.now() : parsedGenerated };
}

interface ForkCatalogFresh {
	notModified: false;
	catalog: ParsedCatalog;
	etag?: string;
}

interface ForkCatalogNotModified {
	notModified: true;
	etag?: string;
}

type ForkCatalogResult = ForkCatalogFresh | ForkCatalogNotModified;

let inFlight: { url: string; promise: Promise<ForkCatalogResult> } | undefined;
let lastResult: { url: string; result: ForkCatalogResult; at: number } | undefined;

/** Drop the shared fetch cache. Exported for tests only. */
export function resetForkCatalogCache(): void {
	inFlight = undefined;
	lastResult = undefined;
}

async function downloadForkCatalog(url: string, etag: string | undefined): Promise<ForkCatalogResult> {
	const response = await fetchWithRetry(
		url,
		{
			headers: {
				accept: "application/json",
				"user-agent": getPiUserAgent(VERSION),
				...(etag ? { "if-none-match": etag } : {}),
			},
		},
		{ attemptTimeoutMs: FORK_CATALOG_ATTEMPT_TIMEOUT_MS },
	);
	if (response.status === 304 && etag) return { notModified: true, etag };
	if (response.status === 404 || response.status === 410) {
		throw new Error(`Fork model catalog is unavailable at ${url}: HTTP ${response.status}`);
	}
	if (!response.ok) throw new Error(`Fork model catalog request failed: HTTP ${response.status}`);
	const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_BYTES) {
		throw new Error(`Fork model catalog exceeds ${MAX_CATALOG_BYTES} bytes`);
	}
	const bytes = await response.text();
	if (bytes.length > MAX_CATALOG_BYTES) throw new Error(`Fork model catalog exceeds ${MAX_CATALOG_BYTES} bytes`);
	return { notModified: false, catalog: parseCatalog(bytes), etag: response.headers.get("etag") ?? undefined };
}

/**
 * Fetch the fork catalog once per refresh window: concurrent providers of one refresh join the
 * in-flight request, and providers that arrive just after it settles reuse its result. The fetch
 * is deliberately independent of any caller's abort signal, so one cancelled provider refresh
 * cannot fail the shared request for the others; callers check their own signal after awaiting.
 */
function fetchForkCatalog(url: string, etag: string | undefined): Promise<ForkCatalogResult> {
	if (lastResult && lastResult.url === url && Date.now() - lastResult.at < FORK_CATALOG_SHARE_WINDOW_MS) {
		return Promise.resolve(lastResult.result);
	}
	if (inFlight && inFlight.url === url) return inFlight.promise;
	const promise = downloadForkCatalog(url, etag).finally(() => {
		if (inFlight?.promise === promise) inFlight = undefined;
	});
	promise
		.then((result) => {
			lastResult = { url, result, at: Date.now() };
		})
		.catch(() => {
			lastResult = undefined;
		});
	inFlight = { url, promise };
	return promise;
}

function overlayModels(entry: ModelsStoreEntry | undefined, localGeneratedAt: number | undefined): readonly AnyModel[] {
	if (!entry) return [];
	if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
		return [];
	}
	return entry.models;
}

function mergeModels<TModel extends AnyModel>(baseline: readonly TModel[], dynamic: readonly TModel[]): TModel[] {
	const merged = new Map<string, TModel>();
	for (const model of [...baseline, ...dynamic]) merged.set(`${getModelType(model)}\0${model.id}`, model);
	return [...merged.values()];
}

/** Add a persisted fork-repository catalog overlay to a static built-in provider. */
export function withForkCatalog(provider: Provider, localGeneratedAt?: number): Provider {
	let dynamicModels: readonly AnyModel[] = [];

	return {
		...provider,
		getModels: () =>
			mergeModels(
				provider.getModels(),
				dynamicModels.filter((model) => isModelType(model, "chat")),
			),
		getAllModels: () => mergeModels(provider.getAllModels?.() ?? provider.getModels(), dynamicModels),
		refreshModels: async (context) => {
			const stored = context.stored;
			const restored = overlayModels(stored, localGeneratedAt).filter((model) => model.provider === provider.id);
			if (
				!(await context.publish({
					update: () => {
						dynamicModels = restored;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < FORK_CATALOG_REFRESH_INTERVAL_MS
			) {
				return;
			}

			// Only revalidate when a cached body backs the validator, so a 304 can never
			// leave the overlay empty.
			const validator = stored && stored.models.length > 0 ? stored.etag : undefined;
			const result = await fetchForkCatalog(getForkCatalogUrl(), validator);
			if (context.signal.aborted) return;
			const checkedAt = Date.now();
			if (result.notModified && stored) {
				await context.publish({ persist: { ...stored, checkedAt } });
				return;
			}
			if (result.notModified) return;

			const slice = result.catalog.providers[provider.id] ?? [];
			const entry: ModelsStoreEntry = {
				models: slice,
				checkedAt,
				lastModified: result.catalog.generatedAt,
				etag: result.etag,
			};
			const published = overlayModels(entry, localGeneratedAt).filter((model) => model.provider === provider.id);
			await context.publish({
				persist: entry,
				update: () => {
					dynamicModels = published;
				},
			});
		},
	};
}
