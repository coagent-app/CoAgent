# Kill Research Store — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the research store and auto-save. Research goes to memory. One system.

**Architecture:** Delete research-store.ts, strip research tool to just save_lead_schema (moved to exa tool), remove autoSave() calls, update system prompt.

**Tech Stack:** TypeScript, MCP server (mcp-exa)

---

### Task 1: Remove autoSave and research-store imports from index.ts

**Files:**
- Modify: `packages/mcp-exa/src/index.ts:19` (remove import)
- Modify: `packages/mcp-exa/src/index.ts:110-164` (remove autoSave function)
- Modify: `packages/mcp-exa/src/index.ts:252` (remove autoSave call in search)
- Modify: `packages/mcp-exa/src/index.ts:274` (remove autoSave call in find_similar)
- Modify: `packages/mcp-exa/src/index.ts:288` (remove autoSave call in get_contents)

**Step 1:** Remove the import line:
```typescript
// DELETE: import { saveResearch, searchResearch, getResearchStats, readResearch } from './research-store.js'
```

**Step 2:** Delete the entire `autoSave()` function (lines 110-164) and the `ExaResultLike` interface (line 107).

**Step 3:** In the search handler (~line 252), remove `const saved = autoSave(...)` and the `${saved}` from the response string.

**Step 4:** In the find_similar handler (~line 274), remove `const saved = autoSave(...)` and `${saved}`.

**Step 5:** In the get_contents handler (~line 288), remove `autoSave(...)`.

---

### Task 2: Kill the research tool, move save_lead_schema to exa tool

**Files:**
- Modify: `packages/mcp-exa/src/index.ts` (remove research tool definition + handler, add save_lead_schema to exa tool)

**Step 1:** Remove the entire `research` tool from the `ListToolsRequestSchema` handler.

**Step 2:** Add `save_lead_schema` as an action on the `exa` tool — add it to the enum and add `fields` + `extractionQuery` params.

**Step 3:** Remove the entire `if (name === 'research')` handler block.

**Step 4:** Add a `save_lead_schema` case inside the `exa` switch block (move the existing logic).

---

### Task 3: Delete research-store.ts

**Files:**
- Delete: `packages/mcp-exa/src/research-store.ts`

**Step 1:** Delete the file.

---

### Task 4: Update system prompt in agent.ts

**Files:**
- Modify: `packages/agent-core/src/agent.ts:627-628`

**Step 1:** Change the Exa section in buildSystemPrompt from:
```
Exa: web search, lead gen, competitor research. research tool queries saved results (free). monitor sets up recurring searches on domains.
```
To:
```
Exa: web search, lead gen, competitor research. After research, save structured findings to memory (e.g. "south-florida-agencies.md"). monitor sets up recurring searches on domains.
```

---

### Task 5: Build and verify

**Step 1:** Build mcp-exa: `npx tsc -p packages/mcp-exa/tsconfig.json`
**Step 2:** Build agent-core: `npx tsc -p packages/agent-core/tsconfig.json`
**Step 3:** Restart backend, verify no errors.
**Step 4:** Commit.
