import { afterEach, describe, expect, it } from "vitest";
import {
	isTransientMcpError,
	LATEST_PROTOCOL_VERSION,
	McpAuthRequiredError,
	McpClient,
	McpConnectFailedError,
	McpHttpError,
	McpNeedsAuthError,
	McpServerSession,
	type McpServerSessionOptions,
	type McpServerSessionState,
	McpSessionExpiredError,
	type McpTransport,
} from "../src/index.ts";
import type { JsonRpcMessage } from "../src/protocol/jsonrpc.ts";
import { createInMemoryTransportPair, type InMemoryTransport } from "../src/testing/index.ts";

const serverTransports: InMemoryTransport[] = [];

/** Client-side transport of an in-memory server answering initialize, tools, and resources. */
function fakeTransport(options: { expireFirstCall?: boolean } = {}): McpTransport {
	const pair = createInMemoryTransportPair();
	serverTransports.push(pair.server);
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fake", version: "1.0.0" },
					}
				: message.method === "tools/list"
					? { tools: [] }
					: message.method === "resources/read"
						? { contents: [{ uri: "docs://a", text: "ok" }] }
						: { content: [{ type: "text", text: "ok" }] };
		queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: message.id, result }));
	});
	void pair.server.start();
	const send = pair.client.send.bind(pair.client);
	if (options.expireFirstCall) {
		// Simulates the HTTP transport's 404 for a session the server no longer knows.
		pair.client.send = async (message: JsonRpcMessage) => {
			if ("method" in message && message.method === "tools/call") throw new McpSessionExpiredError("gone");
			return send(message);
		};
	}
	return pair.client;
}

/** A transport whose every request fails, as a server that will not answer does. */
function failingTransport(error: () => Error): McpTransport {
	const transport = fakeTransport();
	transport.send = async () => {
		throw error();
	};
	return transport;
}

/** The same transport, with diagnostics reporting `text` about the server behind it. */
function withDiagnostics(transport: McpTransport, text: string): McpTransport {
	return {
		start: () => transport.start(),
		send: (message) => transport.send(message),
		close: () => transport.close(),
		onMessage: (listener) => transport.onMessage(listener),
		onError: (listener) => transport.onError(listener),
		onClose: (listener) => transport.onClose(listener),
		diagnostics: { read: () => text },
	};
}

function createSession(transports: (() => McpTransport)[], options: Partial<McpServerSessionOptions> = {}) {
	let opened = 0;
	const states: McpServerSessionState[] = [];
	const clients: McpClient[] = [];
	const session = new McpServerSession({
		name: "fake",
		createClient: () => {
			const client = new McpClient({ name: "test-client", version: "1.0.0" });
			clients.push(client);
			return client;
		},
		createTransport: () => transports[opened++](),
		onStateChange: (state) => states.push(state),
		...options,
	});
	return { session, opened: () => opened, states, clients };
}

/** The error a promise rejects with, so one attempt can be inspected several ways. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
	return promise.then(
		() => {
			throw new Error("Expected the promise to reject");
		},
		(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
	);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
	for (const transport of serverTransports.splice(0)) await transport.close();
});

describe("isTransientMcpError", () => {
	it("retries timeouts, rate limits, and server failures only", () => {
		for (const status of [408, 429, 500, 503]) expect(isTransientMcpError(new McpHttpError(status, "x"))).toBe(true);
		// "Not implemented" never becomes implemented while a client waits.
		expect(isTransientMcpError(new McpHttpError(501, "x"))).toBe(false);
		for (const status of [400, 401, 404]) expect(isTransientMcpError(new McpHttpError(status, "x"))).toBe(false);
		expect(isTransientMcpError(new McpSessionExpiredError("gone"))).toBe(false);
		expect(isTransientMcpError(new McpAuthRequiredError(new Response(null, { status: 401 })))).toBe(false);
	});

	it("treats network failures as transient", () => {
		// What `fetch` reports for a connection that broke, and what node and undici report as a code.
		expect(isTransientMcpError(new TypeError("fetch failed"))).toBe(true);
		expect(isTransientMcpError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
		expect(isTransientMcpError(Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" }))).toBe(true);
		expect(isTransientMcpError(new Error("MCP connection closed"))).toBe(false);
		expect(isTransientMcpError("not an error")).toBe(false);
	});
});

describe("McpServerSession", () => {
	it("starts a new session and retries once when the session expired", async () => {
		const { session, opened } = createSession([
			() => fakeTransport({ expireFirstCall: true }),
			() => fakeTransport(),
		]);
		const results = await Promise.all([
			session.call((client) => client.callTool("echo")),
			session.call((client) => client.callTool("echo")),
		]);
		expect(results).toEqual([
			{ content: [{ type: "text", text: "ok" }] },
			{ content: [{ type: "text", text: "ok" }] },
		]);
		expect(opened()).toBe(2);
		await session.close();
	});

	it("retries a connect that failed with a transient error, but not one that did not", async () => {
		const { session, opened } = createSession(
			[
				() => failingTransport(() => new McpHttpError(503, "MCP HTTP request failed with status 503")),
				() => fakeTransport(),
			],
			{ connectRetryDelaysMs: [250, 1_000] },
		);
		await session.connect();
		expect(session.state).toBe("connected");
		expect(session.error).toBeUndefined();
		expect(opened()).toBe(2);
		await session.close();

		const rejected = createSession(
			[() => failingTransport(() => new McpHttpError(400, "MCP HTTP request failed with status 400: bad"))],
			{ connectRetryDelaysMs: [250, 1_000] },
		);
		const failure = await rejection(rejected.session.connect());
		expect(failure).toBeInstanceOf(McpConnectFailedError);
		expect(failure.message).toContain("status 400: bad");
		expect(failure.cause).toBeInstanceOf(McpHttpError);
		expect(rejected.session.state).toBe("failed");
		expect(rejected.session.error).toContain("status 400: bad");
		expect(rejected.opened()).toBe(1);
	});

	it("retries a read once after a transient error, but not a call", async () => {
		const transport = fakeTransport();
		const send = transport.send.bind(transport);
		const failed = new Set<string>();
		// The first read and the first call fail with 502.
		transport.send = async (message) => {
			const method = "method" in message ? message.method : "";
			if ((method === "resources/read" || method === "tools/call") && !failed.has(method)) {
				failed.add(method);
				throw new McpHttpError(502, "MCP HTTP request failed with status 502");
			}
			return send(message);
		};
		const { session } = createSession([() => transport]);
		expect(await session.read((client) => client.readResource("docs://a"))).toEqual({
			contents: [{ uri: "docs://a", text: "ok" }],
		});
		await expect(session.call((client) => client.callTool("echo"))).rejects.toThrow("status 502");
		await session.close();
	});

	it("reports that the user has to sign in when the server rejects the credentials", async () => {
		const { session } = createSession([
			() => failingTransport(() => new McpAuthRequiredError(new Response(null, { status: 401 }))),
		]);
		expect(await rejection(session.connect())).toBeInstanceOf(McpNeedsAuthError);
		expect(session.state).toBe("needs-auth");
		expect(session.error).toBeUndefined();
		await session.close();
	});

	it("uses the host's authorization rule on a request", async () => {
		const transport = fakeTransport();
		const send = transport.send.bind(transport);
		transport.send = async (message) => {
			if ("method" in message && message.method === "tools/call") throw new Error("token rejected");
			return send(message);
		};
		const { session } = createSession([() => transport], {
			isAuthorizationError: (error) => error instanceof Error && error.message === "token rejected",
		});
		expect(await rejection(session.call((client) => client.callTool("echo")))).toBeInstanceOf(McpNeedsAuthError);
		expect(session.state).toBe("needs-auth");
		await session.close();
	});

	it("stops waiting to retry a connection when closed", async () => {
		const { session, opened } = createSession(
			[() => failingTransport(() => new McpHttpError(503, "MCP HTTP request failed with status 503"))],
			{ connectRetryDelaysMs: [250, 1_000] },
		);
		let failure: unknown;
		const connecting = session.connect().catch((error: unknown) => {
			failure = error;
		});
		// The first attempt failed; the retry is 250ms away.
		await settle();
		const closedAt = Date.now();
		await session.close();
		expect(Date.now() - closedAt).toBeLessThan(200);
		await connecting;
		expect(String(failure)).toContain("status 503");
		expect(session.state).toBe("closed");
		expect(opened()).toBe(1);
	});

	it("stops waiting to retry a connection when the host's signal aborts", async () => {
		const shutdown = new AbortController();
		const { session } = createSession(
			[() => failingTransport(() => new McpHttpError(503, "MCP HTTP request failed with status 503"))],
			{ connectRetryDelaysMs: [250, 1_000], signal: shutdown.signal },
		);
		const connecting = rejection(session.connect());
		await settle();
		shutdown.abort();
		expect((await connecting).message).toContain("status 503");
		expect(session.state).toBe("closed");
		await session.close();
	});

	// #10249
	it("closes a connection that is still initializing before close returns", async () => {
		const pair = createInMemoryTransportPair();
		// The server receives initialize but never answers it.
		const initializing = new Promise<void>((resolve) => {
			pair.server.onMessage(() => resolve());
		});
		void pair.server.start();
		let transportClosed = false;
		pair.client.onClose(() => {
			transportClosed = true;
		});
		const { session } = createSession([() => pair.client]);
		let failure: unknown;
		const connecting = session.connect().catch((error: unknown) => {
			failure = error;
		});
		await initializing;
		await session.close();
		await connecting;
		expect(transportClosed).toBe(true);
		expect(String(failure)).toContain("MCP connection closed");
		expect(session.state).toBe("closed");
	});

	it("adds a transport's diagnostics to a failed connect", async () => {
		const { session } = createSession([
			() =>
				withDiagnostics(
					failingTransport(() => new Error("server did not start")),
					"  fatal: missing key  ",
				),
		]);
		const failure = await rejection(session.connect());
		expect(failure).toBeInstanceOf(McpConnectFailedError);
		// The error carries the composed text, so a host can quote it without reading the state back.
		expect(failure.message).toBe("server did not start\nfatal: missing key");
		expect(failure.cause).toBeInstanceOf(Error);
		expect(session.state).toBe("failed");
		expect(session.error).toBe(failure.message);
	});

	it("adds a transport's diagnostics to a dropped connection", async () => {
		const { session } = createSession([() => withDiagnostics(fakeTransport(), "server panicked")]);
		await session.connect();
		await serverTransports.at(-1)?.close();
		await settle();
		expect(session.state).toBe("disconnected");
		expect(session.error).toBe("Connection closed\nserver panicked");
		await session.close();
	});

	it("keeps a dropped client of an earlier session from failing the current one", async () => {
		// The expired session's client is detached, not closed, so it outlives the reconnect.
		const { session, clients, opened } = createSession([
			() => fakeTransport({ expireFirstCall: true }),
			() => fakeTransport(),
		]);
		expect(await session.call((client) => client.callTool("echo"))).toEqual({
			content: [{ type: "text", text: "ok" }],
		});
		expect(opened()).toBe(2);
		await clients[0].close();
		await settle();
		expect(session.state).toBe("connected");
		expect(session.error).toBeUndefined();
		await session.close();
	});

	it("keeps the last 2000 characters of a transport's diagnostics", async () => {
		const tail = `${"x".repeat(3_000)}CRASH`;
		const { session } = createSession([
			() =>
				withDiagnostics(
					failingTransport(() => new Error("did not start")),
					tail,
				),
		]);
		await expect(session.connect()).rejects.toThrow("did not start");
		const error = session.error ?? "";
		expect(error).toBe(`did not start\n${"x".repeat(1_995)}CRASH`);
		expect(error.slice(error.indexOf("\n") + 1)).toHaveLength(2_000);
	});

	it("goes connecting, connected, disconnected, connected when the transport drops", async () => {
		const { session, states } = createSession([() => fakeTransport(), () => fakeTransport()]);
		await session.connect();
		await serverTransports.at(-1)?.close();
		await settle();
		expect(session.state).toBe("disconnected");
		expect(session.error).toBe("Connection closed");
		expect(await session.call((client) => client.callTool("echo"))).toEqual({
			content: [{ type: "text", text: "ok" }],
		});
		expect(states).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"]);
		await session.close();
		expect(states.at(-1)).toBe("closed");
	});

	it("rejects calls and connects after the session was closed", async () => {
		const { session } = createSession([() => fakeTransport()]);
		await session.connect();
		await session.close();
		await expect(session.call((client) => client.callTool("echo"))).rejects.toThrow('MCP server "fake" is shut down');
		await expect(session.connect()).rejects.toThrow('MCP server "fake" is shut down');
	});

	it("reconnects and signs out through the session state", async () => {
		const { session, opened, states } = createSession([
			() => fakeTransport(),
			() => fakeTransport(),
			() => fakeTransport(),
		]);
		await session.connect();
		await session.reconnect();
		expect(session.state).toBe("connected");
		expect(opened()).toBe(2);
		await session.signOut();
		expect(session.state).toBe("needs-auth");
		await session.reconnect();
		expect(session.state).toBe("connected");
		expect(opened()).toBe(3);
		expect(states).toEqual([
			"connecting",
			"connected",
			"connecting",
			"connected",
			"needs-auth",
			"connecting",
			"connected",
		]);
		await session.close();
	});

	it("runs the host's setup before the state becomes connected", async () => {
		const order: string[] = [];
		let session: McpServerSession | undefined;
		session = new McpServerSession({
			name: "fake",
			createClient: () => new McpClient({ name: "test-client", version: "1.0.0" }),
			createTransport: () => fakeTransport(),
			onConnected: async (client) => {
				order.push(`session:${session?.state}`, `client:${client.connectionState}`);
				await client.listTools();
				order.push("listed");
			},
		});
		await session.connect();
		expect(order).toEqual(["session:connecting", "client:connected", "listed"]);
		await session.close();
	});

	it("fails a connect whose client dropped during setup", async () => {
		const { session } = createSession([() => fakeTransport()], {
			onConnected: async (client) => {
				await client.close();
			},
		});
		await expect(session.connect()).rejects.toThrow("connection closed during setup");
		expect(session.state).toBe("failed");
	});
});
