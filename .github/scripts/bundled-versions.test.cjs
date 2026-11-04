// Tests for bundled-versions.cjs. Run with: node --test '.github/scripts/*.test.cjs'

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { COMPONENTS, MARKER, readVersions, renderFooter, applyFooter, run } = require('./bundled-versions.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const readRepo = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// The guard that matters most: Renovate and humans both edit these files, and a
// pin that drifts out of its pattern would otherwise just vanish from the notes.
test('every component parses from the real repo files', () => {
  const { versions, missing } = readVersions(readRepo);
  assert.deepEqual(missing, []);
  assert.equal(versions.length, COMPONENTS.length);
  for (const { name, version } of versions) {
    assert.match(version, /^\d+(\.\d+)*[a-z]?$/, `${name} version looks like a version, got ${version}`);
  }
});

test('Alpine release suffixes are dropped, upstream letters kept', () => {
  const dockerfile = [
    'ARG CLAUDE_VERSION=2.1.311',
    'ARG UV_VERSION=0.13.7',
    'ARG HA_CLI_VERSION=5.6.0',
    'ARG GH_CLI_VERSION=2.103.3',
    '    nodejs=24.22.1-r1 \\',
    '    tmux=3.7c-r0 \\',
    '    ttyd=1.7.7-r0 \\',
  ].join('\n');
  const files = {
    'claude-terminal/Dockerfile': dockerfile,
    'claude-terminal/ha-mcp/pyproject.toml': 'dependencies = [\n    "ha-mcp==9.1.0",\n]\n',
  };
  const { versions, missing } = readVersions((f) => files[f]);
  assert.deepEqual(missing, []);
  const byName = Object.fromEntries(versions.map(({ name, version }) => [name, version]));
  assert.equal(byName.ttyd, '1.7.7');
  assert.equal(byName.tmux, '3.7c');
  assert.equal(byName['Node.js'], '24.22.1');
  assert.equal(byName['ha-mcp'], '9.1.0');
});

test('a pin that stops matching is reported, not guessed', () => {
  const files = { 'claude-terminal/Dockerfile': 'ARG CLAUDE_VERSION=2.1.311\n', 'claude-terminal/ha-mcp/pyproject.toml': '' };
  const { versions, missing } = readVersions((f) => files[f]);
  assert.deepEqual(versions.map((v) => v.name), ['Claude Code']);
  assert.ok(missing.includes('ha-mcp'));
  assert.ok(missing.includes('ttyd'));
});

test('npm=... does not satisfy the nodejs pattern', () => {
  const files = { 'claude-terminal/Dockerfile': '    npm=11.12.1-r0 \\\n', 'claude-terminal/ha-mcp/pyproject.toml': '' };
  assert.ok(readVersions((f) => files[f]).missing.includes('Node.js'));
});

test('footer renders a table with the Claude Code footnote', () => {
  const footer = renderFooter([
    { name: 'Claude Code', version: '2.1.311', footnote: 'Self-updates.' },
    { name: 'ttyd', version: '1.7.7' },
  ]);
  assert.equal(
    footer,
    [MARKER, '## Bundled versions', '', '| Component | Version |', '|---|---|', '| Claude Code | 2.1.311 ¹ |', '| ttyd | 1.7.7 |', '', '¹ Self-updates.'].join('\n'),
  );
});

test('footer without footnotes has no trailing note block', () => {
  assert.ok(renderFooter([{ name: 'ttyd', version: '1.7.7' }]).endsWith('| ttyd | 1.7.7 |'));
});

test('applyFooter appends after the full-changelog line', () => {
  const body = '**1 feature**\n\n## ✨ Features\n\n- x (#1)\n\n**Full changelog:** [a...b](u)\n';
  assert.equal(applyFooter(body, 'FOOT'), '**1 feature**\n\n## ✨ Features\n\n- x (#1)\n\n**Full changelog:** [a...b](u)\n\nFOOT\n');
});

test('applyFooter replaces an existing footer instead of stacking', () => {
  const once = applyFooter('notes\n', renderFooter([{ name: 'ttyd', version: '1.7.6' }]));
  const twice = applyFooter(once, renderFooter([{ name: 'ttyd', version: '1.7.7' }]));
  assert.equal(twice.split(MARKER).length, 2);
  assert.ok(twice.includes('1.7.7') && !twice.includes('1.7.6'));
  assert.ok(twice.startsWith('notes\n\n'));
});

test('applyFooter on an empty body is just the footer', () => {
  assert.equal(applyFooter('', 'FOOT'), 'FOOT\n');
});

// run(): the github-script glue, against a fake Octokit.
function fakeGithub(release) {
  const calls = [];
  return {
    calls,
    rest: {
      repos: {
        getRelease: async (args) => {
          calls.push(['get', args]);
          return { data: release };
        },
        updateRelease: async (args) => {
          calls.push(['update', args]);
        },
      },
    },
  };
}

function fakeCore() {
  const core = { failed: null, info: () => {}, setFailed: (m) => (core.failed = m) };
  return core;
}

const context = { repo: { owner: 'o', repo: 'r' } };

test('run updates the draft, keeping its tag', async () => {
  process.env.RELEASE_ID = '42';
  const github = fakeGithub({ draft: true, tag_name: 'v3.2.0', body: 'notes' });
  const core = fakeCore();
  await run({ github, context, core, root: ROOT });
  const update = github.calls.find(([k]) => k === 'update')[1];
  assert.equal(update.release_id, 42);
  assert.equal(update.tag_name, 'v3.2.0');
  assert.ok(update.body.startsWith('notes\n\n' + MARKER));
  assert.equal(core.failed, null);
});

test('run leaves a published release alone', async () => {
  process.env.RELEASE_ID = '42';
  const github = fakeGithub({ draft: false, tag_name: 'v3.1.0', body: 'notes' });
  await run({ github, context, core: fakeCore(), root: ROOT });
  assert.equal(github.calls.filter(([k]) => k === 'update').length, 0);
});
