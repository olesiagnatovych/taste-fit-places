// Taste profiles as natural-language text: the input to Step 3 (Gemini with Grounding scores
// each place against the profile for its category). Kept as plain text on purpose, so it reads
// close to how a person describes their own taste, not as pre-structured data.
//
// Showcase note: these are paraphrased, neutral versions of the private profiles, with personal
// details removed. The experiment results in docs/ were measured with the private wording, so a
// run with this text may not reproduce them exactly.

export const WINE_TASTE_PROFILE = `
Wine type: any type is welcome (white, orange, red, pét-nat). The filter is style and
production method, not color.

Style and production method: natural, biodynamic, organic, small-production,
minimal-intervention, wild or spontaneous fermentation, méthode ancestrale (pét-nat), and
aging in neutral vessels (old wood, clay amphorae or qvevri, concrete). These are independent
positive signals, matched with OR, not AND: real evidence of any one is enough for a match.
One signal is a weaker match; two or more distinct signals are a stronger match. Say which.

Flavor: notes that many drinkers call faults are wanted here, as signs of a genuinely natural,
low-intervention wine: funky, barnyard, earthy, wet forest floor, kombucha-like, wild, "weird",
including mousy notes.

Region: European preferred. Strongest signal: Eastern European natural wine (Georgia, Slovenia,
Hungary, Czech Republic, Slovakia, Croatia). Other European regions are also good (Austria,
Germany, Italy, France).

Atmosphere: friendly, knowledgeable and unpretentious; nobody performing for the room. A
somewhat lower average rating can come from exactly this quality, so a lower rating alone is
not a quality problem.

Food, two valid types: light bites only (bread and butter, olives, cured ham, charcuterie,
cheese, oysters, burrata, salads), or a full food menu. Note which one the place is.

Price: around $50, up to $100.

Hard disqualifier: a food menu of canned items only, however good the wine is.
`.trim();

export const SUSHI_TASTE_PROFILE = `
Fish quality is the point: fresh, firm but tender, clean texture, never mushy, rubbery or
sinewy; fatty tuna should melt. Nigiri is the main order, not rolls.

Hard disqualifier: a muddy or pond-like off-flavor in the fish (geosmin), or a chemical or
chlorine smell in the space.

Sauce: a small, proportionate touch is fine. The disqualifier is sauce that dominates and hides
the fish.

Budget: a place whose prices top out at $30 per person or less usually means compromised fish
quality; avoid that tier. This is an experience-based quality floor, not a soft preference.
Sweet spot $30–$50 per person; more is fine but not required.

Format is not a quality signal in either direction. "Omakase" is a seating format and a price
level, not proof of freshness. A neighborhood spot, an izakaya, or a place that also serves rolls
and small plates is not assumed to be worse. Weigh specific evidence about the nigiri, sashimi and
fatty tuna on its own terms.

Not a disqualifier: a menu that also has sauce-heavy or fusion rolls next to real nigiri and
sashimi. That is common in US sushi places and says little about the fish itself.

Atmosphere: loud and lively or quiet and small are both fine. Not wanted: service that performs a
role, or ceremony that becomes more important than the food. Creative technique is welcome when
it serves the food.
`.trim();

export const COFFEE_TASTE_PROFILE = `
Hard disqualifier: dark roast. This is the biggest disqualifier in this category.

Reading reviews: praise such as "strong" or "bold" often describes a dark, bitter, over-roasted
coffee. Read it as a negative signal here, the opposite of a generic sentiment score.

Positive signals: specialty or "third wave" coffee, light roast (preferred), medium roast
(acceptable, especially with a specific brew method). Pour-over is a plus but not required.
Cold brew is a separate method; treat it as mildly positive, but it may turn negative when paired
with "strong" language.

Cappuccino: no toppings, such as chocolate powder.

A real fit does not need specialty-coffee vocabulary in reviews. A place can fit well when
reviews mostly praise general quality, consistency or pastries.
`.trim();

export const ART_TASTE_PROFILE = `
Mediums: paintings, installations and immersive art experiences, sculpture parks, urban gardens
with sculpture, interactive art, galleries.

Era: modern art (late 19th century to the 1970s) and contemporary art. Classical and older
historical art is not of interest unless it is otherwise notable.

Core filter, more important than subject: the work needs a real idea behind it. Unusual or
provocative work that makes the viewer think or feel is wanted. Reference points: conceptual and
performance art in the tradition of Duchamp, Abramović, Cattelan and Hirst.

Nudity: fine when it serves a concept, story or statement; not wanted when bodies are the only
point.

Hard disqualifier: work that shows cruelty or violence, or people or animals hurting each other.

Some further personal content preferences apply and are kept private.

Interactive work: strongly positive (perceptual or immersive rooms, hands-on workshops,
installations where visitors add or move something).
`.trim();

export const PIZZA_TASTE_PROFILE = `
Style: Italian (European), not American: thin crust, wood-fired oven. Modern Italian pizza is
loved, not just tolerated: fior di latte, burrata or ricotta, and pistachio combinations are
favorites. The disqualifier is Americanization, not innovation.

Sauce: a natural tomato base (canned tomato or homemade tomato paste are both fine). Processed,
ketchup-style, overly sweet or thick sauce is a hard disqualifier.

Cheese: real mozzarella, ricotta, burrata; not a generic "cheese blend".

Meat: cooked ham (prosciutto cotto), mortadella and cured ham (prosciutto crudo) are all wanted.

Dislike, not a disqualifier: pepperoni or spicy salami pizza.

Reference dishes: Quattro Formaggi, Quattro Stagioni-type combinations, and pizza a portafoglio
(small, folded Neapolitan street pizza).

Permanent hard disqualifiers, never relaxed: (1) deep dish, which is not considered pizza at all
here; (2) processed, ketchup-style sauce.

Thick or non-thin dough is not a hard disqualifier. Treat it everywhere as a medium fit and state
it as a caveat in plain language, so the hedge is visible instead of hidden behind the verdict.

Not a disqualifier: a menu that also includes Americanized items (fries, sausage) next to genuine
pizza. Judge what you would actually order.

Price: no strong limit in the normal $10–20 range.

Discovery signal: a pizzeria run by Italians raises the odds of authenticity, and reviewers who
understand pizza describe it in specific, knowledgeable language. That specificity is a real
signal, not just keyword presence.
`.trim();
