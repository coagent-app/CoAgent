// V4: Drop predictable words using actual language model probabilities
// Uses DistilGPT2 via transformers.js to compute P(word | context) for each word.
// Words with high probability (predictable) get dropped.
// Words with low probability (surprising / information-carrying) get kept.

import { AutoTokenizer, AutoModelForCausalLM } from '@huggingface/transformers'

// ── Log-softmax over a Float32Array slice ──

function logSoftmax(logits, vocabSize, offset) {
  let max = -Infinity
  for (let j = 0; j < vocabSize; j++) {
    if (logits[offset + j] > max) max = logits[offset + j]
  }
  let sumExp = 0
  for (let j = 0; j < vocabSize; j++) {
    sumExp += Math.exp(logits[offset + j] - max)
  }
  const logSumExp = max + Math.log(sumExp)
  return (tokenId) => logits[offset + tokenId] - logSumExp
}

// ── Compute per-token surprisal for a text ──

async function computeTokenSurprisals(text, model, tokenizer) {
  const encoded = await tokenizer(text, { return_tensors: 'pt' })
  const inputIds = encoded.input_ids
  const seqLen = inputIds.dims[1]

  if (seqLen < 2) return []

  const { logits } = await model(encoded)
  const vocabSize = logits.dims[2]
  const logitsData = logits.data

  const results = []
  for (let i = 0; i < seqLen - 1; i++) {
    const getLogProb = logSoftmax(logitsData, vocabSize, i * vocabSize)
    const nextTokenId = Number(inputIds.data[i + 1])
    const logProb = getLogProb(nextTokenId)
    const surprisal = -logProb // higher = more surprising = more information

    const tokenText = tokenizer.decode([nextTokenId])
    results.push({
      tokenId: nextTokenId,
      tokenText,
      logProb,
      surprisal,
      prob: Math.exp(logProb),
    })
  }
  return results
}

// ── Group sub-word tokens into words and aggregate surprisal ──

function groupTokensToWords(tokenSurprisals, tokenizer) {
  const words = []
  let currentWord = ''
  let currentSurprisal = 0
  let tokenCount = 0

  for (const ts of tokenSurprisals) {
    const text = ts.tokenText
    // GPT-2 BPE: tokens starting a new word begin with space (Ġ in raw vocab)
    const startsNewWord = text.startsWith(' ') || text.startsWith('\n')

    if (startsNewWord && currentWord) {
      words.push({
        word: currentWord,
        avgSurprisal: currentSurprisal / tokenCount,
        totalSurprisal: currentSurprisal,
        tokenCount,
      })
      currentWord = text.trimStart()
      currentSurprisal = ts.surprisal
      tokenCount = 1
    } else {
      currentWord += text.trimStart()
      currentSurprisal += ts.surprisal
      tokenCount++
    }
  }

  if (currentWord) {
    words.push({
      word: currentWord,
      avgSurprisal: currentSurprisal / tokenCount,
      totalSurprisal: currentSurprisal,
      tokenCount,
    })
  }

  return words
}

// ── Words that must NEVER be dropped regardless of predictability ──

function isProtected(word) {
  const w = word.toLowerCase()
  // Numbers, money, percentages
  if (/\$/.test(word)) return true
  if (/\d/.test(word)) return true
  if (/%/.test(word)) return true
  // Proper nouns (starts with capital)
  if (/^[A-Z][a-z]/.test(word)) return true
  // ALL CAPS (acronyms)
  if (/^[A-Z]{2,}/.test(word)) return true
  // Negations
  if (['no', 'not', 'never', 'none', 'neither', 'nor', "don't", "doesn't", "didn't", "won't", "can't", "shouldn't", "couldn't", "wouldn't", "isn't", "aren't"].includes(w)) return true
  // Email-like
  if (/@/.test(word)) return true
  return false
}

// ── Compress a message by dropping predictable words ──

async function compressMessage(text, model, tokenizer, threshold = 2.0) {
  // Short messages (≤5 words) — keep everything, too little context to score
  if (text.split(/\s+/).length <= 5) return text

  const tokenSurprisals = await computeTokenSurprisals(text, model, tokenizer)
  if (tokenSurprisals.length === 0) return text

  const words = groupTokensToWords(tokenSurprisals, tokenizer)

  // Always keep the first word (no preceding context to judge predictability)
  const kept = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (i === 0 || isProtected(w.word)) {
      kept.push(w.word)
      continue
    }
    // Keep words above surprisal threshold (surprising = informative)
    if (w.avgSurprisal >= threshold) {
      kept.push(w.word)
    }
  }

  return kept.join(' ')
}

// ═══════════════════════════════════════════════════════════════
// TEST CONVERSATIONS
// ═══════════════════════════════════════════════════════════════

const tests = [
  {
    name: "Filler greeting",
    text: "Hey there, good morning! Hope you're doing well today. I've got a bunch of stuff to go through with you if you have time.",
    critical: [],
  },
  {
    name: "Deal details",
    text: "So the Johnson property at 742 Evergreen Terrace got a counter-offer yesterday. They came back at $452,000 with a 45-day close and they want the seller to cover closing costs up to $8,000.",
    critical: ["Johnson", "742", "Evergreen", "Terrace", "$452,000", "45-day", "close", "seller", "closing", "costs", "$8,000"],
  },
  {
    name: "Analysis with numbers",
    text: "Got it. So the Johnson counter-offer is $452k, 45-day close, seller covers up to $8k in closing costs. That's actually pretty reasonable based on the comps we pulled last week. The comparable sales in that neighborhood ranged from $435k to $470k, so $452k sits right in the sweet spot.",
    critical: ["Johnson", "$452k", "45-day", "$8k", "closing", "costs", "$435k", "$470k"],
  },
  {
    name: "Pure filler agreement",
    text: "Yeah yeah yeah, that sounds about right. I was thinking the same thing honestly.",
    critical: [],
  },
  {
    name: "Client action with specifics",
    text: "My client Maria Gonzalez called me last night about the downtown condo at 1500 Market Street Unit 12B. She wants to increase her offer from $315,000 to $328,500 and she's willing to waive the inspection contingency.",
    critical: ["Maria", "Gonzalez", "1500", "Market", "Street", "Unit", "12B", "$315,000", "$328,500", "waive", "inspection", "contingency"],
  },
  {
    name: "Critical instruction",
    text: "That's correct. Oh and one more thing — under no circumstances should you send any communications to the seller's agent before I explicitly approve the final draft. I want to review every word.",
    critical: ["no", "circumstances", "send", "communications", "seller", "agent", "approve", "final", "draft", "review"],
  },
  {
    name: "Medical details",
    text: "Dr. Patel said my blood pressure is 142/91 which is stage 2 hypertension. She's putting me on Lisinopril 10mg once daily starting tomorrow. I need to take it in the morning with food.",
    critical: ["Dr.", "Patel", "blood", "pressure", "142/91", "stage", "2", "hypertension", "Lisinopril", "10mg", "daily", "tomorrow", "morning", "food"],
  },
  {
    name: "Contract terms",
    text: "So the licensing agreement with Nexus Corp has the following key terms: $75,000 annual fee, 3-year commitment with auto-renewal, they get exclusive rights to our API in North America, and there's a 2.5% revenue share on any products they build using our technology.",
    critical: ["Nexus", "Corp", "$75,000", "annual", "fee", "3-year", "auto-renewal", "exclusive", "rights", "API", "North", "America", "2.5%", "revenue", "share"],
  },
  {
    name: "Technical decision",
    text: "We need to migrate from PostgreSQL 14 to PostgreSQL 16 before the end of Q2. The main reason is that we need the JSON path improvements and the logical replication enhancements for our multi-region setup.",
    critical: ["migrate", "PostgreSQL", "14", "16", "Q2", "JSON", "path", "improvements", "logical", "replication", "enhancements", "multi-region"],
  },
  {
    name: "Constraint with number",
    text: "The other thing is we absolutely cannot have more than 15 minutes of downtime during the migration. Our SLA with Enterprise customers guarantees 99.95% uptime and we're already at 99.97% this quarter.",
    critical: ["not", "15", "minutes", "downtime", "migration", "SLA", "Enterprise", "99.95%", "uptime", "99.97%"],
  },
  {
    name: "Standing instruction",
    text: "From now on, always send new leads a welcome email within 1 hour. Don't ask me, just do it.",
    critical: ["always", "send", "leads", "welcome", "email", "1", "hour", "Don't", "ask"],
  },
  {
    name: "Short constraint",
    text: "No HOA.",
    critical: ["No", "HOA"],
  },
  {
    name: "Short constraint 2",
    text: "Max 3 bedrooms.",
    critical: ["Max", "3", "bedrooms"],
  },
  {
    name: "Filler gratitude",
    text: "Great, thanks so much for handling all this. You're a lifesaver honestly. I don't know what I'd do without you managing all these details.",
    critical: [],
  },
  {
    name: "Event planning details",
    text: "The party is December 18th at the Riverside Grand Hotel, Ballroom B. We're expecting 85 guests. The hotel needs a final headcount by December 11th and a $3,500 deposit by this Friday.",
    critical: ["December", "18th", "Riverside", "Grand", "Hotel", "Ballroom", "B", "85", "guests", "headcount", "December", "11th", "$3,500", "deposit", "Friday"],
  },
  {
    name: "Pure acknowledgment",
    text: "Yeah that makes sense. I was thinking the same thing.",
    critical: [],
  },
  {
    name: "Never instruction",
    text: "Oh wait — never schedule anything on Sundays. That's family time.",
    critical: ["never", "schedule", "Sundays", "family"],
  },
  {
    name: "Password",
    text: "My password for the client portal is Sunset2024! — can you save that somewhere safe?",
    critical: ["password", "client", "portal", "Sunset2024"],
  },
]

async function main() {
  console.log('=== V4: PREDICTABILITY-BASED WORD COMPRESSION ===')
  console.log('Using DistilGPT2 to score word predictability via P(word | context)')
  console.log('Drop predictable words, keep surprising (information-carrying) words\n')

  console.log('Loading DistilGPT2...')
  const tokenizer = await AutoTokenizer.from_pretrained('Xenova/distilgpt2')
  const model = await AutoModelForCausalLM.from_pretrained('Xenova/distilgpt2')
  console.log('Model loaded.\n')

  // Try multiple thresholds to find optimal
  const THRESHOLDS = [1.5, 2.0, 2.5, 3.0, 4.0]

  for (const threshold of THRESHOLDS) {
    console.log('\n' + '█'.repeat(90))
    console.log(`  THRESHOLD = ${threshold} (drop words with avgSurprisal < ${threshold})`)
    console.log('█'.repeat(90) + '\n')

    let totalOriginalWords = 0
    let totalCompressedWords = 0
    let totalCriticalWords = 0
    let totalCriticalPreserved = 0
    let passes = 0

    for (const test of tests) {
      const original = test.text
      const compressed = await compressMessage(original, model, tokenizer, threshold)
      const origWords = original.split(/\s+/).length
      const compWords = compressed.split(/\s+/).filter(w => w).length
      const ratio = ((1 - compWords / origWords) * 100).toFixed(0)

      totalOriginalWords += origWords
      totalCompressedWords += compWords

      const compressedLower = compressed.toLowerCase()
      const preserved = test.critical.filter(w => compressedLower.includes(w.toLowerCase()))
      const missed = test.critical.filter(w => !compressedLower.includes(w.toLowerCase()))
      totalCriticalWords += test.critical.length
      totalCriticalPreserved += preserved.length

      const status = missed.length === 0 ? 'PASS' : 'FAIL'
      if (status === 'PASS') passes++

      console.log(`${status} | ${test.name} (${origWords}→${compWords} words, ${ratio}% reduction)`)
      console.log(`  Original:   "${original.slice(0, 120)}${original.length > 120 ? '...' : ''}"`)
      console.log(`  Compressed: "${compressed.slice(0, 120)}${compressed.length > 120 ? '...' : ''}"`)
      if (missed.length > 0) {
        console.log(`  !! MISSED: ${missed.join(', ')}`)
      }
      console.log()
    }

    console.log('─'.repeat(90))
    console.log(`THRESHOLD ${threshold} SUMMARY:`)
    console.log(`  Word reduction: ${totalOriginalWords} → ${totalCompressedWords} (${((1 - totalCompressedWords / totalOriginalWords) * 100).toFixed(1)}% compression)`)
    console.log(`  Critical words preserved: ${totalCriticalPreserved}/${totalCriticalWords} (${(totalCriticalPreserved / totalCriticalWords * 100).toFixed(1)}%)`)
    console.log(`  Tests passed: ${passes}/${tests.length}`)
  }

  // Show detailed surprisal breakdown for one example
  console.log('\n' + '═'.repeat(90))
  console.log('DETAILED SURPRISAL BREAKDOWN — "Deal details" message')
  console.log('═'.repeat(90) + '\n')

  const exampleText = tests[1].text
  const tokenSurprisals = await computeTokenSurprisals(exampleText, model, tokenizer)
  const words = groupTokensToWords(tokenSurprisals, tokenizer)

  console.log('Word-level surprisal scores (higher = more surprising = more info):')
  for (const w of words) {
    const bar = '█'.repeat(Math.round(w.avgSurprisal))
    const prot = isProtected(w.word) ? ' [PROTECTED]' : ''
    console.log(`  ${w.avgSurprisal.toFixed(2)} ${bar.padEnd(15)} "${w.word}"${prot}`)
  }
}

main().catch(console.error)
