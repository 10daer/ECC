# GateGuard evaluation

How to tell whether a change to the fact-forcing gate
(`scripts/hooks/gateguard-fact-force.js`) improves it: ask the right question
at the right time, deny less where a denial repeats work already done, and
never let a security-critical target through.

`scripts/dev/gateguard-eval.js` replays a corpus of realistic sessions against
the working-tree hook and against the hook at one or more git refs, and
compares the decisions. `tests/hooks/gateguard-scenarios.test.js` replays the
same corpus against the working tree only and fails if any step's decision
changes.

## What is measured

Every step of a scenario is one hook call. The corpus author labels each step
with the decision the gate should make and why it matters:

| Label | Meaning |
|---|---|
| `expect` | `deny` or `allow` (allow covers prior-search credit, sibling collapse, trivial edits, read-only shell commands and plain passes) |
| `mustDeny` | Security-critical: sensitive targets, bypass attempts, mutating or destructive first commands. Any allow is a bypass. |
| `redundant` | A denial here would repeat investigation the session already did (a scoped search that names the file, a same-turn sibling, a comment-only edit, a read-only first command). |
| `relevantQuestions` | For code targets, the question ids the change genuinely warrants (see the question table in [design-notes.md](design-notes.md#questions-from-the-change-profile)). |

Metrics per hook:

- **Denials**: every denial costs the agent a round trip and context.
- **Redundant denials**: denials on steps labelled `redundant`.
- **Must-deny bypasses**: allows on steps labelled `mustDeny`. Must be 0 for
  the working tree.
- **Expectation mismatches**: decisions that differ from `expect`. Must be 0
  for the working tree; for a baseline they are the behaviour the branch
  changes.
- **Irrelevant questions asked**: for denials of code targets, asked question
  ids that are not in `relevantQuestions`. Questions are read from the
  numbered list of a full denial, or from the phrases of a condensed one-line
  denial (issued after the first three denials of a session): the working
  tree's per-question phrases (`condensedQuestionPhrase`) and the fixed hint
  older hooks use. The condensed rows count the ones asked in condensed
  denials only.
- **Warranted questions not asked**: `relevantQuestions` ids a code denial did
  not ask. Asking fewer questions must not drop the ones that matter.
- **Estimated denial tokens**: characters of all denial reasons divided by 4.
- **Allows with a note**: how the working tree avoided a denial.
- **Hook latency p50/p95**: wall time of `run()` per step, in process. The
  only non-deterministic metric.

Each scenario runs in its own temp project (files and symlinks created from
the fixture), with its own transcript, `GATEGUARD_STATE_DIR`, `HOME` and a
clean environment (`PATH`, `CLAUDE_PROJECT_DIR`, plus the scenario's `env`),
in a fresh worker thread, so module state and state files never leak between
scenarios or hooks. A baseline hook is materialised from `git show
<ref>:scripts/hooks/gateguard-fact-force.js` plus every file it requires
relatively at that ref, into a temp tree that mirrors the repo layout.

## Results

Working tree = branch `gateguard-full`; `upstream/main` = `bd9402f7`;
`58a4a0d0` = the pull request head before this round. Node 22, Linux.

```text
Corpus: 18 scenarios, 172 steps.
```

| Metric | working tree | upstream/main | 58a4a0d0 |
| --- | ---: | ---: | ---: |
| Steps | 172 | 172 | 172 |
| Denials | 124 | 152 | 130 |
| Redundant denials | 0 | 36 | 16 |
| Must-deny bypasses | 0 | 5 | 5 |
| Expectation mismatches | 0 | 48 | 26 |
| Irrelevant questions asked | 2 | 181 | 146 |
| Irrelevant questions in condensed denials | 2 | 105 | 84 |
| Warranted questions not asked | 1 | 55 | 42 |
| Estimated denial tokens | 23584 | 26724 | 24549 |
| Allows with a credit note | 9 | 0 | 8 |
| Allows with a sibling note | 11 | 0 | 11 |
| Allows with a trivial-edit note | 5 | 0 | 0 |
| Hook latency p50 (ms) | 1.71 | 0.86 | 1.45 |
| Hook latency p95 (ms) | 7.89 | 2.95 | 5.99 |

| Scenario | Steps | Denials: working tree | Denials: upstream/main | Denials: 58a4a0d0 |
| --- | ---: | ---: | ---: | ---: |
| docs-heavy-session | 14 | 6 | 12 | 6 |
| scaffold-module | 10 | 3 | 10 | 3 |
| bugfix-after-scoped-search | 6 | 1 | 3 | 2 |
| cold-writes | 5 | 3 | 4 | 3 |
| exported-api-edits | 6 | 6 | 6 | 6 |
| internal-only-edits | 5 | 4 | 4 | 4 |
| data-handling-edits | 5 | 5 | 5 | 5 |
| comment-only-edits | 10 | 6 | 9 | 9 |
| sensitive-targets | 8 | 8 | 8 | 8 |
| subagent-edits | 6 | 3 | 1 | 1 |
| first-shell-commands | 20 | 11 | 17 | 17 |
| windows-paths | 8 | 5 | 7 | 5 |
| bypass-search-filters | 17 | 14 | 17 | 14 |
| bypass-turn-and-batch | 7 | 7 | 7 | 7 |
| bypass-siblings | 11 | 11 | 11 | 11 |
| cap-with-sensitive | 6 | 4 | 6 | 4 |
| bypass-comment-context | 22 | 21 | 19 | 19 |
| exported-members | 6 | 6 | 6 | 6 |

### Reading the results

Against `upstream/main`:

- 18% fewer denials (152 to 124) and 12% fewer denial tokens, with every
  redundant denial in the corpus gone (36 to 0).
- All five must-deny bypasses closed: `upstream/main` lets a subagent edit
  `src/auth/oauth.js` and `config/secrets.yaml` without a question, and never
  gates a MultiEdit call that names its file in `tool_input.file_path` (the
  tool's own shape), so `.env`, `config/.env.local` from a subagent and a
  first-touch code file all pass.
- Irrelevant questions drop from 181 to 2 and warranted-but-unasked from 55
  to 1: edits without a public-surface line ask for local call sites instead
  of importers, members of exported interfaces, enums, export lists,
  dataclasses and `pub` enums keep the importer questions, the data-schema
  question is asked only when the change touches data, and condensed denials
  name the same questions as full ones.
- Denials rise only where they should: the subagent's first touch of a
  sensitive file, MultiEdit calls, the first mutating shell command after a
  read-only one (`upstream/main` spends its once-per-session routine gate on
  `ls`), and the first code-changing edit after a comment-only one (the
  comment edit no longer spends the file's first touch).

Against `58a4a0d0` (the pull request head before this round): 6 fewer
denials net. The first 16 scenarios account for 8 fewer (3 in the
comment-only scenario, 6 from read-only first shell commands and 1 from the
test edit credited by its stem, less 2 more for subagent edits of sensitive
files); `bypass-comment-context` adds 2 (three MultiEdit calls now gated, one
comment edit passed). Redundant denials drop from 16 to 0, all five bypasses
close, and irrelevant questions drop from 146 to 2.

The security review of this round's allowances added two scenarios.
`bypass-comment-context` holds 21 must-deny steps: comment-looking edits that
change code in their file (a comment line after a continued C macro, a line
break dropped so the next line joins a comment, lines inside a template
literal, a docstring and a heredoc, a snippet that starts inside a string,
`replace_all` reaching a string), directive comments (shebang, encoding
cookie, `# type:`, `# nosec`, `@ts-expect-error`, `eslint-disable`,
`//go:build`, `//go:embed`, a cgo preamble, a Rust doc test), MultiEdit calls
naming their file once, and `rg -z` as a first shell command; plus one
comment edit below closed templates and regexes that should still pass.
Before the fixes the branch let 20 of those 21 through (every edit and
`rg -z` as a trivial or read-only pass, and the three MultiEdit calls);
`upstream/main` and `58a4a0d0` let the three MultiEdit calls through.
`exported-members` holds six member edits whose container declaration sits
outside the snippet; before the fixes the branch asked for local call sites
on the five public ones (5 irrelevant questions, 10 warranted ones not asked).

What the working tree still gets wrong, by the corpus's own labels:

- Sensitive targets are never profiled, so a sensitive code Write always asks
  the data-schema question (`symlinked-auth-first`, `symlinked-auth-sibling`:
  the 2 irrelevant questions).
- The C edit that turns a declaration into a comment continuation
  (`c-comment-continuation`) has no data words, so the condensed hint no
  longer mentions data schemas; the corpus labels that question as warranted
  (the 1 unasked one).
- Latency roughly doubles against `upstream/main` (p50 about 2 ms, p95 about
  8 ms) with the added transcript scanning and path resolution; both stay far
  below the 200 ms budget for blocking hooks. Checking a comment-only edit
  reads and scans the target file, which costs up to about 50 ms for a 1 MiB
  file (the largest one read).

## Reproduce

```bash
git fetch upstream main
node scripts/dev/gateguard-eval.js --markdown
node scripts/dev/gateguard-eval.js --markdown --baseline upstream/main --baseline 58a4a0d0
node scripts/dev/gateguard-eval.js --json > gateguard-eval.json
node tests/hooks/gateguard-scenarios.test.js
```

`--baseline <ref>` takes any ref and can be repeated (default
`upstream/main`); pass the pull request head (`58a4a0d0` above) to compare
against it. `--corpus <dir>` points at another
scenario directory. The script exits non-zero when the working tree has a
mismatch, a must-deny bypass, an explicit `allow` decision or a thrown error.

## Corpus format

One JSON file per scenario in `tests/fixtures/gateguard-scenarios/`:

- `name`, `description`;
- `files` (project-relative path to content), optional `dirs` and `symlinks`
  (link path to target, relative to the link), created in a temp project;
- optional `root` (a fixed project path, used for Windows-style paths, where
  nothing is created on disk) and `env` (extra environment variables);
- `steps`, in order. Each step has an `id`, an optional `note`, the
  `transcript` records appended to the session transcript before the call
  (human prompts with `promptId`, assistant `tool_use` records with
  `message.id`, `tool_result` records, compaction boundaries, and the pending
  call's own `tool_use` record), the hook `payload`, and the labels above.

`{{root}}` and `{{transcript}}` in any string are replaced with the temp
project and transcript paths. Transcripts are the same for every hook: a
step's call is assumed to succeed eventually, so the next step's records start
with its `tool_result`.

A scenario with `symlinks` is skipped (and reported) where symlinks cannot be
created, such as Windows without the privilege.

## Limits

- The corpus is synthetic. Sessions were written to resemble real ones, not
  sampled from them, so the denial counts show the direction and size of a
  change, not rates to expect in the field. Opt-in metrics
  (`GATEGUARD_METRICS=1` and `scripts/gateguard-report.js`) measure real
  sessions.
- The labels are the corpus author's judgement, made with the design in mind.
  `redundant` and `relevantQuestions` in particular are opinions: a different
  author could call the README or CHANGELOG edits after a docs-wide search
  redundant, or leave out the data-schema question for
  `c-comment-continuation`.
  Zero redundant denials means the working tree handles the cases this author
  judged redundant, not that it never repeats a question.
- Question relevance is read from denial text. Condensed denials are mapped by
  phrase, and a hedged phrase ("data schemas if any") counts as asked.
- A baseline sees the same transcript as the working tree even where it would
  have denied an earlier call; retries are not modelled, and a denied call's
  retry is assumed to pass.
- The routine shell gate is once per session, so a baseline that spent it on
  a read-only command shows an allow on a later mutating command. That counts
  as a mismatch, not a bypass (`mustDeny` is set only where the baseline's own
  gate should also deny).
- Windows-style paths run lexically on non-Windows hosts; realpath and symlink
  behaviour for them is not exercised.
- Latency is measured in process for `run()` only (no Node start-up), on the
  machine that ran the evaluation.
