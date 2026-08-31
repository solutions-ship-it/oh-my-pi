import { describe, expect, test } from "bun:test";
import { validateOwnedRelease } from "./yildizlar-release";

const manifest = {
	schemaVersion: 1,
	channel: "yildizlar-local",
	sourceCommit: "f164081c65e9d2059868d879ce42d4fc2a960d8c",
	bundleSha256: "96ec22ca46f270b91c4547c260156a9af3d6ad0c5ca77f509fa549348640b770",
};

describe("Yildizlar-owned OMP release", () => {
	test("accepts the pinned source commit and bundle", () => {
		expect(validateOwnedRelease(manifest, manifest.sourceCommit, manifest.bundleSha256)).toEqual({ ok: true });
	});

	test("rejects a changed source commit before installation", () => {
		expect(validateOwnedRelease(manifest, "0".repeat(40), manifest.bundleSha256)).toEqual({
		ok: false,
		reason: "source commit does not match manifest",
	});
	});

	test("rejects a changed bundle before installation", () => {
		expect(validateOwnedRelease(manifest, manifest.sourceCommit, "0".repeat(64))).toEqual({
		ok: false,
		reason: "bundle hash does not match manifest",
	});
	});
});
