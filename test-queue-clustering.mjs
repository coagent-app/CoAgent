/**
 * Test: semantic event queue clustering
 * Simulates a day of webhook events and shows what the agent would actually see
 */

const VOYAGE_API_KEY = 'pa-3gv1bUpAJh5cpEzP758txb4iI4g5LnjRr4hZ7gFMM7t'
const SIMILARITY_THRESHOLD = 0.80

// ── Fake incoming events (realistic real estate day) ─────────────────────────

const incomingEvents = [
  { trigger: 'GMAIL_NEW_EMAIL', from: 'seller@coastalrealty.com', subject: 'Counter offer on 123 Main St', snippet: 'We are willing to come down to $485,000 if you can close by March 15.' },
  { trigger: 'GMAIL_NEW_EMAIL', from: 'client@gmail.com', subject: 'Question about the open house', snippet: 'Hi, are you still doing the open house on Sunday at 456 Oak Ave?' },
  { trigger: 'GOOGLECALENDAR_NEW_EVENT', title: 'Showing: 123 Main St', organizer: 'buyer@gmail.com', start: '2026-02-23T14:00:00Z' },
  { trigger: 'GMAIL_NEW_EMAIL', from: 'lender@bankofamerica.com', subject: 'Appraisal complete - 123 Main St', snippet: 'The property at 123 Main St has been appraised at $492,000.' },
  { trigger: 'GMAIL_NEW_EMAIL', from: 'newlead@zillow.com', subject: 'New inquiry on your listing', snippet: 'Sarah Johnson is interested in 789 Elm St. She is pre-approved for $600k.' },
  { trigger: 'GOOGLECALENDAR_EVENT_REMINDER', title: 'Client call: Johnson family', organizer: 'you@brokerage.com', start: '2026-02-22T16:00:00Z' },
  { trigger: 'GMAIL_NEW_EMAIL', from: 'seller@coastalrealty.com', subject: 'Re: Counter offer - deadline', snippet: 'Just following up on the counter offer. The sellers need a response by EOD.' },
  { trigger: 'GMAIL_NEW_EMAIL', from: 'inspector@homeinspect.com', subject: '123 Main St inspection report ready', snippet: 'Please find attached the full inspection report for 123 Main St. Minor issues noted.' },
  { trigger: 'HUBSPOT_NEW_CONTACT', name: 'Sarah Johnson', email: 'sarah.j@gmail.com', source: 'Zillow inquiry' },
  { trigger: 'GMAIL_NEW_EMAIL', from: 'client@gmail.com', subject: 'Sunday open house - bringing my parents', snippet: 'We will be there at 2pm with my parents. Really excited about Oak Ave.' },
]

// ── Voyage embedding ──────────────────────────────────────────────────────────

async function embed(texts) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, model: 'voyage-3-lite' })
  })
  const data = await res.json()
  return data.data.map(d => d.embedding)
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function eventToText(e) {
  const parts = [e.trigger]
  if (e.from) parts.push(`from: ${e.from}`)
  if (e.subject) parts.push(`subject: ${e.subject}`)
  if (e.snippet) parts.push(`snippet: ${e.snippet}`)
  if (e.title) parts.push(`title: ${e.title}`)
  if (e.organizer) parts.push(`organizer: ${e.organizer}`)
  if (e.name) parts.push(`name: ${e.name}`)
  if (e.source) parts.push(`source: ${e.source}`)
  return parts.join(' | ')
}

// ── Clustering ────────────────────────────────────────────────────────────────

async function clusterEvents(events) {
  console.log(`\nEmbedding ${events.length} events...`)
  const texts = events.map(eventToText)
  const embeddings = await embed(texts)

  const clusters = [] // { centroid: [], events: [], texts: [] }

  for (let i = 0; i < events.length; i++) {
    const emb = embeddings[i]
    let bestCluster = null
    let bestScore = 0

    for (const cluster of clusters) {
      const score = cosineSimilarity(emb, cluster.centroid)
      if (score > bestScore) {
        bestScore = score
        bestCluster = cluster
      }
    }

    if (bestCluster && bestScore >= SIMILARITY_THRESHOLD) {
      bestCluster.events.push(events[i])
      bestCluster.texts.push(texts[i])
      // Update centroid as running average
      for (let j = 0; j < emb.length; j++) {
        bestCluster.centroid[j] = (bestCluster.centroid[j] * (bestCluster.events.length - 1) + emb[j]) / bestCluster.events.length
      }
      console.log(`  Event ${i+1} → merged into existing cluster (score: ${bestScore.toFixed(3)})`)
    } else {
      clusters.push({ centroid: emb, events: [events[i]], texts: [texts[i]] })
      console.log(`  Event ${i+1} → new cluster #${clusters.length}${bestScore > 0 ? ` (best match was ${bestScore.toFixed(3)})` : ''}`)
    }
  }

  return clusters
}

// ── Main ─────────────────────────────────────────────────────────────────────

const clusters = await clusterEvents(incomingEvents)

console.log('\n' + '='.repeat(60))
console.log(`RESULT: ${incomingEvents.length} events → ${clusters.length} clusters`)
console.log('='.repeat(60))
console.log('\nWhat the agent would see:\n')

clusters.forEach((cluster, i) => {
  console.log(`Cluster ${i+1} (${cluster.events.length} event${cluster.events.length > 1 ? 's' : ''})`)
  cluster.events.forEach(e => {
    const label = e.subject || e.title || e.name || e.trigger
    const from = e.from || e.organizer || e.source || ''
    console.log(`  • [${e.trigger}] ${label}${from ? ' — ' + from : ''}`)
  })
  console.log()
})
