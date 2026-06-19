# From Idea to Shipped Code: Our AI-Assisted Development Process

_A proposal for how we build software — illustrated with a real feature we shipped this week._

---

## The one-paragraph version

We've been running a development process where a human and an AI agent each do what they're best at. The human owns **judgement**: what to build, why, and whether the result is good enough to ship. The AI owns **execution**: turning a settled decision into tested, reviewed code. Between those two sits a chain of four steps — **Grill → PRD → Issues → Build** — that converts a vague idea into shipped software while keeping a human checkpoint at every transition. This document walks through that chain using a real feature, the **Channel Send module**, that went from "this code is a mess" to merged through exactly this process.

> **Read this first if you only read one thing:** the AI never decides *what* matters or *whether it's good enough*. Those are the four human gates marked 🚦 throughout. The AI's job starts only after a human has signed off on the decision, and its work doesn't reach `main` until a human reviews the result.

---

## Why this, instead of "just let the AI write code"?

The failure mode everyone fears with AI coding is: someone types "build me a feature," the AI confidently produces 800 lines, and now you own code nobody understood, scoped, or reviewed. That's not a process — it's a liability.

The opposite failure mode is the one we've always had: good ideas die in the gap between "we should fix this" and "someone has the time to spec it, ticket it, and build it carefully." The spec is in someone's head, the tickets are vague, the implementation drifts from the intent, and nobody writes the tests because the deadline is now.

This process closes both gaps. It forces the *thinking* to happen up front, in writing, with a human pushing back — and only then hands a fully-specified, sliced-up plan to an agent that executes it with discipline (test-first, type-checked, one small change at a time).

---

## The process at a glance

```
   HUMAN THINKING                                    AI EXECUTION
   (judgement, intent, sign-off)                     (disciplined implementation)
   ─────────────────────────────                     ────────────────────────────

   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │  1. GRILL    │──▶│  2. PRD      │──▶│  3. ISSUES   │──▶│  4. BUILD    │
   │              │   │              │   │              │   │ (Sandcastle) │
   │ Interrogate  │   │ Write down   │   │ Slice into   │   │ Agent builds │
   │ the idea     │   │ the decision │   │ shippable    │   │ each issue,  │
   │ until it's   │   │ as a spec    │   │ vertical     │   │ test-first   │
   │ actually     │   │              │   │ bullets      │   │              │
   │ thought      │   │              │   │              │   │              │
   │ through      │   │              │   │              │   │              │
   └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
        🚦                  🚦                  🚦                  🚦
   You resolve every   You approve the    You triage which   You review every
   open question       spec before it     issues are ready   PR before it
   before moving on    becomes tickets    for the agent      merges to main

   Artifacts left behind at each step (all in the repo, all reviewable):
   CONTEXT.md + ADRs   docs/prd/*.md      GitHub issues      Git commits + PRs
```

Each step produces a **durable artifact** — a file or ticket that lives in the repo. Nothing is in someone's head. If a person leaves, the reasoning is still on disk.

---

## The four steps, in detail

### 1. Grill — interrogate the idea until it's actually thought through

**What it is.** Before any code or even any spec, you sit down with the AI and have it *grill you* about the plan. It plays the skeptic: it builds a decision tree of everything that's unresolved and refuses to let you hand-wave. "You said the three channels should behave identically on a crash — do they today? Which one is right? What happens to the half-finished batch?" It keeps going until every branch is resolved.

We use two variants:

- **`/grill-me`** — pure stress-test of a plan or design.
- **`/grill-with-docs`** — the same interrogation, but it also checks your plan against the project's *existing* documented language and decisions, sharpens terminology, and **writes the resolved decisions back into the repo as it goes** — into a glossary (`CONTEXT.md`) and Architecture Decision Records (`docs/adr/`). This is the one to use when the decision touches concepts the team needs to share a vocabulary for.

**🚦 Human gate:** *You* answer the questions. The AI can't resolve them for you — it can only expose them. You decide when the idea is settled enough to write down.

**The artifact:** a sharpened plan, plus (with `/grill-with-docs`) updated `CONTEXT.md` glossary entries and ADRs. These mean the *next* person — human or AI — uses the same words for the same things.

> **Real example.** The Channel Send work started from an architecture review that flagged a smell: email, WhatsApp, and personalised campaigns were three copy-pasted send pipelines that had quietly drifted. Grilling surfaced the decisions that the eventual spec is built on — e.g. *"the email path survives a mid-batch crash by flushing every 25 recipients; WhatsApp and personalised lose the whole batch. Which is correct?"* The grill forced an answer (**all channels should survive a crash**) instead of letting it stay an accident. Terms like **Channel Send**, **Channel Sender**, **Channel**, and **Batch** were pinned down as canonical names at this stage.

---

### 2. PRD — write the decision down as a spec

**What it is.** Once the idea survives grilling, the AI turns the conversation into a **Product Requirements Document** and publishes it to the issue tracker. A PRD here isn't a 40-page Word doc — it's a tight, structured file: the problem statement, the solution, concrete user stories, and the implementation decisions that came out of the grilling.

**🚦 Human gate:** You read and approve the PRD before it becomes work. This is the "is this the right thing to build, and is this spec good?" checkpoint. If the spec is wrong, you catch it here — on one page — not after the code is written.

**The artifact:** a versioned markdown file (e.g. [docs/prd/channel-send-module.md](docs/prd/channel-send-module.md)) and/or a tracking issue. It cites *where the decision came from* ("Source: architecture review, 2026-06-17") so the lineage is traceable.

> **Real example.** The Channel Send PRD states the problem (three drifted pipelines, a channel branch duplicated in five places, two dead bulk-send paths), the solution (one driver owns the batch lifecycle; one thin adapter per channel owns only that channel's send loop), **14 user stories** written from the operator's and developer's point of view, and the precise interface the adapters implement. Anyone can read that file and know exactly what was being built and why — including the AI that will build it.

---

### 3. Issues — slice the spec into shippable vertical bullets

**What it is.** A PRD is too big to hand to an agent in one go. The AI breaks it into **independently-grabbable issues**, each a **tracer bullet** — a thin slice that goes all the way through the system (UI → logic → data, or the equivalent) and *proves one piece works end-to-end* rather than building a horizontal layer that can't be tested on its own.

**🚦 Human gate:** You **triage** the issues — confirm the slices are right, set priorities, and label which ones are `ready-for-agent`. The agent only ever picks up issues a human has explicitly marked ready. Nothing gets built just because it exists as an issue.

**The artifact:** a set of GitHub issues, each small enough to build and review in one sitting, each referencing its parent PRD.

> **Real example.** The Channel Send PRD became a sequence of small, ordered issues, each a safe step:
> - _#12 — Characterization tests pinning the current per-channel output_ (lock in today's behaviour before touching anything)
> - _#10 — Delete the dead bulk-send actions_
> - _#13 — Introduce the Channel Send driver + migrate email_
> - _#14 — Migrate WhatsApp onto the driver_
> - _#15 — Migrate personalised onto the driver_
>
> Notice the order: write tests that pin existing behaviour *first*, delete dead code, then migrate one channel at a time. Each issue is independently reviewable and independently revertable. If #14 had gone wrong, #13 was already safely shipped.

---

### 4. Build — the agent implements each issue, with discipline

**What it is.** This is where **Sandcastle** comes in — our setup for running an autonomous coding agent (we call the agent **RALPH**) in an **isolated sandbox**. RALPH picks the highest-priority `ready-for-agent` issue that isn't blocked, and works it through a fixed loop:

1. **Explore** — read the issue and its parent PRD, read the relevant source and tests *before* writing anything.
2. **Plan** — decide the smallest change that satisfies the issue.
3. **Execute (Red→Green→Refactor)** — write a *failing test first*, then write just enough code to make it pass, then clean up. Test-first is enforced, not optional.
4. **Verify** — run the type-checker and the full test suite; fix anything broken before continuing.
5. **Commit** — one clean commit, prefixed `RALPH:`, listing the decisions made and files changed.
6. **Close** — close the issue with a note on what was done.

It does **one issue per iteration** and runs inside a container, on a temporary branch, so it can't disrupt anyone's working environment. The branch is merged back only when the run completes cleanly.

**🚦 Human gate — the most important one:** RALPH's work lands as **commits and pull requests, not direct pushes to `main`**. A human reviews every PR before it merges. The agent is fast and disciplined, but it is *proposing* changes, not *approving* them. (Tools like our `/code-review` and `/security-review` can do a first pass, but a person signs off.)

**The artifact:** clean, test-backed git commits and PRs you can read, review, and revert.

> **Real example.** Every `RALPH:` commit in our history is one issue, built this way:
> ```
> 42f715b RALPH: Recipient Selection module — explicit (hand-picked) path end-to-end (#19)
> d75a8b3 RALPH: Migrate personalised onto the Channel Send driver (#15)
> b3ff125 RALPH: Migrate WhatsApp onto the Channel Send driver (#14)
> 04da33d RALPH: Introduce the Channel Send driver + push-based Channel Sender, migrate email (#13)
> 5aa20ac RALPH: Collapse the five copied channel conditionals into one dispatch helper (#11)
> ce74cbe RALPH: Characterization tests pinning per-channel per-recipient output (#12)
> ```
> Each one is a small, reviewed, test-backed step. Read top to bottom, they tell the story of the whole refactor — exactly the plan from the PRD, executed one tracer bullet at a time.

---

## The whole thing, end to end (the Channel Send story)

Putting the four steps together with one real feature:

| Step | What happened | Where it lives |
|------|---------------|----------------|
| **Trigger** | An architecture review flagged that three campaign-send pipelines had been copy-pasted and drifted; a crash mid-send lost progress on two of three channels. | Architecture review, 2026-06-17 |
| **1. Grill** | We interrogated the plan: which crash behaviour is correct? What's the seam between "the batch lifecycle" and "a channel's send loop"? Named the concepts. | `CONTEXT.md` glossary, ADRs |
| **2. PRD** | Wrote the spec: one **Channel Send** driver owns the lifecycle; one thin **Channel Sender** per channel. 14 user stories. Approved. | [docs/prd/channel-send-module.md](docs/prd/channel-send-module.md) |
| **3. Issues** | Sliced into ordered tracer bullets: pin behaviour with tests → delete dead code → migrate email → WhatsApp → personalised. Triaged and marked ready. | GitHub issues #10–#15 |
| **4. Build** | RALPH built each issue test-first in a sandbox, one per iteration; each landed as a reviewed `RALPH:` commit. | Commits #11–#15 |
| **Result** | A mid-batch crash now survives on *every* channel; adding a new channel means writing one adapter, not editing five places. Drift is gone. | Merged to `main` |

The same trail exists for two other modules built this way — **Contact Query** and **Lead Query** — so this isn't a one-off; it's a repeatable pattern.

---

## A reusable template (apply this to anything)

For any non-trivial piece of work, the team can follow the same five lines:

```
1. GRILL    →  /grill-with-docs   (or /grill-me)
   Sit with the AI. Answer every hard question. Pin the vocabulary.
   STOP when: every open question on the plan has a decided answer.

2. PRD      →  /to-prd
   Let the AI write the spec from the grilled conversation. Read it.
   STOP when: you'd be comfortable handing this one page to a new hire.

3. ISSUES   →  /to-issues  +  /triage
   Slice into tracer bullets. Order them so each is safe to ship alone.
   STOP when: each issue is small, end-to-end, and labelled ready-for-agent.

4. BUILD    →  Sandcastle / RALPH
   Agent builds one issue per iteration, test-first, in a sandbox.
   STOP when: you've reviewed the PR. Only then does it merge.

5. REVIEW   →  /code-review, /security-review, human sign-off
   A person owns the merge button. Always.
```

**Rule of thumb for what skips steps:** a typo fix or a one-line tweak doesn't need a PRD. But anything that touches a shared concept, changes behaviour users notice, or will outlive the person writing it should go through the full chain. The cost of the chain is an hour of thinking up front; the payoff is a written trail and code you didn't have to hand-write or hand-debug.

---

## What changes if we adopt this

**For the work:**
- The *thinking* happens before the *building*, in writing, where it's cheap to change.
- Every decision leaves a durable artifact. Onboarding and handover stop being oral history.
- The implementation can't drift from the intent, because the intent is a spec the builder reads.
- Tests come first, by construction — not "if there's time."

**For speed:**
- The slow, careful part (deciding what's right) is done by the person, once.
- The mechanical part (writing tested code for a settled spec) runs autonomously, and can run while you do other things.

**For control:**
- Four explicit human checkpoints. The AI never decides what matters or whether the result ships.
- Everything is normal git and normal issues — reviewable, revertable, auditable. No black box.

---

## Honest risks, and how the process controls them

| Risk | Control built into the process |
|------|-------------------------------|
| "The AI builds the wrong thing." | It only builds from an *approved PRD*, sliced into *triaged issues*. Wrong things get caught at the spec gate, on one page. |
| "The AI writes plausible-but-broken code." | Test-first (RGR) + type-check + full suite must pass before commit. And a human reviews every PR. |
| "It runs wild and breaks our environment." | It runs in an isolated sandbox, on a temporary branch, one issue at a time, merged back only on a clean run. |
| "Nobody understands the code afterwards." | Each change is small, references its PRD, and ships as a readable commit. The reasoning trail (grill → PRD → issue) is on disk. |
| "We become dependent on a tool we don't control." | The artifacts are vendor-neutral: markdown specs, GitHub issues, git commits. The process survives any tool change. |

---

## How to try it (a low-risk first run)

Pick one well-bounded, annoying-but-not-critical piece of work. Run it through all four steps with a person watching each gate. Compare the result — the spec, the issues, the reviewed PRs — against how that work would normally have gone. The Channel Send, Contact Query, and Lead Query modules are three examples already sitting in this repo to point at.

---

_Process artifacts referenced in this document:_
- _Grilling & docs: [CONTEXT.md](../CONTEXT.md), `docs/adr/`_
- _PRDs: [docs/prd/channel-send-module.md](docs/prd/channel-send-module.md), [docs/prd/contact-query-module.md](docs/prd/contact-query-module.md), [docs/prd/lead-query-module.md](docs/prd/lead-query-module.md)_
- _Agent setup: [.sandcastle/main.mts](../.sandcastle/main.mts), [.sandcastle/prompt.md](../.sandcastle/prompt.md)_
- _Build trail: `git log --grep="RALPH"`_
