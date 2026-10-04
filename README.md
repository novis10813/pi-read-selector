# pi-read-selector

A pi extension that overrides the built-in `read` tool to add a path-embedded
line-range selector. It delegates to the built-in read, so result shape,
truncation, image handling and the TUI renderer stay identical.

| Selector | Meaning |
|---|---|
| `file.ts:50` | from line 50 to end |
| `file.ts:50-100` | lines 50 through 100 |
| `file.ts:50+100` | 100 lines starting at line 50 |
| `file.ts:5-16,960-973` | multiple ranges, joined with `… (lines X-Y elided)` markers |
| `file.ts:raw` | skip the binary-file guard |
| `file.ts:5-16:raw` | a range combined with raw |

A single bounded range includes 1 leading and 3 trailing context lines.
Multi-range and open-ended ranges are exact. A real file whose name ends in
selector-looking text (for example `weird:10`) is read as a literal path.
Binary files that are not images are refused with a hint to use `xxd` or
`strings`.

Selector parsing is ported from [oh-my-pi](https://github.com/can1357/oh-my-pi)
(MIT).

## Install

```bash
pi install git:github.com/novis10813/pi-read-selector
```

No npm dependencies. `@earendil-works/pi-*` and `typebox` are provided by
pi's extension loader.

Interactive mode shows an override warning because the extension registers a
tool named `read`. This is expected.

## Development

```bash
npm test
```

The test loads `read-selector.ts` through jiti and derives `PI_PKG` from the
active node (`process.execPath` → nvm `lib/node_modules/@earendil-works/pi-coding-agent`).
Run it with the node that has pi installed.

## Notes on overriding a built-in tool

- `parameters` must match the built-in schema exactly, otherwise resumed
  sessions with old tool calls fail validation.
- Delegate to the factories exported by `@earendil-works/pi-coding-agent`
  (`createReadTool(cwd).execute(...)`) so the result shape follows the pi
  version in use.
- Without `renderCall` / `renderResult` the built-in renderer is inherited.
  `promptSnippet` and `promptGuidelines` are not inherited and must be defined.
- Known tradeoff: the inherited renderer infers syntax highlighting from
  `args.path`, so a selector suffix disables highlighting in the TUI. The
  model is unaffected.

## Roadmap

Phase 1 is done: selector syntax, context lines, binary guard.

Deferred (2026-08 review):

- Directory reads (depth-2 tree, overlaps with `ls`)
- `:conflicts` (git merge-conflict scan)
- Structural summaries (depends on the Rust native `@oh-my-pi/pi-natives`)

Design intent: URL, archive, SQLite or PDF sources should be added as source
handlers inside this same `read` tool, not as separate tools. The registry is
not implemented yet (the header comment in `read-selector.ts` describes the
planned seam).
