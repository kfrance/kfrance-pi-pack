import { describe, it } from "node:test";
import assert from "node:assert";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	DEFAULT_FILESYSTEM,
	expandAndResolve,
	expandConfigPath,
	formatConfig,
	isReadAllowed,
	isWriteAllowed,
	loadJsonConfig,
	matchesDenyPattern,
	mergeFilesystem,
	type FilesystemConfig,
} from "../extensions/sandbox.ts";

const CWD = "/home/user/project";
const HOME = homedir();

describe("sandbox", () => {
	// ========================================================================
	// mergeFilesystem
	// ========================================================================

	describe("mergeFilesystem", () => {
		it("returns a copy of base when no override", () => {
			const result = mergeFilesystem(DEFAULT_FILESYSTEM);
			assert.deepStrictEqual(result, DEFAULT_FILESYSTEM);
			assert.notStrictEqual(result, DEFAULT_FILESYSTEM); // different object
		});

		it("returns a copy of base when override is undefined", () => {
			const result = mergeFilesystem(DEFAULT_FILESYSTEM, undefined);
			assert.deepStrictEqual(result, DEFAULT_FILESYSTEM);
		});

		it("overrides individual fields", () => {
			const result = mergeFilesystem(DEFAULT_FILESYSTEM, {
				allowWrite: ["/custom"],
			});
			assert.deepStrictEqual(result.allowWrite, ["/custom"]);
			assert.deepStrictEqual(result.denyRead, DEFAULT_FILESYSTEM.denyRead);
			assert.deepStrictEqual(result.denyWrite, DEFAULT_FILESYSTEM.denyWrite);
		});

		it("overrides all fields", () => {
			const result = mergeFilesystem(DEFAULT_FILESYSTEM, {
				denyRead: ["~/.ssh"],
				allowWrite: ["/a"],
				denyWrite: [".secret"],
			});
			assert.deepStrictEqual(result, {
				denyRead: ["~/.ssh"],
				allowWrite: ["/a"],
				denyWrite: [".secret"],
			});
		});
	});

	// ========================================================================
	// loadJsonConfig
	// ========================================================================

	describe("loadJsonConfig", () => {
		it("returns empty object for non-existent path", () => {
			const result = loadJsonConfig("/does/not/exist/sandbox.json");
			assert.deepStrictEqual(result, {});
		});
	});

	// ========================================================================
	// expandAndResolve
	// ========================================================================

	describe("expandAndResolve", () => {
		it("resolves relative path against cwd", () => {
			assert.strictEqual(expandAndResolve("foo/bar.txt", CWD), resolve(CWD, "foo/bar.txt"));
		});

		it("expands ~ to home directory", () => {
			assert.strictEqual(expandAndResolve("~", CWD), HOME);
		});

		it("expands ~/ prefix", () => {
			assert.strictEqual(expandAndResolve("~/docs/file.txt", CWD), HOME + "/docs/file.txt");
		});

		it("strips leading @ prefix", () => {
			assert.strictEqual(expandAndResolve("@foo/bar.txt", CWD), resolve(CWD, "foo/bar.txt"));
		});

		it("handles absolute paths", () => {
			assert.strictEqual(expandAndResolve("/tmp/test.txt", CWD), "/tmp/test.txt");
		});

		it("strips @ then expands ~", () => {
			assert.strictEqual(expandAndResolve("@~/test.txt", CWD), HOME + "/test.txt");
		});
	});

	// ========================================================================
	// expandConfigPath
	// ========================================================================

	describe("expandConfigPath", () => {
		it("expands . to cwd", () => {
			assert.strictEqual(expandConfigPath(".", CWD), resolve(CWD));
		});

		it("expands ~ to home", () => {
			assert.strictEqual(expandConfigPath("~", CWD), HOME);
		});

		it("expands ~/ paths", () => {
			assert.strictEqual(expandConfigPath("~/projects", CWD), resolve(HOME, "projects"));
		});

		it("expands ./ paths against cwd", () => {
			assert.strictEqual(expandConfigPath("./src", CWD), resolve(CWD, "src"));
		});

		it("passes through absolute paths", () => {
			assert.strictEqual(expandConfigPath("/tmp", CWD), "/tmp");
		});

		it("resolves relative paths against cwd", () => {
			assert.strictEqual(expandConfigPath("build", CWD), resolve(CWD, "build"));
		});
	});

	// ========================================================================
	// matchesDenyPattern
	// ========================================================================

	describe("matchesDenyPattern", () => {
		it("matches *.ext glob pattern", () => {
			assert.strictEqual(matchesDenyPattern("/some/path/secret.pem", "*.pem", CWD), true);
			assert.strictEqual(matchesDenyPattern("/some/path/secret.key", "*.pem", CWD), false);
		});

		it("matches .env.* pattern", () => {
			assert.strictEqual(matchesDenyPattern("/project/.env.local", ".env.*", CWD), true);
			assert.strictEqual(matchesDenyPattern("/project/.env.production", ".env.*", CWD), true);
			assert.strictEqual(matchesDenyPattern("/project/.env", ".env.*", CWD), false);
		});

		it("matches exact basename", () => {
			assert.strictEqual(matchesDenyPattern("/project/.env", ".env", CWD), true);
			assert.strictEqual(matchesDenyPattern("/project/.env.local", ".env", CWD), false);
		});

		it("matches ~/ directory prefix pattern", () => {
			assert.strictEqual(matchesDenyPattern(HOME + "/.ssh/id_rsa", "~/.ssh", CWD), true);
			assert.strictEqual(matchesDenyPattern(HOME + "/.ssh", "~/.ssh", CWD), true);
			assert.strictEqual(matchesDenyPattern(HOME + "/.config/test", "~/.ssh", CWD), false);
		});

		it("matches ./ directory prefix pattern", () => {
			assert.strictEqual(
				matchesDenyPattern(resolve(CWD, "secrets/key.pem"), "./secrets", CWD),
				true,
			);
			assert.strictEqual(
				matchesDenyPattern(resolve(CWD, "src/main.ts"), "./secrets", CWD),
				false,
			);
		});

		it("matches absolute directory prefix pattern", () => {
			assert.strictEqual(matchesDenyPattern("/etc/shadow", "/etc/", CWD), true);
			assert.strictEqual(matchesDenyPattern("/etc/passwd", "/etc/", CWD), true);
			assert.strictEqual(matchesDenyPattern("/tmp/test", "/etc/", CWD), false);
		});
	});

	// ========================================================================
	// isReadAllowed
	// ========================================================================

	describe("isReadAllowed", () => {
		const fs: FilesystemConfig = {
			denyRead: ["~/.ssh", "~/.aws", ".env", "*.pem"],
			allowWrite: ["."],
			denyWrite: [],
		};

		it("allows reads not matching any deny pattern", () => {
			const result = isReadAllowed("/project/src/main.ts", CWD, fs);
			assert.strictEqual(result.allowed, true);
		});

		it("denies reads matching denyRead pattern", () => {
			const result = isReadAllowed(HOME + "/.ssh/id_rsa", CWD, fs);
			assert.strictEqual(result.allowed, false);
			assert.ok(result.reason?.includes("~/.ssh"));
		});

		it("denies reads matching basename pattern", () => {
			const result = isReadAllowed("/project/.env", CWD, fs);
			assert.strictEqual(result.allowed, false);
		});

		it("denies reads matching glob pattern", () => {
			const result = isReadAllowed("/project/cert.pem", CWD, fs);
			assert.strictEqual(result.allowed, false);
		});
	});

	// ========================================================================
	// isWriteAllowed
	// ========================================================================

	describe("isWriteAllowed", () => {
		const fs: FilesystemConfig = {
			denyRead: [],
			allowWrite: [".", "/tmp"],
			denyWrite: [".env", "*.key"],
		};

		it("allows writes inside allowWrite directories", () => {
			const result = isWriteAllowed(resolve(CWD, "src/file.ts"), CWD, fs);
			assert.strictEqual(result.allowed, true);
		});

		it("allows writes to /tmp", () => {
			const result = isWriteAllowed("/tmp/output.txt", CWD, fs);
			assert.strictEqual(result.allowed, true);
		});

		it("denies writes outside allowWrite directories", () => {
			const result = isWriteAllowed("/etc/passwd", CWD, fs);
			assert.strictEqual(result.allowed, false);
			assert.ok(result.reason?.includes("outside allowed write"));
		});

		it("denies writes matching denyWrite even if inside allowWrite", () => {
			const result = isWriteAllowed(resolve(CWD, ".env"), CWD, fs);
			assert.strictEqual(result.allowed, false);
			assert.ok(result.reason?.includes("denyWrite"));
		});

		it("denies writes matching denyWrite glob pattern", () => {
			const result = isWriteAllowed(resolve(CWD, "server.key"), CWD, fs);
			assert.strictEqual(result.allowed, false);
		});

		it("denyWrite takes priority over allowWrite", () => {
			// .env is inside CWD (allowWrite: ".") but matches denyWrite ".env"
			const result = isWriteAllowed(resolve(CWD, ".env"), CWD, fs);
			assert.strictEqual(result.allowed, false);
		});
	});

	// ========================================================================
	// formatConfig
	// ========================================================================

	describe("formatConfig", () => {
		it("shows ACTIVE status when active", () => {
			const output = formatConfig(true, DEFAULT_FILESYSTEM);
			assert.ok(output.includes("Status: ACTIVE"));
		});

		it("shows DISABLED status when inactive", () => {
			const output = formatConfig(false, DEFAULT_FILESYSTEM);
			assert.ok(output.includes("Status: DISABLED"));
		});

		it("includes filesystem config details", () => {
			const fs: FilesystemConfig = {
				denyRead: ["~/.ssh"],
				allowWrite: [".", "/tmp"],
				denyWrite: [".secret"],
			};
			const output = formatConfig(true, fs);
			assert.ok(output.includes("~/.ssh"));
			assert.ok(output.includes("/tmp"));
			assert.ok(output.includes(".secret"));
		});

		it("shows (none) for empty arrays", () => {
			const fs: FilesystemConfig = {
				denyRead: [],
				allowWrite: [],
				denyWrite: [],
			};
			const output = formatConfig(false, fs);
			assert.ok(output.includes("(none)"));
		});

		it("mentions network is unrestricted", () => {
			const output = formatConfig(true, DEFAULT_FILESYSTEM);
			assert.ok(output.includes("unrestricted"));
		});
	});

	// ========================================================================
	// DEFAULT_FILESYSTEM
	// ========================================================================

	describe("DEFAULT_FILESYSTEM", () => {
		it("has sensible defaults", () => {
			assert.ok(DEFAULT_FILESYSTEM.denyRead.includes("~/.ssh"));
			assert.ok(DEFAULT_FILESYSTEM.denyRead.includes("~/.aws"));
			assert.ok(DEFAULT_FILESYSTEM.denyRead.includes("~/.gnupg"));
			assert.ok(DEFAULT_FILESYSTEM.allowWrite.includes("."));
			assert.ok(DEFAULT_FILESYSTEM.allowWrite.includes("/tmp"));
			assert.deepStrictEqual(DEFAULT_FILESYSTEM.denyWrite, []);
		});
	});
});
