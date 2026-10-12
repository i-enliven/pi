# Choose a Model

For GitHub Copilot, start with `/login`, then choose a model with `/model`. Use custom model configuration only when Pi does not already include the endpoint you need.

## Choose a connection

| What you have | Recommended setup |
|---|---|
| A GitHub Copilot subscription | Sign in through `/login` |
| A GitHub Copilot API token | Set `COPILOT_GITHUB_TOKEN` |
| A local GGUF model | Connect Pi to the llama.cpp router |
| A provider API key for a compatible endpoint | Add it to `models.json` |
| A local GGUF model | Connect Pi to the llama.cpp router |
| An OpenAI- or Anthropic-compatible endpoint | Add it to `models.json` |
| A provider with a custom protocol or authentication flow | Build or install a provider extension |

This fork ships a bundled model catalog, generated at build time from the checked-in model data. On refresh (model search, `pi update --models`), Pi overlays newer data from the catalog file committed to the fork repository (`nix/model-catalog/models.all.json` on GitHub). The overlay is cached in `~/.pi/agent/models-store.json` and stays available offline. Set `PI_MODEL_CATALOG_URL` to serve the catalog from another location, or `PI_OFFLINE` to disable the overlay and use only the bundled catalog.

## Authenticate

Run `/login` and select a provider. Pi stores credentials in [`auth.json`](configuration.md#agent-directory). Run `/logout` to remove stored credentials for a provider.

You can instead provide an API key through the provider's environment variable. This is useful in CI and other environments where Pi should not write credentials. [Providers](providers.md) lists the variables and provider-specific setup.

When several credential sources are configured, Pi uses a runtime `--api-key` first, then a stored `auth.json` credential, an `apiKey` from `models.json`, and finally the provider's environment variables. Provider extensions can define their own authentication behavior.

Keep `auth.json` and any credential commands private. Project settings and extensions can execute inside the Pi process after you trust a project. Review [Security](security.md) before loading configuration from an untrusted directory.

## Select a model

Run `/model` to search available models. The picker shows models whose providers have usable authentication. Press `Ctrl+S` on a model to save it as the default for new sessions.

Run `/thinking` to select the thinking level for the current model. Press `Ctrl+S` there to save the startup level. Pi limits the choices to levels supported by the selected model.

`Ctrl+P` cycles through available models. Use `/scoped-models` to control that cycle and save the selection, or configure model patterns through [Settings](settings.md#model-cycling).

A session records model and thinking-level changes. Resuming the session restores them without changing defaults for new sessions.

## Connect local models

Pi integrates directly with the llama.cpp router. The router discovers GGUF files and loads models on demand. Pi's `/llama` command manages the router, while `/model` selects one of its loaded models.

Follow [Local Models with llama.cpp](llama-cpp.md) for server startup, model layout, downloads, and connection troubleshooting.

For Ollama, LM Studio, vLLM, SGLang, and other compatible servers, [configure a compatible endpoint](#configure-a-compatible-endpoint) in `models.json`.

## Configure a compatible endpoint

Use [`models.json`](configuration.md#agent-directory) when an endpoint speaks an API Pi already supports: `openai-completions`, `openai-responses`, or `anthropic-messages`. This includes most Ollama, LM Studio, vLLM, SGLang, and proxy deployments.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

The dummy key makes the model available to Pi; Ollama ignores it. For an authenticated endpoint, `apiKey` and header values can use `$NAME` or `${NAME}` environment interpolation, a literal value, or a leading `!command`. Commands in `models.json` run at request time and are not cached by Pi.

Opening `/model` reloads the file. A `models` entry adds or replaces a model with the same ID on that provider. Use `modelOverrides` to change metadata for an existing built-in or extension-provided model without replacing the provider's model list. Unknown override IDs are ignored.

### Describe model input and caching

Use `inputLimits.images.resize` to control how Pi encodes new image attachments, `read` results, and tool-result images before storing them in conversation history:

```json
{
  "id": "vision-model",
  "input": ["text", "image"],
  "inputLimits": {
    "images": {
      "resize": {
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxBytes": 524288,
        "jpegQuality": 75
      }
    }
  }
}
```

`maxBytes` limits the base64-encoded payload. Omitted resize fields use conservative defaults of 2000 by 2000 pixels, 4.5 MiB encoded, and JPEG quality 80. Images are encoded once; changing models does not rewrite historical images. The catalog can also describe hard request limits with `inputLimits.maxRequestBytes`, `images.maxPerMessage`, and `images.maxPerRequest`, but Pi does not yet rewrite or reject history based on them.

<a id="prompt-cache-lifetimes"></a>

Use `promptCache` to declare the provider's best-effort cache lifetime in seconds for the `short` or `long` retention tier:

```json
{ "id": "claude-sonnet-5", "promptCache": { "short": 300, "long": 3600 } }
```

Choose the conservative end of any published range. A model without a lifetime for the active tier is not eligible for cache warming. A `modelOverrides` entry can set `inputLimits` or `promptCache` for a built-in or extension model, including a model accessed through a validated proxy. See [`cacheWarming`](settings.md#model-and-thinking).

### Configure sampling by thinking level

OpenAI-compatible APIs support free-form `samplingParams` model defaults and `samplingParamsByThinkingLevel` overrides. The latter uses Pi thinking-level keys (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`), not provider values from `thinkingLevelMap`:

```json
{
  "id": "qwen-thinking-model",
  "reasoning": true,
  "samplingParams": {
    "temperature": 1.0,
    "top_p": 0.95
  },
  "samplingParamsByThinkingLevel": {
    "off": {
      "temperature": 0.7,
      "top_p": 0.8
    },
    "high": {
      "top_k": 20
    }
  }
}
```

Pi first clamps unsupported thinking levels, then merges model `samplingParams`, the effective level's override, and request-level `samplingParams` in that order. Later values win per key. Missing levels inherit the model defaults. `modelOverrides` merges per-level entries per key with the base model. These fields apply only to `openai-completions` and `openai-responses`; other APIs ignore them.

Compatibility settings should describe verified differences in the endpoint's request or response behavior. Do not enable them based only on an endpoint advertising OpenAI or Anthropic compatibility.

Pi adds no vendor-specific attribution headers to compatible endpoints. Earlier releases injected `X-OpenRouter-Title`/`X-OpenRouter-Categories` for a `baseUrl` pointing at `openrouter.ai`, `X-BILLING-INVOKE-ORIGIN` for `integrate.api.nvidia.com`, `User-Agent: pi-coding-agent` for Cloudflare hosts, and `x-opencode-session`/`x-opencode-client` for `opencode.ai`. Those injections are gone; a `models.json` endpoint now sends only the headers it resolves from provider and model configuration. Set them yourself under `headers` if an endpoint needs them.

## Use classifier models

Classifier models do not chat. They answer typed questions about JSON state: pick one of several choices, answer yes or no, or give a score, each with probabilities.

The only classifier models Pi lists come from a [llama.cpp router](llama-cpp.md#classification). Decision models that llama.cpp serves natively through `/v1/systemone` use the `typesafe-system-one` API; other loaded chat models are exposed as classifiers through `llama-cpp-classify`, which reads log-probabilities from the router. Both need no API key unless the router was started with `--api-key`.

Classifier models do not appear in `/model` and are not declared to the model. Extensions list them with `ctx.modelRegistry.getAvailableOfType("classifier")` and call `ctx.modelRegistry.classify(model, { state, questions })`, which answers typed `choice`, `bool`, and `score` questions about JSON state:

```typescript
const [localClassifier] = await ctx.modelRegistry.getAvailableOfType("classifier", "llamacpp");
if (localClassifier) {
  const result = await ctx.modelRegistry.classify(localClassifier, {
    state: { message: "The change works, thanks." },
    questions: {
      approved: {
        type: "bool",
        instructions: "Does the user approve of the result?",
        criteria: { true: "Approval", false: "No approval" },
      },
    },
  });
  // result.answers.approved
}
```

When the service reports token counts, `result.usage` carries them with their cost. The cost uses the model's catalog price; llama.cpp models report tokens at no cost.

[Virtual models](virtual-models.md#route-requests) can use classifiers to route requests; see the `jev-router.ts` example.

## Use image models

Image models do not chat. Declare them beside your chat models in `models.json` when the endpoint answers image requests over the OpenAI-compatible chat completions protocol:

```json
{
  "providers": {
    "painter": {
      "baseUrl": "http://localhost:8080/v1",
      "apiKey": "local",
      "api": "openai-completions",
      "imageApi": "openai-compatible-images",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ],
      "imageModels": [
        { "id": "flux-dev", "input": ["text", "image"], "output": ["image"] }
      ]
    }
  }
}
```

`openai-compatible-images` is the built-in image API implementation. It posts to the model's `baseUrl` with `modalities: ["image"]` (plus `"text"` when the model's `output` includes `"text"`) and reads results back from `choices[0].message.images[].image_url` data URLs. `imageApi` sets that API for every image model on the provider; a model's own `api` overrides it. `baseUrl` and `apiKey` default to the provider values, so chat and image models on one endpoint share authentication. `input` defaults to `["text"]` and `output` to `["text", "image"]`; `output` must include `"image"`. `modelOverrides` applies to chat models only.

An endpoint that speaks a different image protocol needs a provider extension that registers an image implementation for its own API id; see [Custom Providers](custom-provider.md).

Like classifier models, image models do not appear in `/model` and are not declared to the model. Extensions list them with `ctx.modelRegistry.getAvailableOfType("image")` and generate through `ctx.modelRegistry.generateImages(model, { input })`. The result's `output` holds base64 image blocks:

```typescript
const painter = ctx.modelRegistry
  .getModelsOfType("image", "pixels")
  .find((model) => model.id === "flux-pro");
if (painter) {
  const result = await ctx.modelRegistry.generateImages(painter, {
    input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
  });
  if (result.stopReason === "stop") {
    for (const block of result.output) if (block.type === "image") void block.data;
  }
}
```

`input` can also contain `{ type: "image", data, mimeType }` blocks to edit or use as references. Generated images are not saved to disk.

## Add a custom provider

Use an extension when the provider needs custom streaming, model discovery, or authentication behavior. See [Custom Providers](custom-provider.md) for the extension workflow.

## Troubleshooting

### A model does not appear

Confirm that its provider has usable authentication. Custom models can load from `models.json` but remain unavailable in `/model` until Pi can resolve credentials. For llama.cpp, only models currently loaded by the router appear.

### Authentication works in one shell only

Check whether the key came from an environment variable rather than `auth.json`. Environment variables must be present in the process that starts Pi.

### Sign-in opens a browser on a remote machine

Complete the provider's headless authentication flow when available. Some providers let you paste the final redirect URL or authorization code back into Pi. See [Authenticate interactively](providers.md#authenticate-interactively).

### A compatible endpoint rejects requests

Check its API type and compatibility settings in `models.json`. The upstream server must support the corresponding request fields and behavior.
