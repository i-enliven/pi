import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import { createModels } from "../src/models.ts";
import * as extensionOAuthCompatibility from "../src/oauth.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe.sequential("OAuthAuth adapters", () => {
	it("keeps the extension OAuth barrel free of built-in flow implementations", () => {
		expect(Object.keys(extensionOAuthCompatibility)).toEqual([]);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("marks the GitHub Copilot OAuth flow as subscription-backed", () => {
		expect(githubCopilotOAuth.isSubscription).toBe(true);
	});

	it("github-copilot toAuth derives baseUrl from the token proxy endpoint", async () => {
		const access = "tid=abc;exp=123;proxy-ep=proxy.enterprise.example;rest";
		const auth = await githubCopilotOAuth.toAuth({ type: "oauth", access, refresh: "r", expires: 0 });
		expect(auth).toEqual({ apiKey: access, baseUrl: "https://api.enterprise.example" });
	});

	it("github-copilot toAuth falls back to the enterprise domain, then the individual endpoint", async () => {
		const enterprise = await githubCopilotOAuth.toAuth({
			type: "oauth",
			access: "no-proxy-ep",
			refresh: "r",
			expires: 0,
			enterpriseUrl: "https://company.ghe.com",
		});
		expect(enterprise.baseUrl).toBe("https://copilot-api.company.ghe.com");

		const individual = await githubCopilotOAuth.toAuth({
			type: "oauth",
			access: "no-proxy-ep",
			refresh: "r",
			expires: 0,
		});
		expect(individual.baseUrl).toBe("https://api.individual.githubcopilot.com");
	});

	it("github-copilot refresh preserves the enterprise domain", async () => {
		const fetchedUrls: string[] = [];
		const fetchMock = vi.fn(async (input: unknown) => {
			const url = typeof input === "string" ? input : String(input);
			fetchedUrls.push(url);
			if (url.endsWith("/models")) {
				return jsonResponse({ data: [] });
			}
			return jsonResponse({ token: "new-token", expires_at: 9999999999 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const refreshed = await githubCopilotOAuth.refresh(
			{
				type: "oauth",
				access: "old",
				refresh: "gh-token",
				expires: 0,
				enterpriseUrl: "company.ghe.com",
			},
			neverAbortedSignal,
		);
		expect(refreshed.access).toBe("new-token");
		expect(refreshed.enterpriseUrl).toBe("company.ghe.com");
		expect(fetchedUrls[0]).toContain("api.company.ghe.com");
	});
});

describe("OAuth through Models.getAuth (lazy load chain)", () => {
	it("resolves stored github-copilot oauth credentials including per-credential baseUrl", async () => {
		const access = "tid=abc;exp=123;proxy-ep=proxy.business.githubcopilot.com;rest";
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("github-copilot", async () => ({
			type: "oauth",
			access,
			refresh: "r",
			// Keep this beyond getAuth()'s refresh window.
			expires: Date.now() + 10 * 60_000,
		}));
		const models = createModels({ credentials });
		models.setProvider(githubCopilotProvider());

		const model = models.getModels("github-copilot")[0];
		const result = await models.getAuth(model.provider);
		expect(result?.auth.apiKey).toBe(access);
		expect(result?.auth.baseUrl).toBe("https://api.business.githubcopilot.com");
	});
});
