const EXA_BASE = 'https://api.exa.ai'
const API_KEY = process.env.EXA_API_KEY

// Test subpages with explicit target URLs and bigger businesses
console.log('═'.repeat(70))
console.log(' TEST 1: Subpage crawling on dentists (more likely to have /contact)')
console.log('═'.repeat(70))

const res = await fetch(`${EXA_BASE}/search`, {
  method: 'POST',
  headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'dental practice Austin Texas',
    type: 'auto',
    numResults: 3,
    category: 'company',
    excludeDomains: ['yelp.com','reddit.com','facebook.com','youtube.com','linkedin.com','deltadental.com'],
    contents: {
      text: { maxCharacters: 200 },
      summary: { query: 'Company name, phone number, email, address, owner/dentist name, services offered' },
      subpages: 3,
      subpageTarget: ['contact', 'about', 'team', 'our-team', 'meet-the-team', 'staff'],
    }
  })
})

const data = await res.json()
for (const r of data.results) {
  console.log(`\n📍 ${r.title}`)
  console.log(`   ${r.url}`)
  if (r.summary) console.log(`   ${r.summary.slice(0, 300)}`)
  if (r.subpages?.length) {
    console.log(`   📄 ${r.subpages.length} subpages:`)
    for (const sp of r.subpages) {
      const phones = (sp.text||'').match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || []
      const emails = (sp.text||'').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
      console.log(`      ${sp.url}`)
      if (phones.length) console.log(`      📱 ${[...new Set(phones)].join(', ')}`)
      if (emails.length) console.log(`      ✉️  ${[...new Set(emails)].join(', ')}`)
    }
  } else {
    console.log(`   (no subpages)`)
  }
}

// Test 2: Try the summary with a more structured prompt
console.log('\n\n' + '═'.repeat(70))
console.log(' TEST 2: Smart summary extraction (no subpages needed?)')
console.log('═'.repeat(70))

const res2 = await fetch(`${EXA_BASE}/search`, {
  method: 'POST',
  headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'auto detailing company started 2024 Texas',
    type: 'auto',
    numResults: 5,
    category: 'company',
    excludeDomains: ['yelp.com','reddit.com','facebook.com','youtube.com','linkedin.com'],
    contents: {
      text: { maxCharacters: 200 },
      summary: { query: 'Extract: company name, phone number, email address, physical address, owner name, year founded, number of employees, services offered. If not found say N/A.' },
    }
  })
})

const data2 = await res2.json()
for (const r of data2.results) {
  console.log(`\n📍 ${r.title}`)
  console.log(`   ${r.url}`)
  if (r.summary) console.log(`   ${r.summary}`)
}

console.log('\n✅ Done')
