import { setKeybindings } from "@i-enliven/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("projects provider-owned auth options without provider-specific filtering", () => {
		const getLoginProviderOptions = (
			InteractiveMode as unknown as {
				prototype: {
					getLoginProviderOptions(
						this: object,
						authType?: "oauth" | "api_key",
					): Array<{ id: string; name: string; authType: string; method?: { name: string; login?: unknown } }>;
				};
			}
		).prototype.getLoginProviderOptions;
		const providers = [
			{
				id: "github-copilot",
				name: "GitHub Copilot",
				auth: {
					oauth: { name: "GitHub Copilot", login: async () => ({}) },
					apiKey: { name: "GitHub Copilot token", login: async () => ({}) },
				},
			},
			{
				id: "custom-proxy",
				name: "Custom Proxy",
				auth: { apiKey: { name: "Custom credentials" } },
			},
		];
		const fakeThis = {
			session: {
				modelRuntime: {
					getProviders: () => providers,
					getProviderAuthStatus: () => ({ configured: false }),
					isUsingOAuth: () => false,
				},
			},
		};

		const apiKeyOptions = getLoginProviderOptions.call(fakeThis, "api_key");
		expect(apiKeyOptions).toMatchObject([
			{
				id: "custom-proxy",
				name: "Custom Proxy",
				authType: "api_key",
				method: { name: "Custom credentials" },
			},
			{
				id: "github-copilot",
				name: "GitHub Copilot",
				authType: "api_key",
				method: { name: "GitHub Copilot token" },
			},
		]);
		expect(getLoginProviderOptions.call(fakeThis, "oauth")).toMatchObject([
			{ id: "github-copilot", name: "GitHub Copilot", authType: "oauth" },
		]);
	});

	it("renders an option without compiled auth status as not configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "custom", name: "Custom", authType: "api_key", status: undefined }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("not configured");
		expect(output).not.toContain("✓ configured");
	});

	it("shows OAuth auth distinctly in the API key selector", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{
					id: "github-copilot",
					name: "GitHub Copilot",
					authType: "api_key",
					status: { type: "oauth", source: "OAuth" },
				},
			],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("subscription configured");
	});

	it("shows environment API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{
					id: "github-copilot",
					name: "GitHub Copilot",
					authType: "api_key",
					status: { type: "api_key", source: "COPILOT_GITHUB_TOKEN" },
				},
			],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("✓ env: COPILOT_GITHUB_TOKEN");
		expect(output).not.toContain("not configured");
	});

	it("shows models.json API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{
					id: "local-proxy",
					name: "local-proxy",
					authType: "api_key",
					status: { type: "api_key", source: "key in models.json" },
				},
			],
			() => {},
			() => {},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("✓ key in models.json");
	});

	it("shows models.json command auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{
					id: "op-proxy",
					name: "op-proxy",
					authType: "api_key",
					status: { type: "api_key", source: "command in models.json" },
				},
			],
			() => {},
			() => {},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("✓ command in models.json");
	});
});
