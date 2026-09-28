'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const repoRoot = path.resolve(__dirname, '..', '..');
const workflowPaths = [
  '.github/workflows/release.yml',
  '.github/workflows/reusable-release.yml',
];
const {
  createGithubClient,
  requiredEnvironment,
  verifySignedAnnotatedTag,
  waitForExactShaGates,
} = require('../../scripts/ci/verify-release-gates.js');
const lifecycleRunnerSource = load('tests/ci/packed-artifact-lifecycle.js');

let passed = 0;
let failed = 0;
let pendingTests = Promise.resolve();

function test(name, fn) {
  pendingTests = pendingTests.then(async () => {
    try {
      await fn();
      pass(name);
    } catch (error) {
      fail(name, error);
    }
  });
}

function pass(name) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}

function fail(name, error) {
  console.log(`  ✗ ${name}`);
  console.log(`    Error: ${error.message}`);
  failed += 1;
}

function load(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function jobBlock(source, jobName, nextJobName) {
  const startMarker = `\n  ${jobName}:\n`;
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${jobName} job`);

  if (!nextJobName) {
    return source.slice(start);
  }

  const end = source.indexOf(`\n  ${nextJobName}:\n`, start + startMarker.length);
  assert.ok(end > start, `missing ${nextJobName} job after ${jobName}`);
  return source.slice(start, end);
}

console.log('\n=== Testing packed-artifact release workflows ===\n');

for (const workflowPath of workflowPaths) {
  const source = load(workflowPath);

  test(`${workflowPath} verifies signed tags and exact-SHA CI gates before building`, () => {
    const verify = jobBlock(source, 'verify', 'lifecycle');
    const workflow = yaml.load(source);
    const verifyJob = workflow.jobs.verify;
    const gateStep = verifyJob.steps.find(
      step => step.name === 'Verify signed tag and exact-SHA CI gates'
    );
    const gateIndex = verify.indexOf('name: Verify signed tag and exact-SHA CI gates');
    const installIndex = verify.indexOf('name: Install dependencies');
    const effectivePermissions = verifyJob.permissions || workflow.permissions || {};

    assert.ok(gateIndex >= 0, 'missing release provenance gate');
    assert.ok(installIndex > gateIndex, 'release provenance must be verified before dependencies run');
    assert.ok(gateStep, 'missing named release provenance gate step');
    assert.match(gateStep.run, /node scripts\/ci\/verify-release-gates\.js/);
    assert.match(gateStep.run, /RELEASE_SHA=/);
    assert.ok(gateStep.env?.RELEASE_TAG, 'gate step must receive RELEASE_TAG');
    assert.strictEqual(effectivePermissions.actions, 'read');
    assert.strictEqual(effectivePermissions.checks, 'read');
  });

  test(`${workflowPath} packs once and exports the package name and SHA-256`, () => {
    assert.strictEqual(
      (source.match(/npm pack --json/g) || []).length,
      1,
      'release workflow must pack exactly once'
    );
    assert.match(source, /package_sha256:\s*\$\{\{ steps\.pack\.outputs\.package_sha256 \}\}/);
    assert.match(source, /createHash\(['"]sha256['"]\)/);
    assert.match(source, /package_sha256=['"]? \+ digest/);
  });

  test(`${workflowPath} invokes only test files present in the release source`, () => {
    const referencedTests = [...source.matchAll(/\bnode (tests\/[A-Za-z0-9_./-]+\.js)\b/g)]
      .map(match => match[1]);
    assert.ok(referencedTests.length > 0, 'release workflow should run repository tests');
    for (const testPath of referencedTests) {
      assert.ok(fs.existsSync(path.join(repoRoot, testPath)), `missing workflow test: ${testPath}`);
    }
  });

  test(`${workflowPath} selects reviewed release notes from the validated release version`, () => {
    const verify = jobBlock(source, 'verify', 'lifecycle');

    assert.match(verify, /RELEASE_VERSION="\$\{RELEASE_TAG#v\}"/);
    assert.match(
      verify,
      /RELEASE_NOTES="docs\/releases\/\$\{RELEASE_VERSION\}\/release-notes\.md"/
    );
    assert.match(verify, /if \[ ! -f "\$RELEASE_NOTES" \]/);
    assert.match(verify, /cp "\$RELEASE_NOTES" release_body\.md/);
    assert.doesNotMatch(
      verify,
      /cp docs\/releases\/2\.2\.0\/release-notes\.md/,
      'release workflows must not reuse 2.2.0 notes for later versions'
    );
  });

  test(`${workflowPath} disables generated additions to reviewed release notes`, () => {
    const publish = jobBlock(source, 'publish');
    assert.match(
      publish,
      /body_path:\s*release_body\.md[\s\S]{0,160}generate_release_notes:\s*false/
    );
    assert.doesNotMatch(publish, /generate_release_notes:\s*(?:true|\$\{\{)/);
  });

  test(`${workflowPath} uploads the one packed tgz as the release artifact`, () => {
    const verify = jobBlock(source, 'verify', 'lifecycle');
    const packIndex = verify.indexOf('name: Pack npm artifact');
    const uploadIndex = verify.indexOf('name: Upload release artifacts');

    assert.ok(packIndex >= 0, 'missing pack step');
    assert.ok(uploadIndex > packIndex, 'artifact upload must happen after pack and hash');
    assert.match(verify, /name:\s*ecc-release-artifacts/);
    assert.match(verify, /\$\{\{ steps\.pack\.outputs\.package_file \}\}/);
    assert.match(verify, /tests\/ci\/packed-artifact-lifecycle\.js/);
  });

  test(`${workflowPath} fails retries when npm already has different bytes`, () => {
    const verify = jobBlock(source, 'verify', 'lifecycle');
    assert.match(verify, /name:\s*Verify existing npm artifact matches candidate/);
    assert.match(verify, /if:\s*steps\.npm_publish_state\.outputs\.already_published == 'true'/);
    assert.match(verify, /npm view "\$\{PACKAGE_NAME\}@\$\{PACKAGE_VERSION\}" dist\.integrity/);
    assert.match(verify, /createHash\(['"]sha512['"]\)/);
    assert.match(verify, /Existing npm artifact does not match tested candidate/);
  });

  test(`${workflowPath} verifies the same tgz on Node 20 across three operating systems`, () => {
    const lifecycle = jobBlock(source, 'lifecycle', 'publish');

    assert.match(lifecycle, /needs:\s*verify/);
    assert.match(lifecycle, /os:\s*\[ubuntu-latest, macos-latest, windows-latest\]/);
    assert.match(lifecycle, /runs-on:\s*\$\{\{ matrix\.os \}\}/);
    assert.match(lifecycle, /node-version:\s*['"]20\.x['"]/);
    assert.match(lifecycle, /uses:\s*actions\/download-artifact@/);
    assert.match(lifecycle, /name:\s*ecc-release-artifacts/);
    assert.match(lifecycle, /ECC_RELEASE_PACKAGE:\s*release-artifacts\/\$\{\{ needs\.verify\.outputs\.package_file \}\}/);
    assert.match(lifecycle, /ECC_RELEASE_SHA256:\s*\$\{\{ needs\.verify\.outputs\.package_sha256 \}\}/);
    assert.match(lifecycle, /node release-artifacts\/tests\/ci\/packed-artifact-lifecycle\.js/);
    assert.doesNotMatch(lifecycle, /actions\/checkout@/);
    assert.doesNotMatch(lifecycle, /\bsecrets\s*:/, 'lifecycle job must not receive secrets');
    assert.doesNotMatch(lifecycle, /\$\{\{\s*secrets\./, 'lifecycle job must not reference secrets');
  });

  test(`${workflowPath} blocks publishing on packed-artifact lifecycle success`, () => {
    const publish = jobBlock(source, 'publish');

    assert.match(publish, /needs:\s*\[verify, lifecycle\]/);
    assert.match(publish, /ECC_RELEASE_PACKAGE:\s*\$\{\{ needs\.verify\.outputs\.package_file \}\}/);
    assert.match(publish, /npm publish "\.\/\$\{ECC_RELEASE_PACKAGE\}"/);
    assert.match(publish, /name:\s*Verify artifact before publish/);
    assert.match(publish, /ECC_RELEASE_SHA256:\s*\$\{\{ needs\.verify\.outputs\.package_sha256 \}\}/);
    assert.match(publish, /createHash\(['"]sha256['"]\)/);
    assert.match(publish, /ecc-universal-\[0-9A-Za-z\.\+-\]/);
    assert.ok(
      publish.indexOf('name: Verify artifact before publish')
        < publish.indexOf('name: Create GitHub Release'),
      'publish must verify the independently downloaded archive before creating the release'
    );
  });
}

// Synthetic repository facts mirror the trusted workflow/attempt API contracts.
const releaseSha = 'a'.repeat(40);
const tagSha = 'b'.repeat(40);
const repository = 'affaan-m/ECC';
const inputs = { repository, releaseSha, releaseTag: 'v1.2.3', token: 'synthetic-token' };
const repoIdentity = { id: 1136590548, full_name: repository, default_branch: 'main' };
const requiredNames = ['Analyze (actions)', 'Analyze (javascript-typescript)', 'Analyze (python)'];
const workflows = [
  { id: 228254391, path: '.github/workflows/ci.yml', state: 'active' },
  { id: 292501745, path: 'dynamic/github-code-scanning/codeql', state: 'active' },
];
function fixture() {
  const runs = workflows.map((workflow, index) => ({
    id: 10 + index, workflow_id: workflow.id, path: workflow.path,
    head_sha: releaseSha, head_branch: 'main', event: index ? 'dynamic' : 'push',
    run_attempt: 1, check_suite_id: 100 + index, status: 'completed', conclusion: 'success',
    repository: { ...repoIdentity }, head_repository: { ...repoIdentity },
  }));
  const checks = requiredNames.map((name, index) => ({
    id: 200 + index, name, head_sha: releaseSha, status: 'completed', conclusion: 'success',
    check_suite: { id: 101 }, app: { id: 15368, slug: 'github-actions' },
  }));
  const jobs = checks.map(check => ({
    id: check.id, name: check.name, run_id: 11, run_attempt: 1,
    head_sha: releaseSha, head_branch: 'main', status: 'completed', conclusion: 'success',
    check_run_url: `https://api.github.com/repos/${repository}/check-runs/${check.id}`,
  }));
  return { runs, checks, jobs, workflows: structuredClone(workflows), repo: { ...repoIdentity } };
}
function response(payload, link = null) {
  return { ok: true, status: 200, headers: { get: () => link }, json: async () => payload };
}
function fakeApi(data = fixture(), modify = () => null) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    const replacement = modify(url, options, calls);
    if (replacement) return replacement;
    const pathname = new URL(url).pathname.replace(`/repos/${repository}`, '');
    if (pathname === '') return response(data.repo);
    if (pathname === '/actions/workflows') return response({ total_count: data.workflows.length, workflows: data.workflows });
    if (pathname === '/actions/runs') return response({ total_count: data.runs.length, workflow_runs: data.runs });
    if (pathname === '/actions/runs/11/attempts/1/jobs') return response({ total_count: data.jobs.length, jobs: data.jobs });
    if (pathname === '/check-suites/101/check-runs') return response({ total_count: data.checks.length, check_runs: data.checks });
    if (pathname === '/git/ref/tags/v1.2.3') return response({ ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: tagSha } });
    if (pathname === `/git/tags/${tagSha}`) return response({ sha: tagSha, tag: 'v1.2.3', object: { type: 'commit', sha: releaseSha }, verification: { verified: true, reason: 'valid' } });
    throw new Error(`Unexpected synthetic API path ${pathname}`);
  };
  return { fetchImpl, calls };
}
const once = { attempts: 1, timeoutMs: 1000, requestTimeoutMs: 100 };
async function gates(data, modify) {
  const api = fakeApi(data, modify);
  await waitForExactShaGates(inputs, api.fetchImpl, async () => {}, once);
  return api.calls;
}

test('pre-install verifier loads with built-ins only and still rejects malformed responses', async () => {
  const vm = require('node:vm');
  const { isBuiltin } = require('node:module');
  const exported = {};
  const localModule = { exports: exported };
  vm.runInNewContext(load('scripts/ci/verify-release-gates.js'), {
    module: localModule, exports: exported,
    require: name => { assert.ok(isBuiltin(name), `pre-install dependency: ${name}`); return require(name); },
    process: { env: {} }, URL, AbortController, setTimeout, clearTimeout, fetch: () => { throw new Error('Unexpected live fetch'); },
  });
  await assert.rejects(localModule.exports.verifySignedAnnotatedTag(inputs, async () => response({ object: { type: 'tag' } })), /validation|Invalid/);
  assert.strictEqual(await localModule.exports.verifySignedAnnotatedTag(inputs, fakeApi().fetchImpl), tagSha);
  await localModule.exports.waitForExactShaGates(inputs, fakeApi().fetchImpl, async () => {}, once);
});

test('complete trusted CI and default CodeQL categories pass without display-name trust', async () => {
  const data = fixture();
  data.runs[0].name = 'Renamed CI';
  data.runs[1].name = 'Push on main';
  const calls = await gates(data);
  assert.ok(calls.some(url => url.includes('/attempts/1/jobs')));
  assert.ok(calls.some(url => url.includes('/check-suites/101/check-runs')));
});

for (const [name, mutate] of [
  ['impostor CI workflow', d => { d.runs[0].workflow_id = 999; d.runs[0].name = 'CI'; }],
  ['wrong workflow path', d => { d.runs[0].path = '.github/workflows/spoof.yml'; }],
  ['wrong CI event', d => { d.runs[0].event = 'pull_request'; }],
  ['wrong main branch', d => { d.runs[0].head_branch = 'release/x'; }],
  ['wrong run SHA', d => { d.runs[0].head_sha = 'c'.repeat(40); }],
  ['foreign run repository', d => { d.runs[0].repository.id = 1; }],
  ['foreign head repository', d => { d.runs[0].head_repository.full_name = 'impostor/ECC'; }],
  ['untrusted check app', d => { d.checks[0].app.id = 1; }],
  ['wrong app slug', d => { d.checks[0].app.slug = 'spoof'; }],
  ['wrong check suite', d => { d.checks[0].check_suite.id = 999; }],
  ['wrong check SHA', d => { d.checks[0].head_sha = 'c'.repeat(40); }],
  ['missing required category', d => { d.jobs.pop(); }],
  ['missing bound check', d => { d.checks.pop(); }],
  ['new pending category', d => { d.jobs.push({ ...d.jobs[0], id: 999, name: 'Analyze (ruby)', status: 'queued', conclusion: null }); }],
  ['ambiguous category jobs', d => { d.jobs.push({ ...d.jobs[0], id: 999 }); }],
  ['wrong attempt job', d => { d.jobs[0].run_attempt = 2; }],
  ['wrong run job', d => { d.jobs[0].run_id = 90; }],
  ['wrong job branch', d => { d.jobs[0].head_branch = 'feature'; }],
  ['foreign check URL', d => { d.jobs[0].check_run_url = 'https://api.github.com/repos/spoof/ECC/check-runs/200'; }],
  ['job name does not match bound check', d => { d.checks[0].name = 'CodeQL'; }],
  ['ambiguous workflow metadata', d => { d.workflows.push({ ...d.workflows[0], id: 999 }); }],
  ['inactive trusted workflow', d => { d.workflows[0].state = 'disabled_manually'; }],
]) {
  test(`release gate rejects ${name}`, async () => {
    const data = fixture(); mutate(data);
    await assert.rejects(gates(data));
  });
}

for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required']) {
  test(`required trusted check ${conclusion} fails despite newer spoof success`, async () => {
    const data = fixture();
    data.checks[0].conclusion = conclusion;
    data.checks.push({ ...data.checks[0], id: 999, conclusion: 'success', app: { id: 1, slug: 'spoof' } });
    await assert.rejects(gates(data), /concluded/);
  });
}

test('newer display-name impostor cannot replace a failed trusted CI run', async () => {
  const data = fixture(); data.runs[0].conclusion = 'failure';
  data.runs.push({ ...data.runs[0], id: 999, workflow_id: 999, name: 'CI', conclusion: 'success' });
  await assert.rejects(gates(data), /CI concluded failure/);
});

test('workflow IDs come from exact-path metadata and unrelated spoof results do not gate', async () => {
  const data = fixture();
  data.workflows.forEach((workflow, index) => { workflow.id = 900 + index; data.runs[index].workflow_id = workflow.id; });
  data.runs.push({ ...data.runs[0], id: 999, workflow_id: 999, name: 'CI', conclusion: 'failure' });
  data.checks.push({ ...data.checks[0], id: 999, conclusion: 'failure', app: { id: 1, slug: 'spoof' } });
  await gates(data);
});

test('newer trusted pending run does not reuse older success', async () => {
  const data = fixture();
  data.runs.push({ ...data.runs[1], id: 12, status: 'queued', conclusion: null });
  await assert.rejects(gates(data), /Timed out|deadline/);
});

test('newer trusted attempt cannot reuse previous attempt jobs', async () => {
  const data = fixture();
  data.runs[1].run_attempt = 2;
  await assert.rejects(gates(data, url => url.includes('/attempts/2/jobs') ? response({ total_count: 2, jobs: data.jobs.slice(0, 2).map(job => ({ ...job, run_attempt: 2 })) }) : null));
});

test('a new trusted run appearing during collection fails readiness', async () => {
  const data = fixture(); let runReads = 0;
  await assert.rejects(gates(data, url => {
    if (url.includes('/actions/runs?') && ++runReads === 2) {
      return response({ total_count: 3, workflow_runs: [...data.runs, { ...data.runs[1], id: 12, status: 'queued', conclusion: null }] });
    }
    return null;
  }), /Timed out|deadline/);
});

test('failure on a later check page cannot be hidden', async () => {
  const data = fixture(); data.checks[2].conclusion = 'failure';
  await assert.rejects(gates(data, url => {
    if (!url.includes('/check-runs?')) return null;
    return url.includes('page=2')
      ? response({ total_count: 3, check_runs: data.checks.slice(2) })
      : response({ total_count: 3, check_runs: data.checks.slice(0, 2) }, `<${url}&page=2>; rel="next"`);
  }), /concluded failure/);
});

test('API requests reject redirects and carry abort signals without dependency loading', async () => {
  const api = fakeApi(fixture(), (_url, options) => {
    assert.strictEqual(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return null;
  });
  await verifySignedAnnotatedTag(inputs, api.fetchImpl);
});

test('release input and retry bounds reject unsafe or unbounded values', () => {
  const env = { GITHUB_REPOSITORY: repository, RELEASE_SHA: releaseSha, RELEASE_TAG: 'v1.2.3', GITHUB_TOKEN: inputs.token };
  assert.strictEqual(requiredEnvironment(env).releaseSha, releaseSha);
  for (const change of [
    { GITHUB_REPOSITORY: '../ECC' }, { RELEASE_SHA: 'short' },
    { RELEASE_TAG: 'v1.2.3\nextra' }, { GITHUB_TOKEN: '' }, { RELEASE_TAG_OBJECT_SHA: 'bad' },
  ]) assert.throws(() => requiredEnvironment({ ...env, ...change }));
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 600001 }, { requestTimeoutMs: 15001 }]) {
    assert.throws(() => createGithubClient(inputs, fakeApi().fetchImpl, options), /limits/);
  }
});

test('an aborted global deadline covers a stalled retry sleep', async () => {
  const data = fixture(); data.runs[0].status = 'queued'; data.runs[0].conclusion = null;
  let signal;
  await assert.rejects(waitForExactShaGates(inputs, fakeApi(data).fetchImpl, (_delay, provided) => {
    signal = provided;
    assert.ok(signal instanceof AbortSignal, 'abort signal required');
    return new Promise(() => {});
  }, { attempts: 2, timeoutMs: 20, requestTimeoutMs: 10 }), /deadline/);
  assert.strictEqual(signal.aborted, true);
});

test('signed annotated tag binds full ref, object SHA, name and direct commit', async () => {
  assert.strictEqual(await verifySignedAnnotatedTag(inputs, fakeApi().fetchImpl), tagSha);
});
for (const [name, pathPart, mutate] of [
  ['different ref', '/git/ref/', p => { p.ref = 'refs/tags/v0.0.0'; }],
  ['lightweight tag', '/git/ref/', p => { p.object.type = 'commit'; }],
  ['malformed object SHA', '/git/ref/', p => { p.object.sha = 'bad'; }],
  ['wrong signed name', '/git/tags/', p => { p.tag = 'v0.0.0'; }],
  ['wrong returned object SHA', '/git/tags/', p => { p.sha = 'c'.repeat(40); }],
  ['unverified signature', '/git/tags/', p => { p.verification.verified = false; }],
  ['invalid verification reason', '/git/tags/', p => { p.verification.reason = 'unsigned'; }],
  ['nested tag', '/git/tags/', p => { p.object.type = 'tag'; }],
  ['wrong target commit', '/git/tags/', p => { p.object.sha = 'c'.repeat(40); }],
]) {
  test(`signed tag rejects ${name}`, async () => {
    const base = fakeApi();
    await assert.rejects(verifySignedAnnotatedTag(inputs, async (url, options) => {
      const result = await base.fetchImpl(url, options);
      const payload = await result.json();
      if (url.includes(pathPart)) mutate(payload);
      return response(payload);
    }));
  });
}

test('final tag-only recheck requires the original verified object SHA', async () => {
  await assert.rejects(verifySignedAnnotatedTag({ ...inputs, tagObjectSha: 'c'.repeat(40) }, fakeApi().fetchImpl), /changed/);
  const api = fakeApi();
  assert.strictEqual(await verifySignedAnnotatedTag({ ...inputs, tagObjectSha: tagSha }, api.fetchImpl), tagSha);
  assert.strictEqual(api.calls.length, 2);
});

for (const [name, link] of [
  ['self loop', url => `<${url}>; rel="next"`],
  ['foreign host', () => '<https://evil.invalid/repos/affaan-m/ECC/actions/workflows?page=2>; rel="next"'],
  ['foreign repository', () => '<https://api.github.com/repos/other/ECC/actions/workflows?page=2>; rel="next"'],
  ['foreign endpoint', () => '<https://api.github.com/repos/affaan-m/ECC/actions/runs?per_page=100&page=2>; rel="next"'],
  ['changed query', url => `<${url.replace('per_page=100', 'per_page=1')}&page=2>; rel="next"`],
  ['malformed next', () => 'not-a-link; rel="next"'],
  ['duplicate next', url => `<${url}&page=2>; rel="next", <${url}&page=3>; rel="next"`],
]) {
  test(`API pagination rejects ${name}`, async () => {
    let requests = 0;
    await assert.rejects(gates(fixture(), url => {
      if (!url.includes('/actions/workflows?')) return null;
      requests += 1;
      assert.ok(requests <= 2, 'pagination must terminate');
      return response({ total_count: 2, workflows }, link(url));
    }));
    assert.ok(requests <= 2);
  });
}

test('API pagination rejects two-page cycles and incomplete totals', async () => {
  const first = `https://api.github.com/repos/${repository}/actions/workflows?per_page=100`;
  await assert.rejects(gates(fixture(), url => url.includes('/actions/workflows?')
    ? response({ total_count: 4, workflows: url.includes('page=2') ? workflows.map(workflow => ({ ...workflow, id: workflow.id + 2 })) : workflows }, `<${url.includes('page=2') ? first : first + '&page=2'}>; rel="next"`) : null), /cycle/);
  await assert.rejects(gates(fixture(), url => url.includes('/actions/workflows?')
    ? response({ total_count: 3, workflows }) : null), /complete|total/);
});

test('API page and item caps fail closed', async () => {
  await assert.rejects(gates(fixture(), url => url.includes('/actions/workflows?')
    ? response({ total_count: 1001, workflows }) : null), /cap|limit/);
  await assert.rejects(gates(fixture(), url => url.includes('/actions/workflows?')
    ? response({ total_count: 101, workflows: Array.from({ length: 101 }, (_, id) => ({ ...workflows[0], id: id + 1 })) }) : null), /cap|limit/);
  let page = 0;
  await assert.rejects(gates(fixture(), url => url.includes('/actions/workflows?')
    ? response({ total_count: 20, workflows: [{ ...workflows[0], id: ++page }] }, `<https://api.github.com/repos/${repository}/actions/workflows?per_page=100&page=${page + 1}>; rel="next"`) : null), /cap|limit/);
  assert.ok(page <= 10);
});

for (const status of [403, 500]) {
  test(`API ${status} fails without leaking the token`, async () => {
    await assert.rejects(gates(fixture(), () => ({ ok: false, status })), error => {
      assert.match(error.message, new RegExp(String(status)));
      assert.ok(!error.message.includes(inputs.token)); return true;
    });
  });
}

test('invalid JSON and malformed collection shapes fail closed', async () => {
  await assert.rejects(gates(fixture(), () => ({ ...response(null), json: async () => { throw new Error('invalid JSON'); } })), /JSON/);
  await assert.rejects(gates(fixture(), url => url.includes('/actions/workflows?') ? response({ workflows: 'wrong', total_count: 2 }) : null), /validation|Invalid/);
});

test('stalled headers and response bodies are aborted by the request deadline', async () => {
  for (const body of [false, true]) {
    let signal;
    const never = () => new Promise(() => {});
    await assert.rejects(verifySignedAnnotatedTag(inputs, async (_url, options) => {
      signal = options.signal;
      assert.ok(signal instanceof AbortSignal, 'abort signal required');
      return body ? { ...response(null), json: never } : never();
    }, { timeoutMs: 100, requestTimeoutMs: 5 }), /deadline|timed out/);
    assert.strictEqual(signal.aborted, true);
  }
});

test('global deadline includes retries and prevents further requests', async () => {
  const data = fixture(); data.runs[0].status = 'queued'; data.runs[0].conclusion = null;
  let clock = 0; let sleeps = 0;
  await assert.rejects(waitForExactShaGates(inputs, fakeApi(data).fetchImpl, async delay => { clock += delay; sleeps += 1; }, {
    attempts: 5, delayMs: 10, timeoutMs: 15, requestTimeoutMs: 10, now: () => clock,
  }), /deadline/);
  assert.strictEqual(sleeps, 2);
});

for (const workflowPath of workflowPaths) {
  test(`${workflowPath} rechecks captured tag identity immediately before publication`, () => {
    const workflow = yaml.load(load(workflowPath));
    const verify = workflow.jobs.verify;
    assert.strictEqual(verify.outputs.release_sha, '${{ steps.release_gate.outputs.release_sha }}');
    assert.strictEqual(verify.outputs.tag_object_sha, '${{ steps.release_gate.outputs.tag_object_sha }}');
    assert.strictEqual(verify.steps.find(step => step.name === 'Verify signed tag and exact-SHA CI gates').id, 'release_gate');
    const publish = workflow.jobs.publish;
    assert.deepStrictEqual(publish.permissions, { contents: 'write', 'id-token': 'write' });
    const checkout = publish.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.strictEqual(checkout.with.ref, '${{ needs.verify.outputs.release_sha }}');
    assert.strictEqual(checkout.with['persist-credentials'], false);
    assert.strictEqual(checkout.with.path, 'release-gate-source');
    const index = publish.steps.findIndex(step => step.name === 'Recheck verified tag before publish');
    assert.ok(index > 0);
    assert.strictEqual(publish.steps[index + 1].name, 'Publish npm package');
    const gate = publish.steps[index];
    assert.strictEqual(gate.env.RELEASE_SHA, '${{ needs.verify.outputs.release_sha }}');
    assert.strictEqual(gate.env.RELEASE_TAG_OBJECT_SHA, '${{ needs.verify.outputs.tag_object_sha }}');
    assert.match(gate.run, /^node release-gate-source\/scripts\/ci\/verify-release-gates\.js --tag-only$/);
    assert.doesNotMatch(JSON.stringify(publish), /npm ci|npm install|actions:read|checks:read/);
  });
}

test('reusable release requires its input to resolve through the tag namespace', () => {
  const source = load('.github/workflows/reusable-release.yml');
  const verify = jobBlock(source, 'verify', 'lifecycle');
  assert.match(verify, /ref:\s*refs\/tags\/\$\{\{ inputs\.tag \}\}/);
});

test('pull-request CI packs once and exports the exact installer artifact identity', () => {
  const source = load('.github/workflows/ci.yml');
  const pack = jobBlock(source, 'pack-installer', 'packed-install-lifecycle');
  assert.strictEqual((pack.match(/npm pack --json/g) || []).length, 1);
  assert.match(pack, /package_file:\s*\$\{\{ steps\.pack\.outputs\.package_file \}\}/);
  assert.match(pack, /package_sha256:\s*\$\{\{ steps\.pack\.outputs\.package_sha256 \}\}/);
  assert.match(pack, /createHash\(['"]sha256['"]\)/);
  assert.match(pack, /name:\s*ecc-ci-installer-artifact/);
});

test('pull-request CI runs the same packed installer on Linux, macOS, and Windows', () => {
  const source = load('.github/workflows/ci.yml');
  const lifecycle = jobBlock(source, 'packed-install-lifecycle', 'validate');
  assert.match(lifecycle, /needs:\s*pack-installer/);
  assert.match(lifecycle, /os:\s*\[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(lifecycle, /node-version:\s*['"]20\.x['"]/);
  assert.match(lifecycle, /name:\s*ecc-ci-installer-artifact/);
  assert.match(lifecycle, /ECC_RELEASE_PACKAGE:\s*release-artifacts\/\$\{\{ needs\.pack-installer\.outputs\.package_file \}\}/);
  assert.match(lifecycle, /ECC_RELEASE_SHA256:\s*\$\{\{ needs\.pack-installer\.outputs\.package_sha256 \}\}/);
  assert.match(lifecycle, /node tests\/ci\/packed-artifact-lifecycle\.js/);
  assert.doesNotMatch(lifecycle, /\$\{\{\s*secrets\./);
});

test('packed lifecycle invokes installed public bins, including setup help', () => {
  assert.match(lifecycleRunnerSource, /getNpmExecInvocation/);
  assert.match(lifecycleRunnerSource, /\['ecc-universal', 'setup', '--help'\]/);
  assert.match(lifecycleRunnerSource, /\['ecc', \.\.\.args\]/);
  assert.doesNotMatch(lifecycleRunnerSource, /node_modules.*scripts.*ecc\.js/);
});

test('packed lifecycle applies and updates README-primary Claude setup with a fake provider', () => {
  assert.match(lifecycleRunnerSource, /createFakeClaudeExecutable/);
  assert.match(
    lifecycleRunnerSource,
    /const claudeSetupArgs = \[\s*'ecc-universal', 'setup',\s*'--mode', 'claude-plugin',\s*'--scope', 'user',\s*\]/
  );
  assert.match(
    lifecycleRunnerSource,
    /runPublicCli\(\s*\[\.\.\.claudeSetupArgs, '--hooks', 'standard', '--dry-run', '--json'\]/
  );
  assert.match(lifecycleRunnerSource, /Claude setup dry-run must not mutate setup state/);
  assert.match(lifecycleRunnerSource, /runProcess\('git', \['--version'\]/);
  assert.match(lifecycleRunnerSource, /runPackedClaudeSetup\('standard'\)/);
  assert.match(lifecycleRunnerSource, /runPackedClaudeSetup\('strict'\)/);
  assert.match(lifecycleRunnerSource, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(lifecycleRunnerSource, /plugin marketplace add/);
  assert.match(lifecycleRunnerSource, /plugin update ecc@ecc/);
});

test('packed lifecycle mutates through the fully explicit guided Kimi install', () => {
  assert.match(
    lifecycleRunnerSource,
    /const guidedKimiInstallArgs = \[\s*'ecc-universal', 'install', '--guided',\s*'--harness', 'kimi',\s*'--profile', 'core',\s*\]/
  );
  assert.match(
    lifecycleRunnerSource,
    /runPublicCli\(\[\.\.\.guidedKimiInstallArgs, '--dry-run', '--json'\]\)/
  );
  assert.match(
    lifecycleRunnerSource,
    /runPublicCli\(\[\.\.\.guidedKimiInstallArgs, '--yes', '--json'\]\)/
  );
  assert.strictEqual(
    (lifecycleRunnerSource.match(/runGuidedKimiInstall\(\)/g) || []).length,
    2,
    'guided Kimi apply must run once initially and once as an idempotency check'
  );
  assert.match(
    lifecycleRunnerSource,
    /runPublicCli\(\['ecc', 'doctor', '--target', 'kimi', '--json'\]\)/
  );
  assert.match(
    lifecycleRunnerSource,
    /runPublicCli\(\['ecc', 'uninstall', '--target', 'kimi', '--json'\]\)/
  );
  assert.match(lifecycleRunnerSource, /guidedKimiSentinel/);
  assert.match(lifecycleRunnerSource, /dry-run must not mutate the Kimi target/);
  for (const credentialName of ['ANTHROPIC_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY']) {
    assert.match(lifecycleRunnerSource, new RegExp(credentialName));
  }
});

test('packed lifecycle validates canonical Antigravity and OpenCode installs', () => {
  assert.match(lifecycleRunnerSource, /target:\s*'antigravity'/);
  assert.match(lifecycleRunnerSource, /path\.join\(projectDir, '\.agents'\)/);
  assert.match(lifecycleRunnerSource, /target:\s*'opencode'/);
  assert.match(lifecycleRunnerSource, /path\.join\(homeDir, '\.config', 'opencode'\)/);
  assert.match(lifecycleRunnerSource, /\['doctor', '--target', options\.target, '--json'\]/);
  assert.match(lifecycleRunnerSource, /skill-comply[\s\S]*SKILL\.md/);
  assert.match(lifecycleRunnerSource, /!fs\.existsSync\(installedSkillPath\)/);
});

test('packed lifecycle installs and verifies the opt-in Ito distribution surface', () => {
  assert.match(
    lifecycleRunnerSource,
    /'--profile', 'core'[\s\S]*'--with', 'capability:ito-compute'[\s\S]*'--with', 'capability:prediction-markets'/
  );
  for (const moduleId of ['ito-compute', 'prediction-market-skills']) {
    assert.match(lifecycleRunnerSource, new RegExp(`moduleId === '${moduleId}'`));
  }
  for (const installedPath of [
    'skills/ito-baskets/SKILL.md',
    'skills/ito-baskets/agents/openai.yaml',
    'skills/ito-baskets/scripts/ito-baskets.js',
    'skills/ito-compute/SKILL.md',
    'skills/ito-compute/agents/openai.yaml',
    'skills/ito-inference/SKILL.md',
    'skills/ito-training/SKILL.md',
  ]) {
    assert.match(lifecycleRunnerSource, new RegExp(installedPath.replaceAll('.', '\\.')));
  }
  assert.match(lifecycleRunnerSource, /\['ito', 'status'\]/);
  assert.match(lifecycleRunnerSource, /canonical ito-compute-cli is unpublished/i);
  assert.match(lifecycleRunnerSource, /npx\|npm exec\|npm link\|install -g/i);
  assert.match(lifecycleRunnerSource, /installedStat\.isFile\(\)/);
  assert.match(lifecycleRunnerSource, /installedStat\.size > 0/);
  assert.match(lifecycleRunnerSource, /hostileItoSentinel/);
  assert.match(lifecycleRunnerSource, /must-not-reach-hostile-path/);
  assert.match(lifecycleRunnerSource, /packed Itô bridge executed a PATH collision/);
});

pendingTests.then(() => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
});
