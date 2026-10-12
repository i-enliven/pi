import { describe, expect, it, vi } from "vitest";
import { generateImages } from "../src/compat.ts";
import type { FetchFunction, ImageModel, ImagesContext } from "../src/types.ts";

const IMAGE_API = "openai-compatible-images";

interface CapturedRequest {
	url: string;
	init: RequestInit;
	body: Record<string, unknown>;
}

function headerValue(init: RequestInit, name: string): string | undefined {
	const headers = new Headers(init.headers);
	return headers.get(name) ?? undefined;
}

function captureFetch(payload: unknown, status = 200): { fetch: FetchFunction; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetch: FetchFunction = async (input, init) => {
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		requests.push({ url: String(input), init: init ?? {}, body });
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch, requests };
}

function createImageModel(overrides: Partial<ImageModel<typeof IMAGE_API>> = {}): ImageModel<typeof IMAGE_API> {
	return {
		type: "image",
		id: "image-model",
		name: "Image Model",
		api: IMAGE_API,
		provider: "compatible-endpoint",
		baseUrl: "https://images.test/v1",
		input: ["text", "image"],
		output: ["text", "image"],
		cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
		...overrides,
	};
}

const promptInput: ImagesContext = {
	input: [{ type: "text", text: "Generate a dog" }],
};

const imageResponse = {
	id: "img-1",
	usage: {
		prompt_tokens: 12,
		completion_tokens: 34,
		prompt_tokens_details: { cached_tokens: 0 },
	},
	choices: [
		{
			message: {
				content: "Here is your image.",
				images: [{ image_url: "data:image/png;base64,ZmFrZS1wbmc=" }],
			},
		},
	],
};

describe("openai-compatible images", () => {
	it("posts chat completions with image modalities to the model base URL", async () => {
		const model = createImageModel();
		const { fetch, requests } = captureFetch(imageResponse);

		const output = await generateImages(model, promptInput, { apiKey: "test-key", fetch, maxRetries: 0 });

		expect(output.stopReason, `Error: ${output.errorMessage}`).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://images.test/v1/chat/completions");
		expect(requests[0].body.model).toBe("image-model");
		expect(requests[0].body.stream).toBe(false);
		expect(requests[0].body.modalities).toEqual(["image", "text"]);
		expect(requests[0].body.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "Generate a dog" }] },
		]);
		expect(headerValue(requests[0].init, "authorization")).toBe("Bearer test-key");
	});

	it("reads the base URL from each model so one api serves many endpoints", async () => {
		const local = createImageModel({ baseUrl: "http://localhost:8080/v1", provider: "local" });
		const hosted = createImageModel({ baseUrl: "https://hosted.test/api/v1", provider: "hosted" });

		const localCapture = captureFetch(imageResponse);
		const hostedCapture = captureFetch(imageResponse);
		await generateImages(local, promptInput, { apiKey: "test-key", fetch: localCapture.fetch, maxRetries: 0 });
		await generateImages(hosted, promptInput, { apiKey: "test-key", fetch: hostedCapture.fetch, maxRetries: 0 });

		expect(localCapture.requests[0].url).toBe("http://localhost:8080/v1/chat/completions");
		expect(hostedCapture.requests[0].url).toBe("https://hosted.test/api/v1/chat/completions");
	});

	it("returns text plus parsed data URL images in the final output", async () => {
		const model = createImageModel();
		const { fetch } = captureFetch(imageResponse);

		const output = await generateImages(model, promptInput, { apiKey: "test-key", fetch, maxRetries: 0 });

		expect(output.responseId).toBe("img-1");
		expect(output.output[0]).toMatchObject({ type: "text", text: "Here is your image." });
		expect(output.output[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "ZmFrZS1wbmc=" });
		expect(output.usage).toMatchObject({ input: 12, output: 34, cacheRead: 0, cacheWrite: 0 });
	});

	it("skips non-data-URL image references", async () => {
		const model = createImageModel();
		const { fetch } = captureFetch({
			choices: [
				{
					message: {
						content: "",
						images: [{ image_url: "https://images.test/generated.png" }],
					},
				},
			],
		});

		const output = await generateImages(model, promptInput, { apiKey: "test-key", fetch, maxRetries: 0 });

		expect(output.stopReason).toBe("stop");
		expect(output.output).toEqual([]);
	});

	it("sends image inputs as data URL content parts", async () => {
		const model = createImageModel();
		const { fetch, requests } = captureFetch(imageResponse);
		const context: ImagesContext = {
			input: [
				{ type: "text", text: "Make the background blue" },
				{ type: "image", mimeType: "image/png", data: "ZmFrZS1wbmc=" },
			],
		};

		const output = await generateImages(model, context, { apiKey: "test-key", fetch, maxRetries: 0 });

		expect(output.stopReason, `Error: ${output.errorMessage}`).toBe("stop");
		expect(requests[0].body.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Make the background blue" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZS1wbmc=" } },
				],
			},
		]);
	});

	it("does not request text output for image-only models", async () => {
		const model = createImageModel({ output: ["image"] });
		const { fetch, requests } = captureFetch({
			choices: [{ message: { content: "", images: [{ image_url: "data:image/png;base64,ZmFrZS1wbmc=" }] } }],
		});

		const output = await generateImages(model, promptInput, { apiKey: "test-key", fetch, maxRetries: 0 });

		expect(output.output.some((item) => item.type === "image")).toBe(true);
		expect(requests[0].body.modalities).toEqual(["image"]);
	});

	it("sends model and request headers", async () => {
		const model = createImageModel({ headers: { "X-Model-Header": "model" } });
		const { fetch, requests } = captureFetch(imageResponse);

		await generateImages(model, promptInput, {
			apiKey: "test-key",
			fetch,
			maxRetries: 0,
			headers: { "X-Request-Header": "request" },
		});

		expect(headerValue(requests[0].init, "x-model-header")).toBe("model");
		expect(headerValue(requests[0].init, "x-request-header")).toBe("request");
	});

	it("returns an error result when the endpoint rejects the request", async () => {
		const model = createImageModel();
		const { fetch } = captureFetch({ error: { message: "endpoint does not generate images" } }, 400);

		const output = await generateImages(model, promptInput, { apiKey: "test-key", fetch, maxRetries: 0 });

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("endpoint does not generate images");
		expect(output.output).toEqual([]);
	});

	it("returns an aborted result when the caller aborts before the request", async () => {
		const model = createImageModel();
		const fetch = vi.fn<FetchFunction>(async () => new Response("{}", { status: 200 }));
		const controller = new AbortController();
		controller.abort();

		const output = await generateImages(model, promptInput, {
			apiKey: "test-key",
			fetch,
			maxRetries: 0,
			signal: controller.signal,
		});

		expect(output.stopReason).toBe("aborted");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("fails without an API key", async () => {
		const model = createImageModel();
		const { fetch } = captureFetch(imageResponse);

		const output = await generateImages(model, promptInput, { fetch, maxRetries: 0 });

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("No API key for provider: compatible-endpoint");
	});
});
