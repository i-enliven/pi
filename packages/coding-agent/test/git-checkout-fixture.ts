/**
 * Local git fixtures for the source-checkout update tests: a checkout cloned
 * from a bare `fork` remote, plus an unrelated `origin` remote holding the same
 * commit. Everything is local, so no test needs network.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function configureRepo(dir: string): void {
	git(["config", "--local", "user.email", "test@test.com"], dir);
	git(["config", "--local", "user.name", "Test"], dir);
}

function writeAndCommit(dir: string, files: Record<string, string>, message: string): string {
	for (const [relativePath, content] of Object.entries(files)) {
		const path = join(dir, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	git(["add", "-A"], dir);
	git(["commit", "-m", message], dir);
	return git(["rev-parse", "HEAD"], dir);
}

export interface GitCheckoutFixture {
	tempDir: string;
	checkoutDir: string;
	forkDir: string;
	upstreamDir: string;
	/** Commit at which the checkout, the fork remote and the upstream remote all start. */
	baseCommit: string;
}

/**
 * Build a checkout whose `fork` remote holds `initialFiles` on main. The
 * checkout also tracks `origin/main`, so tests can prove which remote the
 * update path picks. The checkout starts clean and tracks `fork/main`.
 */
export function createGitCheckoutFixture(initialFiles: Record<string, string> = {}): GitCheckoutFixture {
	const tempDir = join(tmpdir(), `pi-git-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const seedDir = join(tempDir, "seed");
	const forkDir = join(tempDir, "fork.git");
	const upstreamDir = join(tempDir, "upstream.git");
	const checkoutDir = join(tempDir, "checkout");

	mkdirSync(seedDir, { recursive: true });
	git(["init", "--initial-branch=main", "--bare", forkDir], tempDir);
	git(["init", "--initial-branch=main", "--bare", upstreamDir], tempDir);
	git(["init", "--initial-branch=main"], seedDir);
	configureRepo(seedDir);
	const baseCommit = writeAndCommit(seedDir, { "README.md": "base\n", ...initialFiles }, "base");
	git(["remote", "add", "fork", forkDir], seedDir);
	git(["remote", "add", "origin", upstreamDir], seedDir);
	git(["push", "fork", "main"], seedDir);
	git(["push", "origin", "main"], seedDir);

	git(["clone", forkDir, checkoutDir], tempDir);
	configureRepo(checkoutDir);
	git(["remote", "rename", "origin", "fork"], checkoutDir);
	git(["remote", "add", "origin", upstreamDir], checkoutDir);
	git(["fetch", "origin"], checkoutDir);
	git(["branch", "--set-upstream-to=origin/main", "main"], checkoutDir);

	return { tempDir, checkoutDir, forkDir, upstreamDir, baseCommit };
}

export function removeGitCheckoutFixture(fixture: GitCheckoutFixture): void {
	rmSync(fixture.tempDir, { recursive: true, force: true });
}

/** Commit files to the fork remote without touching the checkout. Returns the new fork tip. */
export function pushFilesToFork(fixture: GitCheckoutFixture, files: Record<string, string>): string {
	const workDir = join(fixture.tempDir, `fork-push-${Object.keys(files).join("-")}`);
	mkdirSync(workDir, { recursive: true });
	git(["clone", fixture.forkDir, workDir], fixture.tempDir);
	configureRepo(workDir);
	const head = writeAndCommit(workDir, files, "fork commit");
	git(["push", "origin", "main"], workDir);
	return head;
}
