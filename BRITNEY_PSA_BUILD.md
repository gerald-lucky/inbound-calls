# Britney → Property Support Agent (PSA): Build Plan & Handoff

> **Status:** Planning complete, implementation not yet started.
> **Last session:** 2026-05-28 (initiated by alex@luckycommunities.com)
> **Branch:** `claude/lucid-maxwell-jN9vk`
>
> This document is the source of truth for turning Britney from a basic
> inbound-call/Slack assistant into a full **Property Support Agent (PSA)** that
> handles customer service calls for Lucky Communities, is trained on our SOPs,
> and both reads from **and writes to** Rent Manager (our CRM).

---

## >> FIRST THING WHEN YOU OPEN THIS SESSION

Re-prompt the team with the same decision we paused on. Ask:

**"Where do you want me to begin?"**
1. **Upload materials, build persona + knowledge** — Upload the PSA job
   description + SOPs now; start Phase 1 (persona) and Phase 2 (knowledge
   ingestion). Most direct path to a working PSA.
2. **Build the plumbing first** — Build the SOP ingestion pipeline +
   `search_knowledge` tool and consolidate the read toolset now (no materials
   needed yet), then add content.
3. **Write a detailed design doc first** — Full technical design for all phases
   before any code.

(The RM write scope below is already decided — see "Decisions made".)

---

## What Britney is TODAY (verified in code)

There are **two separate Britneys** on different brains:

| | Phone agent (`backend/src/services/llm.js`) | Slack staff bot (`backend/src/services/slack-bot.js`) |
|---|---|---|
| Persona | Generic prompt in `agent_configs` DB table (`system_prompt`/`greeting`), env-var fallback | Hard-coded "Britney" prompt (line 9) |
| RM tools | **3**: `lookup_resident`, `get_payment_history`, `generate_cashpay_code` | **12**: + contacts, history notes, service tickets, vacancy, vendors, recurring charges, documents, etc. |
| Audience | Customer-facing (callers) | Staff-facing |

**The phone Britney — the one that becomes the PSA — is the *least* capable of
the two.** The richer toolset already exists in the Slack bot and should be
consolidated into a shared module.

### Key facts confirmed
- **Rent Manager is effectively read-only today.** `rent-manager.js` has a
  generic `rmPost` helper (line 63), but every wired function only *reads*.
  Nothing creates a work order, updates contact info, or adds a note. There is
  no `rmPut`/`rmPatch` helper. **Write access is genuinely new work.**
- **SOP knowledge base is scaffolded but UNUSED.** `supabase/migrations/001_initial.sql`
  created pgvector tables `documents` + `document_chunks` (1536-dim embeddings)
  and a `match_documents()` SQL function. **Nothing in `backend/src/` references
  them** — the RAG plumbing is half-built and waiting.
- **No identity verification.** Any caller can have an account looked up today.
  Before the PSA reads PII or writes to the CRM, she must verify the caller.
  This is a security AND fair-housing/compliance concern.
- **No real payment processor.** `backend/src/routes/payments.js` only logs
  payments into a Supabase table. The only payment integration is Zego CashPay
  (cash at Walmart/CVS). **"Take payments over the phone" requires integrating a
  real card/ACH rail with PCI-DSS handling — the heaviest item on the list.**

### Architecture / call flow
```
Twilio WS → TranscriptionService (Scribe STT)
          → LLMService (Claude Sonnet 4.6, llm.js)  ← persona + tools live here
          → TTSService (ElevenLabs)
          → Twilio WS
```
- `backend/src/call-session.js` orchestrates one call; resolves persona from
  `agent_configs` by Twilio number (`configId` custom param), falls back to env.
- `backend/src/services/agent-configs.js` = CRUD over `agent_configs` (Supabase).
- Model: `claude-sonnet-4-6` in both `llm.js` and `slack-bot.js`.

---

## The 6-Phase Plan

### Phase 1 — Define the PSA (BLOCKED on job description)
Turn the JD into a structured system prompt: role, scope of what she handles,
tone, and **escalation rules** (when to hand to a human, what she must NOT do).
Replaces the thin generic prompt. Decide: keep persona in `agent_configs` DB row
vs. promote to a versioned prompt in code. Recommendation: structured prompt in
code/config, version-controlled, so changes are reviewable.

### Phase 2 — Train on SOPs (BLOCKED on SOPs / training material)
The pgvector scaffolding already exists. Build:
- An **ingestion pipeline**: chunk SOP docs → embed (1536-dim; OpenAI
  `text-embedding-3-small` or equivalent — confirm embedding provider/key) →
  store in `documents`/`document_chunks`.
- A **`search_knowledge` tool** wired into the agent loop, backed by
  `match_documents()`.
- Split: core always-applies policy → system prompt; long-tail SOPs → searchable
  knowledge.

### Phase 3 — Full read access (no external blockers)
Consolidate the duplicated tool definitions in `llm.js` and `slack-bot.js` into
**one shared tools module**, then give the phone PSA the full read toolset —
scoped to what a *customer* is allowed to see (NOT staff-only data). Decide the
customer-facing allow-list (e.g. own balance/payment history yes; other
residents, vendor lists, full vacancy reports — likely no).

### Phase 4 — Rent Manager writes (careful; gated by Phase 5)
Add a write helper (`rmPut`/`rmPatch` as needed) + specific, allow-listed
actions. Each write: confirm-before-commit (read back to caller) + audit log.
**Decided write scope (see below).** Investigate exact Rent Manager API
endpoints for each (Issues/ServiceManager, Contacts/PhoneNumbers, History notes).

### Phase 5 — Identity verification + compliance guardrails
Gates Phases 3 & 4. Verify caller identity before exposing PII or writing
(e.g. match caller phone to account + knowledge-based check). Enforce org policy:
never share financial/resident data externally; fair-housing-safe language;
recommend consulting team leader on eviction/legal topics.

### Phase 6 — Test against SOP-derived scenarios
Scenario test suite before live calls. Include adversarial/identity-spoofing and
"refuse and escalate" cases.

---

## Decisions made (2026-05-28)

**RM write capabilities the PSA should eventually have** (all gated behind
identity verification + confirmation):
- ✅ **Take payments over the phone** — ⚠️ NEW PAYMENT RAIL + PCI-DSS. No real
  processor today (only Zego CashPay). Largest sub-project; treat as its own
  workstream. Do NOT have Claude/the app touch raw card numbers — use a
  PCI-compliant processor (e.g. tokenized IVR/DTMF capture, or hand-off to a
  payment provider). Needs a compliance decision before building.
- ✅ **Create service tickets** (work orders) in Rent Manager.
- ✅ **Update contact info** (resident phone numbers / emails).
- ✅ **Add history notes** (call notes) on the account.

---

## What we need from the team to unblock
1. **PSA job description** (drives Phase 1 persona + escalation rules).
2. **SOPs / training material** (drives Phase 2 knowledge ingestion).
   Preferred formats: clean text/Markdown/PDF, one topic per doc where possible.
3. **Embedding provider decision** for Phase 2 (which API key/model for the
   1536-dim embeddings the schema expects).
4. **Payment compliance direction** for Phase 4 (which processor; how cards are
   captured) before any payment code is written.
5. **Customer-facing read allow-list** confirmation for Phase 3.

---

## Relevant files (quick map)
- `backend/src/services/llm.js` — phone agent brain, tools, agentic loop.
- `backend/src/services/slack-bot.js` — staff bot, the 12-tool superset.
- `backend/src/services/rent-manager.js` — RM API client (`rmGet`/`rmPost`,
  all read functions, `module.exports` at bottom).
- `backend/src/services/agent-configs.js` — persona CRUD (Supabase).
- `backend/src/call-session.js` — per-call orchestration + persona resolution.
- `backend/src/routes/payments.js` — Supabase-only payment log (no processor).
- `supabase/migrations/001_initial.sql` — UNUSED pgvector RAG scaffolding.
- `supabase/migrations/002_routing_and_analytics.sql` — `agent_configs`, `calls`,
  `leads` tables.
- `backend/.env.example` — current env/config surface.
