#!/usr/bin/env node
// Repository policy checks run by `npm run verify` before anything is committed or pushed.
//
//  - .github/workflows/ holds exactly one workflow, under a rotated name
//    (<slug>-<YYYYMMDD>-<HHMMSS>.yml, see scripts/rotate-workflow.mjs);
//  - locally (not in CI), once the branch has commits:
//      every commit's author and committer is the project identity,
//      no commit message carries tool trailers or generated-by markers,
//      no refs/original/* and no backup branches remain,
//      the workflow has been rotated since the last commit (`git status` shows a rename),
//      and the repository is configured to commit as the project identity.
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const IDENTITY = 'Noormohammadiazad <Noormohammadiazad@users.noreply.github.com>';
const DIR = '.github/workflows';
const ROTATED = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{8}-\d{6}\.yml$/;
const FORBIDDEN = /claude|anthropic|co-authored|signed-off|generated with/i;
const BACKUP = /(^|[/_.-])(backup|bak|orig|original|old|save|tmp|temp)([/_.-]|$)/i;

const problems = [];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// ---- the workflow directory
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => !f.startsWith('.')) : [];
if (files.length !== 1) problems.push(`${DIR} must hold exactly one workflow; found ${files.length}${files.length ? ` (${files.join(', ')})` : ''}`);
else if (!ROTATED.test(files[0])) problems.push(`the workflow is not under a rotated name (${files[0]}); run \`npm run rotate:workflow\``);

// ---- git history (local only: CI checkouts carry their own refs and merge commits)
let inRepo = false;
try {
  inRepo = git('rev-parse', '--is-inside-work-tree').trim() === 'true';
} catch {
  inRepo = false;
}
let hasHead = false;
if (inRepo) {
  try {
    git('rev-parse', '--verify', '-q', 'HEAD');
    hasHead = true;
  } catch {
    hasHead = false;
  }
}

if (inRepo && !process.env.CI) {
  const name = (() => {
    try {
      return git('config', 'user.name').trim();
    } catch {
      return '';
    }
  })();
  const email = (() => {
    try {
      return git('config', 'user.email').trim();
    } catch {
      return '';
    }
  })();
  if (`${name} <${email}>` !== IDENTITY) problems.push(`git is configured to commit as "${name} <${email}>", not ${IDENTITY}`);
  for (const v of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    if (process.env[v] && !IDENTITY.includes(process.env[v])) problems.push(`${v} overrides the commit identity`);
  }

  if (hasHead) {
    const ids = [...new Set(git('log', '--format=%an <%ae> | %cn <%ce>').split('\n').filter(Boolean))];
    if (ids.length !== 1 || ids[0] !== `${IDENTITY} | ${IDENTITY}`) problems.push(`commits carry other identities: ${ids.join('; ')}`);

    const offending = git('log', '--format=%B')
      .split('\n')
      .filter((l) => FORBIDDEN.test(l));
    if (offending.length) problems.push(`commit messages carry forbidden trailers or markers: ${offending.map((l) => l.trim()).join(' | ')}`);

    const refs = git('for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);
    for (const r of refs) {
      if (r.startsWith('refs/original/')) problems.push(`leftover ${r}`);
      else if (r.startsWith('refs/heads/') && BACKUP.test(r.slice('refs/heads/'.length))) problems.push(`backup branch ${r}`);
    }

    // this commit must move the workflow to a new name
    if (files.length === 1) {
      const committed = git('ls-tree', '-r', '--name-only', 'HEAD', '--', DIR).split('\n').filter(Boolean);
      if (committed.includes(`${DIR}/${files[0]}`)) problems.push('the workflow has not been rotated since the last commit; run `npm run rotate:workflow`');
    }
  }
}

if (problems.length) {
  console.error('verify: repository policy check failed:');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `verify: repository policy ok${process.env.CI ? ' (CI: history checks skipped)' : hasHead ? '' : ' (no commits yet: history checks skipped)'}`,
);
