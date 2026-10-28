import { evaluate } from "./matcher.js";
import { fixtures } from "./fixtures.js";

let allPassed = true;

console.log("=== Taste-Matching Engine — Rule Validation Against Synthetic Fixtures ===\n");

for (const fixture of fixtures) {
  const result = evaluate(fixture.place, fixture.category);
  const testPassed = result.passed === fixture.expectedPass;
  allPassed = allPassed && testPassed;

  console.log(
    `${testPassed ? "✅" : "❌"} ${fixture.place.name} [${fixture.category}] — engine says ${
      result.passed ? "PASS" : "FAIL"
    }, expected ${fixture.expectedPass ? "PASS" : "FAIL"}`
  );
  console.log(`   Why expected: ${fixture.groundTruthNote}`);
  for (const r of result.ruleResults) {
    console.log(`   ${r.passed ? "  ✓" : "  ✗"} [${r.rule}] ${r.reason}`);
  }
  console.log("");
}

console.log("=".repeat(80));
if (allPassed) {
  console.log("All synthetic fixtures matched expected outcomes.");
} else {
  console.log("Some fixtures did NOT match expected outcome — see ❌ lines above before proceeding.");
  process.exitCode = 1;
}
