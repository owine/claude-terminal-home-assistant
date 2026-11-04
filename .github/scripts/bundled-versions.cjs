// Appends a "Bundled versions" table to the draft release's body.
//
// Renovate groups most patch and minor bumps into one weekly
// `deps: update all non-major dependencies` PR, so a Claude Code or ha-mcp bump
// usually reaches the release notes as that one generic line, and a release
// that bumps nothing says nothing about versions at all. This footer reads the
// pins from the commit the draft is built from, so every release states what
// its image ships, whatever the PRs were titled.
//
// Runs as the last step of release-drafter.yml, after the summary line. Both
// release-drafter and the summary step rewrite the body from scratch on every
// push to main, so the footer is re-rendered each time; MARKER also lets a
// re-run replace an existing footer instead of stacking a second one.
// promote (publish.yml) copies the published body into CHANGELOG.md, so the
// footer reaches Home Assistant's update dialog too.
//
// Tested by bundled-versions.test.cjs (node --test, Unit tests job).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKER = '<!-- bundled-versions -->';

// Order is the table's order. `file` is relative to the repo root; `pattern`
// captures the version from it. Alpine pins carry a package release suffix
// (ttyd=1.7.7-r0) that is packaging, not the upstream version, so it is
// dropped.
const COMPONENTS = [
  {
    name: 'Claude Code',
    file: 'claude-terminal/Dockerfile',
    pattern: /^ARG CLAUDE_VERSION=(\S+)$/m,
    // Claude Code updates itself in /data/home/.local/bin on a running
    // install, so the pin is only where a fresh install starts.
    footnote: 'Claude Code updates itself on a running install; this is the version the image starts with.',
  },
  { name: 'ha-mcp', file: 'claude-terminal/ha-mcp/pyproject.toml', pattern: /^\s*"ha-mcp==([^"]+)",?$/m },
  { name: 'ttyd', file: 'claude-terminal/Dockerfile', pattern: /^\s*ttyd=(\S+?)(?:-r\d+)?\s*\\?$/m },
  { name: 'tmux', file: 'claude-terminal/Dockerfile', pattern: /^\s*tmux=(\S+?)(?:-r\d+)?\s*\\?$/m },
  { name: 'Node.js', file: 'claude-terminal/Dockerfile', pattern: /^\s*nodejs=(\S+?)(?:-r\d+)?\s*\\?$/m },
  { name: 'GitHub CLI', file: 'claude-terminal/Dockerfile', pattern: /^ARG GH_CLI_VERSION=(\S+)$/m },
  { name: 'Home Assistant CLI', file: 'claude-terminal/Dockerfile', pattern: /^ARG HA_CLI_VERSION=(\S+)$/m },
  { name: 'uv', file: 'claude-terminal/Dockerfile', pattern: /^ARG UV_VERSION=(\S+)$/m },
];

// Returns { versions: [{name, version}], missing: [name] } for the files read
// by `readFile(relativePath)`. A pin that no longer matches its pattern is
// reported as missing rather than guessed at.
function readVersions(readFile) {
  const cache = new Map();
  const versions = [];
  const missing = [];
  for (const { name, file, pattern, footnote } of COMPONENTS) {
    if (!cache.has(file)) cache.set(file, readFile(file));
    const match = pattern.exec(cache.get(file));
    if (match) versions.push({ name, version: match[1], footnote });
    else missing.push(name);
  }
  return { versions, missing };
}

// Footnotes are numbered in table order.
const MARKS = ['¹', '²', '³'];

function renderFooter(versions) {
  const footnotes = [];
  const rows = versions.map(({ name, version, footnote }) => {
    if (!footnote) return `| ${name} | ${version} |`;
    const mark = MARKS[footnotes.length];
    footnotes.push(`${mark} ${footnote}`);
    return `| ${name} | ${version} ${mark} |`;
  });
  return [
    MARKER,
    '### Bundled versions',
    '',
    '| Component | Version |',
    '|---|---|',
    ...rows,
    ...(footnotes.length ? ['', ...footnotes] : []),
  ].join('\n');
}

// Puts `footer` at the end of `body`, replacing any footer already there.
function applyFooter(body, footer) {
  const at = body.indexOf(MARKER);
  const base = (at === -1 ? body : body.slice(0, at)).trimEnd();
  return base ? `${base}\n\n${footer}\n` : `${footer}\n`;
}

// actions/github-script entry point. RELEASE_ID arrives through `env:`, never as
// an expression inside the script, matching the summary step.
async function run({ github, context, core, root = process.cwd() }) {
  const { versions, missing } = readVersions((file) => fs.readFileSync(path.join(root, file), 'utf8'));

  const release_id = Number(process.env.RELEASE_ID);
  const { data: release } = await github.rest.repos.getRelease({ ...context.repo, release_id });
  // Published since release-drafter ran: never rewrite a release someone shipped.
  if (!release.draft) {
    core.info(`Release ${release_id} is no longer a draft; leaving its body alone.`);
    return;
  }

  if (versions.length) {
    // Send the draft's own tag back: a PATCH without tag_name drops a draft's
    // tag (see the summary step).
    await github.rest.repos.updateRelease({
      ...context.repo,
      release_id,
      tag_name: release.tag_name,
      body: applyFooter(release.body ?? '', renderFooter(versions)),
    });
    core.info(`Bundled versions: ${versions.map(({ name, version }) => `${name} ${version}`).join(', ')}`);
  }

  // Fail after writing what was found, so the draft keeps the rows that still
  // parse and the run goes red until the pattern is fixed.
  if (missing.length) core.setFailed(`No version pin found for: ${missing.join(', ')}. Update COMPONENTS in .github/scripts/bundled-versions.cjs.`);
}

module.exports = { COMPONENTS, MARKER, readVersions, renderFooter, applyFooter, run };
