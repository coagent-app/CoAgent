// Test: Can an LLM extract the same information from compressed messages as full messages?
// Compares: FULL context vs STOP WORDS compression vs PREDICTABILITY (DistilGPT2) compression

import Anthropic from '@anthropic-ai/sdk'
import { config } from 'dotenv'
import { AutoTokenizer, AutoModelForCausalLM } from '@huggingface/transformers'
config({ path: '../../relay/.env' })

// ═══════════════════════════════════════════════════════════════
// APPROACH 1: Stop word removal (static list)
// ═══════════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
  'a', 'an', 'the',
  'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'he', 'him', 'his',
  'she', 'her', 'hers', 'it', 'its', 'we', 'us', 'our', 'ours',
  'they', 'them', 'their', 'theirs', 'myself', 'yourself', 'itself',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having',
  'do', 'does', 'did',
  'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might',
  'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'of',
  'into', 'onto', 'upon', 'about', 'between', 'through',
  'during', 'before', 'after', 'above', 'below',
  'and', 'but', 'or', 'so', 'yet', 'because', 'since', 'while',
  'although', 'though', 'if', 'then', 'than', 'that', 'which', 'who',
  'just', 'really', 'very', 'quite', 'pretty', 'basically',
  'honestly', 'literally', 'totally', 'completely',
  'definitely', 'certainly', 'obviously', 'clearly', 'simply',
  'kind', 'sort', 'type', 'bit', 'lot', 'lots', 'bunch',
  'thing', 'things', 'stuff', 'something', 'anything', 'everything',
  'somehow', 'somewhat', 'somewhere',
  'please', 'thanks', 'sorry', 'excuse',
  'hey', 'hi', 'hello', 'well', 'oh', 'ah', 'um', 'hmm', 'ugh',
  'this', 'that', 'these', 'those', 'here', 'there',
  'also', 'too', 'even', 'still', 'already',
  'now', 'then', 'when', 'where', 'how', 'what', 'why',
  'some', 'any', 'each', 'every', 'all', 'both',
  'more', 'most', 'much', 'many', 'few', 'less',
  'other', 'another', 'such',
  'like', 'as', 'so', 'up', 'out', 'down', 'off',
  'over', 'own', 'same', 'only', 'actually',
  'got', 'get', 'gets', 'getting',
  'go', 'goes', 'going', 'went', 'gone',
  'come', 'comes', 'coming', 'came',
  'make', 'makes', 'making', 'made',
  'take', 'takes', 'taking', 'took', 'taken',
  'give', 'gives', 'giving', 'gave', 'given',
  'know', 'knows', 'knowing', 'knew', 'known',
  'think', 'thinks', 'thinking', 'thought',
  'say', 'says', 'saying', 'said',
  'tell', 'tells', 'telling', 'told',
  'see', 'sees', 'seeing', 'saw', 'seen',
  'let', 'lets', 'put', 'puts',
  'want', 'wants', 'wanted', 'wanting',
  'need', 'needs', 'needed',
  'look', 'looks', 'looking', 'looked',
  'keep', 'keeps', 'keeping', 'kept',
  'work', 'works', 'working', 'worked',
  'seem', 'seems', 'seemed',
  'feel', 'feels', 'feeling', 'felt',
  'try', 'tries', 'trying', 'tried',
  'back', 'right', 'good', 'great', 'sure', 'fine',
  'one', 'way', 'time', 'day',
  "i'm", "i've", "i'll", "i'd",
  "it's", "that's", "what's", "there's", "here's",
  "we're", "we've", "we'll", "we'd",
  "you're", "you've", "you'll", "you'd",
  "they're", "they've", "they'll", "they'd",
  "he's", "she's", "who's",
  "don't", "doesn't", "didn't", "won't", "wouldn't",
  "can't", "couldn't", "shouldn't", "isn't", "aren't",
  "wasn't", "weren't", "hasn't", "haven't", "hadn't",
])

function isStopWordProtected(word, originalWord) {
  if (/^\$/.test(originalWord)) return true
  if (/^\d/.test(word)) return true
  if (/%$/.test(word)) return true
  if (/-/.test(originalWord) && originalWord.length > 3) return true
  if (/^[A-Z][a-z]/.test(originalWord)) return true
  if (['no', 'not', 'never', 'none', 'neither', 'nor', "don't", "doesn't", "didn't", "won't", "can't", "shouldn't", "couldn't", "wouldn't", "isn't", "aren't"].includes(word)) return true
  if (/@/.test(word)) return true
  if (/\d{3}[-.]?\d{3,4}/.test(word)) return true
  if (/\d+\/\d+/.test(word)) return true
  return false
}

function compressStopWords(text) {
  const tokens = text.match(/\$[\d,.]+k?\b|[\w]+-[\w]+(?:-[\w]+)*|\d+[\d.,/]*%?|[\w']+@[\w.]+|[\w']+[.,!?;:]*|\S+/g) || []
  const kept = []
  for (const original of tokens) {
    const clean = original.replace(/[.,!?;:]+$/, '').toLowerCase()
    if (isStopWordProtected(clean, original)) { kept.push(original); continue }
    if (STOP_WORDS.has(clean)) continue
    kept.push(original)
  }
  return kept.join(' ')
}

// ═══════════════════════════════════════════════════════════════
// APPROACH 2: Predictability-based (DistilGPT2)
// ═══════════════════════════════════════════════════════════════

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
    results.push({
      tokenId: nextTokenId,
      tokenText: tokenizer.decode([nextTokenId]),
      surprisal: -logProb,
    })
  }
  return results
}

function groupTokensToWords(tokenSurprisals) {
  const words = []
  let currentWord = ''
  let currentSurprisal = 0
  let tokenCount = 0

  for (const ts of tokenSurprisals) {
    const text = ts.tokenText
    const startsNewWord = text.startsWith(' ') || text.startsWith('\n')
    if (startsNewWord && currentWord) {
      words.push({ word: currentWord, avgSurprisal: currentSurprisal / tokenCount })
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
    words.push({ word: currentWord, avgSurprisal: currentSurprisal / tokenCount })
  }
  return words
}

function isPredictabilityProtected(word) {
  if (/\$/.test(word)) return true
  if (/\d/.test(word)) return true
  if (/%/.test(word)) return true
  if (/^[A-Z][a-z]/.test(word)) return true
  if (/^[A-Z]{2,}/.test(word)) return true
  const w = word.toLowerCase()
  if (['no', 'not', 'never', 'none', 'neither', 'nor', "don't", "doesn't", "didn't", "won't", "can't", "shouldn't", "couldn't", "wouldn't", "isn't", "aren't"].includes(w)) return true
  if (/@/.test(word)) return true
  return false
}

async function compressPredictability(text, model, tokenizer, threshold = 3.0) {
  if (text.split(/\s+/).length <= 5) return text
  const tokenSurprisals = await computeTokenSurprisals(text, model, tokenizer)
  if (tokenSurprisals.length === 0) return text
  const words = groupTokensToWords(tokenSurprisals)
  const kept = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (i === 0 || isPredictabilityProtected(w.word)) { kept.push(w.word); continue }
    if (w.avgSurprisal >= threshold) kept.push(w.word)
  }
  return kept.join(' ')
}

// ═══════════════════════════════════════════════════════════════
// Test conversation
// ═══════════════════════════════════════════════════════════════

const conversation = [
  { role: 'user',      text: "Hey there, good morning! Hope you're doing well today. I've got a bunch of stuff to go through with you if you have time." },
  { role: 'assistant', text: "Good morning! I'm ready to help. Let's go through everything you need — just take it one thing at a time and I'll keep track." },
  { role: 'user',      text: "So the Johnson property at 742 Evergreen Terrace got a counter-offer yesterday. They came back at $452,000 with a 45-day close and they want the seller to cover closing costs up to $8,000." },
  { role: 'assistant', text: "Got it. So the Johnson counter-offer is $452k, 45-day close, seller covers up to $8k in closing costs. That's actually pretty reasonable based on the comps we pulled last week. The comparable sales in that neighborhood ranged from $435k to $470k, so $452k sits right in the sweet spot." },
  { role: 'user',      text: "Yeah yeah yeah, that sounds about right. I was thinking the same thing honestly." },
  { role: 'assistant', text: "Do you want me to draft a response to their agent, or do you want to think about it for a bit? No rush either way." },
  { role: 'user',      text: "Hmm let me think about it. But actually while I'm thinking, can you look up what's going on with my other listings? I feel like I haven't checked on those in a while." },
  { role: 'assistant', text: "Sure thing, let me pull those up for you. Give me just a second to check the MLS and your CRM for the latest activity on all your active listings." },
  { role: 'user',      text: "My client Maria Gonzalez called me last night about the downtown condo at 1500 Market Street Unit 12B. She wants to increase her offer from $315,000 to $328,500 and she's willing to waive the inspection contingency." },
  { role: 'assistant', text: "That's a significant move by Maria. Going from $315k to $328.5k with waived inspection shows she's serious. I'll update the offer documents. Just to confirm — she's keeping the financing contingency and the 30-day close timeline from the original offer, right?" },
  { role: 'user',      text: "Yes exactly, everything else stays the same. Only the price goes up and the inspection contingency gets waived." },
  { role: 'assistant', text: "Perfect, I'll update that right away. So to summarize: Maria Gonzalez offer on 1500 Market St Unit 12B is now $328,500, inspection waived, financing contingency remains, 30-day close." },
  { role: 'user',      text: "That's correct. Oh and one more thing — under no circumstances should you send any communications to the seller's agent before I explicitly approve the final draft. I want to review every word." },
  { role: 'assistant', text: "Absolutely, I won't send anything to the seller's agent without your explicit sign-off on the final draft. I'll prepare it and share it with you first for review." },
  { role: 'user',      text: "Great, thanks so much for handling all this. You're a lifesaver honestly. I don't know what I'd do without you managing all these details." },
  { role: 'assistant', text: "Happy to help! That's what I'm here for. Anything else you need before I start working on that updated offer for Maria?" },
]

const questions = [
  {
    question: "What is the counter-offer price on the Johnson property and what are the terms?",
    expectedFacts: ["$452,000", "45-day close", "seller covers closing costs", "$8,000"],
  },
  {
    question: "What is Maria Gonzalez's updated offer? Include property, price, and contingencies.",
    expectedFacts: ["1500 Market Street", "Unit 12B", "$328,500", "inspection waived", "financing contingency remains", "30-day close"],
  },
  {
    question: "What specific instruction did the user give about communications?",
    expectedFacts: ["don't send", "seller's agent", "approve", "final draft"],
  },
  {
    question: "What was the comparable sales range for the Johnson property neighborhood?",
    expectedFacts: ["$435k", "$470k"],
  },
]

async function askQuestion(client, messages, question) {
  const response = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 300,
    system: 'Answer the question based ONLY on the conversation history provided. Be specific with numbers and facts. Keep your answer brief.',
    messages: [
      ...messages,
      { role: 'user', content: question }
    ],
  })
  return response.content[0].text
}

function buildMessages(convo) {
  const merged = []
  for (const msg of convo) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += '\n' + msg.text
    } else {
      merged.push({ role: msg.role, content: msg.text })
    }
  }
  return merged
}

async function main() {
  const client = new Anthropic()

  console.log('=== COMPRESSION QUALITY TEST ===')
  console.log('Full vs Stop Words vs Predictability (DistilGPT2)')
  console.log('Model: claude-3-haiku-20240307\n')

  // Load DistilGPT2
  console.log('Loading DistilGPT2 for predictability scoring...')
  const gptTokenizer = await AutoTokenizer.from_pretrained('Xenova/distilgpt2')
  const gptModel = await AutoModelForCausalLM.from_pretrained('Xenova/distilgpt2')
  console.log('Model loaded.\n')

  // Build all three message arrays
  const fullMessages = buildMessages(conversation)

  const stopWordConvo = conversation.map(msg => ({
    role: msg.role, text: compressStopWords(msg.text),
  }))
  const stopWordMessages = buildMessages(stopWordConvo)

  const predictConvo = []
  for (const msg of conversation) {
    predictConvo.push({
      role: msg.role,
      text: await compressPredictability(msg.text, gptModel, gptTokenizer, 3.0),
    })
  }
  const predictMessages = buildMessages(predictConvo)

  // Show stats
  const fullWords = conversation.reduce((sum, m) => sum + m.text.split(/\s+/).length, 0)
  const swWords = stopWordConvo.reduce((sum, m) => sum + m.text.split(/\s+/).length, 0)
  const prWords = predictConvo.reduce((sum, m) => sum + m.text.split(/\s+/).length, 0)
  console.log(`Full:          ${fullWords} words`)
  console.log(`Stop words:    ${swWords} words (${((1 - swWords/fullWords) * 100).toFixed(0)}% reduction)`)
  console.log(`Predictability: ${prWords} words (${((1 - prWords/fullWords) * 100).toFixed(0)}% reduction)\n`)

  // Show compressed samples
  console.log('Sample compressed messages:')
  for (let i = 0; i < Math.min(4, conversation.length); i++) {
    const msg = conversation[i]
    console.log(`\n  [${msg.role}] FULL: "${msg.text.slice(0, 90)}..."`)
    console.log(`  [${msg.role}] STOP: "${stopWordConvo[i].text.slice(0, 90)}..."`)
    console.log(`  [${msg.role}] PRED: "${predictConvo[i].text.slice(0, 90)}..."`)
  }
  console.log()

  // Test each question
  let fullTotal = 0, swTotal = 0, prTotal = 0, maxTotal = 0

  for (const q of questions) {
    console.log('═'.repeat(90))
    console.log(`Q: ${q.question}`)
    console.log(`Expected facts: ${q.expectedFacts.join(' | ')}`)
    console.log('─'.repeat(90))

    const [fullAnswer, swAnswer, prAnswer] = await Promise.all([
      askQuestion(client, fullMessages, q.question),
      askQuestion(client, stopWordMessages, q.question),
      askQuestion(client, predictMessages, q.question),
    ])

    console.log(`\nFULL answer:\n  ${fullAnswer.replace(/\n/g, '\n  ')}`)
    console.log(`\nSTOP WORDS answer:\n  ${swAnswer.replace(/\n/g, '\n  ')}`)
    console.log(`\nPREDICTABILITY answer:\n  ${prAnswer.replace(/\n/g, '\n  ')}`)

    const fullHits = q.expectedFacts.filter(f => fullAnswer.toLowerCase().includes(f.toLowerCase()))
    const swHits = q.expectedFacts.filter(f => swAnswer.toLowerCase().includes(f.toLowerCase()))
    const prHits = q.expectedFacts.filter(f => prAnswer.toLowerCase().includes(f.toLowerCase()))

    fullTotal += fullHits.length
    swTotal += swHits.length
    prTotal += prHits.length
    maxTotal += q.expectedFacts.length

    console.log(`\nFull:           ${fullHits.length}/${q.expectedFacts.length}`)
    console.log(`Stop words:     ${swHits.length}/${q.expectedFacts.length}`)
    console.log(`Predictability: ${prHits.length}/${q.expectedFacts.length}`)
    console.log()
  }

  console.log('═'.repeat(90))
  console.log('FINAL SCORES')
  console.log('═'.repeat(90))
  console.log(`Full context:    ${fullTotal}/${maxTotal} facts recalled (${(fullTotal/maxTotal*100).toFixed(0)}%)`)
  console.log(`Stop words:      ${swTotal}/${maxTotal} facts recalled (${(swTotal/maxTotal*100).toFixed(0)}%) — ${((1 - swWords/fullWords) * 100).toFixed(0)}% compression`)
  console.log(`Predictability:  ${prTotal}/${maxTotal} facts recalled (${(prTotal/maxTotal*100).toFixed(0)}%) — ${((1 - prWords/fullWords) * 100).toFixed(0)}% compression`)
}

main().catch(console.error)
