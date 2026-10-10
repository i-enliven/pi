/**
 * Tests for the source-checkout self-update path: `pi update` checks the fork
 * remote for new commits and runs pull + install + build itself.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCheckoutUpdate, runCheckoutUpdate } from "../src/utils/checkout-update.ts";
import { createFakeNpmRecorder } from "./fake-npm-recorder.ts";
import {
	createGitCheckoutFixture,
	type GitCheckoutFixture,
	git,
	pushFilesToFork,
	removeGitCheckoutFixture,
} from "./git-checkout-fixture.ts";
import { allowNetwork } from "./test-network-env.ts";

let fixture: GitCheckoutFixture;
let previousUpdateRemote: string | undefined;

function commitFile(dir: string, filename: string, content: string, message: string): string {
	writeFileSync(join(dir, filename), content);
	git(["add", filename], dir);
	git(["commit", "-m", message], dir);
	return git(["rev-parse", "HEAD"], dir);
}

beforeEach(() => {
	allowNetwork();
	fixture = createGitCheckoutFixture();
	previousUpdateRemote = process.env.PI_UPDATE_REMOTE;
	delete process.env.PI_UPDATE_REMOTE;
});

afterEach(() => {
	removeGitCheckoutFixture(fixture);
	vi.unstubAllEnvs();
	if (previousUpdateRemote === undefined) {
		delete process.env.PI_UPDATE_REMOTE;
	} else {
		process.env.PI_UPDATE_REMOTE = previousUpdateRemote;
	}
});

describe("checkCheckoutUpdate", () => {
	it("uses the fork remote when the branch tracks a different remote", async () => {
		const check = await checkCheckoutUpdate(fixture.checkoutDir);

		expect(check.kind).toBe("checked");
		if (check.kind !== "checked") return;
		expect(check.plan.remote).toBe("fork");
		expect(check.plan.branch).toBe("main");
	});

	it("falls back to the tracked upstream when there is no fork remote", async () => {
		git(["remote", "remove", "fork"], fixture.checkoutDir);

		const check = await checkCheckoutUpdate(fixture.checkoutDir);

		expect(check.kind).toBe("checked");
		if (check.kind !== "checked") return;
		expect(check.plan.remote).toBe("origin");
	});

	it("uses the remote named by PI_UPDATE_REMOTE", async () => {
		git(["remote", "rename", "fork", "mirror"], fixture.checkoutDir);
		vi.stubEnv("PI_UPDATE_REMOTE", "mirror");

		const check = await checkCheckoutUpdate(fixture.checkoutDir);

		expect(check.kind).toBe("checked");
		if (check.kind !== "checked") return;
		expect(check.plan.remote).toBe("mirror");
	});

	it("reports the number of commits behind the fork remote", async () => {
		pushFilesToFork(fixture, { "change-0.txt": "0\n" });
		const forkHead = pushFilesToFork(fixture, { "change-1.txt": "1\n" });

		const check = await checkCheckoutUpdate(fixture.checkoutDir);

		expect(check.kind).toBe("checked");
		if (check.kind !== "checked") return;
		expect(check.plan.behind).toBe(2);
		expect(check.plan.localCommit).toBe(fixture.baseCommit);
		expect(check.plan.remoteCommit).toBe(forkHead);
	});

	it("reports no commits behind when the checkout matches the fork", async () => {
		const check = await checkCheckoutUpdate(fixture.checkoutDir);

		expect(check.kind).toBe("checked");
		if (check.kind !== "checked") return;
		expect(check.plan.behind).toBe(0);
		expect(check.plan.localCommit).toBe(fixture.baseCommit);
	});

	it("compares against the last fetched fork state when PI_OFFLINE is set", async () => {
		pushFilesToFork(fixture, { "change.txt": "1\n" });
		vi.stubEnv("PI_OFFLINE", "1");

		const check = await checkCheckoutUpdate(fixture.checkoutDir);

		expect(check.kind).toBe("checked");
		if (check.kind !== "checked") return;
		expect(check.plan.behind).toBe(0);
	});

	it("blocks when the checkout has uncommitted changes", async () => {
		writeFileSync(join(fixture.checkoutDir, "dirty.txt"), "work in progress\n");

		const check = await checkCheckoutUpdate(fixture.checkoutDir);

		expect(check.kind).toBe("blocked");
		if (check.kind !== "blocked") return;
		expect(check.reason).toContain("uncommitted");
	});

	it("blocks when the checkout has commits the fork does not have", async () => {
		pushFilesToFork(fixture, { "fork.txt": "fork\n" });
		commitFile(fixture.checkoutDir, "local.txt", "local work\n", "local commit");

		const check = await checkCheckoutUpdate(fixture.checkoutDir);

		expect(check.kind).toBe("blocked");
		if (check.kind !== "blocked") return;
		expect(check.reason).toContain("diverged");
	});

	it("blocks when the fork has no matching branch", async () => {
		git(["checkout", "-b", "experiment"], fixture.checkoutDir);

		const check = await checkCheckoutUpdate(fixture.checkoutDir);

		expect(check.kind).toBe("blocked");
		if (check.kind !== "blocked") return;
		expect(check.reason).toContain("experiment");
	});

	it("reports unavailable when the directory is not a git repository", async () => {
		const notARepo = join(fixture.tempDir, "not-a-repo");
		mkdirSync(join(notARepo, ".git"), { recursive: true });

		const check = await checkCheckoutUpdate(notARepo);

		expect(check.kind).toBe("unavailable");
	});
});

describe("runCheckoutUpdate", () => {
	it("pulls the fork and runs install and build", async () => {
		const forkHead = pushFilesToFork(fixture, { "change.txt": "1\n" });
		const fakeNpm = createFakeNpmRecorder(fixture.tempDir);

		const check = await checkCheckoutUpdate(fixture.checkoutDir, fakeNpm.npmCommand);
		if (check.kind !== "checked") throw new Error(`unexpected check result: ${check.kind}`);
		const started: string[] = [];
		await runCheckoutUpdate(check.plan, (step) => started.push(step.display));

		expect(git(["rev-parse", "HEAD"], fixture.checkoutDir)).toBe(forkHead);
		expect(started).toEqual([
			`git -C ${fixture.checkoutDir} pull --ff-only fork main`,
			`${fakeNpm.npmCommand.join(" ")} -C ${fixture.checkoutDir} install --ignore-scripts`,
			`${fakeNpm.npmCommand.join(" ")} -C ${fixture.checkoutDir} run build`,
		]);
		expect(fakeNpm.calls()).toEqual([
			["-C", fixture.checkoutDir, "install", "--ignore-scripts"],
			["-C", fixture.checkoutDir, "run", "build"],
		]);
	});

	it("fails with the display of the step that failed", async () => {
		pushFilesToFork(fixture, { "change.txt": "1\n" });
		const fakeNpm = createFakeNpmRecorder(fixture.tempDir, { failOn: "install" });

		const check = await checkCheckoutUpdate(fixture.checkoutDir, fakeNpm.npmCommand);
		if (check.kind !== "checked") throw new Error(`unexpected check result: ${check.kind}`);

		await expect(runCheckoutUpdate(check.plan)).rejects.toThrow(/install --ignore-scripts.*exited with code 7/);
		expect(fakeNpm.calls().length).toBe(1);
	});
});
