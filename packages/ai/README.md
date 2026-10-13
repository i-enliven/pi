# @i-enliven/pi-ai

Unified LLM API with provider collections, automatic auth resolution, token and cost tracking, and simple context persistence and hand-off to other models mid-session.

**Note**: The chat catalog only includes models that support tool calling (function calling), as this is essential for agentic workflows. Chat is the only model type this package lists.

## Table of Contents

- [Supported Providers](#supported-providers)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Providers and Models](#providers-and-models)
  - [Provider Factories](#provider-factories)
  - [All Built-in Providers](#all-built-in-providers)
  - [Querying Models](#querying-models)
  - [Static Catalog Reads](#static-catalog-reads)
  - [Dynamic Providers](#dynamic-providers)
- [Auth](#auth)
  - [How Auth Resolves](#how-auth-resolves)
  - [Transforming Request Headers](#transforming-request-headers)
  - [Credential Store](#credential-store)
  - [Environment Variables](#environment-variables)
- [Tools](#tools)
  - [Defining Tools](#defining-tools)
  - [Constrained Sampling for Tools](#constrained-sampling-for-tools)
  - [Handling Tool Calls](#handling-tool-calls)
  - [Streaming Tool Calls with Partial JSON](#streaming-tool-calls-with-partial-json)
  - [Validating Tool Arguments](#validating-tool-arguments)
  - [Complete Event Reference](#complete-event-reference)
  - [Compact Assistant Message Frames](#compact-assistant-message-frames)
- [Image Input](#image-input)
- [Thinking/Reasoning](#thinkingreasoning)
  - [Unified Interface (streamSimple/completeSimple)](#unified-interface-streamsimplecompletesimple)
  - [API-Specific Options (stream/complete)](#api-specific-options-streamcomplete)
  - [Streaming Thinking Content](#streaming-thinking-content)
- [Stop Reasons](#stop-reasons)
- [Error Handling](#error-handling)
  - [Aborting Requests](#aborting-requests)
  - [Continuing After Abort](#continuing-after-abort)
  - [Debugging Provider Payloads](#debugging-provider-payloads)
  - [Observing Provider Stream Events](#observing-provider-stream-events)
- [Custom Providers](#custom-providers)
  - [createProvider()](#createprovider)
  - [Calling API Implementations Directly](#calling-api-implementations-directly)
  - [Compatibility Settings](#compatibility-settings)
- [Faux Provider for Tests](#faux-provider-for-tests)
- [Cross-Provider Handoffs](#cross-provider-handoffs)
- [System Messages](#system-messages)
- [Context Serialization](#context-serialization)
- [Browser Usage](#browser-usage)
- [Bundling and Tree Shaking](#bundling-and-tree-shaking)
- [OAuth Providers](#oauth-providers)
  - [CLI Login](#cli-login)
  - [Programmatic OAuth](#programmatic-oauth)
- [Migrating from the Old Global API](#migrating-from-the-old-global-api)
- [License](#license)

## Supported Providers

- **GitHub Copilot** — the only built-in provider. Its catalog holds chat models over three wire protocols: `anthropic-messages`, `openai-completions`, and `openai-responses`. Authenticate with the Copilot OAuth device flow or with `COPILOT_GITHUB_TOKEN`.
- **faux** — an in-memory provider with scripted responses, for tests and demos. See [Faux Provider for Tests](#faux-provider-for-tests).
- **Any OpenAI- or Anthropic-compatible endpoint** — an Ollama, vLLM, LM Studio, gateway, or proxy deployment registered through [`createProvider()`](#createprovider).

Everything else was removed from this fork. There is no built-in catalog, provider factory, OAuth flow, or wire protocol for any other service.

## Installation

This fork does not publish to npm. Build the package from a clone of the fork repository:

```bash
git clone https://github.com/i-enliven/pi
cd pi
npm install --ignore-scripts
npm run build
```

The built package is at `packages/ai`. Install it into your own project from the checkout:

```bash
npm install --ignore-scripts /path/to/pi/packages/ai
```

TypeBox exports are re-exported from `@i-enliven/pi-ai`: `Type`, `Static`, and `TSchema`.

## Quick Start

You build a `Models` collection of providers and stream through it. The quickest start registers the built-in provider; apps that care about bundle size register individual providers instead (see [Provider Factories](#provider-factories) and [Bundling and Tree Shaking](#bundling-and-tree-shaking)).

```typescript
import { Type, type Context, type Tool } from '@i-enliven/pi-ai';
import { builtinModels } from '@i-enliven/pi-ai/providers/all';

// A Models collection with the built-in provider registered
const models = builtinModels();

// Sync lookup against the collection
const model = models.getModel('github-copilot', 'claude-sonnet-5')!;

// Define tools with TypeBox schemas for type safety and validation
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// Build a conversation context (easily serializable and transferable between models)
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

// Option 1: Streaming with all event types.
// Auth resolves through the provider (COPILOT_GITHUB_TOKEN or a stored credential here).
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // Partial tool arguments are being streamed
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

// Get the final message after streaming, add it to the context
const finalMessage = await s.result();
context.messages.push(finalMessage);

// Handle tool calls if any
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // Add tool result to context (supports text and images)
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// Continue if there were tool calls
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// Option 2: Get complete response without streaming
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

Snippets in the rest of this README assume a `models` collection set up like this (with the relevant providers registered).

## Providers and Models

A **provider** is the runtime unit: it owns its model catalog, its auth (API key resolution, OAuth flows), and its stream behavior. A `Models` collection holds providers and routes every request to the provider that owns the model.

Providers share three **API implementations** (the wire protocols): `anthropic-messages`, `openai-completions`, and `openai-responses`. GitHub Copilot is a mixed-API provider and dispatches per model.

### Provider Factories

For apps that only need specific providers, there is one factory per built-in provider, each a subpath import that pulls only that provider's catalog:

```typescript
import { createModels } from '@i-enliven/pi-ai';
import { githubCopilotProvider } from '@i-enliven/pi-ai/providers/github-copilot';

const models = createModels();
models.setProvider(githubCopilotProvider());
```

Provider factories import their model catalog and lazy API wrappers. They do not import other providers. With bundler code splitting, SDK implementations (`@anthropic-ai/sdk`, `openai`) stay in lazy chunks loaded on the first request to a model of that API.

### All Built-in Providers

For apps that want everything (as in Quick Start):

```typescript
import { builtinModels } from '@i-enliven/pi-ai/providers/all';

const models = builtinModels(); // a Models collection with every built-in provider registered
```

This imports every built-in catalog and provider factory. `builtinModels()` accepts the same options as `createModels()` (`credentials`, `authContext`, `modelsStore`); `builtinProviders()` returns the provider array if you want to register them on your own collection.

### Querying Models

Reads are synchronous and return the last-known lists:

```typescript
const providers = models.getProviders();                 // registered Provider objects
const provider = models.getProvider('github-copilot');   // one provider

const all = models.getModels();                          // every chat model across providers
const copilotModels = models.getModels('github-copilot');
const model = models.getModel('github-copilot', 'claude-sonnet-5');

for (const m of copilotModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  Context: ${m.contextWindow} tokens`);
  console.log(`  Vision: ${m.input.includes('image')}`);
  console.log(`  Reasoning: ${m.reasoning}`);
}
```

`getModels()`/`getModel()`/`getAvailable()` return chat models (`Model<Api>`) usable with `stream()`. `getModelsOfType('chat')` and `getAllModels()` return the same chat models through the type-keyed reads, which exist so callers can treat a provider's list uniformly:

```typescript
import { isModelType, getModelType } from '@i-enliven/pi-ai/utils/model-operations';

for (const model of models.getAllModels()) {
  if (isModelType(model, 'chat')) {
    // model: Model<Api>
  }
}
```

`type` is optional on chat models, so a model without `type` is a chat model. Do not compare `type` directly; narrow mixed lists with `isModelType()` or read the effective type with `getModelType()`.

Dynamically listed chat models are typed `Model<Api>`. Narrow with the `hasApi()` guard when you need API-specific option typing:

```typescript
import { hasApi } from '@i-enliven/pi-ai';

const m = models.getModel('github-copilot', 'claude-sonnet-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> — stream options fully typed
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### Static Catalog Reads

For tooling that wants the generated built-in catalog with full literal typing (provider and model IDs auto-complete), independent of any collection:

```typescript
import {
  getAllBuiltinModels,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from '@i-enliven/pi-ai/providers/all';

const model = getBuiltinModel('github-copilot', 'claude-sonnet-5'); // typed Model<'anthropic-messages'>
const providers = getBuiltinProviders();
const copilotChat = getBuiltinModels('github-copilot'); // Model[]
const copilotAll = getAllBuiltinModels('github-copilot'); // AnyModel[]
```

### Dynamic Providers

Providers may have dynamic model lists (a local inference server, a live gateway listing). Reads stay sync; fetching is an explicit async verb:

```typescript
// getModels() returns the last-known list (empty before the first refresh)
await models.refresh({ providers: ['local-server'] }); // refresh one provider
await models.refresh();                                // refresh all providers concurrently, best-effort
const fresh = models.getModel('local-server', 'my-coder:7b');
```

Static built-in providers are no-ops for `refresh()`. See [createProvider()](#createprovider) for building a dynamic provider.

## Auth

Every provider owns its auth: how API keys resolve (stored credentials, environment variables) and, where supported, OAuth login/refresh flows.

### How Auth Resolves

When you call `models.stream()`, the collection resolves auth through the owning provider and merges it into the request. Explicit per-request values always win:

```typescript
// Resolved through the provider (env var, stored credential, OAuth token):
await models.complete(model, context);

// Explicit key wins over anything the provider would resolve:
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

You can inspect resolution without making a request. Pass a provider ID for provider-scoped auth, or a model to include its static `model.headers`:

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
  console.log(`configured via ${modelAuth.source}`); // e.g. "COPILOT_GITHUB_TOKEN", "OAuth", "stored credential"
  console.log(modelAuth.auth.headers);              // Provider auth headers + model.headers
} else {
  console.log('not configured');
}
```

Both overloads resolve credentials, refresh expired OAuth when necessary, and may return an auth-derived `apiKey`, `headers`, or `baseUrl`. `getAuth()` resolves `undefined` for unconfigured providers and rejects with `ModelsError` when something is actually broken (`"oauth"`: token refresh failed, credential preserved for re-login; `"auth"`: key resolution or credential store failure). Request paths surface the same failures as stream errors.

`getAuth()`, `checkAuth()`, `getAvailable()`, login, and logout accept optional caller cancellation through their existing options or interaction objects and remain unbounded when no signal is supplied. Provider `login`, `ApiKeyAuth.check`, `ApiKeyAuth.resolve`, and `OAuthAuth.refresh` implementations always receive a concrete signal and must honor it for blocking work.

A stored credential *owns* its provider: ambient environment values are consulted only when nothing is stored, and a failed OAuth refresh never silently falls back to an environment key.

### Transforming Request Headers

`Models.stream()`, `complete()`, `streamSimple()`, and `completeSimple()` accept a Models-only `transformHeaders` option. It runs once after provider auth, `model.headers`, and explicit `options.headers` have been merged, but before provider dispatch:

```typescript
const response = await models.completeSimple(model, context, {
  headers: { "X-Client": "my-app" },
  transformHeaders: async (headers) => ({
    ...headers,
    "X-Request-ID": crypto.randomUUID(),
  }),
});
```

The ordering is:

```text
provider auth headers -> model.headers -> explicit options.headers -> transformHeaders -> Provider.stream*()
```

Header names are merged case-insensitively. Explicit headers override auth/model headers, and the transform has final control; returning `null` for a header suppresses lower-level defaults that support deletion.

`transformHeaders` belongs to `Models`, not `Provider`. A `Models` implementation must consume it and remove it before calling `Provider.stream*()`. Provider implementations continue receiving ordinary `ApiStreamOptions` or `SimpleStreamOptions` and never handle the transform themselves. Use this option instead of calling `getAuth(model)` before `stream*()`, which would resolve request auth twice.

### Credential Store

Stored credentials (API keys entered interactively, OAuth tokens) live in a `CredentialStore` — one type-tagged credential per provider. pi-ai ships an in-memory default; apps inject persistent storage:

```typescript
import { createModels, type CredentialStore } from '@i-enliven/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() takes the same options:
// const models = builtinModels({ credentials: myFileBackedStore });
```

The contract is small: `read(providerId)`, `list()` for non-secret `{ providerId, type }` metadata, `modify(providerId, fn)` (the only write path — a serialized read-modify-write), and `delete(providerId)`. Each operation accepts optional cancellation options. Enumeration must not resolve secrets or execute configured key commands. OAuth token refresh runs inside `modify`, so concurrent requests and processes cannot double-refresh a rotated token.

API-key credentials use the same discriminator as pi's `auth.json` and can carry provider-scoped env/config values:

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    PI_CACHE_RETENTION: 'long'
  }
} as const;
```

Reading a credential for a provider ID that no provider has registered is not an error; the entry is simply never consulted.

### Environment Variables

The built-in provider resolves this env var (Node.js; in browsers pass `apiKey` explicitly):

| Provider | Environment Variable(s) |
|----------|------------------------|
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

Custom providers declare their own variable names through [`envApiKeyAuth()`](#createprovider), so an endpoint you register has no reserved name. Provider-scoped values passed through the credential's `env` object or `options.env` take priority over the process environment.

## Tools

Tools enable LLMs to interact with external systems. This library uses TypeBox schemas for type-safe tool definitions with automatic validation using TypeBox's built-in validator and value conversion utilities. TypeBox schemas can be serialized and deserialized as plain JSON, making them ideal for distributed systems.

### Defining Tools

```typescript
import { Type, type Tool, StringEnum } from '@i-enliven/pi-ai';

// Define tool parameters with TypeBox
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: Type.Object({
    location: Type.String({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// Note: StringEnum emits a plain { "type": "string", "enum": [...] } schema.
// Use it instead of Type.Enum when an endpoint rejects the schema shape Type.Enum produces.

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

### Constrained Sampling for Tools

Tools can opt in to provider-side constrained sampling. For JSON-schema tools, `strict: 'prefer'` uses provider-side strict schema enforcement when supported and otherwise falls back to normal tool calling. `strict: 'require'` fails the request when the active provider/model cannot honor it. Set `constrainedSampling: false` to explicitly opt out; it behaves the same as omitting the field.

```typescript
const strictTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file',
  parameters: Type.Object({
    path: Type.String(),
    content: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: { type: 'json_schema', strict: 'prefer' }
};
```

Strict JSON-schema constrained sampling is supported on OpenAI Responses and Chat Completions models whose metadata sets `compat.supportsStrictMode`, and on Anthropic Messages models whose metadata sets `compat.supportsStrictTools`. Both default to `false`; the generated catalog sets them for capable models, and custom model definitions can opt in through `compat`.

OpenAI Responses and Chat Completions can also emit grammar-constrained custom tools with OpenAI Lark or regex grammar variants. If multiple variants are supplied, Lark is preferred over regex. Grammar capability is model metadata: the generated catalog sets `compat.supportsOpenAIGrammarTools` for models on endpoints that pass OpenAI custom tools through. Endpoints that normalize tool schemas mangle grammar tools, so the flag stays off elsewhere. Grammar-capable models reject grammar configurations without a non-empty supported variant. Native grammar tools must have an object parameter schema with exactly one required string property:

```typescript
const patchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a patch',
  parameters: Type.Object({
    input: Type.String()
  }, { additionalProperties: false }),
  constrainedSampling: {
    type: 'grammar',
    variants: {
      openai_lark: 'start: /.+/s'
    }
  }
};
```

### Handling Tool Calls

Tool results use content blocks and can include both text and images:

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// Check for tool calls in the response
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // Execute your tool with the arguments
    // See "Validating Tool Arguments" section for validation
    const result = await executeWeatherApi(block.arguments);

    // Add tool result with text content
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// Tool results can also include images (for vision-capable models)
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### Streaming Tool Calls with Partial JSON

During streaming, tool call arguments are progressively parsed as they arrive. This enables real-time UI updates before the complete arguments are available:

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments contains partially parsed JSON during streaming
    // This allows for progressive UI updates
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // BE DEFENSIVE: arguments may be incomplete
      // Example: Show file path being written even before content is complete
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // Content might be partial or missing
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // Here toolCall.arguments is complete (but not yet validated)
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**Important notes about partial tool arguments:**
- During `toolcall_delta` events, `arguments` contains the best-effort parse of partial JSON
- Fields may be missing or incomplete - always check for existence before use
- String values may be truncated mid-word
- Arrays may be incomplete
- Nested objects may be partially populated
- At minimum, `arguments` will be an empty object `{}`, never `undefined`
- Some endpoints do not stream function call arguments. Instead, you receive a single `toolcall_delta` event with the full arguments.

### Validating Tool Arguments

When implementing your own tool execution loop, use `validateToolCall` to validate arguments before passing them to your tools:

```typescript
import { validateToolCall, type Tool } from '@i-enliven/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // Validate arguments against the tool's schema (throws on invalid args)
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... add tool result to context
    } catch (error) {
      // Validation failed - return error as tool result so model can retry
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### Complete Event Reference

Successful generation follows `start → updates* → done`. A failure after generation starts follows `start → updates* → error`. Request setup may fail before generation starts, in which case the stream contains only `error`; `done` and update events are invalid before `start`. Direct API `streamSimple()` calls throw synchronously when request auth is missing.

Every non-terminal event's `partial` is the shared live response-so-far helper. It is intentionally not an event-time snapshot: providers may mutate the same message and content blocks as generation advances, including while older events wait in the stream queue. Inspect it when handling an event instead of retaining it as historical state. Text and ordinary thinking blocks are empty when their `*_start` event is emitted and grow only through matching `*_delta` events until the authoritative `*_end`; redacted thinking may be complete at start and emit no deltas. Tool-call arguments at `toolcall_start` are provider-specific; `toolcall_delta` carries subsequent JSON updates.

All streaming events emitted during assistant message generation:

| Event Type | Description | Key Properties |
|------------|-------------|----------------|
| `start` | Stream begins | `partial`: Initial assistant message structure |
| `text_start` | Text block starts | `contentIndex`: Position in content array |
| `text_delta` | Text chunk received | `delta`: New text, `contentIndex`: Position |
| `text_end` | Text block complete | `content`: Full text, `contentIndex`: Position |
| `thinking_start` | Thinking block starts | `contentIndex`: Position in content array |
| `thinking_delta` | Thinking chunk received | `delta`: New text, `contentIndex`: Position |
| `thinking_end` | Thinking block complete | `content`: Full thinking, `contentIndex`: Position |
| `toolcall_start` | Tool call begins | `contentIndex`: Position in content array |
| `toolcall_delta` | Tool arguments streaming | `delta`: JSON chunk, `partial.content[contentIndex].arguments`: Partial parsed args |
| `toolcall_end` | Tool call complete | `toolCall`: Complete, but not schema-validated, tool call with `id`, `name`, `arguments` |
| `done` | Stream complete | `reason`: Stop reason ("stop", "length", "toolUse"), `message`: Final assistant message |
| `error` | Error occurred | `reason`: Error type ("error" or "aborted"), `error`: AssistantMessage with partial content |

Streaming events for different content blocks are not guaranteed to be contiguous. Providers may emit deltas for text, thinking, and tool calls in the same upstream chunk, and pi may surface corresponding events interleaved, for example `text_start`, `text_delta`, `toolcall_start`, `text_delta`, `toolcall_delta`. Consumers must use `contentIndex` to associate each delta/end event with its block and must not assume that a block's `*_start`/`*_delta`/`*_end` sequence is uninterrupted by events for other blocks.

### Compact Assistant Message Frames

`AssistantMessageFrameEncoder` converts one stream into compact, persistable `AssistantMessageFrame` values. Create one encoder per stream and feed it every event in order. The encoder understands that `partial` is live: a block-start event consumed after the provider has already queued later deltas snapshots the current block once, and covered queued text/thinking deltas produce no duplicate frame. It retains only per-open-block counters plus, temporarily, the raw prefix needed to synchronize an already-advanced tool call. It never clones the growing full partial per token.

The start frame contains message metadata with empty content. Text and thinking frames store each generated character at most once before the authoritative end frame. Tool calls that were already advanced when their start event was consumed use one compact JSON checkpoint before ordinary deltas resume. Terminal `done` and `error` events produce no frame because final message settlement is separate. A pre-generation `error` therefore produces no frames.

`reduceAssistantMessageFrames()` is the canonical pure reducer. It reconstructs text, thinking, and tool-call arguments, including interleaved blocks identified by `contentIndex`, and rejects malformed sequences. It performs a single pass over the iterable and returns `undefined` when there is no start frame. End frames replace blocks with the provider's authoritative completed content and metadata. The reducer does not validate tool arguments against a TypeBox schema; call `validateToolCall` before execution.

```typescript
import {
  AssistantMessageFrameEncoder,
  reduceAssistantMessageFrames,
  type AssistantMessageFrame,
} from '@i-enliven/pi-ai';

const encoder = new AssistantMessageFrameEncoder();
const frames: AssistantMessageFrame[] = [];
for await (const event of s) {
  const frame = encoder.encode(event);
  if (frame) frames.push(frame);
}

const reconstructedPartial = reduceAssistantMessageFrames(frames);
const finalMessage = await s.result(); // Persist terminal settlement separately.
```

An encoder rejects duplicate starts, updates before start, `done` before start, events after a terminal event, duplicate block starts, and block-kind mismatches. An `error` before start is valid and returns no frame.

## Image Input

Models with vision capabilities can process images. You can check if a model supports images via the `input` property. If you pass images to a non-vision model, they are silently ignored.

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('github-copilot', 'claude-sonnet-5')!;

// Check if model supports images
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// Access the response
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

Image *generation* is not part of this library. Only chat messages carry images, in user content and in tool results.

## Thinking/Reasoning

Many models support thinking/reasoning capabilities where they can show their internal thought process. You can check if a model supports reasoning via the `reasoning` property. If you pass reasoning options to a non-reasoning model, they are silently ignored.

### Unified Interface (streamSimple/completeSimple)

```typescript
const model = models.getModel('github-copilot', 'claude-sonnet-5')!;
// or models.getModel('github-copilot', 'gpt-5.5');
// or models.getModel('local-server', 'my-coder:7b');

// Check if model supports reasoning
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// Use the simplified reasoning option
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// Access thinking and text blocks
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

`xhigh` and `max` are model-specific, opt-in levels. Use `getSupportedThinkingLevels(model)` to determine whether a concrete model exposes either level; models such as GPT-5.6 can expose both.

### API-Specific Options (stream/complete)

`models.stream()`/`complete()` accept the owning API's full option set. Use `hasApi()` to narrow a dynamically looked-up model to its API for full option typing:

```typescript
import { hasApi } from '@i-enliven/pi-ai';

// OpenAI Responses reasoning
const responsesModel = models.getModel('github-copilot', 'gpt-5-mini')!;
if (hasApi(responsesModel, 'openai-responses')) {
  await models.complete(responsesModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'
  });
}

// Anthropic Messages thinking
const messagesModel = models.getModel('github-copilot', 'claude-sonnet-5')!;
if (hasApi(messagesModel, 'anthropic-messages')) {
  await models.complete(messagesModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // budget-based models only
  });
}

// OpenAI Chat Completions
const completionsModel = models.getModel('local-server', 'my-coder:7b')!;
if (hasApi(completionsModel, 'openai-completions')) {
  await models.complete(completionsModel, context, {
    reasoningEffort: 'high'
  });
}
```

Adaptive-thinking models ignore `thinkingBudgetTokens`; they use `effort` instead. Check the model's `compat.forceAdaptiveThinking` and `thinkingLevelMap` before setting budget-based options explicitly.

### Streaming Thinking Content

When streaming, thinking content is delivered through specific events:

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // Stream thinking content
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## Stop Reasons

Every `AssistantMessage` includes a `stopReason` field that indicates how the generation ended:

- `"pending"` - Only present in partial messages when we do not know what the stop reason will be
- `"stop"` - This is the final message the model will produce this turn
- `"length"` - Output hit the maximum token limit
- `"toolUse"` - Model is calling tools and expects tool results
- `"error"` - An error occurred during generation
- `"aborted"` - Request was cancelled via abort signal

`AssistantMessage` may also include `responseId`, a provider-specific upstream response or message identifier when the underlying API exposes one. Do not assume it is always present across providers.

## Error Handling

Request failures after a stream is returned never throw: when a request ends with an error (including aborts and tool call validation errors), the streaming API emits an error event and the final message carries the details. Setup failures may emit `error` without `start`; failures after generation begins emit `start`, any observed updates, then `error`. Direct API `streamSimple()` calls throw synchronously when request auth is missing:

```typescript
// In streaming
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason is either "error" or "aborted"
    // event.error is the AssistantMessage with partial content
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// The final message will have the error details
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content contains any partial content received before the error
  // message.usage contains partial token counts and costs
}
```

When using a provider collection, auth failures (OAuth refresh failed, unknown provider) surface as a stream error with `stopReason: "error"`. Direct API `streamSimple()` calls instead throw synchronously when their required auth is absent.

### Aborting Requests

The abort signal allows you to cancel in-progress requests. Aborted requests have `stopReason === 'aborted'`:

```typescript
const controller = new AbortController();

// Abort after 2 seconds
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: 'Write a long story', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason tells you if it was "error" or "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// Get results (may be partial if aborted)
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

### Continuing After Abort

Aborted messages can be added to the conversation context and continued in subsequent requests:

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail', timestamp: Date.now() }
  ]
};

// First request gets aborted after 2 seconds
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// Add the partial response to context
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue', timestamp: Date.now() });

// Continue the conversation
const continuation = await models.complete(model, context);
```

### Debugging Provider Payloads

Use the `onPayload` callback to inspect the request payload sent to the provider. This is useful for debugging request formatting issues or provider validation errors.

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

The callback is supported by `stream`, `complete`, `streamSimple`, and `completeSimple`.

### Observing Provider Stream Events

Use `onProviderStreamEvent` to inspect provider-specific fields that Pi does not include in `AssistantMessage`. The callback receives the parsed event available to the adapter before Pi normalizes it. Treat the event as read-only because mutations can affect normalization. This is not guaranteed to be the original HTTP bytes or SSE frame.

```typescript
const response = await models.complete(model, context, {
  onProviderStreamEvent: (data) => {
    const chunk = data as Record<string, unknown>;
    if (chunk.model) console.log(`upstream model: ${chunk.model}`);
  },
});
```

Callbacks are awaited in stream order, so slow callbacks delay stream consumption and thrown errors fail the request. SDK-backed adapters can expose only fields retained by their SDK.

## Custom Providers

### createProvider()

`createProvider()` builds a provider from parts: identity, auth, a model list, and a chat API implementation (`api`). Use it for local inference servers, proxies, or any OpenAI- or Anthropic-compatible endpoint:

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@i-enliven/pi-ai';
import { openAICompletionsApi } from '@i-enliven/pi-ai/api/openai-completions.lazy';

const localModel: Model<'openai-completions'> = {
  id: 'my-coder:7b',
  name: 'My Coder 7B (local server)',
  api: 'openai-completions',
  provider: 'local-server',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const localServer = createProvider({
  id: 'local-server',
  name: 'Local server',
  baseUrl: 'http://localhost:11434/v1',
  // Every provider declares auth; keyless local servers resolve as configured with no key.
  auth: { apiKey: { name: 'Local server', resolve: async () => ({ auth: {} }) } },
  models: [localModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(localServer);

await models.complete(models.getModel('local-server', 'my-coder:7b')!, context);
```

For providers with real keys, `envApiKeyAuth(displayName, envVars)` gives the standard behavior (stored credential wins, then the first set env var):

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

Mixed-API providers pass a map keyed by `model.api`; each model dispatches to its API's implementation:

```typescript
import { anthropicMessagesApi } from '@i-enliven/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@i-enliven/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* models with api: 'anthropic-messages' or 'openai-responses' */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

Provider-wide endpoint or request transformations belong in the provider's API implementation: wrap the `ProviderStreams` you pass as `api` so every request goes through the transformation before dispatch.

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

Dynamic model lists use `fetchModels`. `Models.refresh()` refreshes every configured dynamic provider, passing its effective API-key or refreshed OAuth credential. A `ModelsStore` persists dynamic catalogs; both stores default to in-memory implementations. Its `read`, `write`, and `delete` operations accept optional cancellation, and `Models` binds those waits to the provider refresh signal.

```typescript
const models = createModels({ credentials, modelsStore });
const localServer = createProvider({
  id: 'local-server',
  auth: { apiKey: { name: 'Local server', resolve: async () => ({ auth: {} }) } },
  models: [],
  fetchModels: async ({ signal }) => fetchModelsFromServer('http://localhost:11434/v1', signal),
  api: openAICompletionsApi(),
});

models.setProvider(localServer);
const result = await models.refresh({ signal });
if (result.aborted) console.log('refresh cancelled');
for (const [provider, error] of result.errors) console.error(provider, error);
```

`Models.refresh()` is unbounded when its optional signal is omitted. Providers always receive a concrete `RefreshModelsContext.signal` and must honor it for network requests and other blocking work. When a caller supplies a signal, `Models.refresh()` returns promptly with `aborted: true` after cancellation even if a custom provider fails to cooperate; the provider must still honor the signal to stop its underlying work.

Use `models.refresh({ providers: ['local-server'] })` to restrict work to selected providers, `models.refresh({ allowNetwork: false })` to restore persisted catalogs without network access, or `models.refresh({ force: true })` to bypass provider freshness checks. Model reads stay synchronous and return the last restored or refreshed list.

`createProvider()` handles dynamic publication and persistence automatically. Handwritten `Provider.refreshModels()` implementations receive the read-only `context.stored` snapshot and publish through `context.publish({ persist?, update? })`. Omit `persist` to leave storage unchanged, pass a `ModelsStoreEntry` to write it, or pass `persist: null` to delete it. Publication is generation-checked; put synchronous in-memory catalog changes in `update` rather than mutating state before publication.

Custom models can carry `headers` (e.g. proxies behind bot detection) and `compat` flags. `Models.getAuth(model)` includes those model headers, and stream methods merge them before explicit request headers and `transformHeaders`. See [Compatibility Settings](#compatibility-settings).

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so the system prompt is sent as a `system` message instead. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too. This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers.

Use model-level `thinkingLevelMap` to describe model-specific thinking controls. Keys are pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Missing standard levels through `high` use provider defaults; `xhigh` and `max` are opt-in and require a non-null map entry. String values are sent to the provider, `null` marks a level unsupported, and maps may skip levels.

```typescript
const localReasoningModel: Model<'openai-completions'> = {
  id: 'my-thinker:20b',
  name: 'My Thinker 20B (local server)',
  api: 'openai-completions',
  provider: 'local-server',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### Calling API Implementations Directly

The API implementations are importable on their own. Each module exports exactly `stream` and `streamSimple` with that API's full option typing. Direct calls bypass provider auth and context normalization — pass `apiKey` explicitly and wrap the context in `normalizeContext()`:

```typescript
import { normalizeContext } from '@i-enliven/pi-ai';
import { stream } from '@i-enliven/pi-ai/api/anthropic-messages';

const s = stream(copilotModel, normalizeContext(context), {
  apiKey: process.env.COPILOT_GITHUB_TOKEN,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

Built-in API implementations live under `./api/<api-id>`:

| API id | Options type |
|--------|--------------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |

Importing an implementation module loads its SDK. The `./api/<id>.lazy` wrappers (used by the provider factories) defer that load to the first request when the runtime or bundler supports dynamic import chunking. `./api/<api-id>` is the only API entry point; the per-provider subpaths from older releases are gone.

### Compatibility Settings

The `openai-completions` API is implemented by many servers with minor differences, and `anthropic-messages` and `openai-responses` have their own compatibility surface for gateways. Set `compat` on a model to describe a difference you have verified on the endpoint. Nothing is inferred from the base URL: unset fields use the fixed defaults below, so an endpoint that deviates from the spec must declare the deviation. Partially set objects keep those defaults for the fields you omit.

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // Whether provider supports the `store` field (default: true, OpenAI spec)
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true, OpenAI spec)
  supportsReasoningEffort?: boolean; // Whether provider supports `reasoning_effort` (default: true, OpenAI spec)
  supportsUsageInStreaming?: boolean; // Whether provider supports `stream_options: { include_usage: true }` (default: true)
  supportsFinishReason?: boolean;    // Whether streamed responses include `finish_reason`; when false, pi infers it at stream end (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports `strict` in tool definitions (default: false; enabled in metadata for capable built-in models)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
  supportsMidConvoSystemMessages?: boolean; // Whether the model accepts system messages after the conversation started; false folds them into the leading prompt (default: false; the generated catalog enables it for verified models)
  supportsMidConvoToolAdditions?: boolean; // Whether system messages can add tools mid-conversation; requires supportsMidConvoSystemMessages (default: false)
  supportsLongCacheRetention?: boolean; // Whether provider supports long prompt cache retention (default: true)
  sendSessionAffinityHeaders?: boolean; // Send session-affinity data from `sessionId` (default: false)
  sessionAffinityFormat?: 'openai' | 'openai-nosession'; // 'openai' uses `prompt_cache_key`, `session_id`, `x-client-request-id`, and `x-session-affinity`; 'openai-nosession' uses `prompt_cache_key`, `x-client-request-id`, and `x-session-affinity` (default: 'openai')
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // Which field name to use (default: 'max_completion_tokens', OpenAI spec)
  requiresToolResultName?: boolean;  // Whether tool results require the `name` field (default: false)
  requiresAssistantAfterToolResult?: boolean; // Whether tool results must be followed by an assistant message (default: false)
  requiresThinkingAsText?: boolean;  // Whether thinking blocks must be converted to text (default: false)
  requiresReasoningContentOnAssistantMessages?: boolean; // Whether all replayed assistant messages must include empty reasoning_content when reasoning is enabled (default: false)
  thinkingFormat?: 'openai' | 'chat-template' | 'string-thinking'; // 'openai' uses reasoning_effort, 'chat-template' uses configurable chat_template_kwargs, 'string-thinking' uses top-level thinking (default: 'openai')
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_kwargs values; use $var for pi-controlled thinking values
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'; // Top-level field that caps reasoning tokens from thinkingBudgets. Off by default.
  supportsThinkingTokenBudget?: boolean; // Alias for thinkingTokenBudgetField: 'thinking_token_budget'. Prefer thinkingTokenBudgetField. Default: false.
  cacheControlFormat?: 'anthropic';  // Anthropic-style cache_control on system prompt, last tool, and last user/assistant/tool-result text content
  vllmPriority?: number;             // vLLM scheduler priority sent as top-level `priority`
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  supportsMidConvoSystemMessages?: boolean; // Whether the model accepts system messages after the conversation started (default: false)
  sessionAffinityFormat?: 'openai' | 'openai-nosession'; // 'openai' sends `session_id` and `x-client-request-id`; 'openai-nosession' sends `x-client-request-id`. Does not affect the `prompt_cache_key` body param (default: 'openai')
  supportsLongCacheRetention?: boolean; // Whether provider supports long prompt cache retention (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports strict JSON-schema function tools (default: false; enabled in metadata for capable built-in models)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools (default: false)
  supportsAdditionalTools?: boolean; // Whether the model accepts message-anchored `additional_tools` input items (default: false)
  supportsToolSearch?: boolean;      // Whether the model accepts client-executed tool search (default: false)
  supportsExplicitPromptCacheMode?: boolean; // Whether the model accepts `prompt_cache_options` (default: false)
  supportsMaxOutputTokens?: boolean; // Whether the provider accepts `max_output_tokens` (default: true)
}

interface AnthropicMessagesCompat {
  supportsEagerToolInputStreaming?: boolean; // Whether the provider accepts per-tool `eager_input_streaming` (default: true)
  supportsLongCacheRetention?: boolean; // Whether the provider supports `cache_control.ttl: "1h"` (default: true)
  sendSessionAffinityHeaders?: boolean; // Send `x-session-affinity` from `sessionId` when caching is enabled (default: false)
  supportsCacheControlOnTools?: boolean; // Whether the provider accepts `cache_control` on tool definitions (default: true)
  supportsTemperature?: boolean;     // Whether the model accepts the `temperature` request field (default: true)
  forceAdaptiveThinking?: boolean;   // Force adaptive thinking regardless of model id (default: false)
  allowEmptySignature?: boolean;     // Replay empty thinking signatures as `signature: ""` instead of converting thinking to text (default: false)
  supportsStrictTools?: boolean;     // Whether the provider supports Anthropic strict tool schemas (default: false)
  supportsMidConvoEffort?: boolean;  // Whether the transport supports effort-only system messages (default: false)
  supportsMidConvoSystemMessages?: boolean; // Whether the model accepts system-role messages inside the conversation (default: false)
  supportsMidConvoToolChanges?: boolean; // Whether the model accepts mid-conversation `tool_addition`/`tool_removal` blocks (default: false)
  allowedFallbackModels?: AnthropicAllowedFallbackModel[]; // Models the provider accepts as server-side refusal fallbacks
}
```

Chat Completions and Anthropic Messages send session-affinity headers only when the corresponding flag is on. Explicit request headers take precedence over generated headers.

This is useful for:

- **LiteLLM proxies**: May not support `store` field
- **Custom inference servers**: May use non-standard field names
- **Self-hosted endpoints**: May have different feature support

## Faux Provider for Tests

`fauxProvider()` builds an in-memory provider with scripted responses for tests and demos:

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@i-enliven/pi-ai';

const faux = fauxProvider({
  tokensPerSecond: 50 // optional
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: 'Summarize package.json and then call echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Need to inspect package metadata first.'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Now I can summarize the tool output.'),
    fauxText('Here is the summary.')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// Optional: multiple faux models for model-switching tests
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

Notes:
- Responses are consumed from a queue in request start order.
- If the queue is empty, the faux provider returns an assistant error message with `errorMessage: "No more faux responses queued"`.
- Use `faux.setResponses([...])` to replace the remaining queue and `faux.appendResponses([...])` to add more responses.
- `faux.models` exposes all faux models. `faux.getModel()` returns the first one, and `faux.getModel(id)` returns a specific one.
- Use `fauxAssistantMessage(...)` for scripted assistant replies. Use `fauxText(...)`, `fauxThinking(...)`, and `fauxToolCall(...)` to build content blocks without filling in low-level fields manually.
- Usage is estimated at roughly 1 token per 4 characters. When `sessionId` is present and `cacheRetention` is not `"none"`, prompt cache reads and writes are simulated automatically.
- Tool call arguments stream incrementally via `toolcall_delta` chunks.
- By default, each streamed chunk is emitted on its own microtask. Set `tokensPerSecond` to pace chunk delivery in real time.
- The intended use is one deterministic scripted flow per handle. If you need independent concurrent flows, create separate faux providers with distinct `provider` ids.

## Cross-Provider Handoffs

The library supports handoffs between different providers within the same conversation. This allows you to switch models mid-conversation while preserving context, including thinking blocks, tool calls, and tool results.

When messages from one provider are sent to a different provider, the library transforms them for compatibility:

- **User and tool result messages** are passed through unchanged
- **Assistant messages from the same provider/API** are preserved as-is
- **Assistant messages from different providers** have their thinking blocks converted to text with `<thinking>` tags
- **Tool calls and regular text** are preserved unchanged

```typescript
import { createModels, type Context } from '@i-enliven/pi-ai';
import { githubCopilotProvider } from '@i-enliven/pi-ai/providers/github-copilot';
import { createProvider, envApiKeyAuth } from '@i-enliven/pi-ai';
import { openAICompletionsApi } from '@i-enliven/pi-ai/api/openai-completions.lazy';

const models = createModels();
models.setProvider(githubCopilotProvider());
models.setProvider(createProvider({
  id: 'local-server',
  auth: { apiKey: envApiKeyAuth('Local server key', ['LOCAL_SERVER_API_KEY']) },
  baseUrl: 'http://localhost:11434/v1',
  models: [localModel],
  api: openAICompletionsApi(),
}));

const context: Context = { messages: [] };

// Start on a Copilot model
const copilot = models.getModel('github-copilot', 'claude-sonnet-5')!;
context.messages.push({ role: 'user', content: 'What is 25 * 18?', timestamp: Date.now() });
context.messages.push(await models.completeSimple(copilot, context, { reasoning: 'medium' }));

// Replay the same transcript on the local model
const local = models.getModel('local-server', 'my-coder:7b')!;
context.messages.push({ role: 'user', content: 'Is that calculation correct?', timestamp: Date.now() });
context.messages.push(await models.complete(local, context));
```

All providers can handle messages from other providers — text, tool calls and results (including images), thinking blocks (transformed to tagged text), and aborted messages with partial content. This enables flexible workflows: start with a fast model, switch to a more capable one for complex reasoning, or maintain continuity across provider outages.

## System Messages

`Context.systemPrompt` and `Context.tools` are shorthand for a leading system message. The public entry points (`Models.stream()`, `streamSimple()`, `complete()`, `completeSimple()`) accept a `Context` and call `normalizeContext()` once; everything below them, including `Provider.stream()`, `ProviderStreams`, and the API implementation modules, receives the resulting `TranscriptContext`, which only has `messages`. The transcript can also carry system messages later in the conversation to change the prompt or the tool set without rewriting the history:

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];             // leading: base prompt; later: added instructions
  sections?: Record<string, string | null>;    // named prompt sections; later messages patch by name, null removes
  toolsAdded?: Tool[];                         // tools that become available here
  toolsRemoved?: ToolReference[];              // tools that stop being available here
  timestamp: number;
}
```

Sections are opaque text rendered verbatim after `content`, joined by blank lines. Keep each one self-delimiting (a tag, a heading) so the model can relate an update to the original. Replaying every system message in order yields the current prompt and tools; the replay helpers take the message list:

```typescript
import { getCurrentSystemPrompt, getCurrentTools } from "@i-enliven/pi-ai";

const messages: Message[] = [
  { role: "system", content: "You are helpful.", sections: { rules: "<rules>Be brief.</rules>" }, toolsAdded: [readTool], timestamp: 1 },
  { role: "user", content: "hi", timestamp: 2 },
  { role: "system", content: "", sections: { rules: "<rules>Be thorough.</rules>" }, toolsRemoved: [{ name: "read" }], timestamp: 3 },
];
getCurrentSystemPrompt(messages); // "You are helpful.\n\n<rules>Be thorough.</rules>"
getCurrentTools(messages);        // []
```

A custom `Provider` or `ProviderStreams` implementation reads the prompt and tools the same way from `context.messages`; `context.systemPrompt` and `context.tools` do not exist at that layer.

Models that accept system messages mid-conversation (`supportsMidConvoSystemMessages` in the model's compat settings, set by the generated catalog for verified models) receive each later system message in place, so the cached prefix stays intact; section changes are framed by name for the model. Every other model receives `collapseSystemMessages(transcript)`: the replayed prompt and current tools as the leading system message, with later system messages dropped. Anthropic Messages models that also set `supportsMidConvoToolChanges` send tool changes as native blocks (`inline-tools-2026-09-15` beta): the top-level tool list holds the initial tools plus a stable deferred placeholder and never changes, later tools are defined by value in `tool_addition` blocks (a new definition under an existing name replaces the old one), and removals are `tool_removal` references, so tool changes do not invalidate the prompt cache. That needs at least one initial tool; otherwise the current tool list is sent at the top level with the system text only. OpenAI Responses models with `supportsAdditionalTools` or `supportsToolSearch` anchor additive tool changes at their message; everything else sends the current tool list at the top level.

## Context Serialization

The `Context` object can be easily serialized and deserialized using standard JSON methods, making it simple to persist conversations, implement chat history, or transfer contexts between services:

```typescript
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?', timestamp: Date.now() }
  ]
};

const model = models.getModel('github-copilot', 'claude-sonnet-5')!;
const response = await models.complete(model, context);
context.messages.push(response);

// Serialize the entire context
const serialized = JSON.stringify(context);

// Save to database, localStorage, file, etc.
localStorage.setItem('conversation', serialized);

// Later: deserialize and continue the conversation
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system', timestamp: Date.now() });

// Continue with any model
const newModel = models.getModel('github-copilot', 'gpt-5-mini')!;
const continuation = await models.complete(newModel, restored);
```

Models are plain serializable data too — no functions or implementations attached — so persisting "which model was this conversation using" is a `JSON.stringify` away.

> **Note**: If the context contains images (encoded as base64 as shown in the Image Input section), those will also be serialized.

## Browser Usage

The library supports browser environments. The core entrypoint and provider factories are side-effect free and bundle cleanly. Environment variables are not available in browsers, so pass API keys explicitly — or inject a `CredentialStore` (e.g. localStorage-backed) and let provider auth resolve from stored credentials:

```typescript
import { createModels } from '@i-enliven/pi-ai';
import { githubCopilotProvider } from '@i-enliven/pi-ai/providers/github-copilot';

const models = createModels();
models.setProvider(githubCopilotProvider());

const model = models.getModel('github-copilot', 'claude-sonnet-5')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: 'Hello!', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **Security Warning**: Exposing API keys in frontend code is dangerous. Anyone can extract and abuse your keys. Only use this approach for internal tools or demos. For production applications, use a backend proxy that keeps your API keys secure.

Browser compatibility notes:

- OAuth login flows are Node-only. They are lazy-loaded behind bundler-opaque imports, so registering an OAuth-capable provider does not pull Node-only code into a browser bundle — only actually logging in would.
- Use a server-side proxy or backend service if you need OAuth-based auth from a web app.

## Bundling and Tree Shaking

For small bundles and low-overhead unbundled scripts, import the model runtime and only the providers you need:

```typescript
import { createModels } from '@i-enliven/pi-ai/models';
import { githubCopilotProvider } from '@i-enliven/pi-ai/providers/github-copilot';

const models = createModels();
models.setProvider(githubCopilotProvider());
```

Rules:

- `@i-enliven/pi-ai/models` exports the model runtime (`createModels`, `createProvider`, model helpers, and their types) without TypeBox, built-in catalogs, or SDK implementations. Other types can still use `import type` from the root.
- `@i-enliven/pi-ai` is the core entrypoint and does not import built-in catalogs, real provider factories, or SDK implementations, but it eagerly imports TypeBox and schema validation. Unbundled Node scripts do not tree-shake its unused exports; prefer `./models`, `./providers/faux`, and specific `./utils/*` subpaths when those are all you need.
- `@i-enliven/pi-ai/providers/<provider>` imports that provider's catalog and lazy API wrappers only.
- `@i-enliven/pi-ai/providers/all` imports every built-in provider factory and all catalogs.
- With code splitting, provider SDKs stay in lazy chunks and load on first request.
- Without code splitting, bundlers fold reachable lazy API implementations into the single bundle. A single-provider bundle then includes that provider's SDKs; `providers/all` includes all statically visible SDKs.
- Importing `@i-enliven/pi-ai/api/<api-id>` directly loads that API implementation and its SDK immediately.

Avoid `@i-enliven/pi-ai/compat` in new bundled apps; it preserves the old global API and imports the full built-in catalog surface.

For single-file Node ESM bundles, some SDK dependencies may still use dynamic CommonJS `require()` internally. If you see errors such as `Dynamic require of "child_process" is not supported`, add a Node `require` shim to the bundle. With esbuild:

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

This is only for Node bundles; it is not a browser workaround.

### Provider-Scoped Environment Overrides

Pass `env` in stream options to scope provider configuration to a request. Values in `env` are used before process environment variables for provider auth and configuration such as `COPILOT_GITHUB_TOKEN`, `PI_CACHE_RETENTION`, and `HTTP_PROXY`/`HTTPS_PROXY`.

```typescript
const models = builtinModels();
const model = models.getModel('github-copilot', 'claude-sonnet-5')!;

const response = await models.complete(model, context, {
  env: {
    COPILOT_GITHUB_TOKEN: '...',
    PI_CACHE_RETENTION: 'long'
  }
});
```

Use this when one process needs different provider settings per request, or when ambient environment variables should not leak into a provider call.

## OAuth Providers

GitHub Copilot is the only provider with an OAuth flow in this fork. It signs in with the device-code flow and reports the models available to the account.

The provider carries an `OAuthAuth` on `provider.auth.oauth` with three operations: `login(interaction)` uses the provider-neutral `AuthInteraction.prompt()`/`notify()` protocol and returns a credential, `refresh(credential, signal)` refreshes the expiring token, and `toAuth(credential)` derives request auth (GitHub Copilot's per-account base URL comes from here). Provider login interactions and refresh calls always carry a concrete abort signal. Refresh is automatic: `models.getAuth(providerId)` and request paths refresh expired tokens under a credential-store lock, so concurrent requests and processes cannot double-refresh.

```typescript
import { createModels } from '@i-enliven/pi-ai';
import { githubCopilotProvider } from '@i-enliven/pi-ai/providers/github-copilot';

const models = createModels({ credentials: myStore }); // persistent CredentialStore
models.setProvider(githubCopilotProvider());

// Login: Models drives the flow and persists the credential
await models.login('github-copilot', 'oauth', {
  prompt: async (p) => {
    // p.type: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code prompts race a local callback server; p.signal aborts them when the server wins
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type: 'info' | 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'info') {
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`${link.label ?? 'More information'}: ${link.url}`);
    }
    if (event.type === 'auth_url') console.log(`Open: ${event.url}`);
    if (event.type === 'device_code') console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});

// From here on, requests resolve and refresh the token automatically
const model = models.getModel('github-copilot', 'claude-sonnet-5')!;
await models.complete(model, context);

// Logout
await models.logout('github-copilot');
```

If you get "The requested model is not supported" from GitHub Copilot, enable the model manually in VS Code: open Copilot Chat, click the model selector, select the model (warning icon), and click "Enable".

### CLI Login

The quickest way to authenticate:

```bash
# from the repository root, after npm run build
node packages/ai/dist/cli.js login              # interactive provider selection
node packages/ai/dist/cli.js login github-copilot
node packages/ai/dist/cli.js list               # list available providers
```

Credentials are saved to `auth.json` in the current directory.

### Programmatic OAuth

Built-in login and refresh flows are private provider implementations. Use provider-owned `OAuthAuth`, which composes with `CredentialStore` and gets locked auto-refresh through `Models`. The `@i-enliven/pi-ai/oauth` entry point retains only type declarations required by coding-agent extension OAuth compatibility.

## Migrating from the Old Global API

Older versions exposed a global API: `stream()`/`complete()` dispatching on `model.api` via a global registry, sync `getModel()`/`getModels()`/`getProviders()` catalog reads, `registerApiProvider()`, `getEnvApiKey()`, and per-API lazy stream functions. That surface lives unchanged on the **compat entrypoint**:

```typescript
// Before
import { getModel, complete } from '@i-enliven/pi-ai';

// After (verbatim behavior, one import-path change)
import { getModel, complete } from '@i-enliven/pi-ai/compat';
```

Compat is a strict superset of the root entrypoint, so a file can switch its import path wholesale. It will be removed in a future release; migrate to `createModels()` + provider factories:

| Old | New |
|-----|-----|
| `getModel('github-copilot', 'claude-sonnet-5')` | `models.getModel('github-copilot', 'claude-sonnet-5')` or `getBuiltinModel()` from `providers/all` |
| `getModels('github-copilot')` / `getProviders()` | `models.getModels('github-copilot')` / `models.getProviders()` or `getBuiltin*` |
| `stream(model, ctx, opts)` (env-key injection) | `models.stream(model, ctx, opts)` (provider auth resolution) |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('github-copilot')` | `await models.getAuth(model.provider)` |
| `streamAnthropic(model, ctx, opts)` | `stream` from `@i-enliven/pi-ai/api/anthropic-messages`, or a provider in a collection |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |

## License

MIT