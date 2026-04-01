const EXA_BASE = 'https://api.exa.ai'
const API_KEY = process.env.EXA_API_KEY

// Test 1: Search WITH subpage crawling (contact + about pages)
console.log('═'.repeat(70))
console.log(' TEST: Subpage crawling on auto detailing search')
console.log('═'.repeat(70))

const res = await fetch(`${EXA_BASE}/search`, {
  method: 'POST',
  headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'mobile auto detailing business Miami Florida',
    type: 'auto',
    numResults: 3,
    category: 'company',
    excludeDomains: ['yelp.com','reddit.com','facebook.com','youtube.com','linkedin.com'],
    contents: {
      text: { maxCharacters: 300 },
      summary: { query: 'Company name, services, contact info, owner name' },
      subpages: 3,
      subpageTarget: ['contact', 'about'],
    }
  })
})

if (!res.ok) {
  console.error('Search failed:', res.status, await res.text())
  process.exit(1)
}

const data = await res.json()

for (const r of data.results) {
  console.log(`\n📍 ${r.title}`)
  console.log(`   URL: ${r.url}`)
  if (r.summary) console.log(`   Summary: ${r.summary}`)
  if (r.text) console.log(`   Text: ${r.text.slice(0, 200)}`)
  
  if (r.subpages?.length) {
    console.log(`   📄 Subpages (${r.subpages.length}):`)
    for (const sp of r.subpages) {
      console.log(`      → ${sp.url}`)
      if (sp.text) {
        // Look for phone/email in subpage text
        const phones = sp.text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || []
        const emails = sp.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
        if (phones.length) console.log(`        📱 ${[...new Set(phones)].join(', ')}`)
        if (emails.length) console.log(`        ✉️  ${[...new Set(emails)].join(', ')}`)
        console.log(`        Text: ${sp.text.slice(0, 200)}`)
      }
    }
  } else {
    console.log(`   (no subpages returned)`)
  }
}

// Test 2: Same search WITHOUT subpages for comparison
console.log('\n\n' + '═'.repeat(70))
console.log(' COMPARISON: Same search, NO subpage crawling')
console.log('═'.repeat(70))

const res2 = await fetch(`${EXA_BASE}/search`, {
  method: 'POST',
  headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'mobile auto detailing business Miami Florida',
    type: 'auto',
    numResults: 3,
    category: 'company',
    excludeDomains: ['yelp.com','reddit.com','facebook.com','youtube.com','linkedin.com'],
    contents: {
      text: { maxCharacters: 300 },
      summary: { query: 'Company name, services, contact info, owner name' },
    }
  })
})

const data2 = await res2.json()
for (const r of data2.results) {
  const text = r.text || ''
  const phones = text.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || []
  const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
  
  console.log(`\n📍 ${r.title}`)
  console.log(`   URL: ${r.url}`)
  if (phones.length) console.log(`   📱 ${[...new Set(phones)].join(', ')}`)
  if (emails.length) console.log(`   ✉️  ${[...new Set(emails)].join(', ')}`)
  console.log(`   (no subpages)`)
}

console.log('\n✅ Done')
