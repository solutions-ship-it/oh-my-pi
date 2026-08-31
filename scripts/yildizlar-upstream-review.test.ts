import { describe, expect, test } from "bun:test";
import { createReviewReport, validateReviewArguments } from "./yildizlar-upstream-review";

const ownedCommit = "a".repeat(40);
const upstreamCommit = "b".repeat(40);
const mergeBase = "c".repeat(40);

describe("Yildizlar upstream review", () => {
	test("reports both directional diffs without proposing an installation", () => {
		expect(
			createReviewReport(
				ownedCommit,
				upstreamCommit,
				mergeBase,
				["packages/coding-agent/src/session/turn-recovery.ts"],
				["scripts/yildizlar-release.ts"],
			),
		).toEqual({
			action: "review_required",
			ownedCommit,
			upstreamCommit,
			mergeBase,
			upstreamOnlyFiles: ["packages/coding-agent/src/session/turn-recovery.ts"],
			ownedOnlyFiles: ["scripts/yildizlar-release.ts"],
			installAllowed: false,
		});
	});

	test("rejects malformed commit identifiers and unsafe report paths", () => {
		expect(createReviewReport("invalid", upstreamCommit, mergeBase, [], [])).toEqual({
			action: "invalid_input",
			reason: "owned commit must be a full SHA-1",
		});
		expect(createReviewReport(ownedCommit, upstreamCommit, mergeBase, ["unsafe\npath"], [])).toEqual({
			action: "invalid_input",
			reason: "changed file path contains a control character",
		});
	});

	test("requires a fresh canonical upstream fetch and rejects caller-selected refs", () => {
		expect(validateReviewArguments(["--fetch"])).toEqual({ ok: true });
		expect(validateReviewArguments([])).toEqual({
			ok: false,
			reason: "upstream review requires --fetch",
		});
		expect(validateReviewArguments(["--fetch", "--upstream-ref", "main"])).toEqual({
			ok: false,
			reason: "caller-selected upstream refs are not allowed",
		});
	});
});
