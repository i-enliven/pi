import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestPiRelease,
	getLatestPiVersion,
	getUpdateRepo,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const LATEST_RELEASE_URL = "https://api.github.com/repos/i-enliven/pi/releases/latest";
const MAIN_PACKAGE_JSON_URL = "https://raw.githubusercontent.com/i-enliven/pi/main/packages/coding-agent/package.json";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the fork GitHub releases api with a pi user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			LATEST_RELEASE_URL,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("honors PI_UPDATE_REPO for the releases api", async () => {
		const previousRepo = process.env.PI_UPDATE_REPO;
		process.env.PI_UPDATE_REPO = "someone-else/pi";
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v2.0.0" }));
		vi.stubGlobal("fetch", fetchMock);

		try {
			expect(getUpdateRepo()).toBe("someone-else/pi");
			await expect(getLatestPiVersion("1.2.3")).resolves.toBe("2.0.0");
			expect(fetchMock).toHaveBeenCalledWith(
				"https://api.github.com/repos/someone-else/pi/releases/latest",
				expect.anything(),
			);
		} finally {
			if (previousRepo === undefined) delete process.env.PI_UPDATE_REPO;
			else process.env.PI_UPDATE_REPO = previousRepo;
		}
	});

	it("parses release tags and bounded notes", async () => {
		const longNote = "x".repeat(3000);
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.4", body: ` ${longNote} ` }));
		vi.stubGlobal("fetch", fetchMock);

		const release = await getLatestPiRelease("1.2.3");
		expect(release?.version).toBe("1.2.4");
		expect(release?.note?.endsWith("…")).toBe(true);
		expect((release?.note ?? "").length).toBeLessThanOrEqual(2001);
	});

	it("falls back to the main branch package.json when the fork has no releases", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
			.mockResolvedValueOnce(Response.json({ version: "1.3.0" }));
		vi.stubGlobal("fetch", fetchMock);

		const release = await getLatestPiRelease("1.2.3");
		expect(release?.version).toBe("1.3.0");
		expect(release?.note).toContain("No GitHub release is published yet");
		expect(fetchMock).toHaveBeenNthCalledWith(2, MAIN_PACKAGE_JSON_URL, expect.anything());
	});

	it("returns nothing when neither releases nor main respond", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
			.mockResolvedValueOnce(new Response("Nope", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3", { retry: true })).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
