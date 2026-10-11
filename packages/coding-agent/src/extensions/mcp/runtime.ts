/**
 * The part of the MCP integration that talks to servers: connections, transports, and OAuth
 * sign-in. It pulls in the MCP client, so index.ts loads it through runtime.lazy.ts only when a
 * server is configured.
 *
 * Per-server session policy — connect retries, transient errors, needs-auth, the stderr tail — is
 * `McpServerSession` in `@i-enliven/pi-mcp`. What stays here is pi's own behaviour: config to
 * transport, client identity, OAuth provider wiring, the tools and resources to expose, and the
 * messages `/mcp` shows.
 */

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AuthProvider,
	type CallToolResult,
	JSON_RPC_ERROR_CODES,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	McpAuthRequiredError,
	McpClient,
	McpConnectFailedError,
	McpError,
	McpNeedsAuthError,
	type McpRequestOptions,
	McpServerSession,
	type McpServerSessionState,
	type Tool as McpTool,
	type McpTransport,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	StdioTransport,
	StreamableHttpTransport,
} from "@i-enliven/pi-mcp";
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "@i-enliven/pi-mcp/oauth";
import { VERSION } from "../../config.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../core/resolve-config-value.ts";
import type { McpServerEntry } from "./config.ts";
import type { McpServerLog } from "./log.ts";
import {
	createMcpAuthProvider,
	type McpAuthProvider,
	type McpOAuthCredentialStore,
	type McpOAuthSettings,
} from "./oauth.ts";
import { isMcpAppResource, type McpResourceServer } from "./resources.ts";
import type { McpToolCaller } from "./tools.ts";

export { McpServerLog } from "./log.ts";
export { McpOAuthCredentialStore, McpSignInCancelledError, signInMcpServer } from "./oauth.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
/** Delays between attempts to connect to an HTTP server that failed with a transient error. */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

export type McpTransportFactory = (
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
) => McpTransport;

function signInRequiredMessage(entry: McpServerEntry): string {
	const provider = "url" in entry.config ? entry.config.auth?.provider : undefined;
	return `MCP server "${entry.name}" requires sign-in. Run ${provider ? `/login ${provider}` : "/mcp"} to sign in.`;
}

/** HTTP servers authenticate with OAuth unless the config supplies an `Authorization` header or `auth`. */
function usesOAuth(entry: McpServerEntry): boolean {
	const { config } = entry;
	if (!("url" in config) || config.auth) return false;
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

/** `~` and `~/…` (also `~\…` on Windows) name the home directory, like in a shell. */
function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

export function createDefaultTransport(
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
): McpTransport {
	const { config, name } = entry;
	if ("url" in config) {
		return new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			authProvider,
		});
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env ?? {})) {
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
	}
	return new StdioTransport({
		command: expandHome(config.command),
		args: config.args?.map(expandHome),
		cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
		env,
		stderr: "pipe",
	});
}

/** Servers that do not implement `resources/templates/list` have no templates. */
async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
	try {
		return await list();
	} catch (error) {
		if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
		throw error;
	}
}

function listTemplates(client: McpClient, options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
	return withoutTemplates(() => client.listResourceTemplates(options), []);
}

/**
 * Resources and templates at connect time, for the counts in `/mcp` and `pi mcp list`. A server
 * whose lists fail still connects: the resource tools list and read its resources on demand.
 */
async function fetchResources(
	client: McpClient,
): Promise<{ resources: Resource[]; resourceTemplates: ResourceTemplate[] }> {
	const [resources, resourceTemplates] = await Promise.all([
		client.listResources().catch(() => []),
		listTemplates(client).catch(() => []),
	]);
	return {
		resources: resources.filter((resource) => !isMcpAppResource(resource)),
		resourceTemplates: resourceTemplates.filter((template) => !isMcpAppResource(template)),
	};
}

/** What a fresh client offered, read during setup and applied once the session is connected. */
interface ServerSetup {
	client: McpClient;
	tools: McpTool[];
	hasResources: boolean;
	resources: Resource[];
	resourceTemplates: ResourceTemplate[];
	instructions: string | undefined;
}

/**
 * One configured server. `McpServerSession` owns the connection; this exposes it to pi and reads the
 * tools and resources a fresh connection offers.
 */
export class McpServerConnection implements McpToolCaller, McpResourceServer {
	readonly entry: McpServerEntry;
	/**
	 * `state` and `error` mirror the session (`applyState`), so `/mcp` and `pi mcp list` can read them
	 * without the client. `error` is what `pi mcp list` prints, and `refreshTools` writes it too, so it
	 * is not a pure copy of the session's.
	 */
	state: McpServerSessionState = "connecting";
	error: string | undefined;
	tools: McpTool[] = [];
	/**
	 * Whether the server offers resources. The lists below are what it listed at the last connect or
	 * change, without MCP App resources.
	 */
	hasResources = false;
	resources: Resource[] = [];
	resourceTemplates: ResourceTemplate[] = [];
	/** Server instructions from `initialize`, describing its tools as a group. */
	instructions: string | undefined;
	/** Last OAuth challenge from the server; sign-in uses its resource metadata URL and scope. */
	challenge: OAuthChallenge | undefined;
	/** Client of the connection whose tools and resources this object currently shows. */
	private client: McpClient | undefined;
	private setup: ServerSetup | undefined;
	private readonly cwd: string;
	private readonly session: McpServerSession;
	private readonly authProvider: McpAuthProvider | undefined;
	private readonly onTools: (connection: McpServerConnection) => void;
	private readonly onChange: ((connection: McpServerConnection) => void) | undefined;
	private readonly log: McpServerLog | undefined;

	constructor(options: {
		entry: McpServerEntry;
		cwd: string;
		createTransport: McpTransportFactory;
		credentials: McpOAuthCredentialStore;
		/** The current token of a pi provider, for servers with `auth.provider`. */
		providerToken?: (provider: string) => Promise<string | undefined>;
		onTools: (connection: McpServerConnection) => void;
		/** Called when `state`, `error`, or `tools` change. */
		onChange?: (connection: McpServerConnection) => void;
		/** Receives the server's log messages (`notifications/message`). */
		log?: McpServerLog;
	}) {
		this.entry = options.entry;
		this.cwd = options.cwd;
		this.onTools = options.onTools;
		this.onChange = options.onChange;
		this.log = options.log;
		const url = this.oauthUrl;
		const provider = "url" in this.entry.config ? this.entry.config.auth?.provider : undefined;
		this.authProvider = url
			? createMcpAuthProvider({
					serverUrl: url,
					store: options.credentials.forServer(this.entry.name, url),
					settings: () => this.oauthSettings(),
					onChallenge: (challenge) => {
						this.challenge = challenge;
					},
				})
			: provider
				? // Read on every request, so the provider's refreshes apply; MCP stores no copy.
					{ token: async () => options.providerToken?.(provider), settled: async () => {} }
				: undefined;
		const createTransport = options.createTransport;
		this.session = new McpServerSession({
			name: this.name,
			// pi's identity, its roots, and the configured request timeout.
			createClient: () => {
				const client = new McpClient({
					name: "pi",
					version: VERSION,
					requestTimeoutMs: this.timeoutMs,
					roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
				});
				const log = this.log;
				if (log) client.onNotification("notifications/message", (params) => log.write(this.entry.name, params));
				return client;
			},
			createTransport: () => createTransport(this.entry, this.cwd, this.authProvider),
			// Only HTTP servers are retried: a stdio command that fails to start stays failed.
			connectRetryDelaysMs: "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [],
			// OAuth servers that still reject the request after a refresh need the user to sign in again.
			isAuthorizationError: (error) =>
				error instanceof McpOAuthAuthorizationRequiredError ||
				(this.authProvider !== undefined && error instanceof McpAuthRequiredError),
			onConnected: (client) => this.readSetup(client),
			onStateChange: (state, error) => this.applyState(state, error),
		});
	}

	get name(): string {
		return this.entry.name;
	}

	get timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	/** Server URL when the server authenticates with OAuth. */
	get oauthUrl(): string | undefined {
		return usesOAuth(this.entry) && "url" in this.entry.config ? this.entry.config.url : undefined;
	}

	oauthSettings(): McpOAuthSettings {
		const oauth = "url" in this.entry.config ? this.entry.config.oauth : undefined;
		if (!oauth) return {};
		return {
			clientId: oauth.clientId,
			clientSecret:
				oauth.clientSecret === undefined
					? undefined
					: resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.entry.name}" oauth.clientSecret`),
			callbackPort: oauth.callbackPort,
			callbackUrl: oauth.callbackUrl,
			scope: oauth.scope,
			clientName: oauth.clientName,
			authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
		};
	}

	getClient(): Promise<McpClient> {
		return this.connect();
	}

	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult> {
		return this.run(false, (client) => client.callTool(name, args, options));
	}

	readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult> {
		return this.run(true, (client) => client.readResource(uri, options));
	}

	resourcesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourcesResult> {
		return this.run(true, (client) => client.listResourcesPage(cursor, options));
	}

	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourceTemplatesResult> {
		return this.run(true, (client) =>
			withoutTemplates(() => client.listResourceTemplatesPage(cursor, options), { resourceTemplates: [] }),
		);
	}

	allResources(options: McpRequestOptions): Promise<Resource[]> {
		return this.run(true, (client) => client.listResources(options));
	}

	allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]> {
		return this.run(true, (client) => listTemplates(client, options));
	}

	/** Connect again with fresh credentials, for example after signing in. */
	async reconnect(): Promise<void> {
		try {
			await this.session.reconnect();
		} catch (error) {
			throw this.hostError(error);
		}
	}

	/** Disconnect after the stored credentials were removed. */
	async signOut(): Promise<void> {
		await this.session.signOut();
	}

	/** Resolves once no transport of this server is open, including one that was still connecting. */
	async close(): Promise<void> {
		await this.session.close();
		// A refresh the server already answered may have rotated the refresh token; exiting before the
		// new tokens are saved would lose the grant.
		await this.authProvider?.settled();
	}

	private async connect(): Promise<McpClient> {
		if (this.state === "closed") throw new Error(`MCP server "${this.entry.name}" is shut down`);
		try {
			return await this.session.connect();
		} catch (error) {
			throw this.hostError(error);
		}
	}

	/**
	 * Run a request through the session. `idempotent` requests are the ones the session may retry;
	 * tool calls are not, since they may have run.
	 */
	private async run<T>(idempotent: boolean, run: (client: McpClient) => Promise<T>): Promise<T> {
		if (this.state === "closed") throw new Error(`MCP server "${this.entry.name}" is shut down`);
		try {
			return await (idempotent ? this.session.read(run) : this.session.call(run));
		} catch (error) {
			throw this.hostError(error);
		}
	}

	/** Session failures as pi's own messages. Request failures keep their text. */
	private hostError(error: unknown): Error {
		if (error instanceof McpNeedsAuthError) return new Error(signInRequiredMessage(this.entry), { cause: error });
		if (error instanceof McpConnectFailedError) {
			// The error carries the composed text (last failure plus the diagnostics tail). `this.error` is
			// the host's own field and `refreshTools` writes it too, so quoting it could name another failure.
			return new Error(`MCP server "${this.entry.name}" failed to connect: ${error.message}`, { cause: error });
		}
		return error instanceof Error ? error : new Error(String(error));
	}

	/**
	 * Read what a fresh client offers and wire its notifications. Applied when the session reports
	 * `connected`, so a connection that dropped during setup leaves the previous lists alone.
	 */
	private async readSetup(client: McpClient): Promise<void> {
		client.onNotification("notifications/tools/list_changed", () => {
			void this.refreshTools(client);
		});
		client.onNotification("notifications/resources/list_changed", () => {
			void this.refreshResources(client);
		});
		// Servers without the tools capability (prompts or resources only) do not answer tools/list.
		const hasResources = client.serverCapabilities?.resources !== undefined;
		const [tools, resources] = await Promise.all([
			client.serverCapabilities?.tools ? client.listTools() : [],
			hasResources ? fetchResources(client) : { resources: [], resourceTemplates: [] },
		]);
		this.setup = {
			client,
			tools,
			hasResources,
			resources: resources.resources,
			resourceTemplates: resources.resourceTemplates,
			instructions: client.instructions?.trim() || undefined,
		};
	}

	private applyState(state: McpServerSessionState, error: string | undefined): void {
		this.state = state;
		this.error = error;
		const setup = this.setup;
		// `readSetup` and the `connected` transition run back to back in `connectOnce`, with no await
		// between them, and one connect attempt runs at a time, so `setup` always belongs to the client
		// that just connected. The session does not hand its client to `onStateChange`: passing it would
		// widen that interface for a pairing this side already controls.
		if (setup && state === "connected") {
			this.setup = undefined;
			this.client = setup.client;
			this.tools = setup.tools;
			this.hasResources = setup.hasResources;
			this.resources = setup.resources;
			this.resourceTemplates = setup.resourceTemplates;
			this.instructions = setup.instructions;
			this.onTools(this);
		} else if (state !== "connected") {
			// No client backs the connection until it reaches `connected` again.
			this.setup = undefined;
			this.client = undefined;
		}
		this.changed();
	}

	private changed(): void {
		this.onChange?.(this);
	}

	private async refreshTools(client: McpClient): Promise<void> {
		try {
			const tools = await client.listTools();
			// Results of a client that no longer backs this connection are dropped.
			if (this.client !== client) return;
			this.tools = tools;
			this.onTools(this);
		} catch (error) {
			this.error = `Failed to refresh tools: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.changed();
	}

	private async refreshResources(client: McpClient): Promise<void> {
		const { resources, resourceTemplates } = await fetchResources(client);
		if (this.client !== client) return;
		this.resources = resources;
		this.resourceTemplates = resourceTemplates;
		this.onTools(this);
		this.changed();
	}
}
