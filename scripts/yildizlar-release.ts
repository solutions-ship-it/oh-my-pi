import * as crypto from "node:crypto";
// `Stats` is declared in `node:fs`, NOT in `node:fs/promises` (which re-uses the
// interface but does not export it). Referencing `fs.Stats` here produced
// TS2724 under the project's `strict` config; a type-only import fixes it
// without touching runtime behaviour.
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

/**
 * Owned-lane release manifest.
 *
 * `status` is the lane LIFECYCLE gate and is REQUIRED. It MUST be exactly
 * `"active"` for an install to proceed. A missing field is rejected too:
 * treating absence as "fine" would let a producer silently bypass the gate by
 * dropping the key, which is the opposite of fail-closed. Any other value —
 * notably `"superseded"` — fails FAIL-CLOSED, so a retired lane cannot
 * downgrade the runtime by reinstalling its stale `bundleSha256`. Unknown or
 * wrongly-typed values are rejected: an unrecognised lifecycle state is not
 * evidence of health.
 */
export type OwnedReleaseManifest = {
	schemaVersion: number;
	channel: string;
	sourceCommit: string;
	releaseBranch: string;
	ownedRepository: string;
	bundleSha256: string;
	status: unknown;
};

export type ReleaseContext = {
	head: string;
	branch: string;
	originRepository: string;
	isClean: boolean;
	sourceIsAncestor: boolean;
};

export type ReleaseReceipt = {
	schemaVersion: 2;
	status: "prepared" | "active";
	channel: string;
	sourceCommit: string;
	bundleSha256: string;
	previousBundleSha256: string;
	installedPath: string;
	backupPath: string;
	updatePolicy: "managed_local_release_only";
};

type LegacyReleaseReceipt = {
	schemaVersion: 1;
	channel: string;
	sourceCommit: string;
	bundleSha256: string;
	installedPath: string;
	backupPath: string;
	updatePolicy: "managed_local_release_only";
};

export type InstallResult = {
	installed: boolean;
	backupPath: string;
	statePath: string;
};

export type ReceiptWriter = (receiptPath: string, receipt: ReleaseReceipt) => Promise<void>;
export type ReleaseValidation = { ok: true } | { ok: false; reason: string };

const sourceCommitPattern = /^[0-9a-f]{40}$/;
const bundleHashPattern = /^[0-9a-f]{64}$/;
const repositoryPattern = /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Structural shape WITHOUT the lifecycle field.
 *
 * Split out so `manifestError` can keep precise messages: a value that is
 * malformed in its identity/pins must still report "identity is invalid",
 * while a well-shaped value that merely lacks `status` reports the specific
 * lifecycle message. Collapsing the two produced a message-contract
 * regression (`{}` started reporting "status is missing").
 */
function hasOwnedReleaseShape(value: unknown): value is Omit<OwnedReleaseManifest, "status"> {
	if (typeof value !== "object" || value === null) return false;
	const manifest = value as {
		schemaVersion?: unknown;
		channel?: unknown;
		sourceCommit?: unknown;
		releaseBranch?: unknown;
		ownedRepository?: unknown;
		bundleSha256?: unknown;
	};
	return (
		typeof manifest.schemaVersion === "number" &&
		typeof manifest.channel === "string" &&
		typeof manifest.sourceCommit === "string" &&
		typeof manifest.releaseBranch === "string" &&
		typeof manifest.ownedRepository === "string" &&
		typeof manifest.bundleSha256 === "string"
	);
}

function isOwnedReleaseManifest(value: unknown): value is OwnedReleaseManifest {
	// `status` is REQUIRED on OwnedReleaseManifest, so the predicate must verify
	// the KEY exists — otherwise it narrows to a type promising a field the
	// value may not have. The VALUE is gated in `manifestError` (must be exactly
	// "active"), which is where fail-closed install policy lives.
	return hasOwnedReleaseShape(value) && Object.hasOwn(value, "status");
}
export function normalizeGitHubRepository(value: string): string | null {
	const normalized = value.trim().replace(/\.git$/, "");
	const httpsMatch = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/);
	if (httpsMatch) return `github.com/${httpsMatch[1]}/${httpsMatch[2]}`;
	const sshMatch = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/);
	if (sshMatch) return `github.com/${sshMatch[1]}/${sshMatch[2]}`;
	return repositoryPattern.test(normalized) ? normalized : null;
}

function manifestError(manifest: unknown): string | null {
	// SIRA SÖZLEŞMESİ (orijinal öncelik BİREBİR korunur): identity → pins →
	// lifecycle. Lifecycle mesajı YALNIZ kimlik ve pin doğrulamalarını GEÇEN bir
	// manifest için üretilir. Aksi halde `{}`, `schemaVersion: 1` veya bozuk pin
	// içeren girdiler eskiden aldıkları "identity/pins is invalid" yerine
	// lifecycle mesajı alır ve operatör teşhisi bozulur (ölçülen regresyon).
	//
	// Kimlik aşaması `isOwnedReleaseManifest` DEĞİL `hasOwnedReleaseShape`
	// kullanır: tam guard artık `status` anahtarını da şart koştuğu için,
	// status'suz bir manifest kimlik aşamasında düşer ve özel lifecycle mesajına
	// hiç ulaşamazdı.
	if (!hasOwnedReleaseShape(manifest) || manifest.schemaVersion !== 2 || manifest.channel !== "yildizlar-local") {
		return "manifest identity is invalid";
	}
	if (
		!sourceCommitPattern.test(manifest.sourceCommit) ||
		!bundleHashPattern.test(manifest.bundleSha256) ||
		!manifest.releaseBranch ||
		!repositoryPattern.test(manifest.ownedRepository)
	) {
		return "manifest pins are invalid";
	}
	// LIFECYCLE GATE (fail-closed). `status` REQUIRED and must be exactly
	// "active"; absence, "superseded"/"retired"/unknown values and non-strings
	// all reject. Without this gate, marking a lane superseded was metadata only
	// and `--install` would reinstall its stale bundle, downgrading the runtime.
	if (!isOwnedReleaseManifest(manifest)) {
		return "manifest lifecycle status is missing; this lane must not be installed";
	}
	if (manifest.status !== "active") {
		const shown = typeof manifest.status === "string" ? manifest.status : typeof manifest.status;
		return `manifest lifecycle status is not active (${shown}); this lane must not be installed`;
	}
	return null;
}

export function validateOwnedRelease(
	manifest: unknown,
	context: ReleaseContext,
	bundleSha256: string,
): ReleaseValidation {
	const invalidManifest = manifestError(manifest);
	if (invalidManifest) return { ok: false, reason: invalidManifest };
	// NARROWING (fixes 3x TS18046 under `strict`): `manifestError` already
	// returns non-null for anything that fails `isOwnedReleaseManifest`, so this
	// check is runtime-redundant and behaviour-preserving — but TypeScript
	// cannot infer that from a `string | null` return, so the field reads below
	// were operating on `unknown`.
	if (!isOwnedReleaseManifest(manifest)) return { ok: false, reason: "manifest identity is invalid" };
	if (!context.isClean) return { ok: false, reason: "release checkout is not clean" };
	if (context.branch !== manifest.releaseBranch)
		return { ok: false, reason: "release branch does not match manifest" };
	if (context.originRepository !== manifest.ownedRepository) {
		return { ok: false, reason: "origin repository does not match manifest" };
	}
	if (!sourceCommitPattern.test(context.head) || !context.sourceIsAncestor) {
		return { ok: false, reason: "pinned source commit is not an ancestor of HEAD" };
	}
	if (bundleSha256 !== manifest.bundleSha256) return { ok: false, reason: "bundle hash does not match manifest" };
	return { ok: true };
}

async function sha256(filePath: string): Promise<string> {
	const bytes = await Bun.file(filePath).arrayBuffer();
	return crypto.createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

async function readManifest(root: string): Promise<unknown> {
	return Bun.file(path.join(root, "ops", "yildizlar-omp-release.json")).json();
}

function isMissingPath(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	return error.code === "ENOENT";
}

function assertPathWithin(home: string, targetPath: string): void {
	const relative = path.relative(home, targetPath);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`release path escapes HOME: ${targetPath}`);
	}
}

async function lstatOrNull(targetPath: string): Promise<Stats | null> {
	try {
		return await fs.lstat(targetPath);
	} catch (error) {
		if (isMissingPath(error)) return null;
		throw error;
	}
}

async function ensureDirectoryTreeWithoutSymlinks(home: string, targetDirectory: string): Promise<void> {
	const resolvedHome = path.resolve(home);
	const resolvedTarget = path.resolve(targetDirectory);
	assertPathWithin(resolvedHome, resolvedTarget);

	const homeStats = await fs.lstat(resolvedHome);
	if (!homeStats.isDirectory() || homeStats.isSymbolicLink()) {
		throw new Error(`release path contains a symbolic link or non-directory: ${resolvedHome}`);
	}

	let currentPath = resolvedHome;
	for (const segment of path.relative(resolvedHome, resolvedTarget).split(path.sep)) {
		if (!segment) continue;
		currentPath = path.join(currentPath, segment);
		const stats = await lstatOrNull(currentPath);
		if (!stats) {
			await fs.mkdir(currentPath);
			continue;
		}
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new Error(`release path contains a symbolic link or non-directory: ${currentPath}`);
		}
	}
}

async function assertRegularFile(targetPath: string, label: string): Promise<void> {
	const stats = await fs.lstat(targetPath);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`${label} must be a regular file: ${targetPath}`);
	}
}

async function syncFile(filePath: string): Promise<void> {
	const handle = await fs.open(filePath, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function copyFileWithoutOverwrite(sourcePath: string, targetPath: string): Promise<void> {
	const stagedPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
	try {
		await fs.copyFile(sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
		await syncFile(stagedPath);
		await fs.link(stagedPath, targetPath);
		await syncDirectory(path.dirname(targetPath));
	} finally {
		await fs.rm(stagedPath, { force: true });
	}
}

async function replaceFileAtomically(sourcePath: string, targetPath: string): Promise<void> {
	const stagedPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
	try {
		await fs.copyFile(sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
		await syncFile(stagedPath);
		await fs.rename(stagedPath, targetPath);
		await syncDirectory(path.dirname(targetPath));
	} finally {
		await fs.rm(stagedPath, { force: true });
	}
}

export async function writeReceiptAtomically(receiptPath: string, receipt: ReleaseReceipt): Promise<void> {
	const stagedPath = path.join(path.dirname(receiptPath), `.${path.basename(receiptPath)}.${crypto.randomUUID()}.tmp`);
	try {
		const handle = await fs.open(stagedPath, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(stagedPath, receiptPath);
		await syncDirectory(path.dirname(receiptPath));
	} finally {
		await fs.rm(stagedPath, { force: true });
	}
}
function isPreparedReceipt(value: unknown): value is ReleaseReceipt {
	if (
		typeof value !== "object" ||
		value === null ||
		!(
			"schemaVersion" in value &&
			"status" in value &&
			"channel" in value &&
			"sourceCommit" in value &&
			"bundleSha256" in value &&
			"previousBundleSha256" in value &&
			"installedPath" in value &&
			"backupPath" in value &&
			"updatePolicy" in value
		)
	) {
		return false;
	}
	return (
		value.schemaVersion === 2 &&
		value.status === "prepared" &&
		typeof value.channel === "string" &&
		typeof value.sourceCommit === "string" &&
		typeof value.bundleSha256 === "string" &&
		typeof value.previousBundleSha256 === "string" &&
		typeof value.installedPath === "string" &&
		typeof value.backupPath === "string" &&
		value.updatePolicy === "managed_local_release_only"
	);
}

function isLegacyReleaseReceipt(value: unknown): value is LegacyReleaseReceipt {
	if (
		typeof value !== "object" ||
		value === null ||
		!(
			"schemaVersion" in value &&
			"channel" in value &&
			"sourceCommit" in value &&
			"bundleSha256" in value &&
			"installedPath" in value &&
			"backupPath" in value &&
			"updatePolicy" in value
		)
	) {
		return false;
	}
	return (
		value.schemaVersion === 1 &&
		typeof value.channel === "string" &&
		typeof value.sourceCommit === "string" &&
		typeof value.bundleSha256 === "string" &&
		typeof value.installedPath === "string" &&
		typeof value.backupPath === "string" &&
		value.updatePolicy === "managed_local_release_only"
	);
}

function receiptMatchesCurrent(
	receipt: { channel: string; sourceCommit: string; bundleSha256: string; installedPath: string; backupPath: string },
	manifest: OwnedReleaseManifest,
	installedPath: string,
	backupPath: string,
	installedBundleSha256: string,
): boolean {
	return (
		receipt.channel === manifest.channel &&
		receipt.sourceCommit === manifest.sourceCommit &&
		receipt.bundleSha256 === installedBundleSha256 &&
		receipt.installedPath === installedPath &&
		receipt.backupPath === backupPath
	);
}

async function reconcileReceiptIfCurrent(
	statePath: string,
	manifest: OwnedReleaseManifest,
	installedPath: string,
	backupPath: string,
	installedBundleSha256: string,
	writeReceipt: ReceiptWriter,
): Promise<void> {
	const state = await lstatOrNull(statePath);
	if (!state) return;
	await assertRegularFile(statePath, "existing release receipt");

	const receipt = await Bun.file(statePath).json();
	if (isPreparedReceipt(receipt)) {
		if (!receiptMatchesCurrent(receipt, manifest, installedPath, backupPath, installedBundleSha256)) {
			throw new Error("prepared release receipt does not match the installed bundle");
		}
		await assertRegularFile(backupPath, "prepared release backup");
		if ((await sha256(backupPath)) !== receipt.previousBundleSha256) {
			throw new Error("prepared release backup does not match its receipt");
		}
		await writeReceipt(statePath, { ...receipt, status: "active" });
		return;
	}

	if (!isLegacyReleaseReceipt(receipt)) return;
	if (!receiptMatchesCurrent(receipt, manifest, installedPath, backupPath, installedBundleSha256)) {
		throw new Error("legacy release receipt does not match the installed bundle");
	}
	await assertRegularFile(backupPath, "legacy release backup");
	await writeReceipt(statePath, {
		...receipt,
		schemaVersion: 2,
		status: "active",
		previousBundleSha256: await sha256(backupPath),
	});
}

export async function installBundle(
	bundlePath: string,
	manifest: OwnedReleaseManifest,
	paths: { home: string; installedPath: string },
	writeReceipt: ReceiptWriter = writeReceiptAtomically,
): Promise<InstallResult> {
	const resolvedHome = path.resolve(paths.home);
	const installedPath = path.resolve(paths.installedPath);
	assertPathWithin(resolvedHome, installedPath);
	await ensureDirectoryTreeWithoutSymlinks(resolvedHome, path.dirname(installedPath));
	await assertRegularFile(installedPath, "installed OMP bundle");
	await assertRegularFile(bundlePath, "built OMP bundle");

	const backupPath = path.join(
		resolvedHome,
		".omp",
		"agent",
		"backups",
		"yildizlar-omp-runtime",
		manifest.sourceCommit,
		"cli.js",
	);
	const statePath = path.join(resolvedHome, ".omp", "agent", "state", "yildizlar-omp-runtime.json");
	await ensureDirectoryTreeWithoutSymlinks(resolvedHome, path.dirname(backupPath));
	await ensureDirectoryTreeWithoutSymlinks(resolvedHome, path.dirname(statePath));

	const currentBundleSha256 = await sha256(installedPath);
	if (currentBundleSha256 === manifest.bundleSha256) {
		await reconcileReceiptIfCurrent(
			statePath,
			manifest,
			installedPath,
			backupPath,
			currentBundleSha256,
			writeReceipt,
		);
		return { installed: false, backupPath, statePath };
	}

	const existingBackup = await lstatOrNull(backupPath);
	if (existingBackup) {
		await assertRegularFile(backupPath, "existing release backup");
		if ((await sha256(backupPath)) !== currentBundleSha256) {
			throw new Error("existing release backup does not match the bundle being replaced");
		}
	} else {
		await copyFileWithoutOverwrite(installedPath, backupPath);
	}

	const preparedReceipt: ReleaseReceipt = {
		schemaVersion: 2,
		status: "prepared",
		channel: manifest.channel,
		sourceCommit: manifest.sourceCommit,
		bundleSha256: manifest.bundleSha256,
		previousBundleSha256: currentBundleSha256,
		installedPath,
		backupPath,
		updatePolicy: "managed_local_release_only",
	};
	await writeReceipt(statePath, preparedReceipt);
	await replaceFileAtomically(bundlePath, installedPath);
	await writeReceipt(statePath, { ...preparedReceipt, status: "active" });
	return { installed: true, backupPath, statePath };
}

async function gitText(root: string, ...args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(root).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
	return result.text().trim();
}

export async function loadReleaseContext(root: string, manifest: OwnedReleaseManifest): Promise<ReleaseContext> {
	const [head, branch, originUrl, status] = await Promise.all([
		gitText(root, "rev-parse", "HEAD"),
		gitText(root, "branch", "--show-current"),
		gitText(root, "remote", "get-url", "origin"),
		gitText(root, "status", "--porcelain"),
	]);
	const sourceIsAncestor =
		(await $`git merge-base --is-ancestor ${manifest.sourceCommit} ${head}`.cwd(root).quiet().nothrow()).exitCode ===
		0;
	return {
		head,
		branch,
		originRepository: normalizeGitHubRepository(originUrl) ?? "",
		isClean: status.length === 0,
		sourceIsAncestor,
	};
}

async function main(): Promise<void> {
	const install = process.argv.includes("--install");
	if (process.argv.slice(2).some(argument => argument !== "--install")) {
		throw new Error("managed release accepts only --install");
	}

	const root = path.resolve(import.meta.dir, "..");
	const rawManifest = await readManifest(root);
	const invalidManifest = manifestError(rawManifest);
	if (invalidManifest || !isOwnedReleaseManifest(rawManifest)) {
		throw new Error(`managed release rejected: ${invalidManifest ?? "manifest identity is invalid"}`);
	}
	const manifest = rawManifest;
	const bundlePath = path.join(root, "packages", "coding-agent", "dist", "cli.js");
	if (install) {
		await $`bun --cwd ${path.join(root, "packages", "coding-agent")} run gen:bundle`.quiet();
	}

	const context = await loadReleaseContext(root, manifest);
	const validation = validateOwnedRelease(manifest, context, await sha256(bundlePath));
	if (!validation.ok) throw new Error(`managed release rejected: ${validation.reason}`);
	if (!install) {
		console.log(`managed release verified: ${context.head} ${manifest.bundleSha256}`);
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
	const result = await installBundle(bundlePath, manifest, { home, installedPath });
	console.log(
		result.installed
			? `managed release installed: ${manifest.sourceCommit} ${manifest.bundleSha256}`
			: `managed release already installed: ${manifest.sourceCommit} ${manifest.bundleSha256}`,
	);
}

if (import.meta.main) {
	await main();
}
