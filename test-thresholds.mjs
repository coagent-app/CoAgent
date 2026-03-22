const VOYAGE_API_KEY = 'pa-3gv1bUpAJh5cpEzP758txb4iI4g5LnjRr4hZ7gFMM7t'

const events = [
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

function eventToText(e) {
  return [e.trigger, e.from && ('from:' + e.from), e.subject, e.snippet, e.title, e.name, e.source].filter(Boolean).join(' | ')
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const res = await fetch('https://api.voyageai.com/v1/embeddings', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + VOYAGE_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: events.map(eventToText), model: 'voyage-3-lite' })
})
const data = await res.json()
const embs = data.data.map(d => d.embedding)

console.log('Key pairwise similarities:')
const pairs = [
  [0, 6, 'Counter offer #1 vs Counter offer #2 (same deal)'],
  [0, 2, 'Counter offer email vs 123 Main Showing'],
  [0, 3, 'Counter offer email vs Appraisal 123 Main'],
  [0, 7, 'Counter offer email vs Inspection 123 Main'],
  [2, 3, 'Showing 123 Main vs Appraisal 123 Main'],
  [1, 9, 'Open house email #1 vs Open house email #2 (same deal)'],
  [4, 8, 'Zillow lead email vs HubSpot new contact (Sarah Johnson)'],
  [4, 5, 'Zillow new lead vs Johnson family call'],
]
for (const [i, j, label] of pairs) {
  console.log('  ' + cosine(embs[i], embs[j]).toFixed(3) + '  ' + label)
}

for (const threshold of [0.75, 0.70, 0.65, 0.60]) {
  const clusters = []
  for (let i = 0; i < events.length; i++) {
    let best = null, bestScore = 0
    for (const c of clusters) {
      const s = cosine(embs[i], c.centroid)
      if (s > bestScore) { bestScore = s; best = c }
    }
    if (best && bestScore >= threshold) {
      best.idxs.push(i)
      for (let j = 0; j < embs[i].length; j++) {
        best.centroid[j] = (best.centroid[j] * (best.idxs.length - 1) + embs[i][j]) / best.idxs.length
      }
    } else {
      clusters.push({ centroid: [...embs[i]], idxs: [i] })
    }
  }
  console.log('\nThreshold ' + threshold + ': ' + clusters.length + ' clusters')
  clusters.forEach((c, ci) => {
    const labels = c.idxs.map(i => events[i].subject || events[i].title || events[i].name)
    if (c.idxs.length > 1) {
      console.log('  [MERGED] ' + labels.join(' + '))
    } else {
      console.log('  [solo]   ' + labels[0])
    }
  })
}
