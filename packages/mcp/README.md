# @i-enliven/pi-mcp

A small, standalone Model Context Protocol client. It does not depend on the official MCP SDK or other pi packages.

The package provides a transport-neutral client core, stdio and Streamable HTTP transports, and an in-memory testing transport.

## Installation

This fork does not publish to npm. Build the package from a clone of the fork repository:

```bash
git clone https://github.com/i-enliven/pi
cd pi
npm install --ignore-scripts
npm run build
```

The built package is at `packages/mcp`. Install it into your own project from the checkout:

```bash
npm install --ignore-scripts /path/to/pi/packages/mcp
```

## Usage

```typescript
import { McpClient, StdioTransport } from "@i-enliven/pi-mcp";

const transport = new StdioTransport({
	command: "npx",
	args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
});
const client = new McpClient({
	name: "my-client",
	version: "1.0.0",
	roots: [{ uri: "file:///workspace", name: "workspace" }],
});

await client.connect(transport);
const tools = await client.listTools();
const result = await client.callTool("search", { query: "MCP" });
await client.close();
```

For a remote server, use `new StreamableHttpTransport({ url, headers })`. Fetch can be injected for proxying or custom networking.

### Server sessions

`McpServerSession` owns one server's connection policy, so a host does not re-implement it: connect retries, the single retry of an idempotent request after a transient failure, reconnecting when a call finds the connection gone, needs-auth, and the server output added to a failure message.

```typescript
import { McpClient, McpServerSession, StreamableHttpTransport, type Tool } from "@i-enliven/pi-mcp";

/** What the server offered at the last connect that reached `connected`. */
let serverTools: Tool[] = [];

const session = new McpServerSession({
	name: "docs",
	createClient: () => new McpClient({ name: "my-client", version: "1.0.0" }),
	createTransport: () => new StreamableHttpTransport({ url: "https://mcp.example.com/mcp" }),
	connectRetryDelaysMs: [250, 1000],
	onConnected: async (client) => {
		// Read what the server offers before the state becomes "connected".
		serverTools = await client.listTools();
	},
	onStateChange: (state, error) => console.log(state, error),
});

// `call` is never retried, because the server may have performed it. `read` is.
const result = await session.call((client) => client.callTool("search", { query: "MCP" }));
await session.close();
```

`session.state` is `connecting`, `connected`, `disconnected`, `needs-auth`, `failed`, or `closed`, and `session.error` carries the failure text plus, when the transport offers `diagnostics`, the tail of what the server printed (stdio supplies its buffered stderr). A connect that ran out of retries rejects with `McpConnectFailedError` (`cause` is the last transport error); a server that keeps rejecting the credentials rejects with `McpNeedsAuthError`. Hosts that decide authorization differently pass `isAuthorizationError`.

`isTransientMcpError(error)` is the one rule both the session and the HTTP transport's reconnect loops use: 408, 429, and 5xx except 501, `TypeError` from `fetch`, and node or undici error codes (`ECONNRESET`, `UND_ERR_SOCKET`, ...).

Because the loops now share that rule instead of keeping their own, two behaviours changed on purpose:

- `read()` is also retried once when the request failed with a `TypeError` or a socket error code, not only with an HTTP status. `call()` is still never retried.
- the SSE reconnect loop no longer retries `501 Not Implemented`, so a server that does not support the GET stream fails fast instead of burning the reconnect budget.

### Tools for an LLM

`toLlmContent(result)` converts a `CallToolResult` to text and image content for a model, in the shape of `@i-enliven/pi-ai`'s `TextContent` and `ImageContent`. Text and images pass through, embedded text and image resources are unwrapped, and audio, resource links, and binary resources become short text placeholders. A result without content blocks but with `structuredContent` becomes its JSON.

Wrapping an MCP tool as a `pi-agent-core` `AgentTool`:

```typescript
import type { AgentTool } from "@i-enliven/pi-agent-core";
import { toLlmContent } from "@i-enliven/pi-mcp";
import { Type } from "typebox";

const tools: AgentTool[] = (await client.listTools()).map((tool) => ({
	// Providers allow at most 64 characters of [A-Za-z0-9_-].
	name: `mcp_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
	label: tool.title ?? tool.name,
	description: tool.description ?? tool.name,
	// Providers require an object schema, and some reject one without `properties`.
	parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
	execute: async (_toolCallId, params, signal) => {
		const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
		// MCP reports tool failures in the result instead of as a protocol error.
		return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
	},
}));
```

### OAuth

`@i-enliven/pi-mcp/oauth` provides the MCP OAuth client subset without depending on the official SDK:

```typescript
import { McpClient, StreamableHttpTransport } from "@i-enliven/pi-mcp";
import {
	adaptOAuthProvider,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	OAuthCallbackServer,
} from "@i-enliven/pi-mcp/oauth";

const serverUrl = "https://mcp.example.com/mcp";
const callback = await OAuthCallbackServer.listen();
let authorizationUrl: URL | undefined;
const oauth = new McpOAuthProvider({
	serverUrl,
	redirectUrl: callback.redirectUrl,
	clientMetadata: { client_name: "My MCP client" },
	onRedirect: (url) => {
		authorizationUrl = url;
	},
});

const connect = () => {
	const client = new McpClient({ name: "my-client", version: "1.0.0" });
	return {
		client,
		connected: client.connect(
			new StreamableHttpTransport({ url: serverUrl, authProvider: adaptOAuthProvider(oauth) }),
		),
	};
};

const first = connect();
try {
	await first.connected;
} catch (error) {
	if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
	const state = await oauth.state();
	const result = callback.waitForCallback(state);
	// Open authorizationUrl in the user's browser here.
	const { code } = await result;
	await authorizeMcp(oauth, { serverUrl, authorizationCode: code });
}

const { client, connected } = connect();
await connected;
```

Inject `McpOAuthStateStore` into `McpOAuthProvider` for durable credentials. The package does not open a browser or choose where credentials are stored.

The OAuth implementation is adapted from the MIT-licensed Model Context Protocol TypeScript SDK v1.29.0. Its license is included under `LICENSES/`.

An MCP transport owns framing and I/O. It delivers individual JSON-RPC messages to `McpClient`; the client owns request correlation, initialization, timeouts, cancellation, server requests, and protocol-level helpers.

## Supported protocol surface

- MCP protocol version `2025-11-25`, accepting servers that negotiate `2025-06-18`, `2025-03-26`, or `2024-11-05`
- initialization and `notifications/initialized`
- per-server session policy in `McpServerSession`: connect retries, idempotent-request retry, reconnect on a dropped connection, needs-auth, and a transport diagnostics tail on failures
- ping
- paginated `tools/list`
- `tools/call`, including structured content
- progress notifications and timeout renewal
- request cancellation
- Streamable HTTP sessions, the server-to-client GET stream with reconnection, and resumption of dropped response streams with `Last-Event-ID`
- stdio shutdown per the spec (close stdin, then SIGTERM, then SIGKILL), applied to the server's whole process group
- server `ping` and `roots/list` requests
- logging and tool-list-change notifications through the generic notification API
- OAuth protected-resource and authorization-server discovery
- PKCE authorization code flow, dynamic client registration, token refresh (one refresh shared by concurrent 401s), and step-up authorization for `insufficient_scope`

Batch JSON-RPC messages, legacy HTTP+SSE, servers, sampling, and tasks are outside the initial core.

## Testing

`@i-enliven/pi-mcp/testing` exports `createInMemoryTransportPair()` for client and adapter tests.
