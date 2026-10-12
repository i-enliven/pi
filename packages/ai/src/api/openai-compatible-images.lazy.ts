import type { ProviderImages } from "../types.ts";

export const openAICompatibleImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./openai-compatible-images.ts")).generateImages(model, context, options),
});
