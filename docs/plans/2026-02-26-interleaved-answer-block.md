# Interleaved Answer Block Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render answer block segments (text and charts) in their natural order instead of grouping charts first then text, so users can follow which text corresponds to which chart.

**Architecture:** Replace separate `chartSegments` and `answerSegments` arrays with a single `answerBlockSegments` array that preserves the original segment order from `message.segments`. Render each segment as chart or text based on its type in a single loop.

**Tech Stack:** React, TypeScript, CSS

---

### Task 1: Replace separate segment arrays with unified answerBlockSegments

**Files:**
- Modify: `frontend/src/components/MessageBubble.tsx:179-195`

**Step 1: Replace the `answerSegments` and `chartSegments` arrays**

Replace lines 179-195 (the `answerSegments` and `chartSegments` declarations) with a single `answerBlockSegments` array:

```typescript
  const answerBlockSegments = hasSegments
    ? message.segments!
        .filter((s) =>
          (s.type === 'answer' && s.text?.trim()) ||
          (s.type === 'subagent_end' && s.text?.trim()) ||
          (s.type === 'tool' && s.toolResult?.chart_spec) ||
          (s.type === 'subagent_end' && s.chart_spec)
        )
        .map((s) => {
          if ((s.type === 'answer' || (s.type === 'subagent_end' && !s.chart_spec)) && s.text && hasCharts) {
            return { ...s, text: stripChartSpecBlocks(s.text) };
          }
          return s;
        })
        .filter((s) => {
          // Remove text segments that became empty after stripping chart blocks
          if ((s.type === 'answer' || (s.type === 'subagent_end' && !s.chart_spec)) && !s.text?.trim()) {
            return false;
          }
          return true;
        })
    : [];
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: Compilation errors because `chartSegments` and `answerSegments` are still referenced in JSX. This is expected — we fix that in Task 2.

---

### Task 2: Update JSX to render interleaved segments

**Files:**
- Modify: `frontend/src/components/MessageBubble.tsx:289-306`

**Step 1: Replace the answer block JSX**

Replace lines 289-306 (the answer block rendering) with:

```tsx
          {answerBlockSegments.length > 0 && (
            <div className="message-bubble__segment message-bubble__segment--answer">
              <div className="message-bubble__segment-label message-bubble__segment-label--answer">{t('answer')}</div>
              {answerBlockSegments.map((seg, i) => {
                // Chart segment (tool with chart_spec or subagent_end with chart_spec)
                if ((seg.type === 'tool' && seg.toolResult?.chart_spec) || (seg.type === 'subagent_end' && seg.chart_spec)) {
                  return (
                    <div key={`chart-${i}`} className="message-bubble__chart-in-answer">
                      {seg.type === 'tool' && seg.toolResult ? (
                        <InlineQueryResult result={seg.toolResult!} />
                      ) : seg.chart_spec ? (
                        <ChartWidget data={seg.chart_spec.data} layout={seg.chart_spec.layout} frames={seg.chart_spec.frames} />
                      ) : null}
                    </div>
                  );
                }
                // Text segment (answer or subagent_end without chart_spec)
                return (
                  <div key={`answer-${i}`} className="message-bubble__segment-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text!}</ReactMarkdown>
                  </div>
                );
              })}
            </div>
          )}
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS — no references to removed `chartSegments` or `answerSegments` remain.

**Step 3: Verify the build succeeds**

Run: `cd frontend && npm run build`
Expected: Build completes without errors.

---

### Task 3: Add chart-in-answer CSS spacing

**Files:**
- Modify: `frontend/src/components/MessageBubble.css` (append after line 416)

**Step 1: Add the missing `.message-bubble__chart-in-answer` class**

Append to the CSS file:

```css
.message-bubble__chart-in-answer {
  margin: 8px 0;
}
```

This adds vertical spacing between chart blocks and surrounding text blocks within the interleaved answer.

---

### Task 4: Commit

**Step 1: Commit all changes**

```bash
git add frontend/src/components/MessageBubble.tsx frontend/src/components/MessageBubble.css docs/plans/2026-02-26-interleaved-answer-block-design.md docs/plans/2026-02-26-interleaved-answer-block.md
git commit -m "feat: interleave text and charts in answer block for better readability"
```
