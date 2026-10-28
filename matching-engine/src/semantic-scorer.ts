// RETIRED in the compliance rebuild. This is the v1 verbatim-citation check: Claude read the
// review text that the old pipeline requested and checked that every quoted phrase really
// appeared in it. The rebuild stopped requesting review text at all (Places API (New) +
// Gemini Grounding), so there is nothing left to check quotes against. Kept as a record of
// the v1 design; nothing in the live search path imports it.
//
// Semantic scoring layer — the layer the deterministic rule engine (matcher.ts) cannot do:
// judging whether free-text review/menu content genuinely reflects the user's taste profile,
// not just whether specific keywords appear.
//
// KEY RISK THIS IS BUILT TO ADDRESS (flagged in the private development log, Session 1):
// "Model must cite actual review text as evidence, not assert conclusions from thin evidence —
// false confidence was identified as the specific failure mode to test for."
//
// So this module does two things a naive "ask Claude if it's a good fit" call would not:
//   1. Forces the model to output an explicit "insufficient_evidence" category, not just
//      good/bad — so thin input produces an honest "I don't know" instead of a confident guess.
//   2. VERIFIES every cited quote is an actual verbatim substring of the input text. If the
//      model cites something that isn't really there, that's flagged as a citation failure —
//      not silently trusted.

import Anthropic from "@anthropic-ai/sdk";

export type FitScore = "strong_fit" | "possible_fit" | "no_fit" | "insufficient_evidence";

export interface SemanticScoreInput {
  placeName: string;
  /** Real (or realistic stand-in, until Places API is wired) review/menu/description text. */
  sourceText: string;
  /** Natural-language taste profile — see taste-profiles.ts. */
  tasteProfile: string;
}

export interface SemanticScoreResult {
  placeName: string;
  fitScore: FitScore;
  reasoning: string;
  citedEvidence: string[];
  /** true only if every cited quote was verified as an actual substring of sourceText. */
  citationsVerified: boolean;
  unverifiedCitations: string[];
}

interface RawModelOutput {
  fit_score: FitScore;
  reasoning: string;
  cited_evidence: string[];
}

function buildPrompt(input: SemanticScoreInput): string {
  return `You are evaluating whether a place genuinely matches a specific person's taste profile, based ONLY on the source text provided below. Do not use outside knowledge about this place.

TASTE PROFILE:
${input.tasteProfile}

SOURCE TEXT (reviews/menu/description for "${input.placeName}"):
${input.sourceText}

Instructions:
- Judge fit based only on what the source text actually says, not on the place's name or assumptions about its category.
- CRITICAL: You may have outside/trained knowledge about this specific place (its real menu, sourcing, reputation, etc.). You MUST NOT use that outside knowledge to fill in details, even if it's accurate in the real world. Base your fit_score and reasoning ONLY on the SOURCE TEXT above. If you find yourself about to state a specific detail (an origin, a flavor note, a preparation method) that isn't literally present in the source text, do not include it — this applies even if you're confident it's true about the real place.
- If the source text has genuine, specific signal matching the taste profile, mark it as strong_fit or possible_fit.
- If the source text is too thin, generic, or vague to judge either way, you MUST mark it insufficient_evidence — do NOT guess or state a confident conclusion from weak evidence. This is important: false confidence from thin evidence is the specific failure mode being tested for.
- If the source text has clear signals AGAINST the taste profile (e.g. a hard disqualifier is present), mark it no_fit.
- cited_evidence must be exact verbatim short quotes (under 15 words each) copied directly from the source text above — not paraphrased, not invented, and not recalled from outside knowledge about this place. Every quote must be checkable word-for-word against the source text.

Respond ONLY with valid JSON, no other text, in exactly this shape:
{"fit_score": "strong_fit" | "possible_fit" | "no_fit" | "insufficient_evidence", "reasoning": "1-3 sentences", "cited_evidence": ["short exact quote", "..."]}`;
}

function verifyCitations(citedEvidence: string[], sourceText: string): { verified: boolean; unverified: string[] } {
  const normalizedSource = sourceText.toLowerCase();
  const unverified = citedEvidence.filter((quote) => !normalizedSource.includes(quote.toLowerCase().trim()));
  return { verified: unverified.length === 0, unverified };
}

export async function scorePlaceSemantic(input: SemanticScoreInput): Promise<SemanticScoreResult> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [{ role: "user", content: buildPrompt(input) }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error(`No text response for ${input.placeName}`);
  }

  const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
  let parsed: RawModelOutput;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse model output for ${input.placeName}: ${cleaned}`);
  }

  const { verified, unverified } = verifyCitations(parsed.cited_evidence ?? [], input.sourceText);

  return {
    placeName: input.placeName,
    fitScore: parsed.fit_score,
    reasoning: parsed.reasoning,
    citedEvidence: parsed.cited_evidence ?? [],
    citationsVerified: verified,
    unverifiedCitations: unverified,
  };
}
