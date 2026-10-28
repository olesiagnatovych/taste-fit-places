const fs = require('fs');
const { execSync } = require('child_process');

// Full Levenshtein edit distance, two-row DP (no external deps).
function levenshtein(a, b) {
  const alen = a.length;
  const blen = b.length;
  if (alen === 0) return blen;
  if (blen === 0) return alen;

  let prev = new Array(blen + 1);
  let curr = new Array(blen + 1);
  for (let j = 0; j <= blen; j++) prev[j] = j;

  for (let i = 1; i <= alen; i++) {
    curr[0] = i;
    for (let j = 1; j <= blen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[blen];
}

// 1.0 = identical, 0.0 = completely different.
function similarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Strips git's own comment lines (only present when committing via an
// editor, not via -m), collapses whitespace, lowercases — so the
// comparison is about the actual words used, not incidental formatting.
function normalize(msg) {
  return msg
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const SIMILARITY_THRESHOLD = 0.90;
const HISTORY_DEPTH = 10;

function getRecentMessages(n) {
  // \x1e (record separator) as a delimiter unlikely to appear in a real
  // commit message, so multi-line messages don't get split incorrectly.
  let raw;
  try {
    raw = execSync(`git log -n ${n} --pretty=format:%H%x1f%B%x1e`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    // No commits yet (first commit in the repo) — nothing to compare against.
    return [];
  }
  return raw
    .split('\x1e')
    .map(r => r.trim())
    .filter(Boolean)
    .map(r => {
      const [hash, ...rest] = r.split('\x1f');
      return { hash, message: rest.join('\x1f') };
    });
}

function main() {
  const msgFilePath = process.argv[2];
  // Real, 2026-09-24 addition — now invoked from prepare-commit-msg, not
  // commit-msg (see that hook's own comment for the full real reasoning):
  // argv[3] is git's own commit SOURCE ("message"/"template"/"merge"/
  // "squash"/"commit" — githooks(5)), argv[4] is the SHA1 of the commit
  // being amended/copied from, present only when source is "commit" (i.e.
  // --amend/-c/-C). Both optional — a direct `node check-commit-msg.js
  // <file>` invocation (manual testing, or an older caller) still works,
  // just without the amend-awareness fix.
  const amendSha = process.argv[4] || null;
  if (!msgFilePath) {
    console.error('Usage: node check-commit-msg.js <commit-message-file> [source] [amend-sha]');
    process.exit(1);
  }

  const newMessageRaw = fs.readFileSync(msgFilePath, 'utf-8');
  const newMessage = normalize(newMessageRaw);

  if (!newMessage) {
    // Empty message — not this check's job to reject that; git handles it.
    process.exit(0);
  }

  let recent = getRecentMessages(HISTORY_DEPTH);

  // Real fix for the amend false-positive (see prepare-commit-msg's own
  // comment): exclude ONLY the specific commit being amended, not the
  // whole history — a message that happens to also match some OTHER of
  // the last 10 commits is still correctly flagged, same as before.
  if (amendSha) {
    recent = recent.filter(({ hash }) => hash !== amendSha);
  }

  if (recent.length === 0) {
    console.log('commit-msg check: OK — no prior commits to compare against.');
    process.exit(0);
  }

  let worst = null;
  for (const { hash, message } of recent) {
    const score = similarity(newMessage, normalize(message));
    if (!worst || score > worst.score) {
      worst = { hash, message, score };
    }
  }

  if (worst.score >= SIMILARITY_THRESHOLD) {
    const pct = (worst.score * 100).toFixed(1);
    const preview = worst.message.split('\n')[0].slice(0, 72);
    console.log('');
    console.log(`Commit blocked: new commit message is ${worst.score === 1 ? 'IDENTICAL' : `${pct}% similar`} to commit ${worst.hash.slice(0, 7)}:`);
    console.log(`  "${preview}${preview.length === 72 ? '...' : ''}"`);
    console.log('');
    console.log(`This looks like a reused message, not one written for this commit's actual diff.`);
    console.log(`Threshold: ${(SIMILARITY_THRESHOLD * 100).toFixed(0)}% similarity against the last ${HISTORY_DEPTH} commits.`);
    process.exit(1);
  }

  console.log(`commit-msg check: OK — ${(worst.score * 100).toFixed(1)}% similarity to closest of last ${HISTORY_DEPTH} commits (below ${(SIMILARITY_THRESHOLD * 100).toFixed(0)}% threshold).`);
  process.exit(0);
}

main();
