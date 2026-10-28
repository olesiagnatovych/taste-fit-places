const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PLACES_API_BASE = 'https://places.googleapis.com/v1';

// List/category names are a closed, known set — the owner's real Google Takeout list
// filenames. A fabricated list name should always fail, regardless of new-discovery status.
// Showcase note: the Takeout export is personal data and is not in this repo, so when the
// folder is missing this returns null and the list-name check is skipped (the place-name
// check below still runs).
function loadRealListNames(takeoutDir) {
  if (!fs.existsSync(takeoutDir)) return null;
  const listNames = new Set();
  const files = fs.readdirSync(takeoutDir).filter(f => f.endsWith('.csv'));
  for (const file of files) {
    listNames.add(path.basename(file, '.csv').toLowerCase());
  }
  return listNames;
}

// Pulls every name/suggestedList/title/list field out of the file, and for
// name/title fields, tries to find an `address:` value in the same object
// literal (bounded by the next tracked field) to make the Places API query
// more precise than a bare name search.
// Character ranges of Next.js page-metadata objects (`export const metadata = { ... }`).
// Their `title:` is the browser-tab title, never a place name, so fields inside these ranges
// are skipped. Without this, `title: "Discover"` in app/layout.tsx was sent to Places API as a
// "place": it failed closed without an API key, and with a key it passed only because some
// real place happens to be called that.
function metadataRanges(content) {
  const ranges = [];
  const start = /export\s+const\s+metadata\b[^=]*=\s*\{/g;
  let m;
  while ((m = start.exec(content)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    ranges.push([m.index, i]);
  }
  return ranges;
}

function extractCandidates(content) {
  const fieldPattern = /(name|suggestedList|title|list)\s*:\s*["'`]([^"'`]+)["'`]/g;
  const addressPattern = /address\s*:\s*["'`]([^"'`]+)["'`]/g;
  const skip = metadataRanges(content);
  const inMetadata = (idx) => skip.some(([s, e]) => idx >= s && idx < e);

  const fieldMatches = [];
  let m;
  while ((m = fieldPattern.exec(content)) !== null) {
    if (inMetadata(m.index)) continue;
    fieldMatches.push({ field: m[1], value: m[2].trim(), index: m.index });
  }
  const addressMatches = [];
  while ((m = addressPattern.exec(content)) !== null) {
    addressMatches.push({ value: m[1].trim(), index: m.index });
  }

  const lineOf = (idx) => content.substring(0, idx).split('\n').length;

  const listChecks = [];
  const placeChecks = [];

  fieldMatches.forEach((fm, i) => {
    if (fm.value.length <= 1) return;
    const nextIndex = fieldMatches[i + 1] ? fieldMatches[i + 1].index : content.length;
    if (fm.field === 'suggestedList' || fm.field === 'list') {
      listChecks.push({ field: fm.field, value: fm.value, line: lineOf(fm.index) });
    } else {
      const addr = addressMatches.find(a => a.index > fm.index && a.index < nextIndex);
      placeChecks.push({
        field: fm.field,
        value: fm.value,
        address: addr ? addr.value : null,
        line: lineOf(fm.index),
      });
    }
  });

  return { listChecks, placeChecks };
}

function checkListNames(listChecks, realListNames) {
  return listChecks.map(c => ({ ...c, ok: realListNames.has(c.value.toLowerCase()) }));
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Word-boundary-safe phrase containment. Plain string .includes() was tried
// first and rejected: it let "plonk" match inside "xyzzyplonk" (one fused
// word, no real boundary) — caught by a deliberate negative-control test
// with a fabricated name, not found through inspection.
function phraseContained(needle, haystack) {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

// Loose match: whole-phrase containment either direction, or >=60% of the
// queried name's significant (3+ char) WHOLE words present in the returned
// display name. Text Search almost always returns *something*, so
// "non-empty response" alone would be a meaningless check — this requires
// the result to actually look like the place we asked about, at word
// boundaries, not as an incidental character substring.
function namesLikelyMatch(queried, returned) {
  const q = normalize(queried);
  const r = normalize(returned);
  if (!q || !r) return false;
  if (phraseContained(r, q) || phraseContained(q, r)) return true;
  const qWords = new Set(q.split(' ').filter(w => w.length >= 3));
  const rWords = new Set(r.split(' ').filter(w => w.length >= 3));
  if (qWords.size === 0) return false;
  let overlap = 0;
  for (const w of qWords) if (rWords.has(w)) overlap++;
  return overlap / qWords.size >= 0.6;
}

// Real-world existence check via Places API (New) Text Search — NOT a
// saved-data check. A place passing here means Google believes it's a real,
// findable business; it says nothing about whether she's saved it.
async function verifyPlaceExists(name, address, apiKey) {
  const textQuery = address ? `${name}, ${address}` : name;
  let response;
  try {
    response = await fetch(`${PLACES_API_BASE}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.id',
      },
      body: JSON.stringify({ textQuery, maxResultCount: 5 }),
    });
  } catch (err) {
    return { found: false, error: `Places API request failed: ${err.message}` };
  }

  if (!response.ok) {
    const errorText = await response.text();
    return { found: false, error: `Places API request failed (${response.status}): ${errorText}` };
  }

  const data = await response.json();
  const places = data.places || [];
  const match = places.find(p => namesLikelyMatch(name, (p.displayName && p.displayName.text) || ''));
  if (match) {
    return { found: true, matchedName: match.displayName.text, matchedAddress: match.formattedAddress };
  }
  return {
    found: false,
    candidates: places.map(p => p.displayName && p.displayName.text).filter(Boolean),
  };
}

async function main() {
  const takeoutDir = process.argv[2] || 'takeout-export';
  const targetFile = process.argv[3];

  if (!targetFile) {
    console.error('Usage: node validate-real-data.js <takeout-dir> <file-to-check>');
    process.exit(1);
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const content = fs.readFileSync(targetFile, 'utf-8');
  const realListNames = loadRealListNames(takeoutDir);
  const { listChecks, placeChecks } = extractCandidates(content);

  let failed = false;

  console.log(`Checking list names against real Takeout list filenames (${takeoutDir}/*.csv)...`);
  if (realListNames === null) console.log(`  (skipped: ${takeoutDir}/ not found — the Takeout export is not part of this repo)`);
  const listResults = realListNames === null ? [] : checkListNames(listChecks, realListNames);
  if (listResults.length === 0) console.log('  (no suggestedList/list fields found)');
  for (const r of listResults) {
    if (r.ok) {
      console.log(`  PASS  line ${r.line}: ${r.field} = "${r.value}" — real saved list`);
    } else {
      failed = true;
      console.log(`  FAIL  line ${r.line}: ${r.field} = "${r.value}" — not a real saved list (no matching file in ${takeoutDir}/)`);
    }
  }

  console.log('');
  console.log('Checking place names against Places API (New) — places:searchText...');
  if (placeChecks.length === 0) console.log('  (no name/title fields found)');

  if (placeChecks.length > 0 && !apiKey) {
    failed = true;
    console.log('  ERROR: GOOGLE_PLACES_API_KEY is not set in matching-engine/.env — cannot verify place names.');
  } else {
    for (const c of placeChecks) {
      const result = await verifyPlaceExists(c.value, c.address, apiKey);
      if (result.error) {
        failed = true;
        console.log(`  FAIL  line ${c.line}: ${c.field} = "${c.value}" — ${result.error}`);
      } else if (result.found) {
        console.log(`  PASS  line ${c.line}: ${c.field} = "${c.value}" — confirmed real via Places API (New): "${result.matchedName}", ${result.matchedAddress}`);
      } else {
        failed = true;
        const note = result.candidates && result.candidates.length
          ? ` (closest results: ${result.candidates.slice(0, 3).join('; ')})`
          : ' (no results returned)';
        console.log(`  FAIL  line ${c.line}: ${c.field} = "${c.value}" — could not be confirmed as a real place via Places API (New)${note}`);
      }
    }
  }

  console.log('');
  if (!failed) {
    console.log(`PASS: ${targetFile} — all list names are real saved lists, all place names confirmed real via Places API (New).`);
    process.exit(0);
  } else {
    console.log(`FAIL: ${targetFile} — see flagged line(s) above.`);
    console.log('A list-name FAIL means: not a real saved list.');
    console.log('A place-name FAIL means: could not be confirmed as a real place via Places API (New) — NOT "the owner hasn\'t saved this yet" (expected and fine for new discoveries).');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('validate-real-data.js crashed:', err.message);
  process.exit(1);
});
