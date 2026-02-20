# Dark/Light Mode Toggle — Design

## Overview

Add a dark/light mode toggle button to the app header, positioned to the left of the Agent Mode / Editor Mode button. Default theme respects OS preference on first visit; user choice persists in `localStorage`.

## UI & Interaction

- **Icon-only button** in the header, left of the mode toggle
- Light mode active: shows **moon icon** (click to switch to dark)
- Dark mode active: shows **sun icon** (click to switch to light)
- Styled as a subtle icon button (transparent background, hover reveals soft circle)
- Appears in both agent-mode and editor-mode headers

## Theme State & Persistence

Initialization priority:
1. `localStorage.getItem('theme')` — use if `'dark'` or `'light'`
2. `window.matchMedia('(prefers-color-scheme: dark)')` — match OS
3. Fall back to `'dark'`

On toggle: save to `localStorage`, set `data-theme` attribute on `<html>`.

Flash prevention: inline `<script>` in `index.html` sets `data-theme` before React hydrates.

## CSS Architecture

CSS custom properties on `:root` (light) and `[data-theme="dark"]` (dark). Semantic tokens:

| Token | Light | Dark |
|-------|-------|------|
| `--color-bg-primary` | `#fff` | `#1a1a2e` |
| `--color-bg-secondary` | `#f9fafb` | `#16213e` |
| `--color-bg-tertiary` | `#f5f5f5` | `#1a1a2e` |
| `--color-bg-code` | `#f3f4f6` | `#1e293b` |
| `--color-bg-hover` | `#f0f7ff` | `#1e3a5f` |
| `--color-bg-user-msg` | `#eef2ff` | `#2d2b55` |
| `--color-text-primary` | `#333` | `#e2e8f0` |
| `--color-text-secondary` | `#1f2937` | `#cbd5e1` |
| `--color-text-muted` | `#666` | `#94a3b8` |
| `--color-text-disabled` | `#9ca3af` | `#64748b` |
| `--color-border-light` | `#e5e7eb` | `#2d3748` |
| `--color-border-medium` | `#ddd` | `#374151` |
| `--color-border-dark` | `#d1d5db` | `#4b5563` |
| `--color-accent-primary` | `#6366f1` | `#818cf8` |
| `--color-accent-primary-hover` | `#4f46e5` | `#6366f1` |
| `--color-accent-secondary` | `#4a90d9` | `#60a5fa` |
| `--color-error-bg` | `#fef2f2` | `#3b1111` |
| `--color-error-text` | `#b91c1c` | `#fca5a5` |
| `--color-error-border` | `#fca5a5` | `#7f1d1d` |
| `--color-success-bg` | `#ecfdf5` / `#f0fdf4` | `#0d3320` |
| `--color-success-text` | `#065f46` / `#16a34a` | `#6ee7b7` |
| `--color-success-border` | `#22c55e` / `#a7f3d0` | `#16a34a` |

## React Architecture

- **`ThemeContext.tsx`** (~30 lines): context, provider, `useTheme()` hook
- Sun/moon icons as inline SVGs (no external library)
- `ThemeProvider` wraps the app alongside `AgentProvider`

## Files Changed

**New:**
- `frontend/src/ThemeContext.tsx`

**Modified:**
- `frontend/index.html` — anti-flash inline script
- `frontend/src/index.css` — CSS custom property definitions
- `frontend/src/App.tsx` — ThemeProvider wrapper, toggle button in header
- `frontend/src/App.css` — replace hardcoded colors, toggle button styles
- `frontend/src/components/Sidebar.css`
- `frontend/src/components/MessageBubble.css`
- `frontend/src/components/ChatInput.css`
- `frontend/src/components/QueryEditor.css`
- `frontend/src/components/ResultsTable.css`
- `frontend/src/components/ResultMarkdown.css`
- `frontend/src/components/FileUpload.css`
- `frontend/src/components/ErrorMessage.css`
- `frontend/src/components/AgentPanel.css`
- `frontend/src/components/InlineQueryResult.css`
