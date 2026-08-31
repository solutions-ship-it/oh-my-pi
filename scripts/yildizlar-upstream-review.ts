import * as path from "node:path";
import { $ } from "bun";
import { loadReleaseContext, normalizeGitHubRepository, type OwnedReleaseManifest } from "./yildizlar-release";

const commitPattern = /^[0-9a-f]{40}$/;
const branchPattern = /^[A-Za-z0-9._/-]+$/;

export type UpstreamReviewReport =
	| {
			action: "review_required";
			ownedCommit: string;
			upstreamCommit: string;
			mergeBase: string;
			upstreamOnlyFiles: string[];
			ownedOnlyFiles: string[];
			installAllowed: false;
	  }
	| { action: "invalid_input"; reason: string };

export type ReviewArgumentValidation = { ok: true } | { ok: false; reason: string };

export function validateReviewArguments(arguments_: string[]): ReviewArgumentValidation {
	if (arguments_.some(argument => argument === "--upstream-ref" || argument.startsWith("--upstream-ref="))) {
		return { ok: false, reason: "caller-selected upstream refs are not allowed" };
	}
	if (!arguments_.includes("--fetch")) return { ok: false, reason: "upstream review requires --fetch" };
	if (arguments_.length !== 1) return { ok: false, reason: "upstream review accepts only --fetch" };
	return { ok: true };
}

function hasControlCharacter(value: string): boolean {
	return [...value].some(character => {
		const code = character.codePointAt(0);
		return code !== undefined && (code < 32 || code === 127);
	});
}

export function createReviewReport(
	ownedCommit: string,
	upstreamCommit: string,
	mergeBase: string,
	upstreamOnlyFiles: string[],
	ownedOnlyFiles: string[],
): UpstreamReviewReport {
	if (!commitPattern.test(ownedCommit))
		return { action: "invalid_input", reason: "owned commit must be a full SHA-1" };
	if (!commitPattern.test(upstreamCommit)) {
		return { action: "invalid_input", reason: "upstream commit must be a full SHA-1" };
	}
	if (!commitPattern.test(mergeBase)) return { action: "invalid_input", reason: "merge base must be a full SHA-1" };
	if ([...upstreamOnlyFiles, ...ownedOnlyFiles].some(hasControlCharacter)) {
		return { action: "invalid_input", reason: "changed file path contains a control character" };
	}
	return {
		action: "review_required",
		ownedCommit,
		upstreamCommit,
		mergeBase,
		upstreamOnlyFiles,
		ownedOnlyFiles,
		installAllowed: false,
	};
}

async function gitText(root: string, ...args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(root).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
	return result.text().trim();
}

async function gitPaths(root: string, range: string): Promise<string[]> {
	const result = await $`git diff --name-only -z ${range}`.cwd(root).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git diff ${range} failed`);
	return result.stdout.toString().split("\0").filter(Boolean);
}

type UpstreamReviewManifest = OwnedReleaseManifest & {
	upstreamRepository: string;
	upstreamBranch: string;
};

function isUpstreamReviewManifest(value: unknown): value is UpstreamReviewManifest {
	if (typeof value !== "object" || value === null) return false;
	return (
		"schemaVersion" in value &&
		"channel" in value &&
		"sourceCommit" in value &&
		"releaseBranch" in value &&
		"ownedRepository" in value &&
		"bundleSha256" in value &&
		"upstreamRepository" in value &&
		"upstreamBranch" in value &&
		typeof value.schemaVersion === "number" &&
		typeof value.channel === "string" &&
		typeof value.sourceCommit === "string" &&
		typeof value.releaseBranch === "string" &&
		typeof value.ownedRepository === "string" &&
		typeof value.bundleSha256 === "string" &&
		typeof value.upstreamRepository === "string" &&
		typeof value.upstreamBranch === "string"
	);
}

function upstreamManifestError(value: unknown): string | null {
	if (!isUpstreamReviewManifest(value)) return "release manifest is invalid";
	if (!normalizeGitHubRepository(value.upstreamRepository) || !branchPattern.test(value.upstreamBranch)) {
		return "release manifest is invalid";
	}
	return null;
}

async function readManifest(root: string): Promise<unknown> {
	return Bun.file(path.join(root, "ops", "yildizlar-omp-release.json")).json();
}

async function main(): Promise<void> {
	const argumentValidation = validateReviewArguments(process.argv.slice(2));
	if (!argumentValidation.ok) throw new Error(argumentValidation.reason);

	const root = path.resolve(import.meta.dir, "..");
	const rawManifest = await readManifest(root);
	const invalidManifest = upstreamManifestError(rawManifest);
	if (invalidManifest || !isUpstreamReviewManifest(rawManifest))
		throw new Error(invalidManifest ?? "release manifest is invalid");
	const manifest = rawManifest;
	const context = await loadReleaseContext(root, manifest);
	if (!context.isClean) throw new Error("owned release checkout is not clean");
	if (context.branch !== manifest.releaseBranch) throw new Error("owned release branch does not match manifest");
	if (context.originRepository !== manifest.ownedRepository)
		throw new Error("owned release origin does not match manifest");
	if (!context.sourceIsAncestor) throw new Error("pinned source commit is not an ancestor of owned HEAD");

	const upstreamRepository = normalizeGitHubRepository(await gitText(root, "remote", "get-url", "upstream"));
	if (upstreamRepository !== normalizeGitHubRepository(manifest.upstreamRepository)) {
		throw new Error("upstream remote does not match manifest");
	}
	await gitText(root, "fetch", "--no-tags", "upstream", `refs/heads/${manifest.upstreamBranch}`);

	const ownedCommit = context.head;
	const upstreamCommit = await gitText(root, "rev-parse", "--verify", "FETCH_HEAD^{commit}");
	const mergeBase = await gitText(root, "merge-base", ownedCommit, upstreamCommit);
	const report = createReviewReport(
		ownedCommit,
		upstreamCommit,
		mergeBase,
		await gitPaths(root, `${mergeBase}..${upstreamCommit}`),
		await gitPaths(root, `${mergeBase}..${ownedCommit}`),
	);
	if (report.action === "invalid_input") throw new Error(report.reason);
	console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) await main();
