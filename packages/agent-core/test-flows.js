const WebSocket = require('ws')

function wsTest(label, messages, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:7830')
    const received = []
    let timer

    ws.on('open', () => {
      console.log(`\n=== ${label} ===`)
      messages.forEach((m, i) => setTimeout(() => ws.send(JSON.stringify(m)), i * 300))
      timer = setTimeout(() => { ws.close() }, timeoutMs)
    })

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      received.push(msg)
      if (msg.type === 'agent_thinking') { process.stdout.write('[thinking] '); return }
      if (msg.type === 'chat_chunk') { process.stdout.write(msg.text); return }
      if (msg.type === 'chat_response') {
        console.log('\n[response done]')
        clearTimeout(timer)
        ws.close()
      }
      if (msg.type === 'todo_update') {
        console.log(`[todo_update] items: ${msg.items.length}`)
        msg.items.forEach(t => console.log(`  - [${t.priority}] ${t.task} | due: ${t.due || 'none'}`))
      }
      if (msg.type === 'queue_update') {
        console.log(`[queue_update] items: ${msg.items.length}`)
      }
      if (msg.type === 'done_update') {
        console.log(`[done_update] items: ${msg.items.length}`)
      }
    })

    ws.on('close', () => resolve(received))
    ws.on('error', e => { console.error('WS ERROR:', e.message); resolve(received) })
  })
}

async function run() {
  // Test 1: Add a todo with a specific time
  await wsTest('TEST 1: Add todo with time', [
    { type: 'chat', message: 'Add a high priority to-do to follow up with Maria Santos about her offer on 456 Ocean Drive. Due today at 3pm.' }
  ], 45000)

  await new Promise(r => setTimeout(r, 1000))

  // Test 2: Check todos appear
  await wsTest('TEST 2: Verify todo list', [
    { type: 'get_todos' }
  ], 3000)

  await new Promise(r => setTimeout(r, 1000))

  // Test 3: Simulate heartbeat (no todos due yet since 3pm may be later)
  await wsTest('TEST 3: Chat asking agent to run heartbeat check', [
    { type: 'chat', message: '[Heartbeat] Read agent.md to check your configured routines, then run them. No tasks are currently due. Reply with a brief summary of what you did, or "All clear." if nothing needed action.' }
  ], 45000)

  await new Promise(r => setTimeout(r, 1000))

  // Test 4: Onboarding check - confirm agent.md is being read
  await wsTest('TEST 4: Ask agent about its setup', [
    { type: 'chat', message: 'What routines are you currently set up to run for me?' }
  ], 45000)

  console.log('\n=== ALL TESTS DONE ===')
  process.exit(0)
}

run().catch(e => { console.error(e); process.exit(1) })
