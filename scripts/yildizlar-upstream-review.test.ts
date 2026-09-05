import { describe, expect, test } from "bun:test";
import { createReviewReport, upstreamManifestError, validateReviewArguments } from "./yildizlar-upstream-review";

const ownedCommit = "a".repeat(40);
const upstreamCommit = "b".repeat(40);
const mergeBase = "c".repeat(40);

const reviewManifest = {
	schemaVersion: 2,
	channel: "yildizlar-local",
	sourceCommit: "f164081c65e9d2059868d879ce42d4fc2a960d8c",
	releaseBranch: "yildizlar/omp-runtime",
	ownedRepository: "github.com/solutions-ship-it/oh-my-pi",
	bundleSha256: "96ec22ca46f270b91c4547c260156a9af3d6ad0c5ca77f509fa549348640b770",
	status: "superseded",
	upstreamRepository: "github.com/can1357/oh-my-pi",
	upstreamBranch: "main",
};

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

	test("manifest typeguard requires the status KEY but never gates on its VALUE", () => {
		// `status` is required on OwnedReleaseManifest, so the predicate must
		// verify the key — otherwise it narrows to a type promising a missing
		// field. Its VALUE is deliberately not gated here: this is the read-only
		// review path, so a `superseded` lane must still be reviewable.
		expect(upstreamManifestError(reviewManifest)).toBeNull();
		expect(reviewManifest.status).toBe("superseded");

		const { status: _dropped, ...withoutStatus } = reviewManifest;
		expect("status" in withoutStatus).toBe(false);
		expect(upstreamManifestError(withoutStatus)).toBe("release manifest is invalid");

		// An explicitly active lane is equally reviewable — the value is not a gate.
		expect(upstreamManifestError({ ...reviewManifest, status: "active" })).toBeNull();
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
