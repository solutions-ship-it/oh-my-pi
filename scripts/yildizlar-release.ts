import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

export type OwnedReleaseManifest = {
	schemaVersion: number;
	channel: string;
	sourceCommit: string;
	bundleSha256: string;
};

export type ReleaseValidation = { ok: true } | { ok: false; reason: string };

const sourceCommitPattern = /^[0-9a-f]{40}$/;
const bundleHashPattern = /^[0-9a-f]{64}$/;

export function validateOwnedRelease(
	manifest: OwnedReleaseManifest,
	sourceCommit: string,
	bundleSha256: string,
): ReleaseValidation {
	if (manifest.schemaVersion !== 1 || manifest.channel !== "yildizlar-local") {
		return { ok: false, reason: "manifest identity is invalid" };
	}
	if (!sourceCommitPattern.test(manifest.sourceCommit) || !bundleHashPattern.test(manifest.bundleSha256)) {
		return { ok: false, reason: "manifest pins are invalid" };
	}
	if (sourceCommit !== manifest.sourceCommit) {
		return { ok: false, reason: "source commit does not match manifest" };
	}
	if (bundleSha256 !== manifest.bundleSha256) {
		return { ok: false, reason: "bundle hash does not match manifest" };
	}
	return { ok: true };
}

async function sha256(filePath: string): Promise<string> {
	const bytes = await Bun.file(filePath).arrayBuffer();
	return crypto.createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

async function readManifest(root: string): Promise<OwnedReleaseManifest> {
	return Bun.file(path.join(root, "ops", "yildizlar-omp-release.json")).json();
}

async function installBundle(
	bundlePath: string,
	manifest: OwnedReleaseManifest,
	installedPath: string,
): Promise<void> {
	const installed = await fs.stat(installedPath).catch(() => null);
	if (!installed?.isFile()) throw new Error(`expected installed OMP bundle is missing: ${installedPath}`);

	const home = process.env.HOME;
	if (!home) throw new Error("HOME is required for a managed local release");
	const backupPath = path.join(home, ".omp", "agent", "backups", "yildizlar-omp-runtime", manifest.sourceCommit, "cli.js");
	await fs.mkdir(path.dirname(backupPath), { recursive: true });
	await fs.copyFile(installedPath, backupPath);

	const stagedPath = `${installedPath}.yildizlar-staged-${process.pid}`;
	await fs.copyFile(bundlePath, stagedPath);
	await fs.rename(stagedPath, installedPath);

	const statePath = path.join(home, ".omp", "agent", "state", "yildizlar-omp-runtime.json");
	await Bun.write(
		statePath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				channel: manifest.channel,
				sourceCommit: manifest.sourceCommit,
				bundleSha256: manifest.bundleSha256,
				installedPath,
				backupPath,
				updatePolicy: "managed_local_release_only",
			},
			null,
			2,
		)}\n`,
	);
}

async function main(): Promise<void> {
	const install = process.argv.includes("--install");
	const root = path.resolve(import.meta.dir, "..");
	const manifest = await readManifest(root);
	const bundlePath = path.join(root, "packages", "coding-agent", "dist", "cli.js");
	const sourceCommit = (await $`git rev-parse HEAD`.cwd(root).quiet()).text().trim();

	if (install) {
		await $`bun --cwd ${path.join(root, "packages", "coding-agent")} run gen:bundle`.quiet();
	}

	const validation = validateOwnedRelease(manifest, sourceCommit, await sha256(bundlePath));
	if (!validation.ok) throw new Error(`managed release rejected: ${validation.reason}`);
	if (!install) {
		console.log(`managed release verified: ${manifest.sourceCommit} ${manifest.bundleSha256}`);
		return;
	}

	const home = process.env.HOME;
	if (!home) throw new Error("HOME is required for a managed local release");
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
	await installBundle(bundlePath, manifest, installedPath);
	console.log(`managed release installed: ${manifest.sourceCommit} ${manifest.bundleSha256}`);
}

if (import.meta.main) {
	await main();
}
