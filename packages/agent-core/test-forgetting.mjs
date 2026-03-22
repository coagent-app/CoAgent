// Test: Intelligent Forgetting — score messages for retention, drop the least important
// Goal: keep a small context window but never lose critical information

import { pipeline } from '@huggingface/transformers'

// 30-message conversation simulating a real CoAgent session
const conversation = [
  { role: 'user',      text: "Hey, what's up?" },                                                    // 0 - greeting, forgettable
  { role: 'assistant', text: "Hey! How can I help you today?" },                                      // 1 - greeting, forgettable
  { role: 'user',      text: "I need help with the Johnson deal. Counter-offer came in at $450k." },  // 2 - CRITICAL fact
  { role: 'assistant', text: "Got it. Let me look into the Johnson property details." },               // 3 - acknowledgment
  { role: 'user',      text: "Also my email is brett@example.com if you need it." },                   // 4 - CRITICAL personal info
  { role: 'assistant', text: "Noted, I've saved your email." },                                        // 5 - acknowledgment
  { role: 'user',      text: "Can you search for the contract?" },                                     // 6 - tool request, forgettable after done
  { role: 'assistant', text: "[Tool: search_files('Johnson contract') → 2 results: johnson-offer.pdf, johnson-comps.xlsx]" }, // 7 - tool result
  { role: 'assistant', text: "Found 2 files. The Johnson offer document shows original ask was $475k, counter at $450k. Comps support $440-460k range." }, // 8 - CRITICAL analysis
  { role: 'user',      text: "Ok thanks" },                                                           // 9 - acknowledgment, forgettable
  { role: 'user',      text: "What do you think I should do?" },                                       // 10 - question
  { role: 'assistant', text: "I'd recommend accepting at $450k with a 30-day close contingency. The comps support this price and the buyer seems motivated." }, // 11 - CRITICAL recommendation
  { role: 'user',      text: "Yeah that makes sense" },                                                // 12 - acknowledgment
  { role: 'user',      text: "Can you draft an email to Sarah Johnson about scheduling the closing?" }, // 13 - task request
  { role: 'assistant', text: "[Tool: search_tools('send email') → gmail tools loaded]" },              // 14 - tool result
  { role: 'assistant', text: "I've drafted an email to Sarah Johnson about scheduling the closing for the $450k deal. Want me to send it?" }, // 15 - CRITICAL action pending
  { role: 'user',      text: "Hold on, don't send it yet." },                                          // 16 - CRITICAL instruction
  { role: 'user',      text: "Actually, change the price to $445k. I want to counter their counter." }, // 17 - CRITICAL supersedes earlier
  { role: 'assistant', text: "Updated the email to reflect $445k counter-offer. Ready to send when you are." }, // 18 - updated state
  { role: 'user',      text: "Ok" },                                                                   // 19 - acknowledgment
  { role: 'user',      text: "Also, remind me to call the mortgage broker Mark Davis tomorrow at 9am." }, // 20 - CRITICAL task
  { role: 'assistant', text: "Added reminder: call Mark Davis (mortgage broker) tomorrow at 9am." },    // 21 - confirmation
  { role: 'user',      text: "Thanks" },                                                               // 22 - forgettable
  { role: 'user',      text: "How many deals did we close last quarter?" },                             // 23 - question
  { role: 'assistant', text: "Last quarter: 12 closed deals, $3.2M total volume, average 28 days on market." }, // 24 - fact
  { role: 'user',      text: "Nice" },                                                                 // 25 - forgettable
  { role: 'user',      text: "I need to prep for a meeting with the Westside Development Group on Friday." }, // 26 - CRITICAL upcoming event
  { role: 'assistant', text: "I'll prepare a brief for Friday's meeting with Westside Development Group. Want me to include recent market data for the Westside area?" }, // 27 - task
  { role: 'user',      text: "Yes please" },                                                           // 28 - light acknowledgment
  { role: 'assistant', text: "Working on the Westside brief now. I'll have it ready by Thursday." },    // 29 - commitment
]

// Ground truth: which messages MUST survive forgetting
const MUST_KEEP = new Set([
  2,   // Johnson counter-offer $450k — core deal fact
  4,   // email address — personal info
  8,   // analysis of Johnson deal — critical context
  11,  // recommendation to accept at $450k
  16,  // "don't send yet" — active instruction
  17,  // counter at $445k — supersedes earlier price
  18,  // updated email state
  20,  // reminder: call Mark Davis tomorrow 9am
  26,  // Friday meeting with Westside Development Group
  29,  // commitment: brief ready by Thursday
])

const SAFE_TO_FORGET = new Set([
  0,   // greeting
  1,   // greeting
  5,   // acknowledgment
  6,   // tool request (done)
  7,   // raw tool result (summarized in 8)
  9,   // "ok thanks"
  12,  // "yeah that makes sense"
  14,  // tool loading result
  19,  // "ok"
  22,  // "thanks"
  25,  // "nice"
  28,  // "yes please"
])

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ── Retention scoring heuristics ──

function heuristicScore(msg, index, total) {
  let score = 0.5 // baseline
  const text = msg.text.toLowerCase()
  const len = text.split(/\s+/).length

  // Short messages are usually low-info
  if (len <= 4) score -= 0.3
  if (len <= 2) score -= 0.2

  // Contains numbers → facts
  if (/\$[\d,.]+|\d{3,}|\d+%|\d+\s*(am|pm)/i.test(msg.text)) score += 0.3

  // Contains proper nouns (capitalized words not at sentence start)
  const properNouns = msg.text.match(/(?<!^)(?<!\. )[A-Z][a-z]{2,}/g)
  if (properNouns && properNouns.length > 0) score += 0.15 * Math.min(properNouns.length, 3)

  // Contains email/phone
  if (/@|phone|\d{3}[-.]?\d{3}[-.]?\d{4}/.test(text)) score += 0.4

  // Contains dates/times
  if (/tomorrow|friday|thursday|monday|tuesday|wednesday|saturday|sunday|\d{1,2}(am|pm)|next week/i.test(text)) score += 0.25

  // User instructions — imperative language
  if (msg.role === 'user' && /don't|do not|stop|hold|wait|change|update|cancel|never|always/i.test(text)) score += 0.35

  // Questions (unanswered context)
  if (/\?$/.test(text.trim())) score += 0.1

  // Pure acknowledgments
  if (/^(ok|okay|sure|thanks|thank you|got it|yeah|yes|nice|cool|sounds good|great|perfect)[\s!.]*$/i.test(text.trim())) score -= 0.4

  // Tool results (raw output)
  if (text.startsWith('[tool:')) score -= 0.15

  // Greetings
  if (/^(hey|hi|hello|what'?s up|how can i help)/i.test(text.trim())) score -= 0.3

  // User messages get a slight boost (they contain intent)
  if (msg.role === 'user') score += 0.1

  // Recency bias — recent messages get a small boost
  const recency = index / total
  score += recency * 0.15

  return Math.max(0, Math.min(1, score))
}

// ── Redundancy detection via embeddings ──

function redundancyPenalty(embedding, otherEmbeddings, threshold = 0.85) {
  let maxSim = 0
  for (const other of otherEmbeddings) {
    const sim = cosine(embedding, other)
    if (sim > maxSim) maxSim = sim
  }
  // If very similar to another message, penalize (redundant)
  if (maxSim > threshold) return -(maxSim - threshold) * 2
  return 0
}

async function main() {
  console.log('=== Intelligent Forgetting Test ===\n')

  // Load embedder
  console.log('Loading model...')
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })
  console.log('Model loaded.\n')

  // Embed all messages
  const embeddings = []
  for (const msg of conversation) {
    const output = await embedder(msg.text, { pooling: 'mean', normalize: true })
    embeddings.push(Array.from(output.data))
  }

  // Score each message
  const scores = conversation.map((msg, i) => {
    const hScore = heuristicScore(msg, i, conversation.length)
    const otherEmbs = embeddings.filter((_, j) => j !== i)
    const rPenalty = redundancyPenalty(embeddings[i], otherEmbs, 0.82)
    const finalScore = Math.max(0, Math.min(1, hScore + rPenalty))

    return {
      index: i,
      role: msg.role,
      text: msg.text.slice(0, 80),
      heuristic: hScore,
      redundancy: rPenalty,
      final: finalScore,
      mustKeep: MUST_KEEP.has(i),
      safeToForget: SAFE_TO_FORGET.has(i),
    }
  })

  // Sort by score to see ranking
  const ranked = [...scores].sort((a, b) => a.final - b.final)

  console.log('=== All Messages Ranked by Retention Score (lowest = forget first) ===\n')
  for (const s of ranked) {
    const tag = s.mustKeep ? ' !! MUST KEEP' : s.safeToForget ? ' -- safe to forget' : ''
    console.log(`  [${String(s.index).padStart(2)}] ${s.final.toFixed(3)} (h:${s.heuristic.toFixed(2)} r:${s.redundancy.toFixed(2)}) ${s.role.padEnd(9)} "${s.text}"${tag}`)
  }

  // Simulate forgetting: keep only top N messages (context window = 15 out of 30)
  const WINDOW_SIZE = 15
  const kept = [...scores].sort((a, b) => b.final - a.final).slice(0, WINDOW_SIZE)
  const keptIndices = new Set(kept.map(s => s.index))
  const forgotten = scores.filter(s => !keptIndices.has(s.index))

  console.log(`\n=== Forgetting Simulation: Keep ${WINDOW_SIZE} of ${conversation.length} ===\n`)

  console.log('KEPT:')
  for (const s of kept.sort((a, b) => a.index - b.index)) {
    const tag = s.mustKeep ? ' [MUST KEEP]' : ''
    console.log(`  [${String(s.index).padStart(2)}] ${s.final.toFixed(3)} "${s.text}"${tag}`)
  }

  console.log('\nFORGOTTEN:')
  for (const s of forgotten.sort((a, b) => a.index - b.index)) {
    const tag = s.mustKeep ? ' [!! ERROR: FORGOT CRITICAL MSG !!]' : s.safeToForget ? ' [correct]' : ' [acceptable]'
    console.log(`  [${String(s.index).padStart(2)}] ${s.final.toFixed(3)} "${s.text}"${tag}`)
  }

  // Score the results
  const criticalForgotten = forgotten.filter(s => s.mustKeep)
  const safeCorrectlyForgotten = forgotten.filter(s => s.safeToForget)

  console.log('\n=== Results ===')
  console.log(`Critical messages preserved: ${MUST_KEEP.size - criticalForgotten.length}/${MUST_KEEP.size}`)
  console.log(`Safe messages correctly forgotten: ${safeCorrectlyForgotten.length}/${SAFE_TO_FORGET.size}`)
  console.log(`Critical messages wrongly forgotten: ${criticalForgotten.length}`)
  if (criticalForgotten.length > 0) {
    console.log('  FAILURES:')
    for (const s of criticalForgotten) {
      console.log(`    [${s.index}] "${s.text}"`)
    }
  }
  console.log(`\nCompression: ${conversation.length} → ${WINDOW_SIZE} messages (${((1 - WINDOW_SIZE/conversation.length) * 100).toFixed(0)}% reduction)`)
}

main().catch(console.error)
