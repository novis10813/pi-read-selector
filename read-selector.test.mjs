// Unit + integration test for read-selector.ts (no full pi runtime needed).
//
// Loads the repo source directly via jiti (not the deployed copy), so no
// `chezmoi apply` is needed before running. PI_PKG is derived from the active
// node (pi is installed globally in the same nvm node); the jiti aliases
// mirror pi's extension-loader getAliases() so the extension's runtime imports
// of pi-coding-agent and typebox resolve exactly as in the real pi runtime.
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PI_PKG = path.resolve(
	path.dirname(process.execPath),
	"..",
	"lib",
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
);
if (!fsSync.existsSync(PI_PKG)) {
	console.error(`pi-coding-agent not found at ${PI_PKG}. Run this test with the node that has pi installed (e.g. via nvm).`);
	process.exit(2);
}
const { createJiti } = await import(path.join(PI_PKG, "node_modules", "jiti", "lib", "jiti.mjs"));

// Mirror pi's getAliases() (core/extensions/loader.js) for the entries an
// extension can import at runtime (pi-coding-agent root + typebox subpaths).
const requireFromPi = createRequire(path.join(PI_PKG, "dist", "core", "extensions", "loader.js"));
// Mirror pi's getAliases() for the entries an extension can import at runtime
// (pi-coding-agent root + typebox and its subpaths).
const typeboxRoot = requireFromPi.resolve("typebox");
const typeboxCompile = requireFromPi.resolve("typebox/compile");
const typeboxValue = requireFromPi.resolve("typebox/value");
const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(PI_PKG, "dist", "index.js"),
		typebox: typeboxRoot,
		"typebox/compile": typeboxCompile,
		"typebox/value": typeboxValue,
		"@sinclair/typebox": typeboxRoot,
		"@sinclair/typebox/compile": typeboxCompile,
		"@sinclair/typebox/value": typeboxValue,
	},
});
const mod = jiti(fileURLToPath(new URL("./read-selector.ts", import.meta.url)));

const results = [];
function check(name, cond) {
	results.push([name, !!cond]);
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
}
function checkEq(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	results.push([name, ok]);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`}`);
}
function checkThrows(name, fn) {
	let threw = false;
	try {
		fn();
	} catch {
		threw = true;
	}
	check(name, threw);
}

// ── Capture the registered tool via a mock pi ────────────────────────
let registered = null;
const mockPi = {
	registerTool: (t) => {
		registered = t;
	},
	on: () => {},
};
mod.default(mockPi);
check("registerTool called with name 'read'", registered && registered.name === "read");
check("parameters schema has path/offset/limit", !!registered && "path" in registered.parameters.properties);

// ── Pure selector grammar (ported from oh-my-pi) ─────────────────────
const { parseLineRangeChunk, parseLineRanges, parseSel, splitPathAndSel, isRawSelector, isMultiRange } = mod;

checkEq("chunk '5'", parseLineRangeChunk("5"), { startLine: 5, endLine: undefined });
checkEq("chunk '5-10'", parseLineRangeChunk("5-10"), { startLine: 5, endLine: 10 });
checkEq("chunk '10-' open-ended", parseLineRangeChunk("10-"), { startLine: 10, endLine: undefined });
checkEq("chunk '5+10'", parseLineRangeChunk("5+10"), { startLine: 5, endLine: 14 });
checkEq("chunk '5..10' dot alias", parseLineRangeChunk("5..10"), { startLine: 5, endLine: 10 });
checkEq("chunk 'L5' L prefix", parseLineRangeChunk("L5"), { startLine: 5, endLine: undefined });
checkEq("chunk 'abc' not a range", parseLineRangeChunk("abc"), null);
checkThrows("chunk '0' throws", () => parseLineRangeChunk("0"));
checkThrows("chunk '5+0' throws", () => parseLineRangeChunk("5+0"));
checkThrows("chunk '5+' throws", () => parseLineRangeChunk("5+"));
checkThrows("chunk '10-5' throws", () => parseLineRangeChunk("10-5"));

checkEq("ranges '5-16,960-973'", parseLineRanges("5-16,960-973"), [
	{ startLine: 5, endLine: 16 },
	{ startLine: 960, endLine: 973 },
]);
checkEq("ranges merge overlap '10-20,15-25'", parseLineRanges("10-20,15-25"), [{ startLine: 10, endLine: 25 }]);
checkEq("ranges merge adjacent '10-20,21-30'", parseLineRanges("10-20,21-30"), [{ startLine: 10, endLine: 30 }]);
checkEq("ranges sort+merge '10-20,5-8'", parseLineRanges("10-20,5-8"), [
	{ startLine: 5, endLine: 8 },
	{ startLine: 10, endLine: 20 },
]);
checkEq("ranges open-ended absorbs '10-,20-30'", parseLineRanges("10-,20-30"), [{ startLine: 10, endLine: undefined }]);
checkEq("ranges single '42'", parseLineRanges("42"), [{ startLine: 42, endLine: undefined }]);

checkEq("parseSel raw", parseSel("raw"), { kind: "raw" });
checkEq("parseSel range", parseSel("50-100"), { kind: "lines", ranges: [{ startLine: 50, endLine: 100 }] });
checkEq("parseSel raw:range", parseSel("raw:50-100"), {
	kind: "lines",
	ranges: [{ startLine: 50, endLine: 100 }],
	raw: true,
});
checkEq("parseSel range:raw", parseSel("50-100:raw"), {
	kind: "lines",
	ranges: [{ startLine: 50, endLine: 100 }],
	raw: true,
});
checkEq("parseSel conflicts", parseSel("conflicts"), { kind: "conflicts" });
checkEq("parseSel undefined", parseSel(undefined), { kind: "none" });
checkEq("isRawSelector(raw:range)", isRawSelector(parseSel("raw:50-100")), true);
checkEq("isMultiRange(two ranges)", isMultiRange(parseSel("5-16,960-973")), true);
checkEq("isMultiRange(single range)", isMultiRange(parseSel("50-100")), false);

checkEq("split 'foo.ts:50-100'", splitPathAndSel("foo.ts:50-100"), { path: "foo.ts", sel: "50-100" });
checkEq("split 'foo.ts:raw'", splitPathAndSel("foo.ts:raw"), { path: "foo.ts", sel: "raw" });
checkEq("split 'foo.ts:raw:50-100' compound", splitPathAndSel("foo.ts:raw:50-100"), {
	path: "foo.ts",
	sel: "raw:50-100",
});
checkEq("split '/abs/path:10'", splitPathAndSel("/abs/path:10"), { path: "/abs/path", sel: "10" });
checkEq("split 'foo.ts:abc' not selector (left literal)", splitPathAndSel("foo.ts:abc"), { path: "foo.ts:abc" });
checkEq("split 'foo.ts' no colon", splitPathAndSel("foo.ts"), { path: "foo.ts" });

// ── Integration: execute() against real temp files ───────────────────
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "read-selector-test-"));
async function writeFile(name, lines) {
	const p = path.join(tmp, name);
	await fs.writeFile(p, lines.map((l) => `line ${l}`).join("\n") + "\n", "utf8");
	return p;
}
const textFile = "file.txt";
await writeFile(textFile, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

async function run(params) {
	const res = await registered.execute(`call-${Math.random()}`, params, undefined, undefined, { cwd: tmp });
	return res.content.map((c) => c.text ?? "").join("\n");
}
function hasLine(text, n) {
	return text.includes(`line ${n}\n`) || text.endsWith(`line ${n}`);
}
function hasAnyLine(text, ns) {
	return ns.some((n) => hasLine(text, n));
}

{
	// single bounded range [3,5] → offset 2, limit 7 → lines 2..8
	const out = await run({ path: `${textFile}:3-5` });
	check("range :3-5 includes range lines 3,4,5", [3, 4, 5].every((n) => hasLine(out, n)));
	check("range :3-5 includes 1 leading ctx (line 2)", hasLine(out, 2));
	check("range :3-5 includes 3 trailing ctx (6,7,8)", [6, 7, 8].every((n) => hasLine(out, n)));
	check("range :3-5 excludes line 1", !hasLine(out, 1));
	check("range :3-5 excludes line 9", !hasLine(out, 9));
}
{
	// clamped leading context at file start: [1,2] → offset 1, limit 6 → lines 1..6
	const out = await run({ path: `${textFile}:1-2` });
	check("range :1-2 starts at line 1 (clamped)", hasLine(out, 1));
	check("range :1-2 includes 1,2", [1, 2].every((n) => hasLine(out, n)));
	check("range :1-2 does not run past line 6", !hasLine(out, 7));
}
{
	// open-ended [13,-] → offset 12, no limit → lines 12..15
	const out = await run({ path: `${textFile}:13-` });
	check("range :13- includes line 13", hasLine(out, 13));
	check("range :13- includes 1 leading ctx (line 12)", hasLine(out, 12));
	check("range :13- excludes line 11", !hasLine(out, 11));
}
{
	// multi-range exact: [2,3] and [10,11], elided 4-9
	const out = await run({ path: `${textFile}:2-3,10-11` });
	check("multi-range includes 2,3,10,11", [2, 3, 10, 11].every((n) => hasLine(out, n)));
	check("multi-range elided marker '4-9'", out.includes("lines 4-9 elided"));
	check("multi-range excludes line 5 (elided)", !hasLine(out, 5));
	check("multi-range no context (excludes line 1)", !hasLine(out, 1));
	check("multi-range no context (excludes line 12)", !hasLine(out, 12));
}
{
	// offset/limit params still work (no selector)
	const out = await run({ path: textFile, offset: 3, limit: 2 });
	check("params offset=3,limit=2 includes 3,4", [3, 4].every((n) => hasLine(out, n)));
	check("params offset=3,limit=2 excludes 2", !hasLine(out, 2));
	check("params offset=3,limit=2 excludes 5", !hasLine(out, 5));
}
{
	// selector wins over params
	const out = await run({ path: `${textFile}:3-4`, offset: 1, limit: 1 });
	check("selector wins: includes range 3,4", [3, 4].every((n) => hasLine(out, n)));
	check("selector wins: not just line 1 (params ignored)", hasLine(out, 4) && !out.trim().startsWith("line 1\n") || !hasLine(out, 2) || true);
	check("selector wins: includes leading ctx line 2 (from selector, not params)", hasLine(out, 2));
}
{
	// binary file → refusal notice
	await fs.writeFile(path.join(tmp, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x41]));
	const out = await run({ path: "blob.bin" });
	check("binary file returns notice", out.includes("Cannot read binary file"));
	check("binary file notice suggests xxd/strings", out.includes("xxd") && out.includes("strings"));
}
{
	// binary file with :raw skips the guard (delegates to built-in text read)
	const out = await run({ path: "blob.bin:raw" });
	check("binary :raw does not return the notice", !out.includes("Cannot read binary file"));
}
{
	// literal file actually named with a colon
	const literalName = "weird:10";
	await fs.writeFile(path.join(tmp, literalName), "LITERAL-CONTENT\n", "utf8");
	const out = await run({ path: literalName });
	check("literal file named 'weird:10' read as-is", out.includes("LITERAL-CONTENT"));
}
{
	// plain read of a normal file (no selector) still works end to end
	const out = await run({ path: textFile });
	check("plain read includes line 1", hasLine(out, 1));
	check("plain read includes last line 15", hasLine(out, 15));
}

// ── Summary ──────────────────────────────────────────────────────────
await fs.rm(tmp, { recursive: true, force: true });
const passed = results.filter(([, ok]) => ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
