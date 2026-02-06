#!/bin/bash
# Test script to verify image service and tmux integration
# Run this inside the add-on container

echo "=== Image Service Integration Test ==="
echo ""

# Test 1: Check if image service is running
echo "1. Checking image service (port 7680)..."
if curl -s http://localhost:7680/health | jq '.status' | grep -q "ok"; then
    echo "   ✓ Image service is running"
    UPLOAD_DIR=$(curl -s http://localhost:7680/config | jq -r '.uploadDir')
    echo "   Upload directory: $UPLOAD_DIR"
else
    echo "   ✗ Image service not responding"
fi
echo ""

# Test 2: Check if upload directory exists and is writable
echo "2. Checking upload directory access..."
if [ -d "/data/images" ]; then
    echo "   ✓ Directory exists: /data/images"
    ls -la /data/images | head -5

    # Try to create a test file
    if touch /data/images/test-access-$$.txt 2>/dev/null; then
        echo "   ✓ Directory is writable"
        rm /data/images/test-access-$$.txt
    else
        echo "   ✗ Directory is not writable"
    fi
else
    echo "   ✗ Directory does not exist"
fi
echo ""

# Test 3: Check if tmux session has same environment
echo "3. Checking tmux session environment..."
if tmux has-session -t claude 2>/dev/null; then
    echo "   ✓ tmux session 'claude' exists"

    # Check HOME in tmux
    TMUX_HOME=$(tmux display-message -p -t claude '#{pane_current_path}' 2>/dev/null || echo "unknown")
    echo "   tmux working directory: $TMUX_HOME"

    # Check if persistent packages PATH is loaded
    TMUX_PATH=$(tmux send-keys -t claude 'echo $PATH' Enter 2>/dev/null; sleep 0.5; tmux capture-pane -p -t claude | tail -1)
    if echo "$TMUX_PATH" | grep -q "/data/packages/bin"; then
        echo "   ✓ Persistent packages in PATH"
    else
        echo "   ⚠ Persistent packages may not be in PATH"
    fi
else
    echo "   ✗ tmux session 'claude' not found"
fi
echo ""

# Test 4: Check if ttyd is proxying correctly
echo "4. Checking ttyd terminal proxy..."
if curl -s http://localhost:7681/ | grep -q "ttyd"; then
    echo "   ✓ ttyd is responding on port 7681"
else
    echo "   ✗ ttyd not responding"
fi

if curl -s http://localhost:7680/terminal/ | grep -q "ttyd"; then
    echo "   ✓ Image service proxy is working"
else
    echo "   ✗ Image service proxy failed"
fi
echo ""

# Test 5: Check environment variables
echo "5. Environment variables:"
echo "   HOME: $HOME"
echo "   ANTHROPIC_CONFIG_DIR: $ANTHROPIC_CONFIG_DIR"
echo "   PATH includes /data/packages: $(echo $PATH | grep -q '/data/packages' && echo 'yes' || echo 'no')"
echo ""

echo "=== Test Complete ==="
