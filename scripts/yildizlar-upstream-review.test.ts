import { describe, expect, test } from "bun:test";
import { createReviewReport, resolveUpstreamRef } from "./yildizlar-upstream-review";

const ownedCommit = "a".repeat(40);
const upstreamCommit = "b".repeat(40);

describe("Yildizlar upstream review", () => {
	test("reports differences without proposing an installation", () => {
		expect(createReviewReport(ownedCommit, upstreamCommit, ["M\tpackages/coding-agent/src/session/turn-recovery.ts"])).toEqual({
		action: "review_required",
		ownedCommit,
		upstreamCommit,
		changedFiles: ["M\tpackages/coding-agent/src/session/turn-recovery.ts"],
		installAllowed: false,
	});
	});

	test("rejects malformed commit identifiers", () => {
		expect(createReviewReport("invalid", upstreamCommit, [])).toEqual({
		action: "invalid_input",
		reason: "owned commit must be a full SHA-1",
	});
	});

	test("reviews the freshly fetched upstream through FETCH_HEAD", () => {
		expect(resolveUpstreamRef(true, "upstream/main")).toBe("FETCH_HEAD");
		expect(resolveUpstreamRef(false, "upstream/main")).toBe("upstream/main");
	});
});
