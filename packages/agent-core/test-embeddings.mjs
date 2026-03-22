// Quick test: local embeddings with all-MiniLM-L6-v2 (quantized)
// Tests: load time, embed speed, retrieval quality

import { pipeline } from '@huggingface/transformers'

// Simulate a real conversation history
const conversationMessages = [
  "Hey, I need help with the Johnson contract. The counter-offer came in at $450k.",
  "I looked at the Johnson contract — their counter of $450k is reasonable given market comps. I'd recommend accepting with a 30-day close contingency.",
  "Can you draft an email to Sarah about the team meeting on Friday?",
  "I drafted an email to Sarah about the Friday team meeting. Want me to send it?",
  "What's the status on the 123 Main Street listing?",
  "The 123 Main Street listing has been active for 14 days. 3 showings last week, one interested buyer who asked about the roof age.",
  "Remind me to follow up with the mortgage broker tomorrow.",
  "Added a reminder to follow up with the mortgage broker tomorrow morning.",
  "Can you pull up the quarterly sales report?",
  "Here's the quarterly sales report summary: 12 closed deals, $3.2M total volume, average days on market: 28.",
  "I got a new lead from Zillow — Mark Thompson looking at properties in the $300-400k range in Westside.",
  "Got it. I've added Mark Thompson as a new lead. $300-400k budget, Westside area. Want me to send him available listings?",
  "What did we discuss about the Johnson property earlier?",
  "Send the monthly newsletter to all my clients.",
  "How many deals did we close last quarter?",
  "What's Mark Thompson's budget again?",
  "Can you check if there are any new emails from Sarah?",
  "Schedule a showing for 456 Oak Avenue this Thursday at 2pm.",
  "What properties do we have listed in the Westside area?",
  "Prepare a CMA for the property at 789 Pine Street.",
]

// Test queries — what the user might ask, and what SHOULD be retrieved
const testQueries = [
  {
    query: "What was the Johnson counter-offer?",
    expectedRelevant: [0, 1],  // messages about Johnson contract
    description: "Recall specific deal detail"
  },
  {
    query: "Tell me about Mark Thompson",
    expectedRelevant: [10, 11, 15],  // messages about Mark
    description: "Recall client info"
  },
  {
    query: "What happened with the quarterly report?",
    expectedRelevant: [8, 9, 14],  // quarterly report messages
    description: "Recall report discussion"
  },
  {
    query: "Any updates on Main Street?",
    expectedRelevant: [4, 5],  // 123 Main Street messages
    description: "Recall listing status"
  },
  {
    query: "Did I ask you to email anyone?",
    expectedRelevant: [2, 3, 13],  // email-related messages
    description: "Recall email tasks"
  },
]

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function main() {
  console.log('=== Local Embedding Test (all-MiniLM-L6-v2 quantized) ===\n')

  // 1. Load model
  console.log('Loading model...')
  const t0 = Date.now()
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'q8',  // quantized int8
  })
  const loadTime = Date.now() - t0
  console.log(`Model loaded in ${loadTime}ms\n`)

  // 2. Embed all messages
  console.log('Embedding conversation history...')
  const embedTimes = []
  const embeddings = []

  for (const msg of conversationMessages) {
    const t1 = Date.now()
    const output = await embedder(msg, { pooling: 'mean', normalize: true })
    const embedding = Array.from(output.data)
    embedTimes.push(Date.now() - t1)
    embeddings.push(embedding)
  }

  const avgEmbed = embedTimes.reduce((a, b) => a + b) / embedTimes.length
  const minEmbed = Math.min(...embedTimes)
  const maxEmbed = Math.max(...embedTimes)
  console.log(`Embedded ${conversationMessages.length} messages`)
  console.log(`  Avg: ${avgEmbed.toFixed(1)}ms | Min: ${minEmbed}ms | Max: ${maxEmbed}ms`)
  console.log(`  Dimensions: ${embeddings[0].length}\n`)

  // 3. Test retrieval quality
  console.log('=== Retrieval Quality Tests ===\n')

  let totalPrecision = 0
  let totalRecall = 0
  let testCount = 0

  for (const test of testQueries) {
    const t2 = Date.now()
    const queryOutput = await embedder(test.query, { pooling: 'mean', normalize: true })
    const queryEmb = Array.from(queryOutput.data)
    const queryTime = Date.now() - t2

    // Score all messages
    const scored = embeddings.map((emb, i) => ({
      index: i,
      score: cosine(queryEmb, emb),
      text: conversationMessages[i].slice(0, 80)
    })).sort((a, b) => b.score - a.score)

    // Top 5 results
    const topK = scored.slice(0, 5)
    const retrievedIndices = topK.map(s => s.index)

    // Precision: how many of top-K are actually relevant?
    const relevant = retrievedIndices.filter(i => test.expectedRelevant.includes(i))
    const precision = relevant.length / topK.length
    const recall = relevant.length / test.expectedRelevant.length
    totalPrecision += precision
    totalRecall += recall
    testCount++

    console.log(`Query: "${test.query}" (${test.description}) [${queryTime}ms]`)
    console.log(`  Expected: [${test.expectedRelevant.join(', ')}] | Found in top-5: [${relevant.join(', ')}]`)
    console.log(`  Precision: ${(precision * 100).toFixed(0)}% | Recall: ${(recall * 100).toFixed(0)}%`)
    for (const r of topK) {
      const mark = test.expectedRelevant.includes(r.index) ? '✓' : ' '
      console.log(`    ${mark} [${r.index}] ${r.score.toFixed(4)} — "${r.text}"`)
    }
    console.log()
  }

  console.log('=== Summary ===')
  console.log(`Avg Precision@5: ${(totalPrecision / testCount * 100).toFixed(1)}%`)
  console.log(`Avg Recall@5: ${(totalRecall / testCount * 100).toFixed(1)}%`)
  console.log(`Model load: ${loadTime}ms (one-time)`)
  console.log(`Avg embed: ${avgEmbed.toFixed(1)}ms per message`)
  console.log(`Dimensions: ${embeddings[0].length}`)
}

main().catch(console.error)
