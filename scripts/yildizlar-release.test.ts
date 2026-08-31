import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	installBundle,
	type OwnedReleaseManifest,
	type ReleaseContext,
	validateOwnedRelease,
	writeReceiptAtomically,
} from "./yildizlar-release";

const manifest: OwnedReleaseManifest = {
	schemaVersion: 2,
	channel: "yildizlar-local",
	sourceCommit: "f164081c65e9d2059868d879ce42d4fc2a960d8c",
	releaseBranch: "yildizlar/omp-runtime",
	ownedRepository: "github.com/solutions-ship-it/oh-my-pi",
	bundleSha256: "96ec22ca46f270b91c4547c260156a9af3d6ad0c5ca77f509fa549348640b770",
};

const releaseContext: ReleaseContext = {
	head: "1".repeat(40),
	branch: manifest.releaseBranch,
	originRepository: manifest.ownedRepository,
	isClean: true,
	sourceIsAncestor: true,
};

async function tempInstall(): Promise<{
	root: string;
	home: string;
	bundlePath: string;
	installedPath: string;
	statePath: string;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "yildizlar-release-"));
	const home = path.join(root, "home");
	const bundlePath = path.join(root, "bundle.js");
	const installedPath = path.join(
		home,
		".bun",
		"install",
		"global",
		"node_modules",
		"@oh-my-pi",
		"pi-coding-agent",
		"dist",
		"cli.js",
	);
	await fs.mkdir(path.dirname(installedPath), { recursive: true });
	await Bun.write(bundlePath, "new bundle");
	await Bun.write(installedPath, "old bundle");
	return {
		root,
		home,
		bundlePath,
		installedPath,
		statePath: path.join(home, ".omp", "agent", "state", "yildizlar-omp-runtime.json"),
	};
}

describe("Yildizlar-owned OMP release", () => {
	test("accepts the pinned ancestor, owned branch, clean tree, and bundle", () => {
		expect(validateOwnedRelease(manifest, releaseContext, manifest.bundleSha256)).toEqual({ ok: true });
	});

	test("rejects a source commit outside the checked-out history", () => {
		expect(
			validateOwnedRelease(manifest, { ...releaseContext, sourceIsAncestor: false }, manifest.bundleSha256),
		).toEqual({
			ok: false,
			reason: "pinned source commit is not an ancestor of HEAD",
		});
	});

	test("rejects a dirty tree and wrong release identity before installation", () => {
		expect(validateOwnedRelease(manifest, { ...releaseContext, isClean: false }, manifest.bundleSha256)).toEqual({
			ok: false,
			reason: "release checkout is not clean",
		});
		expect(validateOwnedRelease(manifest, { ...releaseContext, branch: "main" }, manifest.bundleSha256)).toEqual({
			ok: false,
			reason: "release branch does not match manifest",
		});
		expect(
			validateOwnedRelease(
				manifest,
				{ ...releaseContext, originRepository: "github.com/untrusted/oh-my-pi" },
				manifest.bundleSha256,
			),
		).toEqual({
			ok: false,
			reason: "origin repository does not match manifest",
		});
	});

	test("rejects a changed bundle before installation", () => {
		expect(validateOwnedRelease(manifest, releaseContext, "0".repeat(64))).toEqual({
			ok: false,
			reason: "bundle hash does not match manifest",
		});
	});

	test("installs through prepared and active receipts while retaining the original bundle", async () => {
		const fixture = await tempInstall();
		try {
			const result = await installBundle(fixture.bundlePath, manifest, {
				home: fixture.home,
				installedPath: fixture.installedPath,
			});
			expect(result.installed).toBe(true);
			expect(await Bun.file(fixture.installedPath).text()).toBe("new bundle");
			expect(await Bun.file(result.backupPath).text()).toBe("old bundle");
			expect(await Bun.file(fixture.statePath).json()).toMatchObject({
				status: "active",
				sourceCommit: manifest.sourceCommit,
				bundleSha256: manifest.bundleSha256,
			});
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
	test("upgrades a matching legacy receipt for an already installed bundle", async () => {
		const fixture = await tempInstall();
		try {
			const installedManifest = {
				...manifest,
				bundleSha256: crypto.createHash("sha256").update("new bundle").digest("hex"),
			};
			const backupPath = path.join(
				fixture.home,
				".omp",
				"agent",
				"backups",
				"yildizlar-omp-runtime",
				manifest.sourceCommit,
				"cli.js",
			);
			await Bun.write(fixture.installedPath, "new bundle");
			await fs.mkdir(path.dirname(backupPath), { recursive: true });
			await Bun.write(backupPath, "old bundle");
			await fs.mkdir(path.dirname(fixture.statePath), { recursive: true });
			await Bun.write(
				fixture.statePath,
				`${JSON.stringify({
					schemaVersion: 1,
					channel: manifest.channel,
					sourceCommit: manifest.sourceCommit,
					bundleSha256: installedManifest.bundleSha256,
					installedPath: fixture.installedPath,
					backupPath,
					updatePolicy: "managed_local_release_only",
				})}\n`,
			);

			const result = await installBundle(fixture.bundlePath, installedManifest, {
				home: fixture.home,
				installedPath: fixture.installedPath,
			});

			expect(result.installed).toBe(false);
			expect(await Bun.file(fixture.statePath).json()).toMatchObject({
				schemaVersion: 2,
				status: "active",
				previousBundleSha256: crypto.createHash("sha256").update("old bundle").digest("hex"),
			});
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("rejects a symlinked global install path without touching its destination", async () => {
		const fixture = await tempInstall();
		try {
			const outside = path.join(fixture.root, "outside");
			await fs.mkdir(outside);
			await Bun.write(path.join(outside, "cli.js"), "outside bundle");
			await fs.rm(path.join(fixture.home, ".bun"), { recursive: true });
			await fs.symlink(outside, path.join(fixture.home, ".bun"));

			await expect(
				installBundle(fixture.bundlePath, manifest, {
					home: fixture.home,
					installedPath: fixture.installedPath,
				}),
			).rejects.toThrow("release path contains a symbolic link");
			expect(await Bun.file(path.join(outside, "cli.js")).text()).toBe("outside bundle");
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("leaves a prepared receipt when the final receipt write fails after replacement", async () => {
		const fixture = await tempInstall();
		try {
			const installedManifest = {
				...manifest,
				bundleSha256: crypto.createHash("sha256").update("new bundle").digest("hex"),
			};
			await expect(
				installBundle(
					fixture.bundlePath,
					installedManifest,
					{ home: fixture.home, installedPath: fixture.installedPath },
					async (receiptPath, receipt) => {
						if (receipt.status === "active") throw new Error("injected active receipt failure");
						await writeReceiptAtomically(receiptPath, receipt);
					},
				),
			).rejects.toThrow("injected active receipt failure");
			expect(await Bun.file(fixture.installedPath).text()).toBe("new bundle");
			const preparedReceipt = await Bun.file(fixture.statePath).json();
			expect(preparedReceipt).toMatchObject({ status: "prepared" });
			await Bun.write(preparedReceipt.backupPath, "tampered backup");
			await expect(
				installBundle(fixture.bundlePath, installedManifest, {
					home: fixture.home,
					installedPath: fixture.installedPath,
				}),
			).rejects.toThrow("prepared release backup does not match its receipt");
			await Bun.write(preparedReceipt.backupPath, "old bundle");
			const recovered = await installBundle(fixture.bundlePath, installedManifest, {
				home: fixture.home,
				installedPath: fixture.installedPath,
			});
			expect(recovered.installed).toBe(false);
			expect(await Bun.file(fixture.statePath).json()).toMatchObject({ status: "active" });
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
});
