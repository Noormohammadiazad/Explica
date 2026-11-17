#!/usr/bin/env node
// Moves the one workflow in .github/workflows/ to a file name GitHub has never seen:
//   <slug of its `name:`>-<UTC date>-<UTC time>.yml
// GitHub numbers runs per workflow file path, so a fresh path starts again at run #1.
// The new name is always later than the current one (two rotations in the same second
// still differ) and the file's contents are left untouched.
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = '.github/workflows';
const STAMP = /-(\d{8})-(\d{6})\.ya?ml$/;

const fail = (msg) => {
  console.error(`rotate:workflow: ${msg}`);
  process.exit(1);
};

if (!existsSync(DIR)) fail(`${DIR} does not exist`);
const files = readdirSync(DIR).filter((f) => !f.startsWith('.'));
if (files.length !== 1) {
  fail(`${DIR} must hold exactly one workflow, found ${files.length}${files.length ? `: ${files.join(', ')}` : ''}`);
}
const current = files[0];
if (!/\.ya?ml$/.test(current)) fail(`${current} is not a .yml workflow`);

const text = readFileSync(join(DIR, current), 'utf8');
const name = /^name:\s*(.+?)\s*$/m.exec(text)?.[1]?.replace(/^(['"])(.*)\1$/, '$2') ?? '';
const slug =
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workflow';

// later than now, and later than the stamp the current name already carries
let t = Math.floor(Date.now() / 1000) * 1000;
const prev = STAMP.exec(current);
if (prev) {
  const [, d, h] = prev;
  const was = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +h.slice(0, 2), +h.slice(2, 4), +h.slice(4, 6));
  if (t <= was) t = was + 1000;
}
const iso = new Date(t).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
const next = `${slug}-${stamp}.yml`;
if (existsSync(join(DIR, next))) fail(`${next} already exists`);

const from = join(DIR, current);
const to = join(DIR, next);
let tracked = false;
try {
  execFileSync('git', ['ls-files', '--error-unmatch', from], { stdio: 'ignore' });
  tracked = true;
} catch {
  tracked = false;
}
// a tracked file moves with `git mv`, so `git status` shows the push as a rename
if (tracked) execFileSync('git', ['mv', from, to], { stdio: 'inherit' });
else renameSync(from, to);
console.log(`rotate:workflow: ${current} → ${next}`);
