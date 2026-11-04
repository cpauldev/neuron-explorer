# Interpreting neurons in Qwen3.5-4B: methodology

A working method for explaining a single MLP neuron, built from hands-on investigation in the explorer. It complements the explorer prompt above and uses its vocabulary (poles, steer lens, cone, web summary).

## Mindset

- **A neuron is not a word list.** Strong activations are useful starting points, but their interpretation needs matched controls and fresh examples. Do not assume weaker or contradictory activations share a hidden meaning.
- **Think in situations and distinctions.** Good labels describe a moment in text and what the neuron does there: "a line style comes next", "eggs as a counted ingredient", "we're comparing something, but HOW?". Noun categories ("hazard words", "graspable objects") are usually too literal.
- **Read the input and output as a pair.** "Already knows X → writes Y" is the most productive single move. `L20 N7531` is fed by `compare`, `either`, `comparison`, `corresponding` and writes `first/second`, `upper/lower`, `smaller/larger`: given that a comparison is happening, it supplies how to tell the items apart.
- **The strange part is the pointer.** When one view disagrees with the others, that disagreement is where the next test goes.
- **The network's ideas are often better than ours.** A clean neuron need not match an English word.

## Workflow

For a broad “explain this neuron” request, do a bounded investigation, not just reconnaissance.
The goal is the strongest useful conclusion the evidence supports, not a confident-sounding label or an exhaustive circuit reconstruction.

1. **Establish the evidence.** Read `overview`, `neuron` and `web_summary`; reuse results already present for this model. Identify which data are cached and whether live tests are available. Lens tokens and weight links generate hypotheses, not conclusions.
2. **Compare alternatives.** Write two or three competing explanations, including a simple lexical/context explanation. Use a compact `compare` batch (typically 12–24 texts) with matched targets, near misses, and unrelated controls. Look at peak-token positions, signs, and raw activations rather than peak scores alone. A dataset maximum is a sample statistic, not a goal or proof of interpretation.
3. **Resolve the main ambiguity now.** Pick the test whose possible outcomes would actually distinguish the leading alternatives. Run a second, focused contrast batch, with fresh wording and at least one held-out domain/frame. If two poles seem related, vary the proposed factors independently: include each combination and controls outside both patterns, rather than only collecting separate examples. Choose those factors from this neuron's actual results.
4. **Check the output contribution.** Use `logprobs` with ablation (`mode: mul, dose: 0`) on at least two relevant contexts for a causal output claim, including a matched control. Report absolute baseline/intervened probabilities. Add a moderate-dose `steer` comparison if useful, preferably on two different prompts before generalizing behavior. Loops at large doses are disruption, not proof of a natural function. If ablation is negligible, report that natural contribution was small in those contexts; do not rescue the claim by increasing the dose.
5. **Choose a conclusion and stop.** Review the decision rule below. Only if a specific remaining ambiguity could change the headline, run one final targeted round. Do not descend into upstream ablations unless the user asked for a circuit, or that one experiment is necessary to distinguish the leading explanations.

### Decision and stopping rule

- Normally use two contrast rounds and the causal check, with at most three hypothesis-testing rounds total. Batch related measurements. This is an effort guide, not a quota: reuse existing evidence, stop sooner for a narrow follow-up, and explain tool failures instead of repeatedly retrying them. Do not use a shell script to evade this bound.
- **Supported, scoped explanation:** the target/control distinction recurs in at least two fresh phrasings or frames, survives the strongest tested alternative, and any causal claim has intervention support. State it directly within the tested scope. A replicated contribution to a particular continuation can be a complete conclusion without establishing a general computational function.
- **Separate effects:** if both poles replicate but their proposed connection fails the crossed tests, conclude that the evidence supports two context-dependent patterns without an established common function. Do not keep searching for a metaphor that connects them.
- **Effect known, trigger unresolved:** if steering is coherent but natural activation/ablation does not support a trigger, explain the measured output bias and explicitly limit the trigger claim.
- **Unresolved:** if the key controls fail, evidence conflicts, or two successive focused rounds do not change the interpretation, stop. Name the alternatives you could not distinguish and the concrete failed test. “No stable interpretation emerged from these tests” is a useful result. Do not present a speculative label as established or leave the user with an endless research agenda.
- Confidence follows the particular claim, not the amount of work. High confidence in a narrow observed effect can coexist with no conclusion about a general function. Do not upgrade confidence just because the budget was used.

## Discovering and comparing behavioral effects

Use this workflow for benign behavior discovery and safety-focused assessment. Assess observed harmful effects and their limits without optimizing harmful behavior or providing stronger harmful steering recipes.

1. **Define the question before interpreting a winner.** Distinguish observable output behavior, natural activation, and a proposed mechanism. Separate requested traits rather than treating them as interchangeable. For benign comparisons, choose a small, explicit criterion that also checks coherence, task relevance and repetition. A vivid example is not a comparative score.
2. **Retrieve leads, not ranked answers.** `search_lens` searches cached associations across available layers; it is substring matching, not semantic retrieval or a behavior leaderboard. Inspect actual tokens for unrelated matches inside longer words. Its `total` counts neuron/pole entries, not distinct neurons; record returned/truncated counts and how many distinct candidates received live tests. Use cached or activation evidence as leads without equating either with behavior. Missing sweeps or truncated retrieval limit coverage.
3. **Keep comparisons comparable.** On benign tasks, evaluate shortlisted candidates with the same prompts, generation length and intervention convention, baseline and opposite direction. Separate lexical change, task behavior and degeneration. Check finalists on the same fresh prompts before claiming one outperforms another; extra testing of one candidate alone supports replication, not comparative superiority. If budget only permits a screen, report a promising candidate or no clear winner.
4. **Match the measurement to the claim.** Generation supports an induced output effect; raw-text activation tests natural responses in that format. `compare` defaults to raw text while `steer` uses chat, so state material format differences. For a natural causal claim, inspect relevant positions and use matched controls. A first-reply-token `logprobs` check only tests the opening distribution; it cannot establish presence or absence of a later response-level effect. KL reported as zero is rounded, not proof of exact equality. Do not add unrelated opening-token ablations merely to tick a causal-check box.
5. **Bound the work and the headline.** State retrieval scope, candidates tested and validation scope compactly. A model-wide association search is not a model-wide intervention evaluation. Never claim a universal strongest neuron: comparisons are conditional on the specified criterion and tested contexts. Apply the bounded stopping rule above; no automatic escalation to higher doses, upstream searches or combined interventions. Stop when failure, degeneration or diminishing information prevents a useful conclusion.
6. **Report claim-specific support.** Say separately what was observed, whether it generalized to fresh contexts, whether natural function is understood, and whether a comparison was established. The single report confidence field applies to the headline within its explicit scope; explain materially weaker claims in ordinary prose. Prefer a scoped conclusion to a strong headline repaired by a disclaimer. Optional next steps must not hide a missing test essential to the claim.

## Reading each source

- **Steer lens.** Tokens such as `作为` (as a…), `您的` (your, polite), `无法` / `cannot`, `我是一个` (I am a…) appear across a great many neurons. They are a signature of measuring on chat prompts and carry little information about the specific neuron. Weight the remaining, specific tokens.
- **Steer-lens ranking is by gain.** Rare tokens can top the list while moving between one-in-a-billion and one-in-a-hundred-million, so a striking surface pattern there (spelling, sound) can be a shadow of the real direction (`L19 N5504`'s lens is mostly w-words; in logprobs those stay near 1e-9 while `Instead`, `Though`, `其实` "actually" carry the effect). Check absolute probabilities before naming a neuron from a lens pattern.
- **Constant neurons.** A neuron that sits near one value on every token (e.g. `L6 N159` ≈ −0.9 everywhere, delivered by L0 attention) can show a huge steer KL while zeroing or doubling it barely moves the next token. Check `mul 0` and `mul 2` with `logprobs` before reading meaning into its lens.
- **Logit lens.** Most useful in late layers. Specific repeated tokens (`method` × 12, `egg` × 12) are reliable; mixed fragments are noise.
- **Web summary.** Pooled steer-lens words over the cone. A token on both `fed_by` and `held_by` (e.g. `XSS`, `（`, `.`) often reflects pooling; treat shared topical words differently, see "Fed and held by the same topic" below.
- **Weight links (`writes_into`, `reads_from`, cone).** Leads to check, never circuits. Verify any claimed path with activations under ablation; `L22 N3467 → L31 N1348` was a real, causal link whose removal changed nothing in the output.
- **Activation range.** Raw values from a finite reference sample. Exceeding a reference extreme can identify an interesting probe, but does not establish specificity or a detector; matched controls and replication do that.

## Motifs seen in this model

- **Lookahead.** Many neurons fire on the token before the thing they predict: `L25 N4719−` peaks at "r times **the**" before "cosine" (−15) and at "sin² **+**" before "cos²"; `L22 N5826` peaks at "while **the**" before "dashed".
- **Summary positions.** Mood and planning neurons peak on commas, periods, `?`, `</think>` and the blank line before a reply, where attention gathers the text so far. `L22 N3467` (critical warning) reaches 6.2 at `</think>` before an answer to a bleach question.
- **Reads one way, writes the other.** Some neurons fire positive on a topic while their positive direction writes the opposite register: `L18 N8827` fires on lurid content and, pushed positive, makes text gentle and serene; its negative pole is obscenity.
- **Fed and held by the same topic.** A neuron that draws a distinction inside a topic is wired to neurons on both sides of it. `L10 N6032` is fed by `unsafe`, `vulnerable`, `attack` and held by `secure`, `Police`, `FDA`: it marks danger with no safeguard in place.
- **One direction, signed by context (gain control).** `L23 N7748` adds eggs in counted-ingredient slots (+5.75 at "a dozen") and, at −3.3 in "bacon and fried", holds eggs back so `potatoes` and `toast` stay in play. Logprobs confirm both.
- **Distributed triggers.** Planning neurons are often driven by many small inputs plus attention rather than one upstream switch. `L22 N3467`'s 6.2 is spread across L9–L10 MLPs, L17–L18 heads and several safety neurons, with L11–L17 MLPs acting as a brake.
- **High-gain, rare writers.** A huge steer KL with almost no natural firing marks a lever whose trigger lies outside test sentences. `L26 N4405` (KL 7.4) turns any answer into zeros ("A spider has 0 legs") yet fires only weakly on CSS `margin`, with negligible effect there. Label these by effect and mark the trigger as unknown.
- **Meaning over spelling.** `L20 N7531` fires on `is_larger`, `compare`, `ratio`, `differ` but not on `>`, `==` or `max()`; `L25 N4719` ignores words that merely start with "co-".
- **Tone downstream, idea upstream.** A detector can steer into vocabulary without content while its drivers steer into the idea. `L19 N7839−` fires at −12.6 on "the truth they **don't** want you to know" but, pushed, writes "elite elite elite"; its driver `L10 N7757+` (`normal` / `Secret`) alone writes coherent fringe theories ("not part of mainstream history… a secret society").
- **Facts stored in MLPs, moved by heads, worded late.** Gender of a name, list counts and speaker identity are each spread over many early MLP neurons, carried by a few heads, and turned into a word by a late neuron. Heads often read an intermediate token that already holds the fact: L25 h3 reads the verb ("Alice **went**… because"), not the name, to feed the he-veto `L26 N538`. The line-final `\n` of a chat message acts as that message's summary for later heads.
- **Female marked, male default.** The she/he choice runs through one veto neuron for female referents (`L26 N538` blocks he/him/his) and many small pushes for male ones.

## Doses

- 0.5–0.8 shows the direction while keeping text coherent; 1.5–2 often collapses into loops. Last-layer token neurons (e.g. `L29 N1053`, "bro") loop at any dose.
- Pushes add up across neurons; when stacking, scale each one down.

## Writing it up

- Answer the person's current question in plain language. Lead with the best-supported interpretation and a concrete example; scale detail to the conversation.
- Distinguish where the neuron activates from what changing it causes. Explain measurements in context rather than listing scores alone.
- Treat labels as hypotheses. Do not force a one-job/two-job verdict, infer a detector from steering alone, or present opposite poles as proven semantic opposites.
- Separate what was observed, what it suggests, and what remains unknown. Explain the reason for uncertainty; confidence must track the scope and number of tests.
- Finish with the conclusion reached, not a routine request for more testing. Keep the one material limitation visible; put measurement detail in Evidence. Optional next steps should extend the answer, not contain an unperformed test needed to support its headline. Use an empty next-step list when appropriate.

## Reference neurons

- `L10 N6032+`: risky how-to request ("How do I store gasoline?") → caution voice (`我必须` I must, `我无法` I can't).
- `L11 N6261+`: refusal lever; +1.5 moves the first reply token from "I" (99.6%) to "Sure / Yes / Absolutely".
- `L12 N699`: + AI self-limitation ("I can only…"), − bubbly persona ("What a fun day!").
- `L18 N6311`: + frame as a method ("the sourdough method… why this works"), − pontificate about the topic.
- `L18 N8737+`: sexual desire → euphemistic bedroom talk.
- `L19 N7839−`: conspiracy / "the truth they don't want you to know" (−12.6), weak as a steering lever.
- `L19 N9066+`: felt panic (7.3 on exam panic), writes anxious rambling at +0.8.
- `L20 N7531`: comparing amounts → which item / how they rank.
- `L22 N3467`: plans a ⚠️ critical warning before answering a hazardous request.
- `L22 N5826`: a line style comes next (dashed / dotted / broken).
- `L23 N7748`: writes eggs; + counted-ingredient slots, − keeps other foods in play.
- `L25 N4719−`: cosine comes next (x-component → cos).
- `L26 N4405`: writes zero; trigger unknown.
- `L10 N7757+`: fringe-theory narrator ("not part of mainstream history… a secret society").
- `L12 N2920−`: confident endorsement of a bad idea (sycophancy lever).
- `L15 N3920+`: overclaimed evaluation (sarcasm, mock hyperbole) → sarcastic "right?".
- `L18 N7870+`: visual outline / silhouette / "shaped like".
- `L18 N9069+`: bundling a just-listed set ("a combination of these", "the latter two", "both").
- `L25 N6099−`: AI self-identity ("I am / Qwen is a … large language model").
- `L26 N538+`: female referent → vetoes he / him / his; +0.5 turns Einstein into "she".
- Speaker labels: `L4 N2424`, `L12 N2978` (transcript / screenplay label colon) → `L19 N5644−`, `L28 N1501` (an utterance opens).

## Reference heads

- L25 h3: carries a subject's gender to the pronoun slot, reading the verb.
- L18 h18, L19 h11: carry list counts (2–5 items) from commas and "and" to the quantifier.
- L11 h14 and L15 h1/h2/h3/h12/h15: recall the current speaker's own earlier messages, by name.
- L15 h10: reads the previous turn (the message being replied to). L3 h10: pulls in messages similar in style to the current token.
- L11 h3: binds "you" to the addressee named in the message ("Dave, are you…").
- L24 h30: Qwen's third-person self-reference as "she"; ×2 removes "He".

## Practical notes

- `fires` and `top_firing` read the first token matching `token`; for a repeated token such as the final `\n` of a transcript, pass `at` (an index, negative from the end). `attention` and `attn_drive` take `at` too.
