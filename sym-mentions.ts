/**
 * `@sym:<query>` autocomplete for code symbols, backed by universal-ctags.
 *
 * Typing `@sym:MyFunc` offers matching symbols from the session cwd; accepting inserts
 *
 *     `MyFunction` (src/foo.ts:42)
 *
 * i.e. the symbol name plus a `path:line` selector (`path:start-end` when the ctags parser
 * reports an end line; the TS/JS parser does not). That is the form the agent's `read` tool
 * takes. We deliberately do NOT insert an `@file` mention: it would inline the whole file,
 * and `@file:10-20` ranges are not supported by mentions.
 *
 * Requires universal-ctags (`brew install universal-ctags`); macOS's BSD ctags lacks
 * `--output-format=json`. Override the binary with $CTAGS.
 */
import * as path from "node:path";

const MAX_ITEMS = 50;
const INDEX_TTL_MS = 60_000;
/** Kinds that are noise in a prompt reference. */
const SKIP_KINDS: Record<string, true> = { local: true, parameter: true, label: true, header: true, file: true, module: true };
const CTAGS_CANDIDATES = [process.env.CTAGS, "/opt/homebrew/bin/ctags", "/usr/local/bin/ctags", "ctags"].filter(
	(c): c is string => !!c,
);
const FALLBACK_EXCLUDES = ["node_modules", ".git", "dist", "build", "target", "vendor", ".venv", "__pycache__"];
/**
 * universal-ctags' YAML parser only emits anchors. Add mapping keys (indent <= 4 spaces, i.e. the
 * top two or three levels) so `services`, `web`, etc. are searchable. Unquoted keys only.
 */
const YAML_KEYS = "--regex-yaml=/^ {0,4}([A-Za-z0-9_][A-Za-z0-9_.\\/-]*):([ \\t]|$)/\\1/k,key,keys/";

interface Item {
	value: string;
	label: string;
	description?: string;
}
interface Suggestions {
	items: Item[];
	prefix: string;
}
interface Provider {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
		onPartial?: (s: Suggestions) => void,
	): Promise<Suggestions | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: Item,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
	[k: string]: unknown;
}

interface Sym {
	name: string;
	lcName: string;
	lcFull: string; // "scope.name"
	kind: string;
	scope: string;
	path: string; // relative to cwd
	line: number;
	end: number;
}

let ctagsBin: Promise<string | null> | undefined;

/** First candidate that identifies as Universal Ctags. */
function findCtags(): Promise<string | null> {
	ctagsBin ??= (async () => {
		for (const bin of CTAGS_CANDIDATES) {
			try {
				const p = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
				const out = await new Response(p.stdout).text();
				if (out.includes("Universal Ctags")) return bin;
			} catch {
				// not runnable; try next
			}
		}
		return null;
	})();
	return ctagsBin;
}

async function run(cmd: string[], cwd: string, stdin?: string): Promise<string> {
	const p = Bun.spawn(cmd, {
		cwd,
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: "pipe",
		stderr: "ignore",
	});
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out;
}

async function buildIndex(cwd: string): Promise<Sym[]> {
	const bin = await findCtags();
	if (!bin) return [];
	const fields = ["--output-format=json", "--fields=+nesSp", YAML_KEYS, "-f", "-"];
	// Prefer the gitignore-aware file list; fall back to a plain recursive walk.
	const files = (await run(["rg", "--files"], cwd).catch(() => "")).trim();
	const raw = files
		? await run([bin, ...fields, "-L", "-"], cwd, files)
		: await run([bin, ...fields, "-R", ...FALLBACK_EXCLUDES.map(e => `--exclude=${e}`), "."], cwd);
	const out: Sym[] = [];
	for (const row of raw.split("\n")) {
		if (!row.startsWith("{")) continue;
		let t: {
			_type?: string;
			name?: string;
			path?: string;
			line?: number;
			end?: number;
			kind?: string;
			scope?: string;
			scopeKind?: string;
			pattern?: string;
		};
		try {
			t = JSON.parse(row);
		} catch {
			continue;
		}
		if (t._type !== "tag" || !t.name || !t.path || !t.line || Object.hasOwn(SKIP_KINDS, t.kind ?? "")) continue;
		// Symbols declared inside a function body are not addressable references.
		if (t.scopeKind === "function" || t.scopeKind === "method") continue;
		// The TS parser loses scope inside arrows/object methods; an indented const/var is still a local.
		if ((t.kind === "constant" || t.kind === "variable") && /^\/\^\s/.test(t.pattern ?? "")) continue;
		const scope = t.scope ?? "";
		out.push({
			name: t.name,
			lcName: t.name.toLowerCase(),
			lcFull: (scope ? `${scope}.${t.name}` : t.name).toLowerCase(),
			kind: t.kind ?? "",
			scope,
			path: path.normalize(t.path),
			line: t.line,
			end: t.end && t.end >= t.line ? t.end : t.line,
		});
	}
	return out;
}

const cache = new Map<string, { at: number; syms: Promise<Sym[]> }>();

/** Stale-while-revalidate: a stale index is served immediately while a rebuild runs. */
function index(cwd: string): Promise<Sym[]> {
	const hit = cache.get(cwd);
	if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.syms;
	const syms = buildIndex(cwd).catch(() => [] as Sym[]);
	cache.set(cwd, { at: Date.now(), syms });
	return hit ? hit.syms : syms;
}

function subsequence(q: string, t: string): boolean {
	let i = 0;
	for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
	return i === q.length;
}

/** Lower is better; Infinity = no match. */
function score(q: string, s: Sym): number {
	if (q === "") return 100 + s.lcName.length;
	if (s.lcName === q) return 0;
	if (s.lcName.startsWith(q)) return 10 + s.lcName.length;
	if (s.lcName.includes(q)) return 200 + s.lcName.indexOf(q);
	if (s.lcFull.includes(q)) return 300 + s.lcFull.indexOf(q);
	if (subsequence(q, s.lcFull)) return 500 + s.lcFull.length;
	return Infinity;
}

// `@sym:query` at a token boundary, query up to the cursor.
const TRIGGER = /(?:^|[\s([{<])(@sym:([^\s"'`]*))$/;

interface HostApi {
	on(event: "session_start", handler: (event: unknown, ctx: HostContext) => void): void;
}
interface HostContext {
	cwd: string;
	ui: {
		addAutocompleteProvider(factory: (current: Provider) => Provider): void;
		notify(message: string, level?: "info" | "warning" | "error"): void;
	};
}

export default function (pi: HostApi) {
	pi.on("session_start", (_event, ctx) => {
		void findCtags().then(bin => {
			if (!bin) ctx.ui.notify("sym-mentions: universal-ctags not found (brew install universal-ctags)", "warning");
		});

		ctx.ui.addAutocompleteProvider((current: Provider): Provider => ({
			...current,

			async getSuggestions(lines, cursorLine, cursorCol, signal, onPartial) {
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const m = TRIGGER.exec(before);
				if (!m) return current.getSuggestions(lines, cursorLine, cursorCol, signal, onPartial);

				const query = m[2].toLowerCase();
				const scored: { s: number; sym: Sym }[] = [];
				for (const sym of await index(ctx.cwd)) {
					const s = score(query, sym);
					if (s !== Infinity) scored.push({ s, sym });
				}
				scored.sort((a, b) => a.s - b.s || a.sym.path.length - b.sym.path.length || a.sym.line - b.sym.line);
				const items = scored.slice(0, MAX_ITEMS).map(({ sym }) => {
					const loc = sym.end > sym.line ? `${sym.path}:${sym.line}-${sym.end}` : `${sym.path}:${sym.line}`;
					return {
						value: `\`${sym.name}\` (${loc})`,
						label: sym.scope ? `${sym.scope}.${sym.name}` : sym.name,
						description: `${sym.kind} · ${loc}`,
					};
				});
				return items.length ? { items, prefix: m[1] } : null;
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if (!prefix.startsWith("@sym:")) {
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				}
				const line = lines[cursorLine] ?? "";
				const head = line.slice(0, cursorCol - prefix.length);
				const insert = `${item.value} `;
				const next = [...lines];
				next[cursorLine] = head + insert + line.slice(cursorCol);
				return { lines: next, cursorLine, cursorCol: head.length + insert.length };
			},
		}));
	});
}
