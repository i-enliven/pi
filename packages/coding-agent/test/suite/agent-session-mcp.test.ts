import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import type { McpExposure, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createMcpToolName } from "../../src/extensions/mcp/tools.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import {
	createHarness,
	createTestUiContext,
	getAssistantTexts,
	getMessageText,
	type Harness,
	getToolResult as toolResult,
} from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const SERVER_TOOLS = [
	{
		name: "search",
		description: "Search the docs.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		outputSchema: {
			type: "object",
			properties: { hits: { type: "array", items: { type: "string" } } },
			required: ["hits"],
		},
	},
	{
		name: "fail",
		description: "Always fails.",
		inputSchema: { type: "object", properties: {} },
		annotations: { title: "Fail", destructiveHint: true, readOnlyHint: false, idempotentHint: "yes" },
	},
	{ name: "shot", description: "Returns an image.", inputSchema: { type: "object", properties: {} } },
];

/**
 * Minimal MCP server over an in-memory transport. Records the tool calls it receives.
 * `initializeDelayMs` delays the answer to `initialize`; `Infinity` never answers.
 */
function createFakeServer(
	calls: string[],
	options: {
		listTools?: () => unknown[];
		resources?: boolean;
		instructions?: string;
		initializeDelayMs?: number;
	} = {},
) {
	const { listTools = () => SERVER_TOOLS, resources = false, instructions, initializeDelayMs = 0 } = options;
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {}, ...(resources ? { resources: {} } : {}) },
					serverInfo: { name: "docs", version: "1.0.0" },
					...(instructions ? { instructions } : {}),
				};
			case "tools/list":
				return { tools: listTools() };
			case "resources/list":
				return {
					resources: [
						{ uri: "docs://intro", name: "intro", mimeType: "text/markdown", _meta: { x: 1 } },
						// MCP App user interfaces are left out.
						{ uri: "ui://docs/viewer", name: "viewer", mimeType: "text/html;profile=mcp-app" },
					],
				};
			case "resources/templates/list":
				return {
					resourceTemplates: [
						{ uriTemplate: "docs://pages/{slug}", name: "page", icons: [{ src: "data:image/png;base64,AAAA" }] },
					],
				};
			case "resources/read": {
				const { uri } = request.params as { uri: string };
				calls.push(`read:${uri}`);
				return { contents: [{ uri, mimeType: "text/markdown", text: `# ${uri}` }] };
			}
			case "tools/call": {
				const params = request.params as { name: string; arguments?: { query?: string } };
				calls.push(`${params.name}:${JSON.stringify(params.arguments ?? {})}`);
				if (params.name === "search") {
					const hits = [`${params.arguments?.query} guide`, `${params.arguments?.query} faq`];
					return { content: [{ type: "text", text: hits.join("\n") }], structuredContent: { hits } };
				}
				if (params.name === "shot") {
					return { content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }] };
				}
				return { content: [{ type: "text", text: "server exploded" }], isError: true };
			}
			default:
				return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const send = () => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) });
		if (request.method !== "initialize" || initializeDelayMs === 0) queueMicrotask(send);
		else if (Number.isFinite(initializeDelayMs)) setTimeout(send, initializeDelayMs);
	});
	return pair;
}

describe("AgentSession MCP integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		exposure: McpExposure,
		listTools?: () => unknown[],
		options: {
			builtInTools?: string[];
			/** `--tools` and `--exclude-tools`. */
			allowedToolNames?: string[];
			excludedToolNames?: string[];
			/** Session to continue. */
			sessionManager?: SessionManager;
			/** Whether to wait for `mcp__docs__search` to register. Default: true. */
			waitForTools?: boolean;
			extensionFactories?: ExtensionFactory[];
			toolExposure?: Record<string, McpExposure>;
			resources?: boolean;
			instructions?: string;
			description?: string;
		} = {},
	) {
		const {
			builtInTools,
			allowedToolNames,
			excludedToolNames,
			sessionManager,
			waitForTools = true,
			extensionFactories = [],
			toolExposure,
			resources,
			instructions,
			description,
		} = options;
		const calls: string[] = [];
		const notifications: string[] = [];
		const servers: ReturnType<typeof createFakeServer>["server"][] = [];
		const entry: McpServerEntry = {
			name: "docs",
			config: {
				url: "http://unused.invalid",
				exposure,
				...(toolExposure ? { toolExposure } : {}),
				...(description ? { description } : {}),
			},
			source: "test",
		};
		const harness = await createHarness({
			initialActiveToolNames: allowedToolNames ?? builtInTools ?? [],
			allowedToolNames,
			excludedToolNames,
			sessionManager,
			extensionFactories: [
				...extensionFactories,
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: () => {
						const pair = createFakeServer(calls, { listTools, resources, instructions });
						servers.push(pair.server);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		if (waitForTools) {
			await vi.waitFor(() =>
				expect(harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
			);
		}
		return { harness, calls, servers, notifications };
	}

	function registeredNames(harness: Harness): string[] {
		return harness.session.getAllTools().map((tool) => tool.name);
	}

	it("keeps MCP tools registered when --tools names no MCP tool", async () => {
		const { harness } = await setup("direct", undefined, {
			allowedToolNames: ["read"],
			resources: true,
		});
		// MCP tools stay registered but are never declared, whatever their exposure.
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
		expect(registeredNames(harness)).toEqual(
			expect.arrayContaining(["mcp__docs__search", "mcp__docs__fail", "list_mcp_resources", "read_mcp_resource"]),
		);
		expect(registeredNames(harness)).not.toContain("bash");
	});

	it("removes MCP tools with --no-tools", async () => {
		const { harness, servers } = await setup("direct", undefined, { allowedToolNames: [], waitForTools: false });
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");

		expect(servers).toHaveLength(1);
		expect(harness.session.getAllTools()).toEqual([]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
	});

	it("does not declare unnamed MCP tools restored from the transcript", async () => {
		const first = await setup("direct");
		first.harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await first.harness.session.prompt("first");
		await first.harness.session.prompt("second");

		// Like `pi --tools read -c` followed by /tree.
		const second = await setup("direct", undefined, {
			allowedToolNames: ["read"],
			sessionManager: first.harness.sessionManager,
		});
		const firstAssistant = second.harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("No assistant entry");
		await second.harness.session.navigateTree(firstAssistant.id);

		// The transcript's loadout is restored without the MCP tools it declared.
		expect(second.harness.session.getActiveToolNames()).toEqual([]);
		expect(registeredNames(second.harness)).toContain("mcp__docs__search");
	});

	it("filters MCP tools by the mcp__ entries of --tools", async () => {
		const { harness } = await setup("direct", undefined, {
			allowedToolNames: ["read", "mcp__docs__s*"],
			resources: true,
		});
		await vi.waitFor(() =>
			expect(harness.session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["mcp__docs__search", "mcp__docs__shot"]),
			),
		);
		const registered = registeredNames(harness);
		expect(registered).toEqual(expect.arrayContaining(["mcp__docs__search", "mcp__docs__shot"]));
		expect(registered).not.toContain("mcp__docs__fail");
	});

	it("removes MCP tools matching --exclude-tools patterns", async () => {
		const { harness } = await setup("direct", undefined, { excludedToolNames: ["mcp__docs__f*"] });
		expect(registeredNames(harness)).toContain("mcp__docs__search");
		expect(registeredNames(harness)).not.toContain("mcp__docs__fail");
	});

	it("declares directly exposed MCP tools to the model", async () => {
		const { harness, calls } = await setup("direct");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "direct" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]),
		);
		expect(harness.session.getCallableToolNames()).toContain("mcp__docs__search");
		// Boolean annotation hints are passed on for permission extensions.
		const annotations = new Map(harness.session.getAllTools().map((tool) => [tool.name, tool.annotations]));
		expect(annotations.get("mcp__docs__fail")).toEqual({ destructiveHint: true, readOnlyHint: false });
		expect(annotations.get("mcp__docs__search")).toBeUndefined();
		const result = toolResult(harness, "mcp__docs__search");
		expect(getMessageText(result)).toBe("direct guide\ndirect faq");
		expect(calls).toEqual(['search:{"query":"direct"}']);
	});

	it("keeps hidden MCP tools registered but unreachable", async () => {
		const { harness, calls } = await setup("hidden");
		expect(registeredNames(harness)).toContain("mcp__docs__search");
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__search");
		expect(harness.session.getCallableToolNames()).not.toContain("mcp__docs__search");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(createMcpToolName("docs", "search"), { query: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		const result = toolResult(harness, "mcp__docs__search");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("Tool mcp__docs__search not found");
		expect(calls).toEqual([]);
	});

	it("applies per-tool exposure overrides", async () => {
		const { harness } = await setup("direct", undefined, { toolExposure: { search: "hidden", "f*": "hidden" } });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		// `search` and `fail` are hidden by pattern/exact overrides; `shot` keeps the server's `direct`.
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__shot");
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__search");
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__fail");
		expect(registeredNames(harness)).toEqual(
			expect.arrayContaining(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]),
		);
	});

	it("withdraws and restores direct MCP tools the server changes", async () => {
		let tools = SERVER_TOOLS;
		const { harness, servers } = await setup("direct", () => tools);
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		const listChanged = async () => {
			await servers[0].send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			await new Promise((resolve) => setTimeout(resolve, 10));
		};
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__fail");

		// Tools the server drops are re-registered as hidden, so they leave the model's declarations.
		tools = SERVER_TOOLS.filter((tool) => tool.name !== "fail");
		await listChanged();
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__fail");
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
		expect(registeredNames(harness)).toContain("mcp__docs__fail");

		tools = SERVER_TOOLS;
		await listChanged();
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__fail");
	});

	// Regression: #10239.
	it.each([false, true])("routes tools whose names differ only in - and _ (reverse: %s)", async (reverse) => {
		const tools = [
			{ name: "read-file", description: "dashed", inputSchema: { type: "object", properties: {} } },
			{ name: "read_file", description: "underscored", inputSchema: { type: "object", properties: {} } },
		];
		if (reverse) tools.reverse();
		const { harness, calls } = await setup("direct", () => [...tools, ...SERVER_TOOLS]);
		// Sanitizing maps both to `mcp__docs__read_file`; the extension gives one a hash suffix.
		const names = registeredNames(harness).filter((name) => name.startsWith("mcp__docs__read"));
		expect(names).toHaveLength(2);
		expect(new Set(names).size).toBe(2);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(names[0], {}), fauxToolCall(names[1], {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(calls.slice().sort()).toEqual(["read-file:{}", "read_file:{}"]);
	});

	it("lists and reads resources with Codex's resource tools", async () => {
		const { harness, calls } = await setup("direct", undefined, { resources: true });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("list_mcp_resources", {}),
					fauxToolCall("list_mcp_resource_templates", { server: "docs" }),
					fauxToolCall("read_mcp_resource", { server: "docs", uri: "docs://pages/setup" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("read_mcp_resource", { server: "nope", uri: "docs://x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");

		// The resource tools take the exposure of the servers they reach.
		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]),
		);
		expect(JSON.parse(getMessageText(toolResult(harness, "list_mcp_resources")))).toEqual({
			resources: [{ server: "docs", uri: "docs://intro", name: "intro", mimeType: "text/markdown" }],
		});
		expect(JSON.parse(getMessageText(toolResult(harness, "list_mcp_resource_templates")))).toEqual({
			server: "docs",
			resourceTemplates: [{ server: "docs", uriTemplate: "docs://pages/{slug}", name: "page" }],
		});
		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "read_mcp_resource",
		);
		expect(getMessageText(results[0])).toBe("# docs://pages/setup");
		expect(results[1].isError).toBe(true);
		expect(getMessageText(results[1])).toBe('MCP server "nope" has no resources. Servers with resources: docs');
		expect(calls).toEqual(["read:docs://pages/setup"]);
		const annotations = harness.session.getAllTools().find((tool) => tool.name === "read_mcp_resource");
		expect(annotations?.annotations).toEqual({ readOnlyHint: true });
	});

	it("does not reach the resources of a hidden server", async () => {
		const { harness } = await setup("hidden", undefined, { resources: true });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		// The resource tools cover only non-hidden servers, so they never register here.
		expect(registeredNames(harness)).not.toContain("list_mcp_resources");
	});

	it("attaches the configured description and server instructions to the tool namespace", async () => {
		const { harness } = await setup("direct", undefined, {
			description: "Search the product docs",
			instructions: "Always search before reading.",
		});
		const search = harness.session.getAllTools().find((tool) => tool.name === "mcp__docs__search");
		expect(search?.namespace).toEqual({
			name: "mcp__docs",
			description: "Search the product docs",
			instructions: "Always search before reading.",
		});
	});

	/** A server named `slow` whose answer to `initialize` takes `initializeDelayMs`, without waiting for it. */
	async function setupSlow(
		config: {
			exposure?: McpExposure;
			toolExposure?: Record<string, McpExposure>;
			name?: string;
			instructions?: string;
		},
		initializeDelayMs: number,
		startupWaitMs?: number,
	) {
		const calls: string[] = [];
		const notifications: string[] = [];
		const { name = "slow", instructions, ...serverConfig } = config;
		const entry: McpServerEntry = { name, config: { url: "http://unused.invalid", ...serverConfig }, source: "test" };
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: () => {
						const pair = createFakeServer(calls, { initializeDelayMs, instructions });
						void pair.server.start();
						return pair.client;
					},
					...(startupWaitMs === undefined ? {} : { startupWaitMs }),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		return { harness, calls, notifications };
	}

	it("holds the first prompt for servers with direct tools", async () => {
		const { harness } = await setupSlow({ exposure: "direct" }, 30);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toContain("mcp__slow__search");
	});

	it("does not hold the first prompt for hidden servers that are still connecting", async () => {
		// The server never answers `initialize`.
		const { harness } = await setupSlow({ exposure: "hidden" }, Number.POSITIVE_INFINITY);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(getAssistantTexts(harness)).toEqual(["ready"]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
	});

	it("holds the first prompt for servers with direct tools only up to startupWaitMs", async () => {
		const { harness, notifications } = await setupSlow({ exposure: "direct" }, Number.POSITIVE_INFINITY, 20);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(getAssistantTexts(harness)).toEqual(["ready"]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(notifications).toEqual(["MCP servers are still connecting; their tools become available once connected."]);
	});

	it("activates direct tools that register after the first prompt", async () => {
		const { harness } = await setupSlow({ exposure: "direct" }, 30, 5);
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__slow__search");

		// The tools become available without another prompt; registration activates direct tools.
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__slow__search"));
	});
});

describe("AgentSession MCP servers registered by extensions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** `configured` are the mcp.json servers; `plugins` register servers through the extension API. */
	async function setup(plugins: ExtensionFactory | ExtensionFactory[], configured: McpServerEntry[] = []) {
		const connected: McpServerEntry[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				...(Array.isArray(plugins) ? plugins : [plugins]),
				createMcpExtension({
					loadConfig: () => ({ servers: configured, errors: [] }),
					createTransport: (entry) => {
						connected.push(entry);
						const pair = createFakeServer([]);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		// `/reload` emits session_start only to bound extensions.
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, connected };
	}

	it("connects servers registered while extensions load", async () => {
		const { harness, connected } = await setup((pi) => {
			pi.registerMcpServer("plugin", { url: "http://plugin.invalid", exposure: "direct" });
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(connected.map((entry) => [entry.name, entry.scope])).toEqual([["plugin", "extension"]]);
		expect(harness.session.getActiveToolNames()).toContain("mcp__plugin__search");
	});

	it("connects and disconnects servers registered during the session", async () => {
		let api: ExtensionAPI | undefined;
		const { harness, connected } = await setup((pi) => {
			api = pi;
		});
		if (!api) throw new Error("No extension API");
		const pi = api;

		// The default exposure is `direct`, so the tools are declared when the server connects.
		pi.registerMcpServer("late", { url: "http://late.invalid" });
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__late__search"));
		expect(connected.map((entry) => entry.name)).toEqual(["late"]);

		pi.unregisterMcpServer("late");
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).not.toContain("mcp__late__search"));
	});

	// "my_docs" shares the namespace of "my-docs" (#10239).
	it.each(["my-docs", "my_docs"])("prefers the mcp.json server over a registered %s", async (name) => {
		const configured: McpServerEntry = {
			name: "my-docs",
			config: { url: "http://config.invalid" },
			source: "mcp.json",
		};
		const { connected } = await setup(
			(pi) => {
				pi.registerMcpServer(name, { url: "http://plugin.invalid" });
			},
			[configured],
		);
		await vi.waitFor(() => expect(connected).toEqual([configured]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(connected).toEqual([configured]);
	});

	it("rejects names another extension registered", async () => {
		const errors: string[] = [];
		await setup([
			(pi) => {
				pi.registerMcpServer("taken", { url: "http://x.invalid" });
				// Registering again replaces the extension's own registration.
				pi.registerMcpServer("taken", { url: "http://y.invalid" });
				pi.registerMcpServer("my-server", { url: "http://x.invalid" });
			},
			(pi) => {
				for (const name of ["taken", "my_server"]) {
					try {
						pi.registerMcpServer(name, { url: "http://z.invalid" });
					} catch (caught) {
						errors.push(String(caught));
					}
				}
			},
		]);
		expect(errors).toEqual([
			expect.stringMatching(/MCP server "taken" is already registered by extension/),
			// Names that differ only in - and _ share a namespace (#10239).
			'Error: MCP server "my_server" conflicts with registered server "my-server"',
		]);
	});

	it("reports registered servers when no extension connects them", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => pi.registerMcpServer("orphan", { url: "http://orphan.invalid" })],
		});
		harnesses.push(harness);
		const errors: string[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });

		expect(errors).toEqual([expect.stringContaining('MCP server "orphan" is registered, but no loaded extension')]);
	});
});

describe("AgentSession MCP tools after resume and reload", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/**
	 * A direct `docs` server that answers `initialize` after `initializeDelayMs`; `connected` counts
	 * its connections. `/reload` loads the extensions again.
	 */
	async function setup(
		sessionManager?: SessionManager,
		extensionFactories: ExtensionFactory[] = [],
		initializeDelayMs = 0,
	) {
		const connected: string[] = [];
		const servers: McpServerEntry[] = [
			{ name: "docs", config: { url: "http://unused.invalid", exposure: "direct" }, source: "test" },
		];
		const factories = [
			...extensionFactories,
			createMcpExtension({
				loadConfig: () => ({ servers, errors: [] }),
				createTransport: (entry) => {
					connected.push(entry.name);
					const pair = createFakeServer([], { initializeDelayMs });
					void pair.server.start();
					return pair.client;
				},
			}),
		];
		let extensions = await createTestExtensionsResult(factories);
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => extensions,
			reload: async () => {
				extensions = await createTestExtensionsResult(factories);
			},
		};
		const harness = await createHarness({ resourceLoader, sessionManager });
		harnesses.push(harness);
		// `/reload` emits session_start only to bound extensions.
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, connected };
	}

	async function connectDocsSearch(harness: Harness) {
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
	}

	it("declares direct MCP tools again on resume once their server connects", async () => {
		const first = await setup();
		await connectDocsSearch(first.harness);

		// The session restores its tools before the server connects again.
		const second = await setup(first.harness.sessionManager);
		await vi.waitFor(() => expect(second.harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
		second.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "again" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await second.harness.session.prompt("use it");

		expect(getMessageText(toolResult(second.harness, "mcp__docs__search"))).toBe("again guide\nagain faq");
		const removals = second.harness.session.messages.filter(
			(message) => message.role === "system" && (message.toolsRemoved ?? []).length > 0,
		);
		expect(removals).toEqual([]);
	});

	it("activates restored direct tools when they register after an extension narrows the loadout", async () => {
		const first = await setup();
		await connectDocsSearch(first.harness);

		// Like plan mode restoring its tools before the server connects again.
		const setLoadout: ExtensionFactory = (pi) => {
			pi.on("session_start", () => pi.setActiveTools(["read"]));
		};
		const second = await setup(first.harness.sessionManager, [setLoadout]);
		await vi.waitFor(() =>
			expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
		);

		// Direct tools activate when they register, whatever the loadout set before.
		expect(second.harness.session.getActiveToolNames()).toContain("mcp__docs__search");
	});

	it("declares direct MCP tools again after /reload", async () => {
		const { harness, connected } = await setup();
		await connectDocsSearch(harness);

		await harness.session.reload();

		await vi.waitFor(() => expect(connected).toEqual(["docs", "docs"]));
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
	});
});
