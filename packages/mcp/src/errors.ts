/**
 * HTTP failures of an MCP server, and the one rule for which of them are worth another attempt.
 *
 * The transports throw these; `McpServerSession` and the transports' own reconnect loops decide what
 * a failure means. Retrying is only ever about the transport: a JSON-RPC error (`McpError`) is the
 * server answering the request, and retrying it would run it again.
 */

export class McpHttpError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, message: string, body = "") {
		super(message);
		this.name = "McpHttpError";
		this.status = status;
		this.body = body;
	}
}

export class McpAuthRequiredError extends McpHttpError {
	readonly wwwAuthenticate: string | null;

	constructor(response: Response, body = "") {
		super(401, "MCP server requires authentication", body);
		this.name = "McpAuthRequiredError";
		this.wwwAuthenticate = response.headers.get("www-authenticate");
	}
}

export class McpSessionExpiredError extends McpHttpError {
	constructor(body = "") {
		super(404, "MCP session expired", body);
		this.name = "McpSessionExpiredError";
	}
}

/**
 * Whether a failure is transient: the server was unreachable or busy, so the same attempt may
 * succeed again later. `fetch` reports network failures, including a connection dropped mid-body, as
 * `TypeError`; node and undici report theirs as an error `code` (`ECONNRESET`, `UND_ERR_SOCKET`, ...).
 *
 * `501 Not Implemented` is deliberately not transient: a server that does not support something does
 * not start supporting it while a client waits.
 */
export function isTransientMcpError(error: unknown): boolean {
	if (error instanceof McpHttpError) {
		return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
	}
	if (error instanceof TypeError) return true;
	const code = (error as { code?: unknown } | undefined)?.code;
	return typeof code === "string" && (code.startsWith("E") || code.startsWith("UND_ERR"));
}
