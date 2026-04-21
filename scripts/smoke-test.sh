#!/bin/bash
# Smoke test: verify the production binary starts and listens
# Usage: ./scripts/smoke-test.sh [path-to-binary]

BINARY="${1:-/Applications/Co-Agent.app/Contents/MacOS/coagent-server}"
DATA_DIR="${2:-/tmp/coagent-smoke-test}"
PORT=17830  # Use a non-default port to avoid conflicts
TIMEOUT=15

if [ ! -f "$BINARY" ]; then
  echo "FAIL: Binary not found at $BINARY"
  exit 1
fi

echo "Testing: $BINARY"

# Start server on test port
COAGENT_PORT=$PORT COAGENT_DATA_DIR="$DATA_DIR" \
  "$BINARY" &>/tmp/coagent-smoke-test.log &
PID=$!

# Wait for it to listen
for i in $(seq 1 $TIMEOUT); do
  if lsof -i :$PORT -P 2>/dev/null | grep -q LISTEN; then
    echo "PASS: Server listening on port $PORT (took ${i}s)"

    # Let it run a few more seconds to catch delayed crashes (e.g. teammate spawn)
    echo "Waiting 10s for delayed crashes..."
    sleep 10

    # Check if process is still alive
    if ! kill -0 $PID 2>/dev/null; then
      echo "FAIL: Server crashed after startup"
      echo "--- Log ---"
      cat /tmp/coagent-smoke-test.log
      exit 1
    fi

    # Check for crash/error in logs
    if grep -qi "uncaught exception\|fatal\|panic" /tmp/coagent-smoke-test.log; then
      echo "FAIL: Server had errors:"
      grep -i "uncaught exception\|fatal\|panic\|error:" /tmp/coagent-smoke-test.log
      kill $PID 2>/dev/null
      wait $PID 2>/dev/null
      exit 1
    fi

    kill $PID 2>/dev/null
    wait $PID 2>/dev/null
    echo "PASS: No crashes detected"
    exit 0
  fi
  sleep 1
done

echo "FAIL: Server did not start within ${TIMEOUT}s"
echo "--- Last 20 lines of log ---"
tail -20 /tmp/coagent-smoke-test.log
kill $PID 2>/dev/null
wait $PID 2>/dev/null
exit 1
