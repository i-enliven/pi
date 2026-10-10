import { compare, valid } from "semver";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const DEFAULT_UPDATE_REPO = "i-enliven/pi";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

/** GitHub repository that publishes this Pi fork, overridable with PI_UPDATE_REPO. */
export function getUpdateRepo(): string {
	return process.env.PI_UPDATE_REPO?.trim() || DEFAULT_UPDATE_REPO;
}

function getLatestReleaseUrl(): string {
	return `https://api.github.com/repos/${getUpdateRepo()}/releases/latest`;
}

function getMainPackageJsonUrl(): string {
	return `https://raw.githubusercontent.com/${getUpdateRepo()}/main/packages/coding-agent/package.json`;
}

export interface LatestPiRelease {
	version: string;
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	const headers = {
		"User-Agent": getPiUserAgent(currentVersion),
		accept: "application/json",
	};
	const response = await fetchWithRetry(
		getLatestReleaseUrl(),
		{ headers },
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (response.status === 404) {
		// The fork has not published GitHub releases yet; fall back to the version
		// declared on the main branch so source installs still learn about updates.
		return getMainBranchVersion(options);
	}
	if (!response.ok) return undefined;

	const data = (await response.json()) as { tag_name?: unknown; body?: unknown };
	if (typeof data.tag_name !== "string" || !data.tag_name.trim()) {
		return undefined;
	}
	const version = data.tag_name.trim().replace(/^v/, "");
	const rawNote = typeof data.body === "string" ? data.body.trim() : undefined;
	// Keep the terminal-rendered note bounded.
	const note = rawNote && rawNote.length > 2000 ? `${rawNote.slice(0, 2000).trimEnd()}…` : rawNote;
	return {
		version,
		...(note ? { note } : {}),
	};
}

async function getMainBranchVersion(
	options: { retry?: boolean; timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	try {
		const response = await fetchWithRetry(
			getMainPackageJsonUrl(),
			{ headers: { accept: "application/json" } },
			{
				maxRetries: options.retry ? 2 : 0,
				timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
			},
		);
		if (!response.ok) return undefined;
		const data = (await response.json()) as { version?: unknown };
		if (typeof data.version !== "string" || !data.version.trim()) return undefined;
		return {
			version: data.version.trim(),
			note: `No GitHub release is published yet. Update from the main branch: git pull && npm run build (main reports v${data.version.trim()}).`,
		};
	} catch {
		return undefined;
	}
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
