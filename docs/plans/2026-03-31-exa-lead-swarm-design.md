# Exa Lead Swarm Protocol — Design

## Goal

Teach the CoAgent agent a parallel lead discovery protocol using Exa's search + findSimilar APIs. The agent chains existing Exa tools via system prompt guidance — no new hard-coded orchestration tool. We add leads storage + dedup so results persist.

## Architecture

**System prompt protocol** — instructions in the agent's system prompt that teach it the swarm pattern. The agent already has `exa_search` and `exa_find_similar` via Composio. The protocol tells it WHEN and HOW to chain them.

**Leads storage** — `~/.coagent/research/leads.json` stores all discovered leads. Auto-saved after each swarm. Deduped by domain.

## The Swarm Protocol (2 Rounds, Parallel)

### Round 1: Parallel Seed Swarm

Agent fires ALL initial queries simultaneously:

```
User: "find competitors to steadyautogrowth.com"
              |
    ┌─────────┼─────────┐─────────┐
    v         v         v         v
 search    search    search   find_similar
 angle1    angle2    angle3    (from URL)
    |         |         |         |
    └─────────┴─────────┴─────────┘
              |
         dedup by domain
              |
     present results, ask to expand
```

- Agent generates 3-4 search angles + find_similar from URL (if provided)
- Fires them ALL in parallel (Composio supports parallel tool calls)
- Dedup by domain across all results
- Presents: "Found 32 businesses from 4 parallel searches"
- Asks: "I can expand by: (1) Find similar to top results, (2) Search more angles, (3) Both (~$0.03). Which?"

### Round 2: Chained Expansion (Parallel)

```
     top 3-5 unique results
    ┌─────┼─────┐
    v     v     v
  f_sim  f_sim  f_sim    <- parallel find_similar
    |     |     |
    └─────┴─────┘
         |
    final dedup + enrich
         |
    auto-save to leads.json
```

- Take top 3-5 most promising results from Round 1
- Run find_similar on each — in parallel
- Final dedup across everything
- Enrich with company profiles
- Auto-save to leads.json
- Report: "Saved 47 leads. 8 API calls, ~$0.05"

### Key Behaviors

- **Parallel by default** — never run searches sequentially when they can run simultaneously
- **Ask before Round 2** — user sees Round 1 results and chooses expansion strategy
- **Auto-save** — results always saved to leads.json after completion
- **Cost-aware** — agent reports API calls + estimated cost
- **Exa-aware** — agent knows what Exa is good at (public data, companies, filings) and bad at (private intent signals) and guides users accordingly

## Lead Schema

```json
{
  "id": "uuid",
  "company": "Steady Auto Growth",
  "domain": "steadyautogrowth.com",
  "url": "https://steadyautogrowth.com",
  "phone": null,
  "email": null,
  "address": null,
  "employees": null,
  "revenue": null,
  "industry": "Digital Marketing",
  "linkedin": null,
  "summary": "AI-generated summary from Exa",
  "source": "find_similar",
  "query": "the query that found this lead",
  "round": 1,
  "foundAt": "2026-03-31T10:00:00Z",
  "notes": "",
  "tags": []
}
```

## System Prompt Addition

The agent's system prompt gets a new section — the Lead Swarm Protocol:

1. **When to activate**: user asks for leads, competitors, businesses, market research, "find me X"
2. **Round 1**: generate multiple search angles from the user's request + find_similar if URL given. Fire ALL in parallel. Dedup. Present results with count + cost.
3. **Expansion offer**: transparently present options — find similar, more angles, or both. Include estimated cost.
4. **Round 2**: if approved, chain find_similar on top results in parallel. Dedup. Enrich.
5. **Auto-save**: always save results to leads storage. Tell user the count.
6. **Exa guidance**: know what works (public data, company profiles, filings, news) and what doesn't (private intent, individual buyers/sellers). Steer users toward effective queries.

## Storage

```
~/.coagent/research/
  leads.json     — array of Lead objects
```

Built-in tools for the agent:
- `save_leads(leads[])` — dedup by domain, append to leads.json
- `search_leads(query)` — search existing leads
- `get_lead_stats()` — count, sources, recent additions

## Cost Model

- Round 1 (4 parallel searches): 4 calls = $0.028
- Round 2 (find similar on top 3): 3 calls = $0.021
- Full swarm: ~7 calls = ~$0.049
- With enrichment: +$0.001/page for contents
- Typical full swarm with enrichment: ~$0.06

## What This Does NOT Include (Yet)

- Research tab UI (future)
- Exa monitors / automated funnels (future)
- Custom Exa MCP server (future — using Composio tools for now)
- Webhook integration (future)
