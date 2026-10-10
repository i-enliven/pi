import { spawnProcess, spawnProcessSync, waitForChildProcess } from "./child-process.ts";

/** Remote preferred for updates when it exists, ahead of the tracked upstream. */
const DEFAULT_UPDATE_REMOTE = "fork";
/** Last remote tried when neither PI_UPDATE_REMOTE nor the fork remote exists. */
const FALLBACK_UPDATE_REMOTE = "origin";
const DEFAULT_NPM_COMMAND = "npm";

export interface CheckoutUpdateCommand {
	command: string;
	args: string[];
	display: string;
}

export interface CheckoutUpdatePlan {
	root: string;
	remote: string;
	branch: string;
	localCommit: string;
	remoteCommit: string;
	/** Commits on the update remote that this checkout does not have. */
	behind: number;
	commands: CheckoutUpdateCommand[];
}

export type CheckoutUpdateCheck =
	| { kind: "unavailable"; reason: string }
	| { kind: "blocked"; reason: string }
	| { kind: "checked"; plan: CheckoutUpdatePlan };

interface GitResult {
	stdout: string;
	ok: boolean;
	stderr: string;
}

function runGit(args: string[], cwd: string): GitResult {
	const result = spawnProcessSync("git", args, { cwd, encoding: "utf-8" });
	if (result.error) {
		return { stdout: "", ok: false, stderr: result.error.message };
	}
	return { stdout: result.stdout.trim(), ok: result.status === 0, stderr: result.stderr.trim() };
}

function gitOutput(args: string[], cwd: string): string | undefined {
	const result = runGit(args, cwd);
	return result.ok ? result.stdout : undefined;
}

function countCommits(args: string[], cwd: string): number {
	const output = gitOutput(args, cwd);
	const count = Number.parseInt(output ?? "", 10);
	return Number.isFinite(count) ? count : 0;
}

async function fetchRemote(remote: string, cwd: string): Promise<string | undefined> {
	const child = spawnProcess("git", ["-C", cwd, "fetch", "--quiet", remote], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr?.setEncoding("utf-8");
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const code = await waitForChildProcess(child);
	if (code === 0) return undefined;
	return stderr.trim() || `git fetch ${remote} exited with code ${code ?? "unknown"}`;
}

function hasRemote(remote: string, cwd: string): boolean {
	return gitOutput(["remote", "get-url", remote], cwd) !== undefined;
}

/**
 * Pick the remote a checkout updates from: PI_UPDATE_REMOTE, then the fork
 * remote, then the tracked upstream, then origin. The fork remote wins over the
 * tracked upstream so a checkout that still tracks an upstream clone never
 * pulls code this fork does not publish.
 */
function resolveUpdateRemote(cwd: string, branch: string): string | undefined {
	const configured = process.env.PI_UPDATE_REMOTE?.trim();
	if (configured && hasRemote(configured, cwd)) return configured;
	if (hasRemote(DEFAULT_UPDATE_REMOTE, cwd)) return DEFAULT_UPDATE_REMOTE;
	const upstream = gitOutput(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd);
	const upstreamRemote = upstream?.split("/")[0];
	if (upstreamRemote && hasRemote(upstreamRemote, cwd)) return upstreamRemote;
	if (hasRemote(FALLBACK_UPDATE_REMOTE, cwd)) return FALLBACK_UPDATE_REMOTE;
	return undefined;
}

function buildPlan(
	root: string,
	remote: string,
	branch: string,
	localCommit: string,
	remoteCommit: string,
	behind: number,
	npmCommand?: string[],
): CheckoutUpdatePlan {
	const npm = npmCommand && npmCommand.length > 0 ? npmCommand : [DEFAULT_NPM_COMMAND];
	return {
		root,
		remote,
		branch,
		localCommit,
		remoteCommit,
		behind,
		commands: [
			{
				command: "git",
				args: ["-C", root, "pull", "--ff-only", remote, branch],
				display: `git -C ${root} pull --ff-only ${remote} ${branch}`,
			},
			{
				command: npm[0],
				args: [...npm.slice(1), "-C", root, "install", "--ignore-scripts"],
				display: `${npm.join(" ")} -C ${root} install --ignore-scripts`,
			},
			{
				command: npm[0],
				args: [...npm.slice(1), "-C", root, "run", "build"],
				display: `${npm.join(" ")} -C ${root} run build`,
			},
		],
	};
}

/**
 * Check a source checkout against its update remote without changing it.
 *
 * `unavailable` means the directory cannot be updated automatically (not a git
 * checkout, no usable remote); `blocked` means it could be, but must not be
 * right now (uncommitted work, diverged branch, fetch failure).
 */
export async function checkCheckoutUpdate(root: string, npmCommand?: string[]): Promise<CheckoutUpdateCheck> {
	const branch = gitOutput(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
	if (!branch) {
		return { kind: "unavailable", reason: `${root} is not a git checkout on a branch` };
	}
	const remote = resolveUpdateRemote(root, branch);
	if (!remote) {
		return { kind: "unavailable", reason: `no update remote found for ${root}` };
	}

	const status = gitOutput(["status", "--porcelain"], root);
	if (status === undefined) {
		return { kind: "unavailable", reason: `${root} is not a git checkout` };
	}
	if (status) {
		const changes = status.split("\n").length;
		return {
			kind: "blocked",
			reason: `${root} has ${changes} uncommitted change${changes === 1 ? "" : "s"}. Commit or stash them first.`,
		};
	}

	if (!process.env.PI_OFFLINE) {
		const fetchError = await fetchRemote(remote, root);
		if (fetchError) {
			return { kind: "blocked", reason: `could not fetch ${remote}: ${fetchError}` };
		}
	}

	const remoteCommit = gitOutput(["rev-parse", "--verify", `${remote}/${branch}`], root);
	if (!remoteCommit) {
		return { kind: "blocked", reason: `the ${remote} remote has no branch '${branch}'` };
	}
	const localCommit = gitOutput(["rev-parse", "HEAD"], root);
	if (!localCommit) {
		return { kind: "unavailable", reason: `${root} has no commits on '${branch}'` };
	}

	const behind = countCommits(["rev-list", "--count", `${localCommit}..${remoteCommit}`], root);
	const ahead = countCommits(["rev-list", "--count", `${remoteCommit}..${localCommit}`], root);
	if (behind > 0 && ahead > 0) {
		return {
			kind: "blocked",
			reason: `'${branch}' has diverged from ${remote}/${branch}: ${ahead} local commit${
				ahead === 1 ? "" : "s"
			} not on the remote. Rebase or reset first.`,
		};
	}

	return {
		kind: "checked",
		plan: buildPlan(root, remote, branch, localCommit, remoteCommit, behind, npmCommand),
	};
}

/** Run the plan's steps in order, streaming their output. Rejects on the first failure. */
export async function runCheckoutUpdate(
	plan: CheckoutUpdatePlan,
	onStep?: (step: CheckoutUpdateCommand) => void,
): Promise<void> {
	for (const step of plan.commands) {
		onStep?.(step);
		const child = spawnProcess(step.command, step.args, { stdio: "inherit" });
		const code = await waitForChildProcess(child);
		if (code !== 0) {
			throw new Error(`${step.display} exited with code ${code ?? "unknown"}`);
		}
	}
}
