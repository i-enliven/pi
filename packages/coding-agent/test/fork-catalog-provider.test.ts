import {
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
	type RefreshModelsContext,
} from "@i-enliven/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import {
	FORK_CATALOG_MODEL_TYPES,
	getForkCatalogUrl,
	resetForkCatalogCache,
	withForkCatalog,
} from "../src/core/fork-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function testProvider(localGeneratedAt?: number) {
	return withForkCatalog(
		createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("static")],
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		}),
		localGeneratedAt,
	);
}

async function refreshProvider(
	provider: Provider,
	store: InMemoryModelsStore,
	overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">> = {},
): Promise<void> {
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist === null) await store.delete(provider.id);
		else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	const stored = await store.read(provider.id);
	await provider.refreshModels?.({
		allowNetwork: true,
		signal: neverAbortedSignal,
		stored,
		publish,
		...overrides,
	});
}

function catalogResponse(body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ "test-provider": body }), {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	resetForkCatalogCache();
});

describe("fork model catalog", () => {
	it("resolves the catalog URL from the fork update repo", () => {
		vi.stubEnv("PI_UPDATE_REPO", "");
		vi.stubEnv("PI_MODEL_CATALOG_URL", "");
		expect(getForkCatalogUrl()).toBe(
			"https://raw.githubusercontent.com/i-enliven/pi/main/nix/model-catalog/models.all.json",
		);
		vi.stubEnv("PI_MODEL_CATALOG_URL", "https://catalog.example/models.json");
		expect(getForkCatalogUrl()).toBe("https://catalog.example/models.json");
	});

	it("overlays catalog models on the static list and persists the store entry", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(catalogResponse([model("static"), model("dynamic")], { etag: '"etag-1"' }));
		vi.stubGlobal("fetch", fetchMock);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		const entry = await store.read("test-provider");
		expect(entry?.models.map((m) => m.id)).toEqual(["static", "dynamic"]);
		expect(entry?.etag).toBe('"etag-1"');
		expect(entry?.lastModified).toBeTypeOf("number");
		const url = new URL(fetchMock.mock.calls[0][0] as string);
		expect(url.pathname).toContain("i-enliven/pi");
	});

	it("sends If-None-Match and keeps the cached overlay on 304", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
		vi.stubGlobal("fetch", fetchMock);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write("test-provider", {
			models: [model("cached")],
			checkedAt: 0,
			lastModified: 0,
			etag: '"etag-1"',
		});

		await refreshProvider(provider, store, { force: true });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>)["if-none-match"]).toBe('"etag-1"');
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "cached"]);
		const entry = await store.read("test-provider");
		expect(entry?.checkedAt).toBeTypeOf("number");
	});

	it("skips the network within the refresh interval", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write("test-provider", {
			models: [model("cached")],
			checkedAt: Date.now(),
			lastModified: Date.now(),
			etag: '"etag-1"',
		});

		await refreshProvider(provider, store);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "cached"]);
	});

	it("does not overlay data older than the bundled catalog", async () => {
		const fetchMock = vi.fn().mockResolvedValue(catalogResponse([model("dynamic")]));
		vi.stubGlobal("fetch", fetchMock);
		const provider = testProvider(Date.now() + 60_000);
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);

		// The store entry is persisted, but its data is older than the bundled catalog.
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
	});

	it("stays offline without network permission and restores the cached overlay", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write("test-provider", { models: [model("cached")], lastModified: Date.now() + 10_000 });

		await refreshProvider(provider, store, { allowNetwork: false });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "cached"]);
	});

	it("surfaces request failures", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await expect(refreshProvider(provider, store)).rejects.toThrow("Fork model catalog request failed: HTTP 500");
	});

	it("rejects malformed catalogs", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[1,2]", { status: 200 })));
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await expect(refreshProvider(provider, store)).rejects.toThrow("Model catalog must be an object");
	});

	it("declares the model types it consumes", () => {
		expect(FORK_CATALOG_MODEL_TYPES).toEqual(["chat", "image", "classifier"]);
	});

	it("keeps the pi user agent on catalog requests", async () => {
		const fetchMock = vi.fn().mockResolvedValue(catalogResponse([]));
		vi.stubGlobal("fetch", fetchMock);
		await refreshProvider(testProvider(), new InMemoryModelsStore());
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>)["user-agent"]).toBe(
			`pi/${VERSION} (${process.platform}; node/${process.version}; ${process.arch})`,
		);
	});
});
