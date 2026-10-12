import { githubCopilotOAuth } from "./auth/oauth/github-copilot.ts";
import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";

/** Register OAuth flows statically embedded in the standalone Bun binary. */
export function registerBunOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		githubCopilot: () => githubCopilotOAuth,
	});
}
