const WebSocket = require('ws')
const ws = new WebSocket('ws://localhost:7830')
let done = false

ws.on('open', () => {
  console.log('Connected — sending chat to add a todo...')
  ws.send(JSON.stringify({
    type: 'chat',
    message: 'Add a to-do to call John Smith about the listing at 123 Main St. High priority, due today.'
  }))
})

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.type === 'agent_thinking') { process.stdout.write('[thinking] '); return }
  if (msg.type === 'chat_chunk') { process.stdout.write(msg.text); return }
  if (msg.type === 'chat_response') { console.log('\n[chat done]') }
  if (msg.type === 'todo_update') {
    console.log('\nTODO UPDATE — items:', msg.items.length)
    msg.items.forEach(t => console.log('  -', t.priority, '|', t.task, '| due:', t.due))
    if (!done && msg.items.length > 0) {
      done = true
      setTimeout(() => ws.close(), 300)
    }
  }
})

ws.on('close', () => console.log('\nTest complete.'))
ws.on('error', e => console.error('ERROR:', e.message))
setTimeout(() => ws.close(), 90000)
