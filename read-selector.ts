/**
 * read-selector.ts — override the built-in `read` tool to add oh-my-pi's
 * path-embedded line-range selector syntax on top of pi's built-in read.
 *
 * It registers a tool named `read` (overriding the built-in) that:
 *   - parses a trailing `:<sel>` on `path` (`:50`, `:50-100`, `:50+100`,
 *     `:5-16,960-973`, `:raw`, `:raw:5-16`),
 *   - converts a single range to the built-in `offset`/`limit` form (adding a
 *     little leading/trailing context) and delegates to `createReadTool()`,
 *   - reads multiple ranges as separate delegated reads stitched with elided
 *     markers,
 *   - refuses binary (non-image) files with a bash hint.
 *
 * Delegation (rather than re-reading the file ourselves) means the result
 * shape, truncation, image handling, and TUI renderer all stay identical to
 * the built-in read for the pi version in use.
 *
 * Source-dispatch extension point: `sourceHandlers` below is the registry a
 * future URL / archive / SQLite / PDF handler plugs into. Phase 1 ships only
 * the local-file handler (the fallback); the others are not implemented yet
 * but the seam is in place so they can be added as one tool rather than
 * separate tools.
 *
 * Selector parsing (parseSel / parseLineRanges / parseLineRangeChunk /
 * splitPathAndSel and the RANGE_* regexes) is ported from oh-my-pi
 * (MIT License, Copyright (c) 2025 Mario Zechner):
 *   https://github.com/can1357/oh-my-pi
 *     packages/coding-agent/src/tools/path-utils.ts
 *     packages/coding-agent/src/tools/read-selector.ts
 * The binary-sniff rule is ported from oh-my-pi packages/utils/src/binary.ts.
 */
import type {
	ExtensionAPI,
	ReadToolDetails,
	ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import {
	createReadTool,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";

// ── Selector grammar (ported from oh-my-pi, MIT) ─────────────────────

/** Inclusive line range; `endLine` is undefined for open-ended ranges. */
export interface LineRange {
	startLine: number;
	endLine: number | undefined;
}

export type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "conflicts" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean };

const RANGE_CHUNK_SRC = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST_SRC = `${RANGE_CHUNK_SRC}(?:,${RANGE_CHUNK_SRC})*`;
const FILE_LINE_RANGE_RE = new RegExp(`^(?:${RANGE_LIST_SRC}|raw|conflicts)$`, "i");
const FILE_LINE_RANGE_ONLY_RE = new RegExp(`^${RANGE_LIST_SRC}$`, "i");
const FILE_RAW_ONLY_RE = /^raw$/i;
const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

/**
 * Parse a single `N`, `N-M`, `N-`, `N+K`, or `..`-aliased chunk. Throws on
 * invalid bounds (`:0`, `N+0`, `N-M` with M<N). Returns null when the chunk
 * does not look like a line range at all.
 */
export function parseLineRangeChunk(sel: string): LineRange | null {
	const m = LINE_RANGE_CHUNK_RE.exec(sel);
	if (!m) return null;
	const rawStart = Number.parseInt(m[1], 10);
	if (rawStart < 1) {
		throw new Error("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	}
	// `..` is a forgiving alias for `-` (e.g. `2724..2727` == `2724-2727`).
	const sep = m[2] === ".." ? "-" : m[2];
	const rhs = m[3] ? Number.parseInt(m[3], 10) : undefined;
	let rawEnd: number | undefined;
	if (sep === "+") {
		if (rhs === undefined || rhs < 1) {
			throw new Error(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
		}
		rawEnd = rawStart + rhs - 1;
	} else if (sep === "-") {
		// `301-` is shorthand for "from 301 onward" — equivalent to bare `301`.
		if (rhs !== undefined) {
			if (rhs < rawStart) {
				throw new Error(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
			}
			rawEnd = rhs;
		}
	}
	return { startLine: rawStart, endLine: rawEnd };
}

/**
 * Parse a comma-separated list of line ranges (e.g. `5-16,960-973`). Returns
 * the ranges sorted ascending with overlapping/adjacent ranges merged.
 */
export function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
	const chunks = sel.split(",");
	const parsed: LineRange[] = [];
	for (const chunk of chunks) {
		const range = parseLineRangeChunk(chunk);
		if (!range) return null;
		parsed.push(range);
	}
	if (parsed.length === 0) return null;
	parsed.sort((a, b) => a.startLine - b.startLine);

	const merged: LineRange[] = [parsed[0]];
	for (let i = 1; i < parsed.length; i++) {
		const current = parsed[i];
		const last = merged[merged.length - 1];
		// Open-ended (endLine undefined) means "to EOF" — any later range is absorbed.
		if (last.endLine === undefined) continue;
		// Merge when current starts within (or immediately after) the last range.
		if (current.startLine <= last.endLine + 1) {
			if (current.endLine === undefined || current.endLine > last.endLine) {
				merged[merged.length - 1] = { startLine: last.startLine, endLine: current.endLine };
			}
			continue;
		}
		merged.push(current);
	}
	return merged as [LineRange, ...LineRange[]];
}

/** Returns true when the selector requested raw output (alone or combined with a range). */
export function isRawSelector(parsed: ParsedSelector): boolean {
	return parsed.kind === "raw" || (parsed.kind === "lines" && parsed.raw === true);
}

/** Returns true when the selector requested multiple line ranges. */
export function isMultiRange(parsed: ParsedSelector): boolean {
	return parsed.kind === "lines" && parsed.ranges.length > 1;
}

function selectorChunkLooksReadLike(chunk: string): boolean {
	const lower = chunk.toLowerCase();
	return (
		lower === "raw" ||
		lower === "conflicts" ||
		/^-?\d+(?:[-+]\d+)?$/.test(chunk) ||
		parseLineRanges(chunk) !== null
	);
}

function invalidSelector(sel: string): Error {
	return new Error(
		`Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list of ranges, :raw, or a range combined with raw (e.g. :raw:50-100).`,
	);
}

/** Parse a selector string into its structured form. */
export function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };

	// Compound selector: `1-50:raw` or `raw:1-50`.
	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length === 2) {
			const [a, b] = chunks as [string, string];
			const aIsRaw = a.toLowerCase() === "raw";
			const bIsRaw = b.toLowerCase() === "raw";
			const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
			if (rangeChunk !== null) {
				const ranges = parseLineRanges(rangeChunk);
				if (ranges) return { kind: "lines", ranges, raw: true };
			}
		}
		if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel);
		// Unrecognized compound — treat as part of the path.
		return { kind: "none" };
	}

	if (sel.toLowerCase() === "raw") return { kind: "raw" };
	if (sel.toLowerCase() === "conflicts") return { kind: "conflicts" };
	const ranges = parseLineRanges(sel);
	if (ranges) return { kind: "lines", ranges };
	return { kind: "none" };
}

/**
 * Split a raw path into {path, sel?}. Only peels a trailing `:<chunk>` when
 * that chunk matches the strict selector grammar (a range list, `raw`, or
 * `conflicts`), so a real filename ending in selector-looking text is left
 * intact for the literal-path check to decide.
 */
export function splitPathAndSel(rawPath: string): { path: string; sel?: string } {
	const colon = rawPath.lastIndexOf(":");
	if (colon <= 0) return { path: rawPath };

	const candidate = rawPath.slice(colon + 1);
	if (!FILE_LINE_RANGE_RE.test(candidate)) return { path: rawPath };

	let basePath = rawPath.slice(0, colon);
	let sel = candidate;

	// Allow a compound trailing selector: `path:1-50:raw` or `path:raw:1-50`.
	const innerColon = basePath.lastIndexOf(":");
	if (innerColon > 0) {
		const innerCandidate = basePath.slice(innerColon + 1);
		const innerIsRaw = FILE_RAW_ONLY_RE.test(innerCandidate);
		const outerIsRaw = FILE_RAW_ONLY_RE.test(candidate);
		const innerIsRange = FILE_LINE_RANGE_ONLY_RE.test(innerCandidate);
		const outerIsRange = FILE_LINE_RANGE_ONLY_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			sel = `${innerCandidate}:${candidate}`;
			basePath = basePath.slice(0, innerColon);
		}
	}

	return { path: basePath, sel };
}

// ── Local path probing / binary sniff ────────────────────────────────

/** Mirror pi's path normalization for the subset we need (strip `@`, expand `~`). */
function resolveLocalPath(p: string, cwd: string): string {
	let s = p;
	if (s.startsWith("@")) s = s.slice(1);
	if (s === "~") return os.homedir();
	if (s.startsWith("~/")) return nodePath.join(os.homedir(), s.slice(2));
	return nodePath.isAbsolute(s) ? s : nodePath.resolve(cwd, s);
}

/**
 * Three-way probe: does the exact filesystem entry named `filePath` exist?
 * `missing` (definitive ENOENT/ENOTDIR/ENAMETOOLONG) means "not a literal
 * file, so interpret the trailing chunk as a selector"; anything else
 * (`exists` or `unknown`) means "prefer the literal path".
 */
async function probeLiteralPathExists(
	filePath: string,
	cwd: string,
): Promise<"exists" | "missing" | "unknown"> {
	const resolved = resolveLocalPath(filePath, cwd);
	try {
		await fs.lstat(resolved);
		return "exists";
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG") return "missing";
		return "unknown";
	}
}

const BINARY_SNIFF_BYTES = 8192;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

/** Binary when the header has a NUL byte or is not valid UTF-8 (stream mode tolerates a truncated multibyte at the boundary). */
function isProbablyBinaryHeader(header: Uint8Array): boolean {
	if (header.indexOf(0) !== -1) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(header, { stream: true });
		return false;
	} catch {
		return true;
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Best-effort binary guard: sniff the first 8KB of `basePath`. Returns a
 * refusal notice when the file is binary (and not an image); returns null to
 * let the built-in read proceed. Read failures here fall through to the
 * built-in (which produces its own error), so this never hides a real file.
 */
async function binarySniffNotice(basePath: string, cwd: string): Promise<string | null> {
	const resolved = resolveLocalPath(basePath, cwd);
	if (IMAGE_EXTENSIONS.has(nodePath.extname(resolved).toLowerCase())) return null;

	let header: Uint8Array;
	try {
		const fh = await fs.open(resolved, "r");
		try {
			const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
			const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
			header = buf.subarray(0, bytesRead);
		} finally {
			await fh.close();
		}
	} catch {
		return null; // can't read here (dir, missing, perm) — let the built-in handle it
	}

	if (!isProbablyBinaryHeader(header)) return null;
	let size = 0;
	try {
		size = (await fs.stat(resolved)).size;
	} catch {
		// leave size 0
	}
	return `[Cannot read binary file '${basePath}' (${formatBytes(size)}); not valid UTF-8 text. Use bash: xxd or strings to inspect it.]`;
}

// ── Offset/limit conversion ──────────────────────────────────────────

const RANGE_LEADING_CONTEXT_LINES = 1;
const RANGE_TRAILING_CONTEXT_LINES = 3;

/**
 * Convert a single range to the built-in offset/limit form, adding a little
 * context around bounded ranges. Open-ended ranges only get leading context
 * (no trailing to add before EOF).
 */
function singleRangeToOffsetLimit(range: LineRange): { offset?: number; limit?: number } {
	const start = range.startLine;
	const offset = Math.max(1, start - RANGE_LEADING_CONTEXT_LINES);
	if (range.endLine === undefined) {
		return { offset };
	}
	const rangeLen = range.endLine - start + 1;
	const limit = rangeLen + RANGE_LEADING_CONTEXT_LINES + RANGE_TRAILING_CONTEXT_LINES;
	return { offset, limit };
}

// ── Tool execution ───────────────────────────────────────────────────

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.map((c) => (c.type === "text" ? (c.text ?? "") : "[image]"))
		.join("\n");
}

async function delegateRead(
	basePath: string,
	offset: number | undefined,
	limit: number | undefined,
	toolCallId: string,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<ReturnType<typeof createReadTool>["execute"]>[3],
	cwd: string,
): Promise<{ content: { type: "text"; text: string }[]; details: ReadToolDetails }> {
	const tool = createReadTool(cwd);
	const input: ReadToolInput = { path: basePath };
	if (offset !== undefined) input.offset = offset;
	if (limit !== undefined) input.limit = limit;
	return tool.execute(toolCallId, input, signal, onUpdate);
}

async function readMultiRange(
	basePath: string,
	ranges: [LineRange, ...LineRange[]],
	toolCallId: string,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<ReturnType<typeof createReadTool>["execute"]>[3],
	cwd: string,
): Promise<{ content: { type: "text"; text: string }[]; details: ReadToolDetails }> {
	const tool = createReadTool(cwd);
	const parts: string[] = [];
	for (let i = 0; i < ranges.length; i++) {
		const range = ranges[i];
		// Multi-range reads are exact (no context) so elided markers stay accurate.
		const offset = range.startLine;
		const limit = range.endLine !== undefined ? range.endLine - range.startLine + 1 : undefined;
		const res = await tool.execute(toolCallId, { path: basePath, offset, limit }, signal, onUpdate);
		const text = extractText(res.content as Array<{ type: string; text?: string }>);

		if (i > 0) {
			const prevEnd = ranges[i - 1].endLine;
			const curStart = range.startLine;
			if (prevEnd !== undefined) {
				const elidedStart = prevEnd + 1;
				const elidedEnd = curStart - 1;
				parts.push(
					elidedStart <= elidedEnd
						? `\n\n… (lines ${elidedStart}-${elidedEnd} elided)\n\n`
						: "\n\n",
				);
			}
		}
		parts.push(text);
	}
	return { content: [{ type: "text", text: parts.join("") }], details: {} };
}

// ── Tool definition ──────────────────────────────────────────────────

const readSchema = Type.Object({
	path: Type.String({
		description:
			"Path to the file to read (relative or absolute). May end with a line-range selector such as :50, :50-100, :50+100, :5-16,960-973, or :raw.",
	}),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const readDescription = `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments.

Line-range selectors: append :<sel> to the path to read specific lines (lines are 1-indexed).
  :50            from line 50 to end
  :50-100        lines 50 through 100 (inclusive)
  :50+100        100 lines starting at line 50
  :5-16,960-973  multiple ranges (sorted + merged), joined with "… (lines X-Y elided)" markers
  :raw           skip the binary-file guard (decode as text anyway)
  :5-16:raw / :raw:5-16   a range combined with raw
A single bounded range includes 1 leading + 3 trailing context lines; multi-range and open-ended ranges are exact.

Binary files that are not images are refused with a hint (use bash: xxd or strings).

For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use a selector or the offset/limit parameters to page through large files. The offset/limit parameters still work; when a path selector is present it takes precedence over them.`;

const readPromptSnippet = "Read file contents (supports :line-range selectors on path)";
const readPromptGuidelines = [
	"Use read to examine files instead of cat or sed.",
	"Use read with a :line-range selector (e.g. file.ts:50-100 or file.ts:5-16,960-973) to read specific lines instead of the whole file.",
];

export default function readSelectorExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read",
		label: "read",
		description: readDescription,
		promptSnippet: readPromptSnippet,
		promptGuidelines: readPromptGuidelines,
		parameters: readSchema,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path: rawPath, offset, limit } = params;
			const cwd = ctx.cwd;

			// 1. Strict split — only peels a grammar-valid trailing chunk.
			const strict = splitPathAndSel(rawPath);

			let basePath: string;
			let sel: ParsedSelector;

			if (strict.sel === undefined) {
				basePath = rawPath;
				sel = { kind: "none" };
			} else {
				// A selector-shaped tail was peeled. Prefer a literal file that is
				// actually named with the colon (POSIX allows it) over selector
				// interpretation; only a definitive ENOENT falls back to the split.
				const probe = await probeLiteralPathExists(rawPath, cwd);
				if (probe === "missing") {
					basePath = strict.path;
					sel = parseSel(strict.sel); // may throw on invalid bounds (e.g. :0)
				} else {
					basePath = rawPath;
					sel = { kind: "none" };
				}
			}

			// 2. Dispatch on selector kind.
			if (sel.kind === "conflicts") {
				throw new Error(
					"`read <path>:conflicts` (git merge-conflict scan) is not supported by this build. Read the file normally or with a line range instead.",
				);
			}

			if (sel.kind === "lines") {
				const ranges = sel.ranges;
				if (ranges.length > 1) {
					return await readMultiRange(basePath, ranges, toolCallId, signal, onUpdate, cwd);
				}
				// Single range: selector wins over the offset/limit params.
				const { offset: off, limit: lim } = singleRangeToOffsetLimit(ranges[0]);
				return await delegateRead(basePath, off, lim, toolCallId, signal, onUpdate, cwd);
			}

			// kind "none" or "raw": plain read of the whole file.
			// raw skips the binary guard (explicit "I know this is binary, give me text").
			if (!isRawSelector(sel)) {
				const notice = await binarySniffNotice(basePath, cwd);
				if (notice) return { content: [{ type: "text", text: notice }], details: {} };
			}
			// No selector: honor the offset/limit params; `:raw` reads the whole file.
			return await delegateRead(basePath, offset, limit, toolCallId, signal, onUpdate, cwd);
		},
	});
}
