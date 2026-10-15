/**
 * Pair-work mode: the agent may not change your working tree. It edits a
 * throwaway sandbox copy of the repo and hands you a `git apply`-able patch.
 *
 *   /pair-work true      enter the mode
 *   /pair-work false     leave it
 *   /pair-work status
 *
 * How it works
 *  - A sandbox is built from the exact current working tree (tracked changes plus
 *    untracked, non-ignored files) via a temporary index, so the real index, refs
 *    and files are never touched. It is rebuilt whenever the working tree changes
 *    (e.g. after you applied a patch) and kept otherwise so revisions keep their edits.
 *  - A `tool_call` gate default-denies every tool except a read-only allowlist.
 *    `edit`/`write`/`ast_edit` are allowed only on absolute paths inside the sandbox
 *    (symlinks resolved), `lsp` only for read actions, `bash` only for plain read-only
 *    `git` commands. Tools outside the allowlist are also removed from the model's
 *    active tool set.
 *  - The `pair_work_patch` tool diffs the sandbox against its baseline, writes
 *    `<name>.patch`, dry-run checks it against your real tree and returns the path.
 *
 * This is a guardrail against an agent doing the wrong thing, not a security
 * sandbox: the edit-target parser is best effort and bash is limited by a token
 * allowlist, not by the OS.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const BASE = path.join(os.homedir(), ".omp", "agent", "pair-work");
const PATCH_ROOT = process.env.PAIR_WORK_PATCH_DIR ?? path.join(BASE, "patches");
const PATCH_TOOL = "pair_work_patch";
const ENTRY_TYPE = "pair-work";

/** Tools with no side effects on the repo or system; always allowed. */
const READ_ONLY_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	find: true,
	ast_grep: true,
	web_search: true,
	ask: true,
	todo: true,
	wait: true,
	task: true,
	recall: true,
	reflect: true,
	yield: true,
	think: true,
	[PATCH_TOOL]: true,
};

/** Tools allowed only when their arguments pass a check in the gate below. */
const GATED_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, lsp: true, bash: true };

const LSP_READ_ACTIONS: Record<string, true> = {
	diagnostics: true,
	definition: true,
	references: true,
	hover: true,
	symbols: true,
	type_definition: true,
	implementation: true,
	status: true,
	capabilities: true,
};

const READONLY_GIT: Record<string, true> = {
	status: true,
	diff: true,
	log: true,
	show: true,
	blame: true,
	"ls-files": true,
	"ls-tree": true,
	"rev-parse": true,
	"rev-list": true,
	"merge-base": true,
	"name-rev": true,
	describe: true,
	shortlog: true,
	"cat-file": true,
	grep: true,
};

interface Sandbox {
	root: string;
	dir: string;
	tree: string;
	patchDir: string;
}

// Module-level on purpose: child sessions share this module, so subagents obey the same gate.
let enabled = false;
let sandbox: Sandbox | undefined;
let savedTools: string[] | undefined;
let inflight: Promise<{ sandbox: Sandbox; status: "created" | "refreshed" | "reused" }> | undefined;

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<Buffer> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} (exit ${code}): ${err.trim()}`);
	return Buffer.from(out);
}

/** Tree object of the exact working tree, built in a temporary copy of the index. */
async function snapshotTree(root: string): Promise<string> {
	const realIndex = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).toString().trim();
	await fs.mkdir(BASE, { recursive: true });
	const tmpIndex = path.join(BASE, `index-${process.pid}-${Date.now()}`);
	try {
		// Copy keeps the stat cache warm; a missing index (fresh repo) is fine.
		await fs.copyFile(realIndex, tmpIndex).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		const env = { GIT_INDEX_FILE: tmpIndex };
		await git(root, ["add", "-A"], env);
		return (await git(root, ["write-tree"], env)).toString().trim();
	} finally {
		await fs.rm(tmpIndex, { force: true });
	}
}

async function buildSandbox(root: string, tree: string, dir: string): Promise<void> {
	await fs.rm(dir, { recursive: true, force: true });
	await fs.mkdir(dir, { recursive: true });
	const untar = Bun.spawn(
		["bash", "-c", 'set -o pipefail; git -C "$PW_ROOT" archive --format=tar "$PW_TREE" | tar -x -C "$PW_DIR"'],
		{ env: { ...process.env, PW_ROOT: root, PW_TREE: tree, PW_DIR: dir }, stdout: "ignore", stderr: "pipe" },
	);
	const [err, code] = await Promise.all([new Response(untar.stderr).text(), untar.exited]);
	if (code !== 0) throw new Error(`sandbox extraction failed (exit ${code}): ${err.trim()}`);
	await git(dir, ["init", "-q"]);
	for (const [key, value] of [
		["core.autocrlf", "false"],
		["core.safecrlf", "false"],
		["commit.gpgsign", "false"],
		["user.name", "pair-work"],
		["user.email", "pair-work@localhost"],
	]) {
		await git(dir, ["config", key, value]);
	}
	await git(dir, ["add", "-A", "-f"]);
	await git(dir, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "pair-work baseline"]);
}

/**
 * Build the sandbox, or keep the current one when the working tree is unchanged since it was built.
 * `fresh` always rebuilds: entering the mode must never inherit edits left over from an earlier run.
 * One sandbox per (repo, session) so two omp sessions on the same repo cannot share edits.
 */
function ensureSandbox(ctx: ExtensionContext, fresh = false): NonNullable<typeof inflight> {
	inflight ??= (async () => {
		const root = (await git(ctx.cwd, ["rev-parse", "--show-toplevel"])).toString().trim();
		const tree = await snapshotTree(root);
		const key = createHash("sha1").update(`${root}\0${ctx.sessionManager.getSessionId()}`).digest("hex").slice(0, 12);
		const dir = path.join(BASE, "sandboxes", key);
		const metaFile = `${dir}.tree`;
		const patchDir = path.join(PATCH_ROOT, path.basename(root));
		const previous = fresh ? undefined : await fs.readFile(metaFile, "utf8").catch(() => undefined);
		const present = await fs.stat(path.join(dir, ".git")).then(
			() => true,
			() => false,
		);
		if (present && previous === tree) {
			sandbox = { root, dir: await fs.realpath(dir), tree, patchDir };
			return { sandbox, status: "reused" as const };
		}
		await fs.rm(metaFile, { force: true });
		await buildSandbox(root, tree, dir);
		await fs.writeFile(metaFile, tree);
		sandbox = { root, dir: await fs.realpath(dir), tree, patchDir };
		return { sandbox, status: previous === undefined && (fresh || !present) ? ("created" as const) : ("refreshed" as const) };
	})().finally(() => {
		inflight = undefined;
	});
	return inflight;
}

/** Where a write to `absolute` would really land: deepest existing ancestor realpathed. */
async function landingPath(absolute: string): Promise<string | undefined> {
	const tail: string[] = [];
	for (let current = absolute; ; current = path.dirname(current)) {
		try {
			return path.join(await fs.realpath(current), ...tail);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
		}
		// ENOENT from realpath can also mean a dangling symlink; that is unknowable, so refuse.
		if (await fs.lstat(current).then(() => true, () => false)) return undefined;
		if (path.dirname(current) === current) return undefined;
		tail.unshift(path.basename(current));
	}
}

async function insideSandbox(raw: string): Promise<boolean> {
	if (!sandbox) return false;
	// `..` anywhere (even after a glob char) could climb out; refuse before truncating.
	if (raw.split(/[\\/]/).includes("..")) return false;
	// Globs: only the literal prefix decides where the rewrite can land.
	let target = raw.trim().replace(/[*?[{].*$/, "");
	if (target === "~" || target.startsWith("~/")) target = path.join(os.homedir(), target.slice(1));
	if (!path.isAbsolute(target)) return false;
	const landed = await landingPath(path.resolve(target));
	return landed !== undefined && (landed === sandbox.dir || landed.startsWith(sandbox.dir + path.sep));
}

interface EditTarget {
	path: string;
	/** Hashline header carried a `#TAG`, i.e. the edit expects an existing file. */
	tagged: boolean;
}

/** Best-effort, deliberately over-inclusive: any bracketed header, patch header or MV line counts. */
function editTargets(input: Record<string, unknown>): EditTarget[] {
	const targets: EditTarget[] = [];
	if (typeof input.path === "string") targets.push({ path: input.path, tagged: false });
	if (Array.isArray(input.edits)) {
		for (const edit of input.edits) {
			if (edit && typeof edit === "object" && "rename" in edit && typeof edit.rename === "string") {
				targets.push({ path: edit.rename, tagged: false });
			}
		}
	}
	if (typeof input.input === "string") {
		for (const match of input.input.matchAll(/^\[([^\]\n]+)\][ \t]*$/gm)) {
			const tag = /#[0-9A-Fa-f]{4}$/.exec(match[1]);
			targets.push({ path: tag ? match[1].slice(0, tag.index) : match[1], tagged: tag !== null });
		}
		for (const match of input.input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)) {
			targets.push({ path: match[1], tagged: false });
		}
		for (const match of input.input.matchAll(/^[ \t]*MV[ \t]+(.+?)[ \t]*$/gm)) {
			targets.push({ path: match[1].replace(/^["']|["']$/g, ""), tagged: false });
		}
	}
	return targets;
}

function isReadOnlyGit(command: string): boolean {
	// No quoting, expansion, chaining, redirection: tokens must mean what they look like.
	if (/[;&|<>`$()\\'"\n\r]/.test(command)) return false;
	const tokens = command.trim().split(/\s+/);
	if (tokens[0] !== "git" || !READONLY_GIT[tokens[1] ?? ""]) return false;
	return !tokens.slice(2).some(token => /^(--output|--open-files-in-pager|-O|--ext-diff|--textconv|--exec|--upload-pack)/.test(token));
}

async function setToolsFor(pi: ExtensionAPI, on: boolean): Promise<void> {
	if (on) {
		savedTools ??= pi.getActiveTools();
		const visible = savedTools.filter(name => READ_ONLY_TOOLS[name] || GATED_TOOLS[name]);
		await pi.setActiveTools([...new Set([...visible, PATCH_TOOL])]);
	} else if (savedTools) {
		await pi.setActiveTools(savedTools.filter(name => name !== PATCH_TOOL));
		savedTools = undefined;
	}
}

async function enable(pi: ExtensionAPI, ctx: ExtensionContext): Promise<Sandbox> {
	const { sandbox: sb } = await ensureSandbox(ctx, true);
	enabled = true;
	await setToolsFor(pi, true);
	ctx.ui.setStatus("pair-work", "pair-work: patch only");
	return sb;
}

async function disable(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	enabled = false;
	const old = sandbox;
	sandbox = undefined;
	if (old) {
		await fs.rm(old.dir, { recursive: true, force: true });
		await fs.rm(`${old.dir}.tree`, { force: true });
	}
	await setToolsFor(pi, false);
	ctx.ui.setStatus("pair-work", undefined);
}

/** Make the live mode match what this session last recorded (resume, /new, startup). */
async function syncFromSession(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.agent.kind !== "main") return;
	let want = false;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data;
		want = typeof data === "object" && data !== null && "enabled" in data && data.enabled === true;
	}
	if (want === enabled) return;
	try {
		if (want) await enable(pi, ctx);
		else await disable(pi, ctx);
	} catch (error) {
		ctx.ui.notify(`pair-work: could not restore mode: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function instructions(sb: Sandbox, status: "created" | "refreshed" | "reused" | undefined): string {
	const note =
		status === "refreshed"
			? "\nThe working tree changed since your last turn, so the sandbox was rebuilt from it: sandbox edits and patches the user has not applied are gone."
			: "";
	return `<pair-work-mode>
Pair-work mode is active. You MUST NOT modify the user's working tree or the system. The user reviews and applies your changes by hand.
- Real repo: ${sb.root}
- Sandbox (editable copy of the real working tree, git-tracked baseline): ${sb.dir}
  Real path ${sb.root}/a/b corresponds to ${sb.dir}/a/b.
- Make every change inside the sandbox with \`edit\`/\`write\`/\`ast_edit\` using ABSOLUTE sandbox paths. Relative paths resolve into the real tree and are denied.
- Reading either tree is fine; prefer the sandbox copy of files you will change.
- Do NOT write patch files yourself. When the change is complete call \`${PATCH_TOOL}\` with a kebab-case \`name\` (e.g. "kebabcase") and a one-paragraph \`summary\`. It diffs the sandbox, writes <name>.patch, dry-run checks it against the real tree and returns the path.
- Then tell the user the patch path and what it does. NEVER claim the change is applied; the user applies it with \`git apply\`.
- Revisions: edit the sandbox again and call \`${PATCH_TOOL}\` with the same name; the patch is cumulative against the real working tree.
- Available: read-only tools, \`lsp\` read actions, read-only \`git\` via bash (plain \`git log|diff|show|status|blame|grep|ls-files|...\`, no quotes/pipes). No other bash, eval, MCP or write-capable tools.${note}
</pair-work-mode>`;
}

export default function (pi: ExtensionAPI) {
	const z = pi.zod;
	const indexSchema = z.object({
		patches: z.array(
			z.object({
				name: z.string(),
				file: z.string(),
				root: z.string(),
				summary: z.string(),
				createdAt: z.string(),
			}),
		),
	});

	pi.registerTool({
		name: PATCH_TOOL,
		label: "Pair-work patch",
		description:
			"Pair-work mode only. Diff the sandbox against its baseline, write <name>.patch, dry-run `git apply --check` it against the real working tree, and return the patch path for the user to review and apply.",
		parameters: z.object({
			name: z.string().describe("kebab-case patch name, without extension"),
			summary: z.string().describe("what the patch changes and why"),
		}),
		defaultInactive: true,
		loadMode: "essential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!enabled || !sandbox) throw new Error("pair-work mode is not active");
			const sb = sandbox;
			const name = params.name
				.toLowerCase()
				.replace(/\.patch$/, "")
				.replace(/[^a-z0-9._-]+/g, "-")
				.replace(/^[-.]+|[-.]+$/g, "");
			if (!name) throw new Error("patch name is empty after sanitizing; use a kebab-case name");

			await git(sb.dir, ["add", "-A", "-f"]);
			const diff = await git(sb.dir, [
				"-c",
				"diff.noprefix=false",
				"-c",
				"diff.mnemonicPrefix=false",
				"diff",
				"--cached",
				"--binary",
				"--no-color",
				"--no-ext-diff",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				"HEAD",
			]);
			if (diff.length === 0) throw new Error(`no changes in the sandbox (${sb.dir}); edit files there first`);

			await fs.mkdir(sb.patchDir, { recursive: true });
			const patchFile = path.join(sb.patchDir, `${name}.patch`);
			await Bun.write(patchFile, diff);

			// Index consumed by the nvim integration (lua/config/pairwork.lua): one entry per patch, upserted by file.
			const indexFile = path.join(sb.patchDir, "index.json");
			const stored = indexSchema.safeParse(
				await fs.readFile(indexFile, "utf8").then(text => JSON.parse(text)).catch(() => undefined),
			);
			const patches = (stored.success ? stored.data.patches : []).filter(p => p.file !== patchFile);
			patches.push({ name, file: patchFile, root: sb.root, summary: params.summary, createdAt: new Date().toISOString() });
			const tmpIndex = `${indexFile}.${process.pid}.tmp`;
			await fs.writeFile(tmpIndex, JSON.stringify({ version: 1, patches }, null, 2));
			await fs.rename(tmpIndex, indexFile);

			const stat = (await git(sb.root, ["apply", "--stat", patchFile])).toString().trimEnd();
			let check = "applies cleanly to the current working tree";
			try {
				await git(sb.root, ["apply", "--check", patchFile]);
			} catch (error) {
				check = `DOES NOT apply cleanly: ${error instanceof Error ? error.message : String(error)}`;
			}
			ctx.ui.notify(`Patch written: ${patchFile}`, "info");
			return {
				content: [
					{
						type: "text",
						text: [
							`Patch written: ${patchFile}`,
							`Summary: ${params.summary}`,
							stat,
							`git apply --check: ${check}`,
							`The user applies it with: git -C ${sb.root} apply ${patchFile}`,
							"Tell the user the path. Do not apply it yourself.",
						].join("\n"),
					},
				],
				details: { path: patchFile },
			};
		},
	});

	pi.registerCommand("pair-work", {
		description: "Patch-only mode: /pair-work true|false|status",
		getArgumentCompletions: prefix =>
			["true", "false", "status"].filter(v => v.startsWith(prefix)).map(v => ({ value: v, label: v })),
		async handler(args, ctx) {
			const arg = args.trim().toLowerCase();
			if (/^(true|on|1|yes)$/.test(arg)) {
				try {
					const sb = await enable(pi, ctx);
					pi.appendEntry(ENTRY_TYPE, { enabled: true });
					ctx.ui.notify(
						`pair-work ON. The agent edits a sandbox (${sb.dir}) and writes patches to ${sb.patchDir}. Your working tree is never touched.`,
						"info",
					);
				} catch (error) {
					await disable(pi, ctx);
					ctx.ui.notify(`pair-work not enabled: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			} else if (/^(false|off|0|no)$/.test(arg)) {
				await disable(pi, ctx);
				pi.appendEntry(ENTRY_TYPE, { enabled: false });
				ctx.ui.notify("pair-work OFF. Full tool access restored.", "info");
			} else if (arg === "" || arg === "status") {
				ctx.ui.notify(
					enabled && sandbox
						? `pair-work ON (sandbox ${sandbox.dir}, patches ${sandbox.patchDir})`
						: "pair-work OFF",
					"info",
				);
			} else {
				ctx.ui.notify("Usage: /pair-work true|false|status", "warning");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => syncFromSession(pi, ctx));
	pi.on("session_switch", (_event, ctx) => syncFromSession(pi, ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		let status: "created" | "refreshed" | "reused" | undefined;
		if (ctx.agent.kind === "main") {
			try {
				status = (await ensureSandbox(ctx)).status;
			} catch (error) {
				ctx.ui.notify(`pair-work: sandbox refresh failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
		if (!sandbox) return;
		return { systemPrompt: [...event.systemPrompt, instructions(sandbox, status)] };
	});

	pi.on("tool_call", async event => {
		if (!enabled || READ_ONLY_TOOLS[event.toolName]) return;
		const deny = (reason: string) => ({ block: true, reason: `pair-work mode: ${reason}` });
		const input: Record<string, unknown> = { ...event.input };
		const where = sandbox ? `Use absolute paths under ${sandbox.dir}.` : "No sandbox is available.";

		switch (event.toolName) {
			case "edit": {
				const targets = editTargets(input);
				if (targets.length === 0) return deny("could not determine which file this edit targets.");
				for (const target of targets) {
					if (!(await insideSandbox(target.path))) {
						return deny(`'${target.path}' is outside the sandbox. ${where}`);
					}
					// A tag naming a file missing from the sandbox could be re-bound onto the real file.
					if (target.tagged && !(await fs.stat(target.path.replace(/^~(?=\/)/, os.homedir())).then(() => true, () => false))) {
						return deny(`'${target.path}' does not exist in the sandbox; tagged edits need an existing file.`);
					}
				}
				return;
			}
			case "write":
				if (typeof input.path === "string" && (await insideSandbox(input.path))) return;
				return deny(`writes are only allowed inside the sandbox. ${where}`);
			case "ast_edit": {
				const paths = Array.isArray(input.paths) ? input.paths : [];
				for (const p of paths) {
					if (typeof p !== "string" || !(await insideSandbox(p))) return deny(`ast_edit target '${String(p)}' is outside the sandbox. ${where}`);
				}
				return paths.length > 0 ? undefined : deny("ast_edit needs explicit sandbox paths.");
			}
			case "lsp":
				return typeof input.action === "string" && LSP_READ_ACTIONS[input.action]
					? undefined
					: deny(`lsp action '${String(input.action)}' can modify files.`);
			case "bash":
				return typeof input.command === "string" && isReadOnlyGit(input.command)
					? undefined
					: deny("bash is limited to plain read-only git commands (log, diff, show, status, blame, grep, ls-files, ...), no quotes, pipes or redirects. Use read/grep/glob for everything else.");
			default:
				return deny(`tool '${event.toolName}' is not available. Make changes in the sandbox and call ${PATCH_TOOL}.`);
		}
	});
}
