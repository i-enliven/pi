/**
 * A fake `npm` for tests: an argv-compatible script that records each invocation
 * instead of touching the network or the filesystem. Point the `npmCommand`
 * setting at `npmCommand` to route package operations through it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeNpmRecorder {
	/** argv-style value for the npmCommand setting. */
	npmCommand: string[];
	/** Recorded argv of each invocation, in order. */
	calls(): string[][];
}

export function createFakeNpmRecorder(dir: string, options?: { failOn?: string; exitCode?: number }): FakeNpmRecorder {
	const id = Math.random().toString(36).slice(2);
	const recordPath = join(dir, `npm-calls-${id}.json`);
	const scriptPath = join(dir, `fake-npm-${id}.cjs`);
	const failOn = options?.failOn;
	writeFileSync(
		scriptPath,
		`const fs=require("node:fs"),args=process.argv.slice(2);
const calls=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf8")):[];
calls.push(args);
fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(calls));
${failOn ? `if(args.includes(${JSON.stringify(failOn)})) process.exit(${options?.exitCode ?? 7});` : ""}
`,
	);
	return {
		npmCommand: [process.execPath, scriptPath],
		calls: () => (existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf-8")) as string[][]) : []),
	};
}
