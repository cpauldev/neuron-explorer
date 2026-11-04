# Neuron explanation prompt evaluation

The change targets investigation completeness and calibrated stopping, rather than higher confidence labels.
The original instructions encouraged a common story, exceeding sampled activation extremes, and suggesting
another test. The revised instructions require competing hypotheses, matched contrasts, fresh examples,
an intervention check for output claims, and a bounded decision. Optional next steps must extend a conclusion.

## Live results

All completed runs used the local Qwen3.5-4B and the Codex CLI-default assistant setting, in fresh chats.
No provider/model preferences or existing conversations were changed by the evaluation script.

| Run | Contrasts | Output checks | Outcome | Time |
| --- | --- | --- | --- | --- |
| Original prompt, L19 N8930 | 28 texts in 2 compare calls | 1 logprobs call; 1 steering call | Supported candidate patterns, but deferred the central amount-versus-deservedness contrast to a next step | 83.2 s |
| Revised prompt, L19 N8930 | 34 texts in 2 compare calls | 3 logprobs calls, including a deserved-treatment control | Tested fresh frames, concluded separate scoped numerical-change/unfair-treatment patterns and small natural output effects; no next steps | 93.3 s |
| Revised prompt, L0 N17 | 30 texts in 2 compare calls; 2 token traces | 4 logprobs calls | Rejected simple boiling/function-word/script labels, reported low confidence and no stable semantic interpretation; stopped with no next steps | 56.7 s |

The first revised L19 attempt hit the provider usage limit before producing findings. It is a failed run,
excluded from the quality comparison. A later retry initially found the local server stopped; no explanation
ran on that attempt. The completed L19 run retried its findings presentation once because the first summary
exceeded the existing tool limit. A compact-summary instruction was then added; L0's report succeeded on its
first presentation attempt. The scientific investigation instructions were otherwise the same in those two runs.

## Assessment and limits

The revised L19 answer is more complete because it performs the central disambiguation and evaluates natural
output contribution before concluding. It does not discover a unified meaning for both poles, and it says so.
The L0 check demonstrates that the workflow can reject interpretations and stop without manufacturing a label.
Both reports distinguish observations, interpretations and untested generalizations.

These are small qualitative trials, not a benchmark or proof of reliability. The assistant model was the CLI
default, not a pinned model/seed; generations are stochastic. Different probes also produce different activation
extremes, so their raw maxima should not be compared as a quality score. Test counts and confidence alone do not
establish correctness. Further evaluation should include additional neurons and repeated trials before claiming
a general improvement rate.

Reproduce with `scripts/evaluate_neuron_explanation.py`; see the development guide. Local artifacts under
`output/evaluations/` preserve prompt snapshots, complete tool histories, successful reports and terminal status.
The harness excludes rejected report attempts from its successful reports and exits nonzero for incomplete runs.

## Browser trials and iteration

Six fresh explanations were submitted through the actual chat composer, with the local model loaded.
The evaluation script only observed these UI-submitted chats. All six completed with findings:

| Artifact label | Neuron | Turn time | Outcome |
| --- | --- | --- | --- |
| ui-clear-l22-a | L22 N5826 | 55.7 s | Medium confidence: contributes to line-style descriptions; context-dependent ablation effects |
| ui-ambiguous-l0-a | L0 N17 | 68.5 s | Low confidence: no stable semantic interpretation; stopped |
| ui-unseen-l17 | L17 N2048 | 86.4 s | Medium confidence in a scoped capitalization bias under negative steering; natural trigger remains uncertain |
| ui-conflicting-l19 | L19 N8930 | 104.4 s | Medium confidence in an unfair-treatment contribution; no unsupported unified meaning across poles |
| ui-clear-l22-b | L22 N5826 | 65.3 s | Repeated the line-style conclusion, including contradictory directional effects in different contexts |
| ui-ambiguous-l0-b | L0 N17 | 64.6 s | Again declined a semantic label after fresh contrasts and two ablation contexts |

The methodology's amount/deservedness example was removed before these trials to avoid tailoring the
instructions to L19 N8930. L22 is a reference example in the methodology; L17 was an additional case outside
that list. The repeats used unchanged investigation instructions, with a small report-format refinement:
after L19's first report was rejected for a source label over 60 characters, the prompt requested short
source labels. The assistant corrected that rejection itself; both subsequent reports succeeded first try.

A follow-up in the second L22 chat asked for the simplest takeaway using existing tests. It answered in
two short paragraphs, retained moderate confidence and the counterexample, and ran no new tools. Its
history is saved separately as `ui-clear-l22-b/followup-history.json`.

Browser testing found two related presentation issues, now covered by UI regression tests: completed
investigations without next steps offered “Explain selection” again (including after a plain-text follow-up),
and rejected findings tools appeared as successfully used. Completed relevant reports now suppress the
repeat starter across the conversation; errored tools show a failed state. The relevant UI suite passes
59 tests and the production build passes.

Both repeats agree at the useful level of scope: the clear case has a reproducible contribution, while
the ambiguous case remains unresolved. Every report had an empty next-steps list; this alone is not a
quality metric. The reports were reviewed for contrasts, counterexamples, interventions and calibrated
claims. These six stochastic trials are encouraging qualitative evidence, not a general reliability rate
or proof that the inferred functions are exhaustive. Further prompt changes should respond to observed
failures rather than simply force longer investigations or higher confidence.

## Discovery/comparison audit and revision

An audit of the existing hostility investigation found valid generation controls and appropriately limited
natural-function claims, but weak support for a strongest-candidate headline. Search used lexical substring
matches (including unrelated longer words), only five candidates received a common initial test, and only
the chosen candidate received fresh generation checks. The two ablations measured opening-token distributions,
not later response-level behavior. No new harmful-behavior optimization was run for this audit.

The discovery workflow now distinguishes retrieval coverage, comparable live screening, fresh finalist
validation and natural-function explanation. It requires quality costs to remain separate from target effects,
limits comparative headlines to their actual evidence, treats rounded zero KL as approximate, and disallows
irrelevant opening-token checks as a substitute for measuring the claimed effect. The older automatic dose
escalation, driver search and stacking instructions were removed. The MCP search description now explains
substring false matches, lexical ordering, truncation and neuron/pole counts. Search behavior itself is unchanged.

`benign-discovery-comparison` tested music-topic steering via the backend chat path in a fresh conversation.
The request explicitly asked for a bounded screen, fresh validation and quality distinctions, so it is an
instructed evaluation rather than an unprompted reliability test. It completed in 160.1 seconds with one search,
ten generation comparisons and one successful findings call. Three candidates received the same two screening
prompts; both finalists received the same two fresh prompts at matching settings. One finalist inserted music
into a factual explanation and made it false. The report recognized that tradeoff, selected a scoped useful lead,
and declined to establish an overall strongest neuron. It made no natural-function claim and added no unrelated
ablation calls. The saved raw results support those distinctions.

`benign-discovery-natural` then used only: “Can you find the neuron that makes the model talk about music?
Try to find the strongest one.” It completed in 171.6 seconds with one search, eighteen generation comparisons
and one successful findings call. Six candidates received identical evening/park screening prompts; three
finalists received identical fresh focus-tip/cafe prompts, matching generation settings within each stage.
The report distinguished heavier topic displacement from useful, relevant music-themed output, explicitly
flagged malformed wording and repetition, and reported retrieval scope (40 of 206 pole entries) and live scope
(six candidates). It declined a universal strongest claim and limited its interpretation to induced output
biases. Inspection of the fresh outputs confirmed the quoted effects and quality costs.

Both trials used unchanged prompt snapshots and the CLI-default assistant, through API-submitted fresh chats,
not browser submissions. Neither optimized harmful output. Both reported medium confidence and no next steps.
They do not establish general reliability or a global ranking: one was explicitly instructed, both concern one
benign topic, generations are greedy and truncated, and the assistant configuration is not a pinned seed/model.
The bounded screen also missed candidates that appeared in the broader screen, illustrating why retrieval
and tested scope must remain explicit. Nine assistant-common unit tests and Python syntax checks passed;
no frontend changes were made in this phase.

## Timed activity and public progress UI

Two subsequent trials were submitted through the browser composer to check the revised activity presentation.
`ui-timed-activity` completed an explanation in 70.1 seconds and displayed a settled “Worked for 1m 8s”
at the successful findings boundary. `ui-timed-milestones` completed a benign music discovery in 184.9 seconds,
with real public updates at 11.9, 69.4 and 130.1 seconds after submission. Its final header read “Worked for
3m 2s”; expanding it restored all three updates and compact tool groups, while the findings remained outside.
Screenshots preserve the live and completed states in each trial's output directory.

Public updates are model-authored summaries of actual progress, requested at milestones and roughly every
30–60 seconds of extended work; this is not a guaranteed heartbeat during a blocking tool call. The UI removes
the changing one-line activity preview, keeps detailed tool results collapsed during work, and automatically
collapses progress when the final answer starts. Timings replay from persisted journal events; successful
findings and explicit final-answer phases freeze work duration independently of final streaming completion.
Stopped/failed states remain distinct. Focused UI and journal validation passes 76 tests; the production build
and Python syntax check pass. The initial live check exposed overly large inline tool results, leading to
nested official tool groups before the longer verification trial.
