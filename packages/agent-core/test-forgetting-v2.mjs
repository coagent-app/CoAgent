// V2: Embedding-driven forgetting — score by relevance to current prompt
// The embedding of the current user message decides what to forget

import { pipeline } from '@huggingface/transformers'

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Minimal heuristic — ONLY detects pure filler, nothing else
function isObviousFiller(text) {
  const t = text.trim().toLowerCase()
  return /^(ok|okay|sure|thanks|thank you|got it|yeah|yes|nice|cool|sounds good|great|perfect|alright|yep|yup|no problem|exactly|hmm|hey|hi|hello|good morning|good afternoon)[\s!.]*$/i.test(t)
}

// Score = how relevant is this message to what the user is asking RIGHT NOW
function computeRetention(msgEmbedding, promptEmbedding, msg, index, total) {
  const relevance = cosine(msgEmbedding, promptEmbedding)

  // Recency boost — recent messages get a small nudge
  const recency = index / total * 0.15

  // Filler penalty — only for obvious filler
  const fillerPenalty = isObviousFiller(msg.text) ? -0.5 : 0

  // Tool result slight penalty (raw output, not the summary)
  const toolPenalty = msg.text.startsWith('[Tool:') ? -0.05 : 0

  return relevance + recency + fillerPenalty + toolPenalty
}

// ═══════════════════════════════════════════════════════════════
// TEST SCENARIOS — same ones that failed before
// ═══════════════════════════════════════════════════════════════

const scenarios = [
  {
    name: "Test 1: Short Constraints (previously FAILED)",
    description: "Critical facts in 2-3 word messages. Previous heuristic-only approach: 2/6 kept.",
    currentPrompt: "Find me properties matching my criteria",
    windowSize: 6,
    conversation: [
      { role: 'user',      text: "Hey can you help with something?" },
      { role: 'assistant', text: "Of course! What do you need?" },
      { role: 'user',      text: "Budget is $200k." },                    // MUST KEEP
      { role: 'user',      text: "Max 3 bedrooms." },                     // MUST KEEP — was LOST before
      { role: 'user',      text: "Westside only." },                      // MUST KEEP — was LOST before
      { role: 'assistant', text: "Got it — searching for properties: Westside, 3 bed max, $200k budget." },
      { role: 'user',      text: "No HOA." },                             // MUST KEEP — was LOST before
      { role: 'user',      text: "Must have garage." },                   // MUST KEEP
      { role: 'assistant', text: "Added constraints: no HOA, must have garage. Searching now." },
      { role: 'user',      text: "Thanks" },
      { role: 'user',      text: "Oh and pet-friendly." },                // MUST KEEP — was LOST before
      { role: 'assistant', text: "Noted — pet-friendly added to criteria." },
    ],
    mustKeep: [2, 3, 4, 6, 7, 10],
    safeToForget: [0, 1, 9],
  },

  {
    name: "Test 2: Long Conversation — Extreme (previously FAILED)",
    description: "50 messages to 12. Previous: 6/10 critical kept.",
    currentPrompt: "Give me a summary of everything we discussed today",
    windowSize: 12,
    conversation: [
      { role: 'user',      text: "Good morning" },
      { role: 'assistant', text: "Good morning! How can I help?" },
      { role: 'user',      text: "Let's go through my day." },
      { role: 'assistant', text: "Sure, let me check your schedule." },
      { role: 'assistant', text: "[Tool: GOOGLECALENDAR_FIND_EVENT → 5 events]" },
      { role: 'assistant', text: "You have 5 meetings today. First one is at 9am with the design team." },
      { role: 'user',      text: "Ok" },
      { role: 'user',      text: "My password for the client portal is Sunset2024! — can you save that somewhere safe?" }, // MUST KEEP
      { role: 'assistant', text: "I've noted your client portal password securely." },
      { role: 'user',      text: "Cool" },
      { role: 'user',      text: "Can you check my emails?" },
      { role: 'assistant', text: "[Tool: GMAIL_FETCH_EMAILS → 12 new emails]" },
      { role: 'assistant', text: "12 new emails. 3 seem important: one from Lisa Chen about the downtown project, one from your accountant about Q4 taxes, and one from a new lead." },
      { role: 'user',      text: "What did Lisa say?" },
      { role: 'assistant', text: "Lisa Chen says the downtown project inspection is scheduled for March 15th. She needs your confirmation by end of week." }, // MUST KEEP
      { role: 'user',      text: "Ok confirm it. Tell her I'll be there." },
      { role: 'assistant', text: "[Tool: GMAIL_SEND_EMAIL → sent to lisa.chen@...]" },
      { role: 'assistant', text: "Confirmed with Lisa. You're set for the March 15th inspection." },
      { role: 'user',      text: "Great" },
      { role: 'user',      text: "What about the accountant?" },
      { role: 'assistant', text: "Your accountant says Q4 estimated taxes of $12,400 are due January 15th. She attached the filing documents." }, // MUST KEEP
      { role: 'user',      text: "Ugh. Add a reminder for January 13th to file taxes." }, // MUST KEEP
      { role: 'assistant', text: "Reminder set: File Q4 taxes ($12,400) — January 13th." },
      { role: 'user',      text: "Thanks" },
      { role: 'user',      text: "What about the new lead?" },
      { role: 'assistant', text: "New lead: James Park, looking for commercial space in the $500-700k range downtown. Referred by Chen." }, // MUST KEEP
      { role: 'user',      text: "Nice. Add him to my CRM." },
      { role: 'assistant', text: "[Tool: CRM_CREATE_CONTACT → created James Park]" },
      { role: 'assistant', text: "Added James Park to CRM. Commercial, $500-700k, downtown, referred by Chen." },
      { role: 'user',      text: "Perfect" },
      { role: 'user',      text: "Actually, one more thing. I want to change my approach with new leads." },
      { role: 'assistant', text: "Sure, what do you have in mind?" },
      { role: 'user',      text: "From now on, always send new leads a welcome email within 1 hour. Don't ask me, just do it." }, // MUST KEEP
      { role: 'assistant', text: "Got it — automatic welcome email to new leads within 1 hour, no approval needed." },
      { role: 'user',      text: "Exactly" },
      { role: 'user',      text: "Ok what else is on my plate?" },
      { role: 'assistant', text: "You have a property viewing at 456 Oak Ave at 3pm and a team standup at 5pm." },
      { role: 'user',      text: "The Oak Ave viewing — the client is Mrs. Rodriguez. She's very particular about natural light." }, // MUST KEEP
      { role: 'assistant', text: "Noted. Mrs. Rodriguez at 456 Oak Ave, 3pm, prioritizes natural light." },
      { role: 'user',      text: "Yeah" },
      { role: 'user',      text: "Can you check how my listings are performing?" },
      { role: 'assistant', text: "[Tool: search_files('listing performance') → report found]" },
      { role: 'assistant', text: "Your 5 active listings: 2 have offers pending, 1 had a price drop last week, 2 are steady. Total portfolio value: $2.8M." }, // MUST KEEP
      { role: 'user',      text: "Which ones have offers?" },
      { role: 'assistant', text: "789 Pine ($340k, 2 offers) and 321 Elm ($520k, 1 offer). Pine's highest offer is $335k." }, // MUST KEEP
      { role: 'user',      text: "Ok" },
      { role: 'user',      text: "I think that's it for now." },
      { role: 'assistant', text: "Sounds good. Quick recap: Lisa confirmed for March 15 inspection, taxes due Jan 15 ($12,400), new lead James Park added, Mrs. Rodriguez viewing at 3pm." },
      { role: 'user',      text: "Oh wait — never schedule anything on Sundays. That's family time." }, // MUST KEEP
      { role: 'assistant', text: "Noted — Sundays are blocked, no scheduling." },
    ],
    mustKeep: [7, 14, 20, 21, 25, 32, 37, 42, 44, 48],
    safeToForget: [0, 1, 4, 6, 9, 11, 16, 18, 23, 27, 29, 34, 39, 41, 45],
  },

  {
    name: "Test 3: Multi-Topic Switching (previously FAILED)",
    description: "Jumps between topics. Previous: 4/6 critical kept.",
    currentPrompt: "Remind me what we covered about all my projects today",
    windowSize: 10,
    conversation: [
      { role: 'user',      text: "What's the status on the Miller renovation?" },
      { role: 'assistant', text: "Miller renovation: 60% complete, $45k spent of $75k budget. Plumbing done, electrical next week." }, // MUST KEEP
      { role: 'user',      text: "Ok" },
      { role: 'user',      text: "Switch topics — did the Peterson appraisal come back?" },
      { role: 'assistant', text: "Yes, Peterson property appraised at $380k. That's $20k above asking." }, // MUST KEEP
      { role: 'user',      text: "Nice" },
      { role: 'user',      text: "Any news on my license renewal?" },
      { role: 'assistant', text: "Your real estate license expires March 31st. You need 12 CE hours. Currently have 4 completed." }, // MUST KEEP — was LOST before
      { role: 'user',      text: "Ugh, I need to get on that." },
      { role: 'user',      text: "Back to Miller — tell the contractor to use quartz countertops, not granite." }, // MUST KEEP — was LOST before
      { role: 'assistant', text: "Noted — quartz countertops for Miller renovation, not granite." },
      { role: 'user',      text: "And the budget for countertops is $8k max." }, // MUST KEEP
      { role: 'assistant', text: "Got it — quartz countertops, $8k max budget." },
      { role: 'user',      text: "Ok" },
      { role: 'user',      text: "One more thing — Peterson wants to close by April 15th." }, // MUST KEEP
      { role: 'assistant', text: "Peterson closing deadline: April 15th." },
      { role: 'user',      text: "Great" },
      { role: 'user',      text: "That's all for now." },
    ],
    mustKeep: [1, 4, 7, 9, 11, 14],
    safeToForget: [2, 5, 13, 16, 17],
  },

  {
    name: "Test 4: Tool-Heavy (previously FAILED)",
    description: "Keep conclusions, forget raw tool output. Previous: 4/5 kept.",
    currentPrompt: "What's my schedule look like and what do I need to prep for?",
    windowSize: 8,
    conversation: [
      { role: 'user',      text: "Find all my meetings for today." },
      { role: 'assistant', text: "[Tool: search_tools('calendar') → googlecalendar tools loaded]" },
      { role: 'assistant', text: "[Tool: GOOGLECALENDAR_FIND_EVENT({today: true}) → {events: [{title: 'Standup', time: '9am'}, {title: 'Client call', time: '2pm'}, {title: 'Team sync', time: '4pm'}]}]" },
      { role: 'assistant', text: "You have 3 meetings today: Standup at 9am, Client call at 2pm, Team sync at 4pm." }, // MUST KEEP
      { role: 'user',      text: "Cancel the team sync." }, // MUST KEEP — was LOST before
      { role: 'assistant', text: "[Tool: GOOGLECALENDAR_DELETE_EVENT({id: 'ts-123'}) → success]" },
      { role: 'assistant', text: "Team sync cancelled. You now have Standup at 9am and Client call at 2pm." }, // MUST KEEP
      { role: 'user',      text: "Great" },
      { role: 'user',      text: "For the client call at 2pm, the client is Zhang Wei from Meridian Corp. Prep me." }, // MUST KEEP
      { role: 'assistant', text: "[Tool: search_files('Meridian Corp') → 1 result: meridian-proposal.pdf]" },
      { role: 'assistant', text: "[Tool: read_file({id: 'mc-001'}) → {content: 'Proposal: $2.1M contract for Q3...'}]" },
      { role: 'assistant', text: "Here's your brief for Zhang Wei (Meridian Corp): They're considering a $2.1M contract for Q3. Key concerns were timeline and support SLA. Last meeting you agreed to 99.9% uptime guarantee." }, // MUST KEEP
      { role: 'user',      text: "Ok" },
    ],
    mustKeep: [3, 4, 6, 8, 11],
    safeToForget: [1, 2, 5, 7, 9, 10, 12],
  },

  {
    name: "Test 5: Contradictions (previously PASSED — verify still works)",
    description: "User changes mind. Only final state matters.",
    currentPrompt: "What are my current notification preferences?",
    windowSize: 8,
    conversation: [
      { role: 'user',      text: "Set my notification preference to email only." },
      { role: 'assistant', text: "Done, notifications set to email only." },
      { role: 'user',      text: "Actually wait, change that to SMS instead." },
      { role: 'assistant', text: "Updated to SMS notifications." },
      { role: 'user',      text: "Hmm" },
      { role: 'user',      text: "You know what, do both email and SMS." }, // MUST KEEP (final)
      { role: 'assistant', text: "Got it — notifications now go to both email and SMS." }, // MUST KEEP
      { role: 'user',      text: "Perfect" },
      { role: 'user',      text: "Also my phone number is 555-0123." }, // MUST KEEP
      { role: 'assistant', text: "Saved your phone number." },
      { role: 'user',      text: "Thanks" },
      { role: 'user',      text: "Don't ever text me before 8am." }, // MUST KEEP
      { role: 'assistant', text: "Noted — no texts before 8am." },
    ],
    mustKeep: [5, 6, 8, 11],
    safeToForget: [4, 7, 10],
  },

  {
    name: "Test 6: Emotional Context (previously PASSED — verify still works)",
    description: "Emotional nuance + instructions about sensitive topics.",
    currentPrompt: "What leads do I have and is there anything I should avoid bringing up?",
    windowSize: 7,
    conversation: [
      { role: 'user',      text: "Hey" },
      { role: 'assistant', text: "Hey! What's going on?" },
      { role: 'user',      text: "I'm really frustrated with the Thompson deal falling through." },
      { role: 'assistant', text: "I'm sorry to hear that. What happened?" },
      { role: 'user',      text: "They backed out last minute. $800k deal gone." }, // MUST KEEP
      { role: 'assistant', text: "That's a significant loss. The $800k Thompson deal backing out last minute must be really frustrating." },
      { role: 'user',      text: "Yeah" },
      { role: 'user',      text: "I need you to never bring this deal up again unless I ask." }, // MUST KEEP
      { role: 'assistant', text: "Understood. I won't mention the Thompson deal unless you bring it up." }, // MUST KEEP
      { role: 'user',      text: "Thanks" },
      { role: 'user',      text: "Let's focus on new leads instead. What's in the pipeline?" },
      { role: 'assistant', text: "You have 3 active leads: Martinez family ($350k, Eastside), Chen ($520k, Downtown), and Park ($410k, Westside)." }, // MUST KEEP
    ],
    mustKeep: [4, 7, 8, 11],
    safeToForget: [0, 1, 6, 9],
  },
]

async function runScenario(scenario, embedder) {
  const { conversation, mustKeep, safeToForget, windowSize, name, description, currentPrompt } = scenario

  // Embed all messages + the current prompt
  const promptOutput = await embedder(currentPrompt, { pooling: 'mean', normalize: true })
  const promptEmb = Array.from(promptOutput.data)

  const embeddings = []
  for (const msg of conversation) {
    const output = await embedder(msg.text, { pooling: 'mean', normalize: true })
    embeddings.push(Array.from(output.data))
  }

  // Score each message by relevance to current prompt
  const scores = conversation.map((msg, i) => {
    const retention = computeRetention(embeddings[i], promptEmb, msg, i, conversation.length)
    return {
      index: i,
      role: msg.role,
      text: msg.text.slice(0, 95),
      score: retention,
      similarity: cosine(embeddings[i], promptEmb),
      mustKeep: mustKeep.includes(i),
      safeToForget: safeToForget.includes(i),
    }
  })

  // Keep top N by score
  const kept = [...scores].sort((a, b) => b.score - a.score).slice(0, windowSize)
  const keptIndices = new Set(kept.map(s => s.index))
  const forgotten = scores.filter(s => !keptIndices.has(s.index))

  const criticalForgotten = forgotten.filter(s => s.mustKeep)
  const safeCorrectlyForgotten = forgotten.filter(s => s.safeToForget)

  console.log(`\n${'═'.repeat(90)}`)
  console.log(`${name}`)
  console.log(`${description}`)
  console.log(`Current prompt: "${currentPrompt}"`)
  console.log(`${'═'.repeat(90)}`)
  console.log(`Window: ${windowSize}/${conversation.length} (${((1 - windowSize/conversation.length) * 100).toFixed(0)}% reduction)\n`)

  console.log('KEPT (sorted by position):')
  for (const s of kept.sort((a, b) => a.index - b.index)) {
    const tag = s.mustKeep ? ' [MUST KEEP]' : ''
    console.log(`  [${String(s.index).padStart(2)}] score:${s.score.toFixed(3)} sim:${s.similarity.toFixed(3)} ${s.role.padEnd(9)} "${s.text}"${tag}`)
  }

  console.log('\nFORGOTTEN:')
  for (const s of forgotten.sort((a, b) => a.index - b.index)) {
    const tag = s.mustKeep ? ' [!! CRITICAL LOSS !!]' : s.safeToForget ? ' [correct]' : ' [ok]'
    console.log(`  [${String(s.index).padStart(2)}] score:${s.score.toFixed(3)} sim:${s.similarity.toFixed(3)} ${s.role.padEnd(9)} "${s.text}"${tag}`)
  }

  const criticalTotal = mustKeep.length
  console.log(`\nCritical preserved: ${criticalTotal - criticalForgotten.length}/${criticalTotal}`)
  console.log(`Safe correctly forgotten: ${safeCorrectlyForgotten.length}/${safeToForget.length}`)
  if (criticalForgotten.length > 0) {
    console.log(`!! FAILURES:`)
    for (const f of criticalForgotten) console.log(`   [${f.index}] "${f.text}"`)
  }

  return {
    name,
    criticalTotal,
    criticalKept: criticalTotal - criticalForgotten.length,
    safeTotal: safeToForget.length,
    safeDropped: safeCorrectlyForgotten.length,
    failures: criticalForgotten.length,
    windowSize,
    totalMessages: conversation.length,
  }
}

async function main() {
  console.log('=== INTELLIGENT FORGETTING V2 — EMBEDDING-DRIVEN ===')
  console.log('Score = cosine_similarity(message, current_prompt) + recency + filler_penalty')
  console.log('No heuristic importance scoring — embeddings decide everything.\n')

  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })
  console.log('Model loaded.')

  const results = []
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, embedder))
  }

  console.log(`\n${'═'.repeat(90)}`)
  console.log('OVERALL SUMMARY')
  console.log(`${'═'.repeat(90)}\n`)

  let totalCritical = 0, totalKept = 0, totalSafe = 0, totalSafeDropped = 0, totalFailures = 0

  for (const r of results) {
    const pass = r.failures === 0 ? 'PASS' : 'FAIL'
    console.log(`${pass} | ${r.name}: ${r.criticalKept}/${r.criticalTotal} critical, ${r.safeDropped}/${r.safeTotal} safe (${r.windowSize}/${r.totalMessages})`)
    totalCritical += r.criticalTotal
    totalKept += r.criticalKept
    totalSafe += r.safeTotal
    totalSafeDropped += r.safeDropped
    totalFailures += r.failures
  }

  console.log(`\n--- TOTALS ---`)
  console.log(`Critical preserved: ${totalKept}/${totalCritical} (${(totalKept/totalCritical*100).toFixed(1)}%)`)
  console.log(`Safe forgotten:     ${totalSafeDropped}/${totalSafe} (${(totalSafeDropped/totalSafe*100).toFixed(1)}%)`)
  console.log(`Total failures:     ${totalFailures}`)
  console.log(`Scenarios passed:   ${results.filter(r => r.failures === 0).length}/${results.length}`)

  // Compare with V1
  console.log(`\n--- VS PREVIOUS (HEURISTIC-ONLY) ---`)
  console.log(`V1: 24/35 critical (68.6%) | 2/6 scenarios passed`)
  console.log(`V2: ${totalKept}/${totalCritical} critical (${(totalKept/totalCritical*100).toFixed(1)}%) | ${results.filter(r => r.failures === 0).length}/${results.length} scenarios passed`)
}

main().catch(console.error)
