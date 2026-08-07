#!/usr/bin/env python3
"""
Simple verification script for the rate limiter.

Run this after starting Redis:
    python3 verify_rate_limiter.py

This tests:
- Token bucket initialization
- Burst capacity (should allow 10 rapid messages)
- Rate limiting (11th rapid message should be blocked)
- Token refill over time
- Atomicity (Lua script returns correct values)

NOTE: True race-condition testing requires multiple processes/instances hitting
Redis concurrently, which is beyond the scope of this unit test. That's covered
by integration tests with the full docker-compose stack.
"""
import asyncio


async def test_player_rate_limiter():
    """Test the player-level rate limiter logic with a real Redis instance."""
    from game_engine.rate_limiter import check_rate_limit
    
    test_player_id = "test_player_verify"
    
    print("=" * 60)
    print("Testing PLAYER-LEVEL rate limiter (post-join)")
    print("=" * 60)
    print(f"Bucket capacity: 10, Refill rate: 5/sec, Cost: 1/msg\n")
    
    # Test 1: Burst capacity - should allow 10 messages rapidly
    print("Test 1: Burst capacity (10 rapid messages)")
    allowed_count = 0
    for i in range(10):
        allowed = await check_rate_limit(test_player_id)
        if allowed:
            allowed_count += 1
        print(f"  Message {i+1}: {'✓ allowed' if allowed else '✗ blocked'}")
    
    assert allowed_count == 10, f"Expected 10 allowed, got {allowed_count}"
    print(f"✓ Test 1 passed: {allowed_count}/10 messages allowed\n")
    
    # Test 2: Rate limiting - 11th message should be blocked
    print("Test 2: Rate limiting (11th rapid message)")
    allowed = await check_rate_limit(test_player_id)
    print(f"  Message 11: {'✓ allowed' if allowed else '✗ blocked'}")
    assert not allowed, "Expected message 11 to be blocked"
    print("✓ Test 2 passed: 11th message blocked\n")
    
    # Test 3: Token refill - wait 0.4s (should refill 2 tokens)
    print("Test 3: Token refill (wait 0.4s → 2 tokens)")
    await asyncio.sleep(0.4)
    allowed_count = 0
    for i in range(3):
        allowed = await check_rate_limit(test_player_id)
        if allowed:
            allowed_count += 1
        print(f"  Message {i+1} after wait: {'✓ allowed' if allowed else '✗ blocked'}")
    
    assert allowed_count == 2, f"Expected 2 allowed after refill, got {allowed_count}"
    print("✓ Test 3 passed: 2 messages allowed after refill\n")
    
    # Test 4: Full refill - wait 2s (should fully refill to 10 tokens)
    print("Test 4: Full refill (wait 2s → full capacity)")
    await asyncio.sleep(2.0)
    allowed_count = 0
    for i in range(10):
        allowed = await check_rate_limit(test_player_id)
        if allowed:
            allowed_count += 1
    
    print(f"  {allowed_count}/10 messages allowed")
    assert allowed_count == 10, f"Expected 10 allowed after full refill, got {allowed_count}"
    print("✓ Test 4 passed: Full capacity restored\n")


async def test_connection_rate_limiter():
    """Test the connection-level rate limiter (pre-join)."""
    from unittest.mock import Mock
    from game_engine.rate_limiter import check_connection_rate_limit
    
    # Mock WebSocket with a test client IP
    mock_ws = Mock()
    mock_ws.client = Mock()
    mock_ws.client.host = "192.168.1.100"
    
    print("=" * 60)
    print("Testing CONNECTION-LEVEL rate limiter (pre-join)")
    print("=" * 60)
    print(f"Bucket capacity: 20, Refill rate: 10/sec, Cost: 1/msg")
    print(f"Rationale: King's Cup is in-person, multiple players on same WiFi\n")
    
    # Test 1: Burst capacity - should allow 20 messages rapidly
    print("Test 1: Burst capacity (20 rapid join attempts)")
    allowed_count = 0
    for i in range(20):
        allowed = await check_connection_rate_limit(mock_ws)
        if allowed:
            allowed_count += 1
        if i < 5 or i >= 19:  # Show first 5 and last one
            print(f"  Join {i+1}: {'✓ allowed' if allowed else '✗ blocked'}")
        elif i == 5:
            print(f"  ... (joins 6-19) ...")
    
    assert allowed_count == 20, f"Expected 20 allowed, got {allowed_count}"
    print(f"✓ Test 1 passed: {allowed_count}/20 joins allowed\n")
    
    # Test 2: Rate limiting - 21st should be blocked
    print("Test 2: Rate limiting (21st rapid join)")
    allowed = await check_connection_rate_limit(mock_ws)
    print(f"  Join 21: {'✓ allowed' if allowed else '✗ blocked'}")
    assert not allowed, "Expected join 21 to be blocked"
    print("✓ Test 2 passed: 21st join blocked\n")
    
    # Test 3: Shared WiFi scenario - 6 friends joining simultaneously
    print("Test 3: Realistic scenario - wait 2s, then 6 simultaneous joins")
    await asyncio.sleep(2.0)
    allowed_count = 0
    for i in range(6):
        allowed = await check_connection_rate_limit(mock_ws)
        if allowed:
            allowed_count += 1
        print(f"  Friend {i+1}: {'✓ joined' if allowed else '✗ blocked'}")
    
    assert allowed_count == 6, f"Expected 6 allowed, got {allowed_count}"
    print("✓ Test 3 passed: All 6 friends successfully joined\n")


async def test_atomicity_note():
    """Print note about atomicity testing."""
    print("=" * 60)
    print("ATOMICITY NOTE")
    print("=" * 60)
    print("The Lua script implementation ensures atomic GET-calculate-SET.")
    print("True race-condition testing requires multiple processes/instances")
    print("hitting Redis concurrently, which is tested in integration tests")
    print("with the full docker-compose stack (app1, app2 behind nginx).\n")
    print("This unit test verifies correctness of the token bucket logic,")
    print("not the distributed concurrency properties.\n")


if __name__ == "__main__":
    async def run_all_tests():
        try:
            await test_player_rate_limiter()
            await test_connection_rate_limiter()
            await test_atomicity_note()
            
            print("=" * 60)
            print("✓ All rate limiter tests passed!")
            print("=" * 60)
        except ImportError as e:
            print(f"✗ Import error: {e}")
            print("\nMake sure Redis is running and Python dependencies are installed:")
            print("  pip install redis fastapi pydantic")
        except Exception as e:
            print(f"✗ Test failed: {e}")
            import traceback
            traceback.print_exc()
    
    asyncio.run(run_all_tests())
