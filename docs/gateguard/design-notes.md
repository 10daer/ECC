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
- `scripts/lib/gateguard-readonly-shell.js`: decides whether a Bash or
  PowerShell command is allowlisted read-only introspection (see
  [Read-only first shell command](#read-only-first-shell-command)). Built by
  `createReadOnlyShell()` from the hook's `quoteAwareSegments`, like the
  search evidence.
- `scripts/lib/gateguard-metrics.js`: builds, validates and appends the opt-in
  decision metrics lines (see [Metrics](#metrics)). `scripts/gateguard-report.js`
  reads them back.

## Fail to deny

Every allowance other than a retry of an already-gated target (prior-search
credit, the trivial-edit pass, sibling collapse, the denial cap, the read-only
first shell command) is an exception to the first-touch or routine
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

## Test stems

A test is named after the module it exercises, and a search for that module
(`rg tokenizer src tests`) is the search that finds its tests. So for a target
of the test class, one test affix is stripped before the stem rules apply:
a `.test` or `.spec` suffix, a `test_` prefix on `.py`, and a `_test` suffix
on `.py` and `.go`, the same affixes that make a file a test. The result
still has to be at least four characters, not generic (`index.test.js` gives
`index`, which never credits), a whole word in the search, and in the
search's scope; exclusions that mention the stripped stem cover the target.
Only one affix is stripped, and other classes keep the full stem (a
`tokenizer.test.md` under `skills/` is an instruction file). The full stem
(`tokenizer.test`) still matches as a word, since `.` is a word boundary.

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

## MultiEdit paths

A MultiEdit call names its file once, in `tool_input.file_path`, and its
`edits` entries carry only `old_string`, `new_string` and `replace_all`. An
entry without a `file_path` of its own is gated as the call's `file_path`
(at top level and in subagents), so the call meets the same first-touch,
sensitive-target and trivial-edit rules as an Edit of that file. Entries that
name their own path keep it. Non-object entries are skipped; a non-array
`edits` is treated as empty.

## Change profile

`scripts/lib/gateguard-change-profile.js` reads the change the hook already
receives (Edit `old_string`/`new_string`, each MultiEdit entry for the target,
Write `content`) and derives three booleans: `touchesPublicSurface`,
`touchesData` and `trivial`. It is string analysis of those texts and, for
`trivial`, of the current file text the hook passes in (see
[File context](#file-context)): no reads of its own, no `RegExp` built from
input, and every loop is a single linear pass.

The profile only ever removes questions, so anything uncertain yields the
unknown profile (every question asked, never trivial): an unsupported
extension, a non-string side, no entries or more than 64, a side over 64 KiB
(UTF-8), more than 256 KiB in total, or any exception. Supported languages, by
extension: JS/TS (`.js .mjs .cjs .jsx .ts .tsx .mts .cts`), Python
(`.py .pyi`), Go, Rust, Java, Kotlin (`.kt .kts`), C# and C/C++ (`.c .h .cc
.cpp .cxx .hpp .hh .hxx`), and shell scripts: POSIX shells (`.sh .bash .zsh`),
PowerShell (`.ps1 .psm1`) and batch (`.bat .cmd`). Ruby, Makefiles, Swift,
fish, PowerShell data files and everything else are unknown.

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
  assignment or annotation of a public name (a module constant or variable
  that importers can read). The first line of a snippet may start mid-line
  (an Edit's `old_string` can begin after the indentation), so there only an
  all-uppercase name counts, the constant convention that function locals
  rarely use. `__init__.py` is all surface.
- Go: `func` (after an optional receiver), `type`, `var` or `const` with a
  capitalised name, a `package` line, and any line that starts with a
  capital letter (exported fields, interface methods, grouped declarations).
- Rust: lines starting with `pub` (any `pub(...)`), `impl`, `trait`,
  `extern`, or an ABI or trait attribute (`#[macro_export`, `#[derive`,
  `#[repr`, `#[no_mangle`, `#[export_name`, and their `#[unsafe(...)]`
  forms).
- POSIX shells: a function definition (`name() {`, `function name`), an
  `export`, or `declare -x`/`typeset -x`, at any indentation. A sourced
  script's functions and exported variables are what other scripts use.
- PowerShell (case-insensitive): lines starting with `function`, `filter`,
  `workflow`, `class`, `enum`, `param` (a script's parameters are its
  interface), `Export-ModuleMember`, `[CmdletBinding` or `$global:`.
- Java, Kotlin, C#, C, C++ and batch files always touch the surface:
  package-private Java, Kotlin's public default, C# partial classes, C linkage
  and batch labels reachable by `call :label` make a lexical answer
  unreliable.

An Edit that changes a function body without its declaration line in the
snippet reads as not touching the surface; the local question still asks for
the call sites that rely on the behaviour.

A member line can be public surface even though its container's declaration
is not in the snippet: a property of an exported interface, a variant of a
public enum, a name in an export list. So, when the hook passes the file text,
the nearest line above the first occurrence that starts at column 0 (skipping
blank lines, comments and decorators; a closing `}`, `]` or `)` there means
the edit is at top level) is read as the enclosing opener:

- JS/TS: `module.exports`/`exports` assigned an object, array or call, and
  `export` (or `export default`) of an interface, enum, type, namespace,
  module, `declare`, `{ ... }` list, or `const`/`let`/`var` that is not a
  function or arrow: every line inside is surface. An exported class: lines
  at the class's member indentation (the first non-blank line after the
  opener) are surface; method bodies are not. An exported `function` or
  `async function` is a body, as before.
- Python: `__all__` makes every line surface; a public `class` makes an
  assignment or annotation of a public name at member indentation (class
  attributes, dataclass fields) surface.
- Rust: a `pub` enum, struct, union, trait or `use` makes lines at member
  indentation surface.

The upward scan stops after 4 MiB in total and then counts as surface. The
opener is found by indentation, not by parsing, so it can over-match (a method
body inside an exported object literal counts), which only keeps the importer
question.

## Data handling

`touchesData` looks at every side (both sides of an Edit) as words: identifiers
are split on non-alphanumerics, `_` and camelCase boundaries and lowercased,
so `validate` and `updated` never match `date`. It is true for a data word
(formats such as `json`, `csv`, `yaml`, `parquet`; serialisation; `schema`;
SQL and database words; date/time words such as `date`, `datetime`,
`timestamp`, `strftime`, `utc`, `chrono`, `zoneinfo`; encodings such as
`base64`, `encoding`, `msgpack`; browser storage and cookies; data-store
clients such as `redis`, `prisma`, `sqlalchemy`; file I/O such as `fs`,
`fopen`, `pathlib`), for `open(`, for adjacent pairs such as `read file`,
`time now`, `time parse`, `system time`,
`write text`, `read to`, and for SQL keyword pairs anywhere in the text
(`select`+`from`, `insert`+`into`, `create`+`table`, ...). Over-matching only
keeps the data question.

Shell scripts also touch data with a file redirection (`>`, `>>`, `>|`, `&>`
or `<` followed by a target other than `/dev/null`, `/dev/stdout`,
`/dev/stderr`, `$null` or `nul`; descriptor duplication such as `2>&1` and
`>&2`, heredocs and process substitution do not count), an HTTP or document
tool (`curl`, `wget`, `jq`, `yq`, `xmllint`, `psql`, `tee`, `iwr`, `irm`),
or a PowerShell file or web cmdlet (`Out-File`, `Get-Content`,
`Set-Content`, `Add-Content`, `Invoke-WebRequest`, `Invoke-RestMethod`,
`*-Clixml`; `Import-Csv` matches `csv`). Redirection is found without
reading quotes, so a `>` inside a string also counts.

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
  Make), the trigraph `??/`, a `/*` inside a block comment, and an
  unterminated block comment or string;
- a code line ending in a line continuation `\` (trailing blanks included):
  a C macro, a Python explicit continuation or a string continued onto the
  next line joins that line, so adding or removing a comment-only line after
  it changes code.

## Directive comments

Some comments are read by the language, the build or a tool, so their text is
code. A directive comment is kept in the compared code verbatim: changing,
adding or removing one makes the entry non-trivial, while an unchanged
directive next to an edited ordinary comment does not.

- A comment whose text starts with `!` (shebangs, Rust inner docs, `/*!`),
  `/` (`///` doc comments and TypeScript triple-slash references), `go:`,
  `export` or `extern` followed by a blank (cgo), or `line` followed by a
  blank (Go line directives), with no blank after the comment marker.
- A comment whose first word, after blanks, `*` and `/`, starts with `@`, `#`,
  `<`, `+`, `!`, `type:` or `requires`, or is `global`, `globals` or
  `exported` followed by a blank
  (JSDoc and TypeScript pragmas, `//# sourceMappingURL`, `// +build`, Python
  type comments, ESLint globals, PowerShell `#Requires`).
- A comment containing a tool or encoding marker such as `lint`, `ts-`,
  `noqa`, `nosec`, `pragma`, `coding:`, `fmt:`, `istanbul`, `prettier-`,
  `webpack`, `__PURE__`, `fallthrough`, `shellcheck`, `suppress`, `sonar`,
  `gitleaks`, `allowlist`, `vim:`, `-*-`, `DO NOT EDIT`, `#compdef` or Go's
  example `// Output:`, or a JSDoc type
  (`@` together with `{`). The list is in `DIRECTIVE_WORDS`; matching is
  case-insensitive and substring-based, so it over-matches prose that happens
  to contain a marker, which only keeps an edit gated.
- Every Rust doc comment (`///`, `//!`, `/**`, `/*!`): doc tests compile and
  run.

Suppression markers (`nosec`, `NOSONAR`, `gitleaks:allow`,
`pragma: allowlist secret`, `eslint-disable`) matter most: removing a finding
from a security scanner is not a comment edit.

## Shell scripts

Shell comments are lexed by their own rules, and the lexer gives up (the entry
is not trivial) wherever a comment could be code:

- POSIX shells: `#` starts a comment only at the start of a line or after a
  space, tab or `;`; after a letter, `$`, `{`, `=` and the like it is a word
  character (`a#b`, `$#`, `${#x}`, `${x#y}`). After `(`, `)`, `|`, `&`, `<` or
  `>` the entry is not trivial (zsh glob flags such as `(#i)`). Single quotes
  are raw and must close on the line; `$'...'` is not trivial; double quotes
  may hold `\` escapes and a `${...}` without quotes, but `$(` inside them,
  any backtick, any `<<` (heredocs, here-strings, shifts), a
  backslash before a line break, and a lone carriage return (bash reads it
  as a word character) make the entry not trivial. Only spaces and tabs
  between words are folded; `\` escapes stay code.
- PowerShell: `#` and `<# ... #>` are comments only at the start of a line or
  after a space, tab or `;`; elsewhere the entry is not trivial. `#Requires`
  and `#!` are [directive comments](#directive-comments), as in every
  language. Here-strings (`@"`, `@'`), typographic
  quotes (PowerShell accepts them as quote marks), `$(` inside a double-quoted
  string, a backtick before a line break, and a nested `<#` are not trivial.
- Batch: only `REM` lines (after optional blanks and `@`, followed by a blank
  or the end of the line) are comments; `::` labels are code, since they
  change the parser's behaviour inside blocks. A `REM` line holding `%`, `^`,
  `&`, `|`, `<`, `>`, `(` or `)`, and any line ending in `^`, are not trivial.
  Code lines are compared exactly: `echo` keeps its spacing.

Write is never trivial. In the hook, a trivial Edit (or a MultiEdit whose
entries for that file are all trivial) of an unchecked code, test or prose
target passes with an `additionalContext` note after prior-search credit and
before sibling collapse and the denial cap. It is not marked checked and does
not touch the denial count or ordinal, so the next change that alters code is
gated as a first touch; `trivial_allows` counts the passes (merged by maximum
like the other counters). The trivial pass never marks the target checked and
never applies to sensitive, instruction or config targets, so the next
non-trivial change still meets the full gate.

## File context

A snippet alone cannot show whether a comment-looking line is a comment: it
may sit inside a template literal, a docstring, a raw string or a heredoc
that opens above it, follow a line that continues onto it, or lose its line
break so the next line joins it. So an Edit is trivial only when checked
against the file it applies to.

- The hook reads the current target (never a sensitive one) itself: the path
  is resolved like every other target, opened read-only and non-blocking,
  and used only if `fstat` says it is a regular file of at most 1 MiB; CRLF
  is folded to LF, as the Edit tool does. A missing, unreadable, larger or
  special file (directory, FIFO, device) gives no file text and the edit is
  not trivial. The text is never logged, stored or put in a message.
- Each entry is applied in order, as the tool applies it, to the evolving
  text. `old_string` must be non-empty and occur exactly once, or at least
  once with `replace_all`; otherwise the tool would fail and the entry is not
  trivial. Over 1 MiB of text after an edit, more than 8 MiB of scanning for
  one call, or an edit window over 128 KiB is not trivial. A `new_string`
  holding a `String.prototype.replace` pattern (`$$`, `$&`, `` $` ``, `$'`,
  `$<`, `$` and a digit) is not trivial, in case the tool expands it.
- The edit window runs from the start of the line before the first
  occurrence to the end of the line holding the last occurrence's end
  (through the next line when `old_string` ends in a line break), so a line
  that loses or gains a break is compared joined. The window before and
  after the replacement is compared with the lexer rules above.
- The text before the window must end in plain code: not inside a comment,
  string, template literal (including `${...}`), text block, raw string,
  heredoc or here-string, and not after a line continuation (`\` in C-family,
  Python and POSIX shells, a backtick in PowerShell, `^` in batch). A
  per-language scanner decides; anything it cannot follow makes the edit not
  trivial: a JS `/` after `}` with another `/` or quote later on the line
  (regex or division), JSX in `.js`/`.jsx`/`.tsx` (`.ts`, `.mts` and `.cts`
  allow `<` generics), `<!--` and `-->`, a Python f-string whose
  replacement field holds its own quote, a comment or a line break, C#
  raw strings and interpolation holes with quotes or braces, Kotlin `${`
  inside strings, shell command substitution holding `case`, a heredoc or
  a comment, a heredoc whose terminator never comes, and nesting deeper than
  eight levels.
- Go files that import `"C"` are never trivial: the comment before the import
  is C code.

The scanner was checked against real tokenizers over this repository: every
line start it calls plain code in 801 JS files (espree) and 146 Python files
(`tokenize`) is outside strings, templates, regex literals and comments and
not a backslash continuation.

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
file (same canonical key); entries for other files do not count.

A condensed code denial names the same ids as a full one, one short phrase per
id (`condensedQuestionPhrase`), so the data and duplicate checks follow the
profile there too. The one exception is an Edit with an unknown profile, which
keeps the original hint byte for byte ("importers/callers, affected API, data
schemas if any"); a Write with an unknown profile, sensitive Writes included,
names `callers`, `no-duplicate` and `data-schema` like its full denial.

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

## Read-only first shell command

The routine shell gate asks for the user's request once per session, before
the first Bash or PowerShell command. Sessions usually open with `ls`,
`git status` or a search, which the question adds nothing to, so a command
that is only read-only introspection passes without using the gate up. The
next command that is not read-only still draws the routine denial, so the
question still comes before the first command that can change something.

- Destructive detection runs first and is unchanged; the check sits after it
  and after `GATEGUARD_BASH_ROUTINE_DISABLED`, inside the routine gate, and is
  skipped once the gate is checked. A pass returns the input unchanged,
  never marks the routine gate checked, and adds one to
  `routine_readonly_passes`.
- Character screen, quote-aware: any non-ASCII or control character (other
  than tab), an unterminated quote, or a lone `&` rejects. Bash rejects
  backslashes anywhere, `` ` `` and `$` outside single quotes, and unquoted
  `<`, `>`, `(`, `)`, `{`, `}`, so redirection, here-documents, command,
  process and parameter substitution never pass. PowerShell rejects `` ` ``
  and `$` outside single quotes and unquoted `<`, `>`, `(`, `)`, `{`, `}`,
  `@`, `[`, `]`. Non-ASCII is rejected because PowerShell treats typographic
  quotes as quotes, which the segmenter does not.
- The screened command is split by the hook's quote-aware segmenter on `;`,
  `|`, `&&` and `||`. PowerShell backslashes are doubled first, since they are
  literal there. Every segment must pass.
- Each segment's first word must be an exact allowlisted name with no `=`,
  path separator or glob character, so assignments, wrappers (`env`, `sudo`,
  `sh -c`, `xargs`), paths and unknown programs reject. Bash: `ls`, `pwd`,
  `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `fd`, `tree`, `git`.
  PowerShell (case-insensitive): `Get-ChildItem`, `Get-Content`,
  `Select-String`, `Get-Location` and their aliases, `rg`, `git`; `--%`
  rejects.
- Options that execute or write reject: `find -exec*`/`-ok*`/`-delete`/
  `-fprint*`/`-fls`, `fd -x`/`-X`/`--exec*` (also inside a short cluster),
  `rg --pre*`/`--hostname-bin`/`--search-zip`/`-z` (`-z` runs decompressors
  found on `PATH`, which older ripgrep on Windows also looked up in the
  working directory), `tree -o`/`-R` (also inside a short cluster).
- `git` takes no global options. The subcommand must be `status`, `log`,
  `diff`, `show`, `ls-files`, `rev-parse` or `branch`, and every option must
  be in that subcommand's allowlist, so `--output` (and its abbreviations),
  `--ext-diff` and `--textconv` reject. `branch` takes no positional
  argument, so it only lists.
- Over 4096 characters, a non-string command, or any exception rejects.

The earlier read-only git allowlist, which runs before destructive detection,
is unchanged.

## Idle window

Session state expires after an idle window. A state key from a real session
id (`session_id`, `CLAUDE_SESSION_ID`, `ECC_SESSION_ID`) or a transcript path
names one conversation, so its window is 8 hours: a break in a long
conversation does not re-ask the checks it already answered. The project
fingerprint fallback (`proj-` keys) can be shared by unrelated sessions in the
same directory, so it keeps 30 minutes.

Module-load pruning removes a state file idle for twice its key's window,
judged by file name: `state-proj-*` uses 30 minutes, any other key 8 hours.
A session id that itself starts with `proj-` gets the short window for both
expiry and pruning, which can only expire state sooner. Temporary files from interrupted writes
are never loaded and always use the short window.

## Subagents

File gates skip subagent calls (a non-empty string `agent_id`, `agentId`,
`parent_tool_use_id` or `parentToolUseId`): the parent was already gated on
the work it delegated, and a subagent writing many files would otherwise draw
one denial per file. Shell gates were never skipped, so a subagent can
already receive a denial, present facts and retry.

Sensitive targets are the exception. A subagent Edit, Write or MultiEdit
entry on a sensitive target is denied once per path with the full sensitive
denial, unless the parent already gated that path. Prior-search credit, the
change profile, sibling collapse and the denial cap never apply, as at top
level. The subagent's denial marks a separate subagent key, not the file's
key, so a subagent's retry never unlocks the path for the parent, whose own
first touch is still gated. The keys share the parent's state file when the
subagent's call carries the parent's session id. Exempt globs and Claude
settings files are skipped first, as at top level.

## Metrics

Decision metrics exist to show whether the gate asks the right question at the
right time: how often it denies, how often prior-search credit, sibling
collapse, trivial edits and the cap remove a denial, which questions it asks,
and how often a denial followed a search that nearly counted.

- **Opt-in.** Nothing is written unless `GATEGUARD_METRICS` is one of the
  truthy spellings the other GateGuard switches accept. The variable is read
  on every call, so it can be turned on for part of a session.
- **Codes, never content.** A line holds the schema version, time, a 12-hex
  sha256 prefix of the resolved session key (not the key itself), the tool,
  the target class, the decision, a reason code, question ids, the sensitive
  flag and the change-profile flags. Class, reason, question ids and language
  must match a short lowercase code pattern or are written as `null`, so a
  path, command, file content or transcript text cannot reach the file even
  if a caller passed one by mistake. The session digest is one-way but not
  secret: anyone holding the session id can link it to its lines.
- **One write per call.** Decisions are collected while `run()` decides and
  appended in one `appendFileSync` after it returns, including when it throws.
  A MultiEdit call writes one line per distinct file it decided. Lazily
  computed class and sensitivity for passes are only computed when metrics
  are on.
- **Never changes a decision.** Every metrics error (unwritable directory,
  a directory in place of the file, a failed rotation) is ignored, and the
  gate's result is returned unchanged.
- **No symlinks.** The file is checked with `lstat` and opened with
  `O_NOFOLLOW`; a symlink or other non-regular file in its place is left
  alone and nothing is written, so a shared state directory cannot redirect
  the append or the rotation onto another file.
- **Bounded.** When an append would take `metrics.jsonl` past 1 MiB it is
  renamed to `metrics.jsonl.1`, replacing the previous rotation, so the two
  files together stay near 2 MiB. Concurrent hooks may interleave lines or
  lose one rotation's worth of lines; the report skips anything malformed.
- **Shell denials carry no question ids.** The destructive and routine shell
  gates ask fixed questions that have no ids, so their lines have
  `questions: null`, as do all passes.
