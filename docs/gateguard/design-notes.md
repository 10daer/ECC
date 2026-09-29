# GateGuard design notes

Rationale for the decisions in the GateGuard fact-forcing gate
(`scripts/hooks/gateguard-fact-force.js` and `scripts/lib/gateguard-*.js`).
Code comments point here as `docs/gateguard/design-notes.md#<anchor>`; keep
headings stable, since they are the anchors.

## Module layout

- `scripts/hooks/gateguard-fact-force.js`: the hook. Owns the shell parser
  (`quoteAwareSegments`, `commandBasename`, `SHELL_SEGMENT_SEPARATORS`) that the
  destructive Bash/PowerShell detector uses, the state file I/O, the gate
  messages, and `run()`.
- `scripts/lib/gateguard-target-class.js`: target identity and classification
  for first-touch Edit/Write/MultiEdit targets: canonical path keys, target
  classes and their questions, sensitive-target detection and sibling-collapse
  eligibility. Stateless; filesystem access is limited to worktree `.git`
  checks and realpath/lstat of the target's parent chain.
- `scripts/lib/gateguard-turn-scan.js`: one bounded tail read of the Claude Code
  JSONL transcript, walked back to the start of the current turn. Yields the
  turn id, the turn's completed non-error search calls (newest first), their
  batch ids, the turn's shell commands and its `Read` calls (used only to
  explain a denial, never as evidence).
- `scripts/lib/gateguard-search-evidence.js`: decides whether a search in the
  current turn covers a target (prior-search credit). Its shell-dependent part
  is built by `createSearchEvidence()` from the hook's shell parser, so the
  parser the destructive detector relies on is shared, not copied or moved.
- `scripts/lib/gateguard-state.js`: pure helpers for the session-state fields
  (counters, per-class counts, sibling dir gates). Reading and writing the
  state file, and the one-write event helpers built on it, stay in the hook.
- `scripts/lib/gateguard-change-profile.js`: pure analysis of the change text
  of an Edit/Write/MultiEdit into a bounded change profile (see
  [Change profile](#change-profile)).

## Fail to deny

Every allowance other than a retry of an already-gated target (prior-search
credit, the trivial-edit pass, sibling collapse, the denial cap) is an exception to the first-touch
denial, so each one falls back to the denial on any doubt: an unreadable
transcript, a parse failure, an unresolvable path, or an exception. The lib
exports that feed those decisions never throw (they catch and return a
fallback that denies, or no scan at all), so an error cannot escape into credit or
sibling logic. Allowances are never an `allow` permission decision: credit,
trivial and sibling passes return `additionalContext`, and the cap pass returns
the input unchanged.

## Read is not evidence

`Read` never earns prior-search credit. Claude Code already requires a Read of
a file before an Edit of it, so crediting Read would switch the Edit gate off.
Only `Glob`, `Grep`, `LS` and shell search commands count.

## Sensitive targets

Secrets, keys, auth/payment code, migrations and CI workflows always draw the
first-touch denial with the full questions: prior-search credit, the change
profile, the trivial-edit pass, sibling collapse and the denial cap do not
apply to them, and the denial says so (its note names the three older
exceptions).

- Basename, extension and segment rules are exact, never substrings.
- `.github/workflows/` is also matched below an ancestor (an unverified
  worktree, or a target outside the project root).
- A target is sensitive on its lexical path or on its real (symlink-resolved)
  location, so `src/tools -> ../auth` cannot launder `src/tools/login.py`.
- A real location that cannot be resolved (dangling symlink, `ENOTDIR`,
  `EACCES`, loops), a non-string path, or any error counts as sensitive.

## Target resolution

Relative targets resolve against the tool's `cwd` first, then
`CLAUDE_PROJECT_DIR`, then the process cwd. This deliberately differs from
`GATEGUARD_EXEMPT_GLOBS`, whose globs are project-relative (`CLAUDE_PROJECT_DIR`
first). The canonical checked-state key folds `a.py`, `./a.py` and the absolute
path to one gate; Windows-style paths also fold separators and case.

A target is classified by its project-relative path, so an ancestor such as
`/home/me/tests/proj` never leaks into the class; targets outside the root keep
their absolute path. A Windows-style path has no real location on a POSIX host
(and vice versa), so real-path checks are skipped for it.

## Target classes

The first matching class wins: instruction, test, prose, config, code (the
fallback). Cursor `.mdc` rule files are instructions wherever they live. A
basename starting with `.env` is config unless it has a code extension
(`.env.example.ts` is source). Code targets ask the original four questions,
narrowed by the change profile (see
[Questions from the change profile](#questions-from-the-change-profile)); other
classes get class-specific questions and a class-specific condensed hint.

## Worktree prefix

A `.claude/worktrees/<name>/` prefix is stripped only when that worktree is real
(its `.git` exists). Otherwise the path stays under `.claude`, which is an
instruction directory and blocks sibling collapse.

## Windows name normalization

Windows ignores trailing dots and spaces in a name and treats `name:stream` as
`name`, so segments are normalized the same way before classification:
`CLAUDE.md.` and `CLAUDE.md::$DATA` both name `CLAUDE.md`.

## Turn boundaries

The scan walks the transcript tail backwards to the latest human message or
compaction. Only a user record whose content is a non-empty array of
`tool_result` blocks is a tool result; any other user record is a turn
boundary, which can only shrink the credit window. A compaction summary or
`compact_boundary` record discards the earlier turn and starts a new one. The
tail read is bounded (bytes and lines) to keep the hook fast.

## Turn identity

Claude Code stamps every user record of a turn with the same `promptId`, so it
identifies the turn even after the boundary has scrolled out of the tail
window; without one, the boundary record's `uuid` (or a hash of its line) is
used. When no boundary is found, a clipped window is the current turn only if
its `promptId`s agree; two or more mean an unrecognised turn start, and an
unclipped file has no turn at all.

## Tool result pairing

A search counts only when it completed without error. A tool-use id that occurs
more than once in the window cannot be tied to one result, so it never counts.

## Same-batch searches

Searches in the pending call's own assistant message never count: their results
were not seen when the edit was decided. The batch is located by the pending
`tool_use_id`, or else taken to be the newest assistant message.

## Ambiguous shell is not evidence

Command substitution, process substitution, heredocs and PowerShell backtick
escapes make the searched text ambiguous, so a shell command containing any of
them yields no evidence. Commands over 8192 characters yield none either.

## Directory changes

A `cd` (or its PowerShell equivalents) in any other shell call of the turn
leaves the cwd of every shell search unknown: shell searches then give no
directory evidence, and their relative operands scope nothing. Within one command, a plain literal `cd <dir>` rebases
later relative operands; any other directory change makes them unresolvable.
Operands that are variables, `~`, or relative to an unknown cwd scope nothing.

## Stdin is not a tree search

A search segment that reads stdin (input redirection, a pipe into it, or no
path operand without recursion) searched piped text, not the tree, so it gives
no evidence. A quoted `<` cannot be told from a redirection and is treated as
one. `||` also marks the next segment as piped, which only ever removes
evidence.

## Search scope

Each search offers stem texts, candidate directories, the scope the target must
lie in, and path operands. The target must lie inside the scope. A search whose
operands are all the target itself read the target rather than searched for it,
and gives nothing. A `Glob` without glob characters is a single-file lookup: it
names no directory. A `Glob` with an empty literal prefix and no explicit path
names only the implicit cwd, so it gives no directory credit. Directory
evidence from shell operands must name a directory that exists now.
PowerShell `-Path`/`-LiteralPath` values count as operands but never as
directory evidence.

## Stem matching

A target's stem (basename without extension) credits it only when it has at
least four characters and is not generic (`index`, `utils`, `config`, ...).
Matching is a word-boundary `indexOf` scan; a `RegExp` is never built from
transcript text.

## Search filters

A search that excluded the target never saw it:

- exclusion values, and the flags that introduce them, are never a stem source;
- an exclusion that names the stem, or matches the file or any directory above
  it, blocks credit;
- unreadable exclusion lists (`--exclude-from`, `--ignore-file`,
  `git ls-files -X`) and more than 32 exclusions block credit;
- an exclusion glob past the matching bounds, or malformed, counts as covering
  the target.

find: a negated or pruned name test is an exclusion; a plain `-name`/`-iname` is
an include. `--ignore`/`--hide` exclude names only for `ls` (rg's `--ignore` is
a switch).

## Include filters

Basename include globs (`--include`, `-g`, `--glob`, `-name`, PowerShell
`-Filter`/`-Include`) that all miss the target stop its stem from crediting. An
include glob past the matching bounds admits the target (the stem, scope and
exclusion checks still apply); a malformed one does not.

## Glob matching without RegExp

Filter globs are matched by dynamic programming over glob tokens, never by a
`RegExp`, so a hostile glob cannot cause regex backtracking. Globs are bounded
to 256 characters and 32 brace alternatives. Bracket classes support members,
ranges, `!`/`^` negation and a leading literal `]`; an unclosed class is
malformed. An unbalanced `{` is literal.

## Flag parsing

Only path operands can scope a search:

- flags that consume a value are skipped with it; single-dash clusters
  (`-rne PAT`) are read letter by letter, and a value flag ends the cluster;
- for grep-family tools, `rg`, `git grep`, `Select-String` and `fd`, the first
  positional is the pattern unless `-e`/`-f` (grep family, `rg`, `git grep`
  only; fd's `-e` is an extension) supplied it;
- fd's `-E/--exclude` takes a value; rg's `-r/--replace` takes a value.

## PowerShell parameter binding

PowerShell binds a parameter by any unambiguous prefix, by `-Name:value`, and by
comma lists across arguments, so `-Exclude` has many spellings. A parameter that
cannot be resolved may be an exclusion in disguise: neither it nor a value it
may carry is a stem source.

## New-file detection

A Write target is new only when `lstat` reports `ENOENT`; any other error counts
as an existing file. Only a new file may earn directory credit or sibling
collapse.

## Sibling collapse

A new file whose directory had a sibling gated moments ago passes with a note
instead of a repeat denial.

- Only code, test and prose targets collapse. Harness and tooling directories
  are dot-directories, so any dot segment blocks collapse, as do 8.3 short names
  (`CLAUDE~1`), which can alias any directory.
- The gate is keyed by the real directory. A symlinked directory must keep the
  class and pass the same screen, and must not be sensitive, so
  `src/tools -> .claude/hooks` never collapses.
- A gate opens for the same turn id; without a turn id on either side, for 120 s.
  The 120 s rule applies only when there is no transcript at all; an unusable
  transcript never collapses.
- A gate stamped in the future, or not created by a denial, is ignored.

## Denial cap

`GATEGUARD_FACT_FORCE_MAX_DENIALS` is validated whole (digits only, a safe
integer), not with `parseInt`: a prefix parse would turn `3oops` into a cap. A
malformed value leaves the gate uncapped and says so once on stderr. Once the
session's denials reach the cap, a first touch passes with the input unchanged
and is counted in `cap_allows`. The cap check reads the state the same write
persists, so a lost concurrent update can add a denial but never passes a
target early. Sensitive targets are never capped.

## State file is untrusted

The session state file can be edited or corrupted, so every field is validated
on read: counters clamp to non-negative integers, maps are null-prototype and
reject `__proto__`, `constructor` and `prototype` keys, and malformed or
old-shape entries are dropped. `dir_gates` maps `<class>\u0000<canonicalDir>` to
`{ turn, at, first, ordinal }` and keeps the 50 newest entries. Concurrent
writers are merged on save (checked keys by union, counts by maximum, gates by
newest `at`). Marking a target checked and recording its event happen in one
state write, so an event is never half-recorded.

## Change profile

`scripts/lib/gateguard-change-profile.js` reads the change the hook already
receives (Edit `old_string`/`new_string`, each MultiEdit entry for the target,
Write `content`) and derives three booleans: `touchesPublicSurface`,
`touchesData` and `trivial`. It is pure string analysis: no file or transcript
reads, no `RegExp` built from input, and every loop is a single linear pass.

The profile only ever removes questions, so anything uncertain yields the
unknown profile (every question asked, never trivial): an unsupported
extension, a non-string side, no entries or more than 64, a side over 64 KiB
(UTF-8), more than 256 KiB in total, or any exception. Supported languages, by
extension: JS/TS (`.js .mjs .cjs .jsx .ts .tsx .mts .cts`), Python
(`.py .pyi`), Go, Rust, Java, Kotlin (`.kt .kts`), C# and C/C++ (`.c .h .cc
.cpp .cxx .hpp .hh .hxx`). Shell, Ruby, Makefiles, Swift and everything else
are unknown.

## Public surface

A Write always touches the public surface (a new or rewritten module's
surface is all new). For an Edit, any line on either side that declares or
exposes a public name counts, whether it changed or is only context: context
around a public declaration means the edit is inside that symbol.

- JS/TS: a line starting with the word `export`, `public` or `declare`, or
  containing the word `exports` (`module.exports`, `exports.x`). `.d.ts`,
  `.d.mts` and `.d.cts` files are all surface.
- Python: `def`, `async def` or `class` whose name does not start with `_`
  (dunders such as `__init__` are public), any `__all__`, and a column-0
  assignment or annotation of a public name on a line after the first (the
  first line of a snippet may start mid-line). `__init__.py` is all surface.
- Go: `func` (after an optional receiver), `type`, `var` or `const` with a
  capitalised name, a `package` line, and any line that starts with a
  capital letter (exported fields, interface methods, grouped declarations).
- Rust: lines starting with `pub` (any `pub(...)`), `impl`, `trait`, or
  `#[macro_export`.
- Java, Kotlin, C#, C and C++ always touch the surface: package-private Java,
  Kotlin's public default, C# partial classes and C linkage make a lexical
  answer unreliable.

An Edit that changes a function body without its declaration line in the
snippet reads as not touching the surface; the local question still asks for
the call sites that rely on the behaviour.

## Data handling

`touchesData` looks at every side (both sides of an Edit) as words: identifiers
are split on non-alphanumerics, `_` and camelCase boundaries and lowercased,
so `validate` and `updated` never match `date`. It is true for a data word
(formats such as `json`, `csv`, `yaml`, `parquet`; serialisation; `schema`;
SQL and database words; date/time words such as `date`, `datetime`,
`timestamp`, `strftime`, `utc`; file I/O such as `fs`, `fopen`, `pathlib`),
for `open(`, for adjacent pairs such as `read file`,
`write text`, `read to`, and for SQL keyword pairs anywhere in the text
(`select`+`from`, `insert`+`into`, `create`+`table`, ...). Over-matching only
keeps the data question.

## Trivial edits

An Edit is trivial when, for every entry, old and new have the same code once
comments are removed, blank and comment-only lines are dropped, and runs of
whitespace between tokens are folded to one space. Line structure, whitespace
inside strings, and the presence of whitespace between tokens stay code
(`a+b` to `a + b` is not trivial). For Python, leading whitespace of each code
line is code; comment-only lines carry no indentation.

Comments are `//` and non-nesting `/* */` in the C family and `#` in Python;
C preprocessor lines are code. Strings are single-line `"..."` and `'...'`
(Rust: `"..."` only, with `'x'` char literals told apart from lifetimes).
Anything the lexer cannot read with confidence makes the entry non-trivial:

- any multi-line string form: JS/Go backticks, Python/Java/Kotlin/C# triple
  quotes, Rust raw strings (`r"`, `r#"`), C++ raw strings (`R"`), C# verbatim
  and interpolated strings (`@"`, `$"`), Kotlin strings containing `$`, Python
  f-strings, and any string that runs to the end of a line;
- in JS/TS, any `/` outside a comment (division and regex literals cannot be
  told apart), JSX-like `<x`, `</`, `<>`, `<!`, and `-->`;
- a line comment ending in `\` (it continues onto the next line in C and
  Make), the trigraph `??/`, whitespace after a line-continuation `\`, a `/*`
  inside a block comment, and an unterminated block comment or string.

Write is never trivial. In the hook, a trivial Edit (or a MultiEdit whose
entries for that file are all trivial) of an unchecked code, test or prose
target passes with an `additionalContext` note after prior-search credit and
before sibling collapse and the denial cap. It is not marked checked and does
not touch the denial count or ordinal, so the next change that alters code is
gated as a first touch; `trivial_allows` counts the passes (merged by maximum
like the other counters). The profile sees only the snippet, so a comment-looking
line inside a multi-line string that opens and closes outside the snippet
reads as a comment; the trivial pass never marks the target checked and never
applies to sensitive, instruction or config targets, so the next non-trivial
change still meets the full gate.

## Questions from the change profile

Every question has a stable id, and `questionIdsFor(class, isWrite, profile)`
returns the ids in the order asked, so later measurement can record which
questions were asked without storing text.

| Target | Profile | Question ids |
|---|---|---|
| code Edit/MultiEdit | unknown | `importers`, `public-api`, `data-schema`, `quote-instruction` |
| code Edit/MultiEdit | public surface | `importers`, `public-api`, [`data-schema`], `quote-instruction` |
| code Edit/MultiEdit | no public surface | `local-callers`, [`data-schema`], `quote-instruction` |
| code Write | unknown | `callers`, `no-duplicate`, `data-schema`, `quote-instruction` |
| code Write | known | `callers`, `no-duplicate`, [`data-schema`], `quote-instruction` |
| instruction | any | `loader`, `behaviour-change`, `no-duplicate-instruction`, `quote-instruction` |
| test | any | `under-test`, `existing-tests`, `quote-instruction` |
| prose Write | any | `supersedes`, `linked-from`, `why-new-file`, `quote-instruction` |
| prose Edit | any | `references`, `corrects-or-adds`, `quote-instruction` |
| config | any | `config-reader`, `config-effect`, `no-plaintext-secrets`, `quote-instruction` |

`[data-schema]` is asked only when `touchesData`. With an unknown profile the
code text is byte-identical to the fixed four questions. Sensitive targets are
never profiled, so they always get the full code questions. Instruction and
config questions carry no change-dependent item, and the test and prose items
do not depend on what the change touches, so the profile leaves those classes
alone. For a MultiEdit, the denied file's profile covers every entry for that
file (same canonical key); entries for other files do not count. The condensed
denial uses the local-callers hint when `local-callers` is asked, else the
original code hint.

## Closest search that did not count

When a non-sensitive first touch is denied and the turn holds a search (or a
`Read`, or a non-search shell command) that mentions the target but did not
credit it, the denial adds one line naming the closest one, so the agent does
the missing step instead of restating facts:
`Closest search this turn did not count (<tool> <detail>): <why>.` It reuses
the single cached turn scan; no transcript is read again, and nothing is
computed on the credit or allow paths.

A search mentions the target when its stem matches (or, for a generic or short
stem, the bare name of at least three characters appears as a word) or, for a
new-file Write, when it names the target's directory. Reason codes, from
closest to farthest (the closest wins, then the newest):

| Code | Meaning |
|---|---|
| `same-batch` | it would have credited, but was sent in the pending call's own batch |
| `excluded` | an exclusion covers the target, or include globs miss it |
| `out-of-scope` | its path or operands do not contain the target |
| `stdin-only` | a search segment that read piped input or had no tree operand |
| `not-a-search` | a `Read` of the target, or a non-search shell segment naming it |
| `generic-stem` | the target's name is too generic or short to match any search |

`previous-turn` is not reported: the scan stops at the turn boundary, and
reading past it would cost a second, larger scan. Ambiguous shell commands
(substitutions, heredocs, over 8192 characters) give no line. The tool name
comes from a fixed set; the detail is the tool input, sanitized like a path,
whitespace-folded and cut to 60 characters. Sensitive targets never get the
line, since no search could have credited them. In a condensed denial the line
follows the batch warning.
