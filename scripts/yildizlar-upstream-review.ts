import { $ } from "bun";

const commitPattern = /^[0-9a-f]{40}$/;

export type UpstreamReviewReport =
	| {
			action: "review_required";
			ownedCommit: string;
			upstreamCommit: string;
			changedFiles: string[];
			installAllowed: false;
		}
	| { action: "invalid_input"; reason: string };

export function createReviewReport(
	ownedCommit: string,
	upstreamCommit: string,
	changedFiles: string[],
): UpstreamReviewReport {
	if (!commitPattern.test(ownedCommit)) return { action: "invalid_input", reason: "owned commit must be a full SHA-1" };
	if (!commitPattern.test(upstreamCommit)) return { action: "invalid_input", reason: "upstream commit must be a full SHA-1" };
	return {
		action: "review_required",
		ownedCommit,
		upstreamCommit,
		changedFiles,
		installAllowed: false,
	};
}

export function resolveUpstreamRef(shouldFetch: boolean, upstreamRef: string): string {
	if (shouldFetch) return "FETCH_HEAD";
	return upstreamRef;
}

async function gitText(...args: string[]): Promise<string> {
	const result = await $`git ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
	return result.text().trim();
}

async function main(): Promise<void> {
	const shouldFetch = process.argv.includes("--fetch");
	const refIndex = process.argv.indexOf("--upstream-ref");
	const upstreamRef = refIndex >= 0 ? process.argv[refIndex + 1] : "upstream/main";
	if (!upstreamRef) throw new Error("--upstream-ref requires a ref");
	if (shouldFetch) await gitText("fetch", "upstream", "main");

	const ownedCommit = await gitText("rev-parse", "HEAD");
	const upstreamCommit = await gitText("rev-parse", resolveUpstreamRef(shouldFetch, upstreamRef));
	const changedFiles = (await gitText("diff", "--name-status", `${ownedCommit}...${upstreamCommit}`))
		.split("\n")
		.filter(Boolean);
	const report = createReviewReport(ownedCommit, upstreamCommit, changedFiles);
	if (report.action === "invalid_input") throw new Error(report.reason);
	console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) await main();
