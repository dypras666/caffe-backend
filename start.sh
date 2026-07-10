#!/bin/bash
# Kill any existing instance
pkill -f "node server.js" 2>/dev/null
sleep 1
# Start backend, restart on crash
while true; do
  node server.js
  echo "Backend crashed, restarting in 2s..."
  sleep 2
done
