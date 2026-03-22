# Integrations Modal Design

**Date:** 2026-02-22
**Status:** Approved

---

## Goal

Replace the sidebar's inline "More" expand with a modal that shows all supported integrations. Keep the single-source-of-truth list in `composio-integrations.ts` so adding a new integration later is one line.

---

## Changes

### 1. Sidebar — primary integrations

Replace `STATIC_INTEGRATIONS` and `MORE_INTEGRATIONS` in `Sidebar.tsx` with a single hardcoded list of 6 most-common integrations shown inline. "More" button opens the modal instead of expanding inline.

Primary 6: Gmail, Google Calendar, Google Drive, Notion, HubSpot, Outlook

### 2. IntegrationsModal component

New file: `apps/desktop/src/components/IntegrationsModal.tsx`

- Centered overlay, closes on backdrop click or Escape
- Search input filters by name (client-side)
- Scrollable grid of cards — one per supported integration
- Each card: icon + name + connected status dot + Connect/Disconnect button
- Footer: "Need something else? Request an integration →" (GitHub issues link)

### 3. Single source of truth

`INTEGRATIONS` array in `composio-integrations.ts` is already the canonical list. Sidebar and modal both derive from it — no duplication.

App.tsx passes `integrations`, `onConnect`, `onDisconnect` into the modal (same props already used by Sidebar).

---

## Data flow

```
useAgent() → integrations state
           → connectIntegration(slug)
           → disconnectIntegration(slug)

App.tsx → Sidebar (primary 6 + "More" button)
       → IntegrationsModal (all integrations, open/close state)
```

No new backend messages needed.

---

## Extensibility

To add a new integration later:
1. Add `{ slug, name }` to `INTEGRATIONS` in `composio-integrations.ts`
2. Add icon to `INTEGRATION_ICONS` in `Sidebar.tsx`
3. Optionally add trigger slugs to `TRIGGER_MAP`

That's it — the modal picks it up automatically.
