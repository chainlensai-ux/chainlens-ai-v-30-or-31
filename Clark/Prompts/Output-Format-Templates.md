# Prompts — Output Format Templates (Reference Copy)

Quick-reference versions of the templates defined in [[Output-Formats]], for use when drafting or reviewing prompt changes.

## Token Scan
```
Verdict: WATCH | AVOID | SCAN DEEPER | TRUSTWORTHY | UNKNOWN
Confidence: <stated>
Why: <1-2 sentences>
Signals:
- <bullet, max 3>
Risks:
- <bullet, max 3>
Watch next: <what to monitor>
```

## Wallet Read
```
Wallet read: <1-2 sentences>
Signals:
- <bullet, max 3>
Risks:
- <bullet, max 3>
Behavior read: <personality/activity pattern>
Worth monitoring?: <yes/no + reasoning>
Next check: <what evidence would change the read>
```

## Whale Signal
```
Signal: <what was observed>
Why it matters: <context>
Confidence: <stated>
What to verify: <next step>
```

## Length caps

- Normal: 80–140 words
- Deep report: ≤220 words

These are enforced by the system prompt, not by post-processing — there is no separate truncation step in route.ts. If responses run long in practice, the fix is a prompt change, not a string-slice patch.
