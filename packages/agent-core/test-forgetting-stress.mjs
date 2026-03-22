// Stress test: Intelligent Forgetting across multiple diverse scenarios
// Tests edge cases, adversarial patterns, and realistic long conversations

import { pipeline } from '@huggingface/transformers'

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function heuristicScore(msg, index, total) {
  let score = 0.5
  const text = msg.text.toLowerCase()
  const len = text.split(/\s+/).length

  if (len <= 4) score -= 0.3
  if (len <= 2) score -= 0.2
  if (/\$[\d,.]+|\d{3,}|\d+%|\d+\s*(am|pm)/i.test(msg.text)) score += 0.3
  const properNouns = msg.text.match(/(?<!^)(?<!\. )[A-Z][a-z]{2,}/g)
  if (properNouns && properNouns.length > 0) score += 0.15 * Math.min(properNouns.length, 3)
  if (/@|phone|\d{3}[-.]?\d{3}[-.]?\d{4}/.test(text)) score += 0.4
  if (/tomorrow|friday|thursday|monday|tuesday|wednesday|saturday|sunday|\d{1,2}(am|pm)|next week|next month|deadline/i.test(text)) score += 0.25
  if (msg.role === 'user' && /don't|do not|stop|hold|wait|change|update|cancel|never|always|important|must|need/i.test(text)) score += 0.35
  if (/\?$/.test(text.trim())) score += 0.1
  if (/^(ok|okay|sure|thanks|thank you|got it|yeah|yes|nice|cool|sounds good|great|perfect|alright|yep|yup|no problem)[\s!.]*$/i.test(text.trim())) score -= 0.4
  if (text.startsWith('[tool:')) score -= 0.15
  if (/^(hey|hi|hello|what'?s up|how can i help|good morning|good afternoon)/i.test(text.trim())) score -= 0.3
  if (msg.role === 'user') score += 0.1
  const recency = index / total
  score += recency * 0.15

  return Math.max(0, Math.min(1, score))
}

function redundancyPenalty(embedding, otherEmbeddings, threshold = 0.82) {
  let maxSim = 0
  for (const other of otherEmbeddings) {
    const sim = cosine(embedding, other)
    if (sim > maxSim) maxSim = sim
  }
  if (maxSim > threshold) return -(maxSim - threshold) * 2
  return 0
}

// ═══════════════════════════════════════════════════════════════
// TEST SCENARIOS
// ═══════════════════════════════════════════════════════════════

const scenarios = [
  {
    name: "Scenario 1: Contradictions & Mind Changes",
    description: "User changes their mind multiple times — only latest decision should survive",
    windowSize: 8,
    conversation: [
      { role: 'user',      text: "Set my notification preference to email only." },                  // 0 - superseded
      { role: 'assistant', text: "Done, notifications set to email only." },                          // 1 - superseded
      { role: 'user',      text: "Actually wait, change that to SMS instead." },                      // 2 - superseded
      { role: 'assistant', text: "Updated to SMS notifications." },                                    // 3 - superseded
      { role: 'user',      text: "Hmm" },                                                             // 4 - filler
      { role: 'user',      text: "You know what, do both email and SMS." },                            // 5 - FINAL decision
      { role: 'assistant', text: "Got it — notifications now go to both email and SMS." },             // 6 - FINAL state
      { role: 'user',      text: "Perfect" },                                                          // 7 - filler
      { role: 'user',      text: "Also my phone number is 555-0123." },                                // 8 - CRITICAL
      { role: 'assistant', text: "Saved your phone number." },                                         // 9 - ack
      { role: 'user',      text: "Thanks" },                                                           // 10 - filler
      { role: 'user',      text: "Don't ever text me before 8am." },                                   // 11 - CRITICAL constraint
      { role: 'assistant', text: "Noted — no texts before 8am." },                                     // 12 - confirmation
    ],
    mustKeep: [5, 6, 8, 11],  // final decision, phone number, time constraint
    safeToForget: [4, 7, 10], // filler
  },

  {
    name: "Scenario 2: Tool-Heavy Session",
    description: "Many tool calls — raw results should be forgotten, conclusions kept",
    windowSize: 8,
    conversation: [
      { role: 'user',      text: "Find all my meetings for today." },                                  // 0
      { role: 'assistant', text: "[Tool: search_tools('calendar') → googlecalendar tools loaded]" },    // 1 - tool noise
      { role: 'assistant', text: "[Tool: GOOGLECALENDAR_FIND_EVENT({today: true}) → {events: [{title: 'Standup', time: '9am'}, {title: 'Client call', time: '2pm'}, {title: 'Team sync', time: '4pm'}]}]" }, // 2 - raw tool result
      { role: 'assistant', text: "You have 3 meetings today: Standup at 9am, Client call at 2pm, Team sync at 4pm." }, // 3 - CRITICAL summary
      { role: 'user',      text: "Cancel the team sync." },                                             // 4 - CRITICAL action
      { role: 'assistant', text: "[Tool: GOOGLECALENDAR_DELETE_EVENT({id: 'ts-123'}) → success]" },     // 5 - tool noise
      { role: 'assistant', text: "Team sync cancelled. You now have Standup at 9am and Client call at 2pm." }, // 6 - CRITICAL updated state
      { role: 'user',      text: "Great" },                                                              // 7 - filler
      { role: 'user',      text: "For the client call at 2pm, the client is Zhang Wei from Meridian Corp. Prep me." }, // 8 - CRITICAL
      { role: 'assistant', text: "[Tool: search_files('Meridian Corp') → 1 result: meridian-proposal.pdf]" }, // 9 - tool noise
      { role: 'assistant', text: "[Tool: read_file({id: 'mc-001'}) → {content: 'Proposal: $2.1M contract for Q3...'}]" }, // 10 - tool noise
      { role: 'assistant', text: "Here's your brief for Zhang Wei (Meridian Corp): They're considering a $2.1M contract for Q3. Key concerns were timeline and support SLA. Last meeting you agreed to 99.9% uptime guarantee." }, // 11 - CRITICAL
      { role: 'user',      text: "Ok" },                                                                  // 12 - filler
    ],
    mustKeep: [3, 4, 6, 8, 11],
    safeToForget: [1, 2, 5, 7, 9, 10, 12],
  },

  {
    name: "Scenario 3: Emotional & Nuanced Conversation",
    description: "Tests whether sentiment/tone-carrying messages are preserved",
    windowSize: 7,
    conversation: [
      { role: 'user',      text: "Hey" },                                                              // 0 - greeting
      { role: 'assistant', text: "Hey! What's going on?" },                                            // 1 - greeting
      { role: 'user',      text: "I'm really frustrated with the Thompson deal falling through." },    // 2 - CRITICAL emotional context
      { role: 'assistant', text: "I'm sorry to hear that. What happened?" },                            // 3 - empathy, somewhat important
      { role: 'user',      text: "They backed out last minute. $800k deal gone." },                     // 4 - CRITICAL fact
      { role: 'assistant', text: "That's a significant loss. The $800k Thompson deal backing out last minute must be really frustrating." }, // 5 - empathy + fact recap
      { role: 'user',      text: "Yeah" },                                                              // 6 - filler
      { role: 'user',      text: "I need you to never bring this deal up again unless I ask." },        // 7 - CRITICAL instruction
      { role: 'assistant', text: "Understood. I won't mention the Thompson deal unless you bring it up." }, // 8 - confirmation of instruction
      { role: 'user',      text: "Thanks" },                                                            // 9 - filler
      { role: 'user',      text: "Let's focus on new leads instead. What's in the pipeline?" },         // 10 - new direction
      { role: 'assistant', text: "You have 3 active leads: Martinez family ($350k, Eastside), Chen ($520k, Downtown), and Park ($410k, Westside)." }, // 11 - CRITICAL
    ],
    mustKeep: [4, 7, 8, 11],
    safeToForget: [0, 1, 6, 9],
  },

  {
    name: "Scenario 4: Long Conversation (50 messages) — Extreme Compression",
    description: "50 messages compressed to 12. Tests survival of scattered critical facts.",
    windowSize: 12,
    conversation: [
      { role: 'user',      text: "Good morning" },                                                     // 0
      { role: 'assistant', text: "Good morning! How can I help?" },                                     // 1
      { role: 'user',      text: "Let's go through my day." },                                          // 2
      { role: 'assistant', text: "Sure, let me check your schedule." },                                  // 3
      { role: 'assistant', text: "[Tool: GOOGLECALENDAR_FIND_EVENT → 5 events]" },                       // 4
      { role: 'assistant', text: "You have 5 meetings today. First one is at 9am with the design team." }, // 5
      { role: 'user',      text: "Ok" },                                                                 // 6
      { role: 'user',      text: "My password for the client portal is Sunset2024! — can you save that somewhere safe?" }, // 7 - CRITICAL sensitive info
      { role: 'assistant', text: "I've noted your client portal password securely." },                    // 8
      { role: 'user',      text: "Cool" },                                                               // 9
      { role: 'user',      text: "Can you check my emails?" },                                            // 10
      { role: 'assistant', text: "[Tool: GMAIL_FETCH_EMAILS → 12 new emails]" },                          // 11
      { role: 'assistant', text: "12 new emails. 3 seem important: one from Lisa Chen about the downtown project, one from your accountant about Q4 taxes, and one from a new lead." }, // 12
      { role: 'user',      text: "What did Lisa say?" },                                                  // 13
      { role: 'assistant', text: "Lisa Chen says the downtown project inspection is scheduled for March 15th. She needs your confirmation by end of week." }, // 14 - CRITICAL deadline
      { role: 'user',      text: "Ok confirm it. Tell her I'll be there." },                               // 15 - CRITICAL action
      { role: 'assistant', text: "[Tool: GMAIL_SEND_EMAIL → sent to lisa.chen@...]" },                     // 16
      { role: 'assistant', text: "Confirmed with Lisa. You're set for the March 15th inspection." },       // 17
      { role: 'user',      text: "Great" },                                                                // 18
      { role: 'user',      text: "What about the accountant?" },                                           // 19
      { role: 'assistant', text: "Your accountant says Q4 estimated taxes of $12,400 are due January 15th. She attached the filing documents." }, // 20 - CRITICAL financial
      { role: 'user',      text: "Ugh. Add a reminder for January 13th to file taxes." },                  // 21 - CRITICAL task
      { role: 'assistant', text: "Reminder set: File Q4 taxes ($12,400) — January 13th." },                // 22
      { role: 'user',      text: "Thanks" },                                                               // 23
      { role: 'user',      text: "What about the new lead?" },                                             // 24
      { role: 'assistant', text: "New lead: James Park, looking for commercial space in the $500-700k range downtown. Referred by Chen." }, // 25 - CRITICAL
      { role: 'user',      text: "Nice. Add him to my CRM." },                                             // 26
      { role: 'assistant', text: "[Tool: CRM_CREATE_CONTACT → created James Park]" },                      // 27
      { role: 'assistant', text: "Added James Park to CRM. Commercial, $500-700k, downtown, referred by Chen." }, // 28
      { role: 'user',      text: "Perfect" },                                                               // 29
      { role: 'user',      text: "Actually, one more thing. I want to change my approach with new leads." }, // 30
      { role: 'assistant', text: "Sure, what do you have in mind?" },                                       // 31
      { role: 'user',      text: "From now on, always send new leads a welcome email within 1 hour. Don't ask me, just do it." }, // 32 - CRITICAL standing instruction
      { role: 'assistant', text: "Got it — automatic welcome email to new leads within 1 hour, no approval needed." }, // 33
      { role: 'user',      text: "Exactly" },                                                               // 34
      { role: 'user',      text: "Ok what else is on my plate?" },                                          // 35
      { role: 'assistant', text: "You have a property viewing at 456 Oak Ave at 3pm and a team standup at 5pm." }, // 36
      { role: 'user',      text: "The Oak Ave viewing — the client is Mrs. Rodriguez. She's very particular about natural light." }, // 37 - CRITICAL client detail
      { role: 'assistant', text: "Noted. Mrs. Rodriguez at 456 Oak Ave, 3pm, prioritizes natural light." },  // 38
      { role: 'user',      text: "Yeah" },                                                                  // 39
      { role: 'user',      text: "Can you check how my listings are performing?" },                          // 40
      { role: 'assistant', text: "[Tool: search_files('listing performance') → report found]" },             // 41
      { role: 'assistant', text: "Your 5 active listings: 2 have offers pending, 1 had a price drop last week, 2 are steady. Total portfolio value: $2.8M." }, // 42 - CRITICAL
      { role: 'user',      text: "Which ones have offers?" },                                                // 43
      { role: 'assistant', text: "789 Pine ($340k, 2 offers) and 321 Elm ($520k, 1 offer). Pine's highest offer is $335k." }, // 44 - CRITICAL
      { role: 'user',      text: "Ok" },                                                                    // 45
      { role: 'user',      text: "I think that's it for now." },                                             // 46
      { role: 'assistant', text: "Sounds good. Quick recap: Lisa confirmed for March 15 inspection, taxes due Jan 15 ($12,400), new lead James Park added, Mrs. Rodriguez viewing at 3pm." }, // 47
      { role: 'user',      text: "Oh wait — never schedule anything on Sundays. That's family time." },     // 48 - CRITICAL permanent rule
      { role: 'assistant', text: "Noted — Sundays are blocked, no scheduling." },                            // 49
    ],
    mustKeep: [7, 14, 20, 21, 25, 32, 37, 42, 44, 48],
    safeToForget: [0, 1, 4, 6, 9, 11, 16, 18, 23, 27, 29, 34, 39, 41, 45],
  },

  {
    name: "Scenario 5: Adversarial — Important Info Buried in Short Messages",
    description: "Critical facts delivered in very short messages that might look like filler",
    windowSize: 6,
    conversation: [
      { role: 'user',      text: "Hey can you help with something?" },                                 // 0
      { role: 'assistant', text: "Of course! What do you need?" },                                      // 1
      { role: 'user',      text: "Budget is $200k." },                                                  // 2 - CRITICAL but short!
      { role: 'user',      text: "Max 3 bedrooms." },                                                   // 3 - CRITICAL but short!
      { role: 'user',      text: "Westside only." },                                                    // 4 - CRITICAL but short!
      { role: 'assistant', text: "Got it — searching for properties: Westside, 3 bed max, $200k budget." }, // 5 - recap
      { role: 'user',      text: "No HOA." },                                                           // 6 - CRITICAL but very short!
      { role: 'user',      text: "Must have garage." },                                                  // 7 - CRITICAL but short!
      { role: 'assistant', text: "Added constraints: no HOA, must have garage. Searching now." },         // 8
      { role: 'user',      text: "Thanks" },                                                             // 9 - filler
      { role: 'user',      text: "Oh and pet-friendly." },                                               // 10 - CRITICAL
      { role: 'assistant', text: "Noted — pet-friendly added to criteria." },                             // 11
    ],
    mustKeep: [2, 3, 4, 6, 7, 10],  // ALL the short constraints are critical
    safeToForget: [0, 1, 9],
  },

  {
    name: "Scenario 6: Multi-Topic Switching",
    description: "Conversation jumps between topics — each topic's key info must survive",
    windowSize: 10,
    conversation: [
      { role: 'user',      text: "What's the status on the Miller renovation?" },                       // 0
      { role: 'assistant', text: "Miller renovation: 60% complete, $45k spent of $75k budget. Plumbing done, electrical next week." }, // 1 - CRITICAL
      { role: 'user',      text: "Ok" },                                                                // 2
      { role: 'user',      text: "Switch topics — did the Peterson appraisal come back?" },              // 3
      { role: 'assistant', text: "Yes, Peterson property appraised at $380k. That's $20k above asking." }, // 4 - CRITICAL
      { role: 'user',      text: "Nice" },                                                               // 5
      { role: 'user',      text: "Any news on my license renewal?" },                                    // 6
      { role: 'assistant', text: "Your real estate license expires March 31st. You need 12 CE hours. Currently have 4 completed." }, // 7 - CRITICAL
      { role: 'user',      text: "Ugh, I need to get on that." },                                        // 8
      { role: 'user',      text: "Back to Miller — tell the contractor to use quartz countertops, not granite." }, // 9 - CRITICAL decision
      { role: 'assistant', text: "Noted — quartz countertops for Miller renovation, not granite." },      // 10
      { role: 'user',      text: "And the budget for countertops is $8k max." },                          // 11 - CRITICAL
      { role: 'assistant', text: "Got it — quartz countertops, $8k max budget." },                        // 12
      { role: 'user',      text: "Ok" },                                                                  // 13
      { role: 'user',      text: "One more thing — Peterson wants to close by April 15th." },             // 14 - CRITICAL
      { role: 'assistant', text: "Peterson closing deadline: April 15th." },                               // 15
      { role: 'user',      text: "Great" },                                                                // 16
      { role: 'user',      text: "That's all for now." },                                                  // 17
    ],
    mustKeep: [1, 4, 7, 9, 11, 14],
    safeToForget: [2, 5, 13, 16, 17],
  },
]

async function runScenario(scenario, embedder) {
  const { conversation, mustKeep, safeToForget, windowSize, name, description } = scenario

  // Embed all
  const embeddings = []
  for (const msg of conversation) {
    const output = await embedder(msg.text, { pooling: 'mean', normalize: true })
    embeddings.push(Array.from(output.data))
  }

  // Score
  const scores = conversation.map((msg, i) => {
    const hScore = heuristicScore(msg, i, conversation.length)
    const otherEmbs = embeddings.filter((_, j) => j !== i)
    const rPenalty = redundancyPenalty(embeddings[i], otherEmbs, 0.82)
    return {
      index: i,
      role: msg.role,
      text: msg.text.slice(0, 90),
      final: Math.max(0, Math.min(1, hScore + rPenalty)),
      mustKeep: mustKeep.includes(i),
      safeToForget: safeToForget.includes(i),
    }
  })

  // Keep top N
  const kept = [...scores].sort((a, b) => b.final - a.final).slice(0, windowSize)
  const keptIndices = new Set(kept.map(s => s.index))
  const forgotten = scores.filter(s => !keptIndices.has(s.index))

  const criticalForgotten = forgotten.filter(s => s.mustKeep)
  const safeCorrectlyForgotten = forgotten.filter(s => s.safeToForget)
  const criticalTotal = mustKeep.length
  const safeTotal = safeToForget.length

  console.log(`\n${'═'.repeat(80)}`)
  console.log(`${name}`)
  console.log(`${description}`)
  console.log(`${'═'.repeat(80)}`)
  console.log(`Window: ${windowSize}/${conversation.length} messages (${((1 - windowSize/conversation.length) * 100).toFixed(0)}% reduction)\n`)

  console.log('KEPT:')
  for (const s of kept.sort((a, b) => a.index - b.index)) {
    const tag = s.mustKeep ? ' [MUST KEEP]' : ''
    console.log(`  [${String(s.index).padStart(2)}] ${s.final.toFixed(3)} ${s.role.padEnd(9)} "${s.text}"${tag}`)
  }

  console.log('\nFORGOTTEN:')
  for (const s of forgotten.sort((a, b) => a.index - b.index)) {
    const tag = s.mustKeep ? ' [!! CRITICAL LOSS !!]' : s.safeToForget ? ' [correct]' : ' [ok]'
    console.log(`  [${String(s.index).padStart(2)}] ${s.final.toFixed(3)} ${s.role.padEnd(9)} "${s.text}"${tag}`)
  }

  console.log(`\nCritical preserved: ${criticalTotal - criticalForgotten.length}/${criticalTotal}`)
  console.log(`Safe correctly forgotten: ${safeCorrectlyForgotten.length}/${safeTotal}`)
  if (criticalForgotten.length > 0) {
    console.log(`!! FAILURES: ${criticalForgotten.map(s => `[${s.index}] "${s.text}"`).join(', ')}`)
  }

  return {
    name,
    totalMessages: conversation.length,
    windowSize,
    criticalTotal,
    criticalKept: criticalTotal - criticalForgotten.length,
    safeTotal,
    safeDropped: safeCorrectlyForgotten.length,
    failures: criticalForgotten.map(s => ({ index: s.index, text: s.text })),
  }
}

async function main() {
  console.log('=== INTELLIGENT FORGETTING — STRESS TEST ===')
  console.log(`Testing ${scenarios.length} scenarios...\n`)

  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })
  console.log('Model loaded.')

  const results = []
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, embedder))
  }

  // Summary
  console.log(`\n${'═'.repeat(80)}`)
  console.log('OVERALL SUMMARY')
  console.log(`${'═'.repeat(80)}\n`)

  let totalCritical = 0, totalCriticalKept = 0
  let totalSafe = 0, totalSafeDropped = 0
  let totalFailures = 0

  for (const r of results) {
    const pass = r.failures.length === 0 ? 'PASS' : 'FAIL'
    console.log(`${pass} | ${r.name}: ${r.criticalKept}/${r.criticalTotal} critical kept, ${r.safeDropped}/${r.safeTotal} safe dropped (${r.windowSize}/${r.totalMessages} messages)`)
    totalCritical += r.criticalTotal
    totalCriticalKept += r.criticalKept
    totalSafe += r.safeTotal
    totalSafeDropped += r.safeDropped
    totalFailures += r.failures.length
  }

  console.log(`\n--- TOTALS ---`)
  console.log(`Critical messages preserved: ${totalCriticalKept}/${totalCritical} (${(totalCriticalKept/totalCritical*100).toFixed(1)}%)`)
  console.log(`Safe messages forgotten:     ${totalSafeDropped}/${totalSafe} (${(totalSafeDropped/totalSafe*100).toFixed(1)}%)`)
  console.log(`Total failures:              ${totalFailures}`)
  console.log(`Scenarios passed:            ${results.filter(r => r.failures.length === 0).length}/${results.length}`)
}

main().catch(console.error)
