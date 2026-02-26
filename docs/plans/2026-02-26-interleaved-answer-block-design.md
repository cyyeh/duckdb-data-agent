# Interleaved Answer Block Design

## Problem

The answer block renders all charts first, then all text below. Users cannot easily follow which text corresponds to which chart.

## Solution

Render answer-relevant segments (text and charts) in their natural order from the backend instead of grouping by type. This interleaves text and charts so each chart appears near its related description.

## Approach

**Approach 1: Interleaved rendering using original segment order** (chosen over heuristic pairing or backend-driven pairing for simplicity).

## Changes

### `MessageBubble.tsx`

- Replace separate `chartSegments` and `answerSegments` arrays with a single `answerBlockSegments` array
- Filter `message.segments` for answer-relevant items (answer text, subagent_end text, tool charts, subagent_end charts) preserving original order
- Render each segment as either chart or text based on type in a single loop
- Keep `stripChartSpecBlocks` logic for text segments when charts are present

### `MessageBubble.css`

- Add `.message-bubble__chart-in-answer` styling with margin for spacing between interleaved blocks

### No backend changes required

## Visual Result

Before:
```
ANSWER
[Chart 1]
[Chart 2]
Text paragraph 1...
Text paragraph 2...
```

After:
```
ANSWER
Text paragraph 1...
[Chart 1]
Text paragraph 2...
[Chart 2]
```
