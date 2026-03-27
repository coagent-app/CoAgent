# CoAgent Roadmap

## Now
- [x] Voice pill — expanded response bar, 2-sentence preview, markdown stripped
- [x] OpenAI TTS — voice read-back of agent responses
- [x] Web search — agent can now search the web via Composio tools
- [x] Cache optimization — call_external_tool proxy, 1h TTL
- [x] Integration detail view — click-to-expand with description, capabilities, connect
- [x] 117 integrations organized by category

## Next
- [ ] **Skills page** — user-facing UI to view, edit, create, and toggle skills
- [ ] **WhatsApp channel** — text your agent from your phone, Composio has a WhatsApp toolkit
- [ ] **More triggers** — event updated/cancelled, Slack reactions, email replies, form submissions
- [ ] **Add 30 new integrations** — bonsai, webflow, wix, front, fireflies, signwell, everhour, etc.
- [ ] **Calendar sync** — two-way sync between CoAgent calendar and Google Calendar

## Later
- [ ] **MCP creation** — agent builds its own integrations from API docs. User provides API key, agent scaffolds an MCP server, installs and connects it. Requires web search + MCP template system.
- [ ] **Cloudflare Workers** — per-user agent instances, centralized auth/billing, multi-tenant infrastructure. Foundation for hosted product.
- [ ] **Web/mobile app** — hosted version of CoAgent on Cloudflare. Users sign up, get their own agent without installing anything. Depends on Cloudflare Workers infra.
- [ ] **Tauri auto-updater** — push updates to desktop users without manual reinstall
