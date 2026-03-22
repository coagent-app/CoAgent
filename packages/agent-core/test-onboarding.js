const WebSocket = require('ws')

function chat(message, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:7830')
    let response = ''
    let timer

    ws.on('open', () => ws.send(JSON.stringify({ type: 'chat', message })))

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'agent_thinking') { process.stdout.write('[thinking] '); return }
      if (msg.type === 'chat_chunk') { process.stdout.write(msg.text); response += msg.text; return }
      if (msg.type === 'chat_response') {
        console.log('\n')
        clearTimeout(timer)
        ws.close()
      }
    })

    timer = setTimeout(() => ws.close(), timeoutMs)
    ws.on('close', () => resolve(response))
    ws.on('error', e => { console.error('ERR:', e.message); resolve('') })
  })
}

async function run() {
  console.log('=== ONBOARDING TEST ===\n')
  console.log('--- User opens app for first time ---')
  await chat('Hey', 45000)

  await new Promise(r => setTimeout(r, 1000))
  console.log('--- User gives name ---')
  await chat('My name is Sarah Mitchell', 45000)

  await new Promise(r => setTimeout(r, 1000))
  console.log('--- User gives brokerage ---')
  await chat('I work at Compass, I focus on luxury residential in Miami and Brickell', 45000)

  console.log('\n=== ONBOARDING PHASE 1 DONE ===')
  process.exit(0)
}

run().catch(e => { console.error(e); process.exit(1) })
