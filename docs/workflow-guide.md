# Workflow guide

Principles for workflows that produce work you can trust. Each one comes from a
failure seen in practice.

## Proof

- **Prove, don't claim.** What counts is evidence: a run, a screenshot, a
  recording. An agent's summary is not evidence.
- **The author never judges its own work.** Testing and review are separate
  sessions that did not write the change.
- **Test the real thing.** Drive the running app the way a user would. Unit
  tests show code paths, not that a bug is gone.
- **Reproduce before fixing.** A bug fix starts by showing the failure on the
  base branch, then the same check passing on the branch.
- **A verdict belongs to one commit.** Any new commit, including an update from
  the base branch, voids it.
- **Nothing edits what judges it.** Changes to the kit, CI or protected tests
  always go to a human.

## Agreement

- **Agree the outcome, not the implementation.** A plan carries acceptance
  scenarios the tester can run. For UI, a clickable prototype beats prose.
- **Questions that running something can answer are the agent's.** Only product
  and taste questions reach a human.
- **Thin vertical slices.** Each ticket or phase should fit in one fresh
  session and work end to end.

## Flow

- **One fresh session per step.** Pass artifacts and the branch, never a
  conversation.
- **Route on typed outcomes,** never on free text.
- **Every loop has a limit.** Running out means "needs you" with everything
  attached, or an explicit route such as opening the PR with notes.
- **Review once.** A fresh reviewer always finds one more thing; block only on
  serious findings and let the author decline the rest in writing.
- **Agents propose, the system acts.** Only system steps push, open pull
  requests or merge.

## Decisions and merging

- **Hard rules first.** Paths that always need a human (migrations, the kit, CI)
  are rules, not judgements.
- **Decisions only choose within the rules,** and below the confidence band
  they go to a human.
- **Decide on facts, not prose.** Build a decision's input from file paths,
  diff statistics and test results, never from an agent's description of its
  own change.

Repository auto-merge is off by default. Turn it on in Repositories to let the
system ask a merge-safety decision after proof, CI and the live gate pass. An
acted `merge` answer merges automatically. A confirm-band `merge` offers **Merge**
(the system performs it) or **I’ll review**. An `owner` choice, low confidence,
missing TypeSafe key or request error leaves merging with you on GitHub. The
factory asks once per PR head; every actual merge checks fresh facts and matches
that exact head. Hard rules still require you for migrations, kit and CI changes,
untested workflows and invalid trusted kits, whatever a decision says.

`maintain-pr.with.ciSettleMinutes` defaults to 3: absent checks wait briefly after
a push so late CI can register and use the `ci-failed` route.
`maintain-pr.with.maxBaseSyncs` defaults to 3: repeated base advances then park
for you with a summary. Retry (or move the ticket) to reset the count.

After any PR merge, background checks watch the merge commit on the default
branch. Repositories with no CI use the kit check in a disposable checkout.
Failures create one bug ticket per merge commit and link it from the original
timeline; other tickets continue running.

## Learning

- **Lessons become checks.** A repeated mistake becomes a test, lint or script,
  not another paragraph of instructions.
- **Measure by interruptions.** A good workflow is one where you rarely step in
  after a ticket says it is ready.

## Showing work to people

- **Show only what needs a person.** Done work collapses out of the way.
- **Draw a workflow as a list with loops.** Back-edges are labelled loops;
  everything else follows the order.
