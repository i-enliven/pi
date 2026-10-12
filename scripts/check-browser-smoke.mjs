import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const agentTreeshakeOutputPath = join(tmpdir(), "pi-agent-treeshake-smoke.js");
const errorLogPath = join(tmpdir(), "pi-browser-smoke-errors.log");
const generatedCatalogDataDir = join(process.cwd(), "packages/ai/src/providers/data");

// Fresh checkouts do not materialize provider JSON until model data is hydrated.
const generatedCatalogDataPlugin = {
	name: "generated-model-catalog",
	setup(build) {
		build.onResolve({ filter: /^\.\/data\/[^/]+\.json$/ }, (args) => {
			const path = resolve(dirname(args.importer), args.path);
			if (dirname(path) !== generatedCatalogDataDir || existsSync(path)) return;
			return { path, namespace: "empty-generated-model-catalog" };
		});
		build.onLoad({ filter: /.*/, namespace: "empty-generated-model-catalog" }, () => ({
			contents: "{}",
			loader: "json",
		}));
	},
};

function normalizePath(path) {
	return path.replaceAll("\\", "/");
}

function findInput(inputs, suffix) {
	return Object.keys(inputs).find((input) => {
		const normalized = normalizePath(input);
		return normalized === suffix || normalized.endsWith(`/${suffix}`);
	});
}

function includesNodePackage(inputs, packageName) {
	const marker = `node_modules/${packageName}/`;
	return Object.keys(inputs).some((input) => normalizePath(input).includes(marker));
}

try {
	const agentTreeshakeBuild = await build({
		entryPoints: ["scripts/agent-treeshake-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		metafile: true,
		outfile: agentTreeshakeOutputPath,
		plugins: [generatedCatalogDataPlugin],
		write: false,
	});
	const inputs = agentTreeshakeBuild.metafile.inputs;
	for (const forbiddenInput of [
		"packages/ai/src/compat.ts",
		"packages/ai/src/models.generated.ts",
		"packages/ai/src/providers/all.ts",
	]) {
		const includedInput = findInput(inputs, forbiddenInput);
		if (includedInput) {
			throw new Error(`Agent selective-provider bundle unexpectedly includes ${includedInput}`);
		}
	}

	const contributingInputs = new Set(
		Object.values(agentTreeshakeBuild.metafile.outputs).flatMap((output) =>
			Object.entries(output.inputs)
				.filter(([, contribution]) => contribution.bytesInOutput > 0)
				.map(([input]) => input),
		),
	);
	const catalogInputs = Array.from(contributingInputs).filter((input) =>
		normalizePath(input).includes("packages/ai/src/providers/data/"),
	);
	if (catalogInputs.length !== 1 || !normalizePath(catalogInputs[0]).endsWith("/github-copilot.json")) {
		throw new Error(
			`Agent selective-provider bundle catalogs: expected only github-copilot.json, found ${catalogInputs.join(", ") || "none"}`,
		);
	}

	// The Copilot provider registers the Anthropic Messages, Chat Completions and Responses
	// implementations, so exactly these two API clients may reach the browser bundle.
	const expectedAiSdkPackages = ["@anthropic-ai/sdk", "openai"];
	// SDKs the removed providers used. One here means treeshaking regressed and a removed provider
	// is back in the graph.
	const forbiddenAiSdkPackages = [
		"@aws-sdk/client-bedrock-runtime",
		"@smithy/node-http-handler",
		"@google/genai",
		"http-proxy-agent",
		"https-proxy-agent",
	];
	const includedAiSdkPackages = expectedAiSdkPackages.filter((packageName) => includesNodePackage(inputs, packageName));
	if (includedAiSdkPackages.length !== expectedAiSdkPackages.length) {
		throw new Error(
			`Agent selective-provider bundle SDKs: expected only ${expectedAiSdkPackages.join(", ")}, found ${includedAiSdkPackages.join(", ") || "none"}`,
		);
	}
	const includedForbiddenAiSdkPackages = forbiddenAiSdkPackages.filter((packageName) =>
		includesNodePackage(inputs, packageName),
	);
	if (includedForbiddenAiSdkPackages.length > 0) {
		throw new Error(
			`Agent selective-provider bundle SDKs: unexpected removed-provider SDKs ${includedForbiddenAiSdkPackages.join(", ")}`,
		);
	}

	process.exit(0);
} catch (error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
