/**
 * `@<namespace>:<query>` autocomplete for note vaults.
 *
 * Typing `@notes:Proj` offers every `.md` under the namespace root whose name
 * matches; accepting inserts the real quoted absolute path, e.g.
 * `@"/Users/me/notes/TURN DDOS/Project.md"`, which omp's built-in @file mention
 * expansion then inlines on submit. (Mentions resolve exactly, so the literal
 * text `@notes:Proj` would NOT be read — the completion has to rewrite it.)
 */
import * as os from "node:os";
import * as path from "node:path";

/** namespace -> directory. Add more vaults here. */
const NAMESPACES: Record<string, string> = {
	notes: path.join(os.homedir(), "notes"),
};

const MAX_ITEMS = 50;
const INDEX_TTL_MS = 3000;

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

interface Entry {
	rel: string; // "TURN DDOS/Project.md"
	abs: string;
	stem: string; // "Project"
	dir: string; // "TURN DDOS" or ""
	lcRel: string;
	lcStem: string;
}

const cache = new Map<string, { at: number; entries: Promise<Entry[]> }>();

function index(root: string): Promise<Entry[]> {
	const hit = cache.get(root);
	if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.entries;
	const entries = (async () => {
		const out: Entry[] = [];
		try {
			// dot:false skips .git, .obsidian, .trash, ...
			for await (const rel of new Bun.Glob("**/*.md").scan({ cwd: root, dot: false })) {
				const stem = path.basename(rel, ".md");
				const dir = path.dirname(rel);
				out.push({
					rel,
					abs: path.join(root, rel),
					stem,
					dir: dir === "." ? "" : dir,
					lcRel: rel.toLowerCase(),
					lcStem: stem.toLowerCase(),
				});
			}
		} catch {
			// missing root -> no suggestions
		}
		return out;
	})();
	cache.set(root, { at: Date.now(), entries });
	return entries;
}

function subsequence(q: string, t: string): boolean {
	let i = 0;
	for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
	return i === q.length;
}

/** Lower is better; Infinity = no match. */
function score(q: string, e: Entry): number {
	if (q === "") return 100 + e.lcRel.length;
	if (e.lcStem === q) return 0;
	if (e.lcStem.startsWith(q)) return 10 + e.lcStem.length;
	if (e.lcStem.includes(q)) return 200 + e.lcStem.indexOf(q);
	if (e.lcRel.includes(q)) return 300 + e.lcRel.indexOf(q);
	if (subsequence(q, e.lcRel)) return 500 + e.lcRel.length;
	return Infinity;
}

// `@ns:query` at a token boundary, query up to the cursor. Namespace keys are plain words.
const TRIGGER = /(?:^|[\s([{<])(@([A-Za-z0-9_-]+):([^\s"']*))$/;

interface HostApi {
	on(event: "session_start", handler: (event: unknown, ctx: HostContext) => void): void;
}
interface HostContext {
	ui: { addAutocompleteProvider(factory: (current: Provider) => Provider): void };
}

export default function (pi: HostApi) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current: Provider): Provider => ({
			...current,

			async getSuggestions(lines, cursorLine, cursorCol, signal, onPartial) {
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const m = TRIGGER.exec(before);
				const root = m ? NAMESPACES[m[2]] : undefined;
				if (!m || !root) return current.getSuggestions(lines, cursorLine, cursorCol, signal, onPartial);

				const query = m[3].toLowerCase();
				const scored: { s: number; e: Entry }[] = [];
				for (const e of await index(root)) {
					const s = score(query, e);
					if (s !== Infinity) scored.push({ s, e });
				}
				scored.sort((a, b) => a.s - b.s || a.e.lcRel.localeCompare(b.e.lcRel));
				const items = scored.slice(0, MAX_ITEMS).map(({ e }) => ({
					value: `@"${e.abs}"`,
					label: e.stem,
					description: e.dir || undefined,
				}));
				return items.length ? { items, prefix: m[1] } : null;
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				const m = TRIGGER.exec(prefix);
				if (!m || !NAMESPACES[m[2]] || m[1] !== prefix) {
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
