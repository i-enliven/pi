import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/mcp/src/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/mcp/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@i-enliven\/pi-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@i-enliven\/pi-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@i-enliven\/pi-mcp$/, replacement: workspaceSourcePaths.mcpIndex },
			{ find: /^@i-enliven\/pi-mcp\/oauth$/, replacement: workspaceSourcePaths.mcpOAuth },
			{ find: /^@i-enliven\/pi-mcp\/testing$/, replacement: workspaceSourcePaths.mcpTesting },
			{ find: /^@i-enliven\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@i-enliven\/pi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@i-enliven\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@i-enliven\/pi-ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@i-enliven\/pi-ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@i-enliven\/pi-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@i-enliven\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@i-enliven\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
