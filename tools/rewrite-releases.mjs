#!/usr/bin/env node
// Rewrite every existing GitHub release body with tools/release-notes.mjs.
// Keeps each release's tag, title, prerelease flag and created_at intact.
import { execFileSync } from 'node:child_process';

const REPO = process.env.GITHUB_REPOSITORY || 'okdunli/oboext';
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

const tags = gh(['release', 'list', '--repo', REPO, '--limit', '100'])
  .split('\n').map((l) => l.split('\t')[0].trim()).filter(Boolean);
console.log(`releases to rewrite: ${tags.length}`);

let ok = 0;
for (const tag of tags) {
  let body;
  try {
    body = execFileSync('node', ['tools/release-notes.mjs', tag], { encoding: 'utf8' });
  } catch (e) {
    console.error(`SKIP ${tag}: notes generation failed: ${e.message.split('\n')[0]}`);
    continue;
  }
  try {
    gh(['release', 'edit', tag, '--repo', REPO, '--notes', body]);
    ok++;
    console.log(`ok ${tag}`);
  } catch (e) {
    console.error(`FAIL ${tag}: ${e.message.split('\n')[0]}`);
  }
}
console.log(`done: ${ok}/${tags.length} rewritten`);
