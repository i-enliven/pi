import type { InlineExtension } from "../core/extensions/types.ts";
import mcpExtension from "./mcp/index.ts";

export const builtInExtensions: InlineExtension[] = [
	// Replaceable: an extension that registers `/mcp` (such as a third-party MCP extension) takes
	// over instead of running alongside the built-in one.
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
