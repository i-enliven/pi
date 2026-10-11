/**
 * One server's session: connection lifecycle, retry budgets, needs-auth, and failure context.
 *
 * The host supplies a fresh client and transport per attempt (`createClient`, `createTransport`) and
 * decides what a successful connect means to it (`onConnected`). Everything a host would otherwise
 * re-implement per server lives here: how often a connect is retried, which failures count as
 * transient, when a dropped connection is re-opened, when the user has to sign in, and how much of
 * the server's output is added to a failure message.
 *
 * It stays host-agnostic: no configuration types, no authorization flows, no user-facing instructions.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { McpClient } from "./client.ts";
import { isTransientMcpError, McpAuthRequiredError, McpSessionExpiredError } from "./errors.ts";
import { McpConnectionClosedError } from "./protocol/jsonrpc.ts";
import type { McpTransport } from "./transports/transport.ts";

/** How much of a transport's diagnostics a failure message may carry. */
const STDERR_TAIL_CHARS = 2_000;
/** Delay before the single retry of an idempotent request that hit a transient error. */
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 250;

/**
 * `disconnected`: the connection dropped (for example the stdio server exited); the next call
 * reconnects. `needs-auth`: the server rejected the credentials and the user has to sign in.
 */
export type McpServerSessionState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

/** The server refused the credentials, so the user has to sign in again. */
export class McpNeedsAuthError extends Error {
	constructor(name: string, options: { cause: unknown }) {
		super(`MCP server "${name}" requires sign-in`, options);
		this.name = "McpNeedsAuthError";
	}
}

/**
 * Every connect attempt failed. `message` is the composed failure text (the last error plus the
 * transport's diagnostics tail), `cause` is the error that ended the retries.
 */
export class McpConnectFailedError extends Error {
	constructor(message: string, options: { cause: unknown }) {
		super(message, options);
		this.name = "McpConnectFailedError";
	}
}

export interface McpServerSessionOptions {
	/** Server name, used only in error messages. */
	name: string;
	/** Fresh client for one attempt. The host sets its identity, capabilities, and timeouts here. */
	createClient: () => McpClient;
	/** Fresh transport for one attempt. */
	createTransport: () => McpTransport;
	/** Delays before each reconnect attempt after a transient connect failure. Default: none. */
	connectRetryDelaysMs?: readonly number[];
	/** Delay before the single retry of an idempotent request that hit a transient error. Default: 250. */
	transientRetryDelayMs?: number;
	/** Whether a failure means the user has to sign in. Default: `McpAuthRequiredError`. */
	isAuthorizationError?: (error: unknown) => boolean;
	/** Host setup on a fresh, initialized client, before the state becomes `connected`. */
	onConnected?: (client: McpClient) => void | Promise<void>;
	/** Called whenever `state` or `error` changes. */
	onStateChange?: (state: McpServerSessionState, error: string | undefined) => void;
	/** Host shutdown: aborts a connect in progress and its waits between retries. */
	signal?: AbortSignal;
}

/** The tail of what the transport saw, or undefined when it saw nothing worth showing. */
function diagnosticsTail(transport: McpTransport | undefined): string | undefined {
	return transport?.diagnostics?.read()?.trim().slice(-STDERR_TAIL_CHARS) || undefined;
}

export class McpServerSession {
	private readonly name: string;
	private readonly createClient: () => McpClient;
	private readonly createTransport: () => McpTransport;
	private readonly connectRetryDelaysMs: readonly number[];
	private readonly transientRetryDelayMs: number;
	private readonly isAuthorizationError: (error: unknown) => boolean;
	private readonly onConnected: ((client: McpClient) => void | Promise<void>) | undefined;
	private readonly onStateChange: ((state: McpServerSessionState, error: string | undefined) => void) | undefined;
	/** Aborted by `close()` or by the host's signal; cancels a connect in progress and its waits. */
	private readonly shutdown = new AbortController();

	private stateValue: McpServerSessionState = "connecting";
	private errorValue: string | undefined;
	private client: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	/** Diagnostics of the attempt that just failed, added to its failure message. */
	private stderrTail: string | undefined;

	constructor(options: McpServerSessionOptions) {
		this.name = options.name;
		this.createClient = options.createClient;
		this.createTransport = options.createTransport;
		this.connectRetryDelaysMs = options.connectRetryDelaysMs ?? [];
		this.transientRetryDelayMs = options.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;
		this.isAuthorizationError = options.isAuthorizationError ?? ((error) => error instanceof McpAuthRequiredError);
		this.onConnected = options.onConnected;
		this.onStateChange = options.onStateChange;
		const signal = options.signal;
		if (signal) {
			const abort = () => this.shutdown.abort(signal.reason);
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	}

	get state(): McpServerSessionState {
		return this.stateValue;
	}

	get error(): string | undefined {
		return this.errorValue;
	}

	private get closed(): boolean {
		return this.shutdown.signal.aborted;
	}

	/**
	 * A live client, connecting or reconnecting when needed. Calls made while a connect is running
	 * share it, so a burst of calls opens one session.
	 */
	connect(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new McpConnectionClosedError(`MCP server "${this.name}" is shut down`));
		const client = this.client;
		if (client?.connectionState === "connected") return Promise.resolve(client);
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	/** Run a request on a live client. Never retried: the server may have performed it. */
	call<T>(run: (client: McpClient) => Promise<T>): Promise<T> {
		return this.run(run, false);
	}

	/** Run an idempotent request, retried once after a transient failure or an expired session. */
	read<T>(run: (client: McpClient) => Promise<T>): Promise<T> {
		return this.run(run, true);
	}

	/** Drop the connection and connect again, for example after signing in. */
	async reconnect(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		await this.connect();
	}

	/** Drop the connection and wait for the user to sign in. */
	async signOut(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		if (!this.closed) this.markNeedsAuth();
	}

	/** Resolves once no transport of this server is open, including one that was still connecting. */
	async close(): Promise<void> {
		this.shutdown.abort();
		this.setState("closed", this.errorValue);
		const client = this.client;
		this.client = undefined;
		await Promise.all([client?.close().catch(() => undefined), this.opening?.catch(() => undefined)]);
	}

	private async run<T>(run: (client: McpClient) => Promise<T>, idempotent: boolean): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			const client = await this.connect();
			try {
				return await run(client);
			} catch (error) {
				if (idempotent && attempt === 1 && isTransientMcpError(error)) {
					await sleep(this.transientRetryDelayMs);
					continue;
				}
				if (error instanceof McpSessionExpiredError && attempt === 1) {
					// The server no longer knows the session (restart, deploy), so it did not run the request.
					// Retry once on a new session. The old client is detached but not closed: closing would
					// fail its other in-flight calls, which instead get the same 404 and retry the same way.
					if (this.client === client) this.client = undefined;
					continue;
				}
				if (!this.isAuthorizationError(error)) throw error;
				await this.dropClient(client);
				this.markNeedsAuth();
				throw new McpNeedsAuthError(this.name, { cause: error });
			}
		}
	}

	private async open(): Promise<McpClient> {
		this.setState("connecting", this.errorValue);
		for (let attempt = 0; ; attempt++) {
			this.stderrTail = undefined;
			try {
				return await this.connectOnce();
			} catch (error) {
				const delay = this.connectRetryDelaysMs[attempt];
				if (this.closed || delay === undefined || !isTransientMcpError(error)) throw this.failConnect(error);
				await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(() => undefined);
				if (this.closed) throw this.failConnect(error);
			}
		}
	}

	private async connectOnce(): Promise<McpClient> {
		const client = this.createClient();
		// Closing the client fails its pending initialize or discovery requests and closes the transport.
		// Memoized: a second `client.close()` returns before the first finished closing the transport.
		let closing: Promise<void> | undefined;
		const closeClient = () => {
			closing ??= client.close().catch(() => undefined);
			return closing;
		};
		this.shutdown.signal.addEventListener("abort", closeClient, { once: true });
		let transport: McpTransport | undefined;
		try {
			const created = this.createTransport();
			transport = created;
			await client.connect(created);
			client.onClose(() => this.handleClientClose(client, created));
			await this.onConnected?.(client);
			if (this.closed) throw new Error("shut down while connecting");
			if (client.connectionState !== "connected") throw new Error("connection closed during setup");
			this.client = client;
			this.setState("connected", undefined);
			return client;
		} catch (error) {
			await closeClient();
			this.stderrTail = diagnosticsTail(transport);
			throw error;
		} finally {
			this.shutdown.signal.removeEventListener("abort", closeClient);
		}
	}

	/** The transport dropped. The next call reconnects; until then the state shows why. */
	private handleClientClose(client: McpClient, transport: McpTransport): void {
		if (this.client !== client || this.closed) return;
		this.client = undefined;
		const tail = diagnosticsTail(transport);
		this.setState("disconnected", tail ? `Connection closed\n${tail}` : "Connection closed");
	}

	/** The error a connect attempt ends with, after the retries are used up. */
	private failConnect(error: unknown): Error {
		if (this.isAuthorizationError(error) && !this.closed) {
			this.markNeedsAuth();
			return new McpNeedsAuthError(this.name, { cause: error });
		}
		const message = error instanceof Error ? error.message : String(error);
		// The composed text, the same string `state` and `error` report, so a host can quote the failure
		// from the error alone instead of reading the state back after the fact.
		const failure = this.stderrTail ? `${message}\n${this.stderrTail}` : message;
		this.setState(this.closed ? "closed" : "failed", failure);
		return new McpConnectFailedError(failure, { cause: error });
	}

	private markNeedsAuth(): void {
		this.setState("needs-auth", undefined);
	}

	private setState(state: McpServerSessionState, error: string | undefined): void {
		this.stateValue = state;
		this.errorValue = error;
		this.onStateChange?.(state, error);
	}

	private async dropClient(client: McpClient): Promise<void> {
		if (this.client === client) this.client = undefined;
		await client.close().catch(() => undefined);
	}
}
