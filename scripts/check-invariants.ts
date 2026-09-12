/**
 * Verify every declared business invariant has a tagged, passing test.
 *
 * Matching is on an explicit `[INV-...]` tag in the test title, not on a
 * substring of its prose. Substring matching was a guess: renaming a test
 * silently broke the link, and a loose phrase could rebind an invariant to a
 * different, weaker test that happened to contain the same words.
 *
 * Four failure modes, all fatal:
 *
 *   MISSING    no test carries this tag
 *   FAILING    the tagged test failed
 *   SKIPPED    the tagged test did not run
 *   AMBIGUOUS  more than one test carries the tag, so which one proves it?
 *
 * Plus one more, checked separately: a test tagged with an id that is not
 * declared, which means someone believes they are protecting a rule that
 * nothing tracks.
 *
 *   npx vitest run --reporter=json --outputFile=/tmp/results.json
 *   npx vite-node scripts/check-invariants.ts -- /tmp/results.json
 */
import { readFileSync } from 'node:fs';
import { INVARIANTS } from '../tests/invariants.js';

const resultsPath = process.argv[process.argv.length - 1];
const report = JSON.parse(readFileSync(resultsPath, 'utf8')) as {
  testResults: {
    name: string;
    assertionResults: { fullName: string; title: string; status: string }[];
  }[];
};

const TAG = /\[(INV-[A-Z]+-\d+)\]/;

/** Every tag found across the whole run, with where it was seen. */
const seen = new Map<string, { file: string; title: string; status: string }[]>();

for (const file of report.testResults) {
  const shortFile = file.name.replace(/\\/g, '/').replace(`${process.cwd()}/`, '');
  for (const a of file.assertionResults) {
    const m = TAG.exec(a.title);
    if (!m) continue;
    const id = m[1]!;
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id)!.push({ file: shortFile, title: a.title, status: a.status });
  }
}

type Status = 'PROVEN' | 'MISSING' | 'FAILING' | 'SKIPPED' | 'AMBIGUOUS' | 'WRONG_FILE';

interface Outcome {
  id: string;
  rule: string;
  consequence: string;
  status: Status;
  detail?: string;
}

const outcomes: Outcome[] = [];

for (const inv of INVARIANTS) {
  const hits = seen.get(inv.id) ?? [];

  let status: Status;
  let detail: string | undefined;

  if (hits.length === 0) {
    status = 'MISSING';
  } else if (hits.length > 1) {
    // Two tests claiming the same invariant means neither is definitively
    // the proof. Resolve it rather than guessing.
    status = 'AMBIGUOUS';
    detail = hits.map((h) => `${h.file}: ${h.title}`).join('; ');
  } else {
    const hit = hits[0]!;
    if (hit.status === 'passed') {
      // The declared file is documentation; if a test moves, say so rather
      // than failing, because the guarantee is still in place.
      status = hit.file.endsWith(inv.file) ? 'PROVEN' : 'WRONG_FILE';
      if (status === 'WRONG_FILE') detail = `now in ${hit.file}, declared as ${inv.file}`;
    } else if (hit.status === 'pending' || hit.status === 'skipped' || hit.status === 'todo') {
      status = 'SKIPPED';
    } else {
      status = 'FAILING';
    }
  }

  outcomes.push({ id: inv.id, rule: inv.rule, consequence: inv.consequence, status, detail });
}

/* Tags in the suite that no invariant declares. */
const declared = new Set(INVARIANTS.map((i) => i.id));
const orphans = [...seen.keys()].filter((id) => !declared.has(id));

/* ------------------------------------------------------------------ */

const proven = outcomes.filter((o) => o.status === 'PROVEN').length;
const moved = outcomes.filter((o) => o.status === 'WRONG_FILE');
const broken = outcomes.filter(
  (o) => o.status !== 'PROVEN' && o.status !== 'WRONG_FILE',
);

console.log(`\nBusiness invariants: ${proven}/${outcomes.length} proven\n`);

const explain: Record<Status, string> = {
  PROVEN: '',
  MISSING: 'no test carries this tag any more',
  FAILING: 'the test that proves this is failing',
  SKIPPED: 'the test that proves this did not run',
  AMBIGUOUS: 'more than one test claims this tag',
  WRONG_FILE: 'the test moved',
};

for (const o of broken) {
  console.error(`  ${o.status.padEnd(9)} ${o.id}  ${o.rule}`);
  console.error(`            ${explain[o.status]}`);
  if (o.detail) console.error(`            ${o.detail}`);
  console.error(`            Risk: ${o.consequence}\n`);
}

// A moved test still proves the rule, so this is a note, not a failure.
for (const o of moved) {
  console.warn(`  NOTE      ${o.id}  ${o.detail}`);
  console.warn(`            Update the file in tests/invariants.ts.\n`);
}

for (const id of orphans) {
  const where = seen.get(id)!.map((h) => `${h.file}: ${h.title}`).join('; ');
  console.error(`  ORPHAN    ${id} is tagged in the suite but declared nowhere`);
  console.error(`            ${where}`);
  console.error(`            Someone believes a rule is protected that nothing tracks.\n`);
}

if (broken.length || orphans.length) {
  const parts = [
    broken.length ? `${broken.length} invariant${broken.length === 1 ? '' : 's'} no longer proven` : '',
    orphans.length ? `${orphans.length} orphan tag${orphans.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  console.error(
    `${parts.join(' and ')}. Restore the test, or change the declaration in tests/invariants.ts deliberately.`,
  );
  process.exit(1);
}

console.log(
  moved.length
    ? `Every invariant is proven. ${moved.length} test${moved.length === 1 ? ' has' : 's have'} moved; update the declared file.\n`
    : 'Every declared invariant is proven by a tagged, passing test.\n',
);
