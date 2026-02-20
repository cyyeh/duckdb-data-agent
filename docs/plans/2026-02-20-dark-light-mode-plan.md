# Dark/Light Mode Toggle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a dark/light mode toggle with sun/moon icons, CSS custom properties for theming, localStorage persistence, and OS preference detection.

**Architecture:** ThemeContext provides theme state via React Context. CSS custom properties on `:root` (light) and `[data-theme="dark"]` (dark) drive all colors. An inline script in `index.html` prevents flash of wrong theme.

**Tech Stack:** React 18, TypeScript, CSS custom properties, localStorage, `prefers-color-scheme` media query

---

### Task 1: Define CSS custom properties in index.css

**Files:**
- Modify: `frontend/src/index.css`

**Step 1: Replace index.css with CSS custom property definitions + light/dark themes**

Replace the entire contents of `frontend/src/index.css` with:

```css
/* ===== Theme Tokens ===== */
:root {
  /* Backgrounds */
  --color-bg-primary: #fff;
  --color-bg-secondary: #f9fafb;
  --color-bg-tertiary: #f5f5f5;
  --color-bg-code: #f3f4f6;
  --color-bg-hover: #f0f7ff;
  --color-bg-hover-strong: #e8e8e8;
  --color-bg-user-msg: #eef2ff;

  /* Text */
  --color-text-primary: #333;
  --color-text-secondary: #1f2937;
  --color-text-tertiary: #374151;
  --color-text-code: #4b5563;
  --color-text-muted: #666;
  --color-text-subtle: #6b7280;
  --color-text-disabled: #9ca3af;
  --color-text-faint: #999;

  /* Borders */
  --color-border-faint: #eee;
  --color-border-light: #e5e7eb;
  --color-border-medium: #ddd;
  --color-border-dark: #d1d5db;
  --color-border-dashed: #ccc;

  /* Accent - Primary (indigo) */
  --color-accent-primary: #6366f1;
  --color-accent-primary-hover: #4f46e5;
  --color-accent-primary-active: #4338ca;
  --color-accent-primary-light: #818cf8;
  --color-accent-primary-border: #c7d2fe;
  --color-accent-primary-shadow: rgba(99, 102, 241, 0.15);
  --color-accent-primary-shadow-strong: rgba(129, 140, 248, 0.2);

  /* Accent - Secondary (blue) */
  --color-accent-secondary: #4a90d9;
  --color-accent-secondary-hover: #357abd;
  --color-accent-secondary-shadow: rgba(74, 144, 217, 0.2);

  /* Error (red) */
  --color-error: #dc2626;
  --color-error-hover: #b91c1c;
  --color-error-text: #b91c1c;
  --color-error-text-dark: #991b1b;
  --color-error-bg: #fef2f2;
  --color-error-bg-hover: #fee2e2;
  --color-error-bg-subtle: #fee;
  --color-error-border: #fca5a5;
  --color-error-border-light: #fecaca;

  /* Success (green) */
  --color-success-bg: #f0fdf4;
  --color-success-bg-alt: #ecfdf5;
  --color-success-border: #22c55e;
  --color-success-border-light: #a7f3d0;
  --color-success-text: #16a34a;
  --color-success-text-dark: #065f46;

  /* Tool labels */
  --color-tool-bash-text: #6d28d9;
  --color-tool-bash-bg: #ede9fe;
  --color-tool-bash-border: #c4b5fd;
  --color-tool-generic-text: #1e40af;
  --color-tool-generic-bg: #eff6ff;
  --color-tool-generic-border: #93c5fd;
}

[data-theme="dark"] {
  /* Backgrounds */
  --color-bg-primary: #1a1a2e;
  --color-bg-secondary: #16213e;
  --color-bg-tertiary: #1a1a2e;
  --color-bg-code: #1e293b;
  --color-bg-hover: #1e3a5f;
  --color-bg-hover-strong: #2d3748;
  --color-bg-user-msg: #2d2b55;

  /* Text */
  --color-text-primary: #e2e8f0;
  --color-text-secondary: #cbd5e1;
  --color-text-tertiary: #94a3b8;
  --color-text-code: #a0aec0;
  --color-text-muted: #94a3b8;
  --color-text-subtle: #8892a4;
  --color-text-disabled: #64748b;
  --color-text-faint: #64748b;

  /* Borders */
  --color-border-faint: #1e293b;
  --color-border-light: #2d3748;
  --color-border-medium: #374151;
  --color-border-dark: #4b5563;
  --color-border-dashed: #4b5563;

  /* Accent - Primary (indigo) */
  --color-accent-primary: #818cf8;
  --color-accent-primary-hover: #6366f1;
  --color-accent-primary-active: #4f46e5;
  --color-accent-primary-light: #a5b4fc;
  --color-accent-primary-border: #4338ca;
  --color-accent-primary-shadow: rgba(129, 140, 248, 0.2);
  --color-accent-primary-shadow-strong: rgba(129, 140, 248, 0.3);

  /* Accent - Secondary (blue) */
  --color-accent-secondary: #60a5fa;
  --color-accent-secondary-hover: #3b82f6;
  --color-accent-secondary-shadow: rgba(96, 165, 250, 0.2);

  /* Error (red) */
  --color-error: #f87171;
  --color-error-hover: #ef4444;
  --color-error-text: #fca5a5;
  --color-error-text-dark: #fca5a5;
  --color-error-bg: #3b1111;
  --color-error-bg-hover: #5c1a1a;
  --color-error-bg-subtle: #3b1111;
  --color-error-border: #7f1d1d;
  --color-error-border-light: #991b1b;

  /* Success (green) */
  --color-success-bg: #0d3320;
  --color-success-bg-alt: #0d3320;
  --color-success-border: #16a34a;
  --color-success-border-light: #15803d;
  --color-success-text: #6ee7b7;
  --color-success-text-dark: #a7f3d0;

  /* Tool labels */
  --color-tool-bash-text: #c4b5fd;
  --color-tool-bash-bg: #2e1065;
  --color-tool-bash-border: #6d28d9;
  --color-tool-generic-text: #93c5fd;
  --color-tool-generic-bg: #1e3a5f;
  --color-tool-generic-border: #1e40af;
}

/* ===== Global Reset & Base ===== */
*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
    sans-serif;
  line-height: 1.5;
  color: var(--color-text-primary);
  background: var(--color-bg-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

#root {
  min-height: 100vh;
}
```

**Step 2: Verify the dev server compiles**

Run: `cd frontend && npm run dev` — check that the page loads with no errors in the terminal.

**Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "feat: add CSS custom properties for dark/light theme tokens"
```

---

### Task 2: Add anti-flash script in index.html

**Files:**
- Modify: `frontend/index.html`

**Step 1: Add inline script to `<head>` that sets data-theme before render**

Add the following `<script>` tag inside `<head>`, after the `<title>` tag:

```html
<script>
  (function() {
    var t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  })();
</script>
```

**Step 2: Commit**

```bash
git add frontend/index.html
git commit -m "feat: add anti-flash theme detection script in index.html"
```

---

### Task 3: Create ThemeContext.tsx

**Files:**
- Create: `frontend/src/ThemeContext.tsx`

**Step 1: Create ThemeContext with provider and useTheme hook**

```tsx
import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('theme');
  if (stored === 'dark' || stored === 'light') return stored;
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
```

**Step 2: Commit**

```bash
git add frontend/src/ThemeContext.tsx
git commit -m "feat: add ThemeContext with provider, useTheme hook, and localStorage persistence"
```

---

### Task 4: Integrate ThemeProvider and toggle button in App.tsx + App.css

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.css`

**Step 1: Update App.tsx**

Add import at top:
```tsx
import { ThemeProvider, useTheme } from './ThemeContext';
```

In `AppContent`, add at the top of the function body:
```tsx
const { theme, toggleTheme } = useTheme();
```

Replace both `<div className="app__header">` blocks (lines 122-129 and 135-143) so the header renders the theme toggle button to the left of the mode toggle. Since both branches have duplicate headers, extract a shared header. Replace the entire return in `AppContent` (lines 115-165) with:

```tsx
  const themeIcon = theme === 'dark' ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );

  return (
    <div className={appClass}>
      <div className="app__sidebar-wrapper">
        <Sidebar tables={tables} onTableClick={handleTableClick} onTableDelete={handleTableDelete} collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((prev) => !prev)} />
      </div>
      {agentOpen ? (
        <div className="app__agent-wrapper">
          <div className="app__header">
            <h1 className="app__title">DuckDB Data Agent</h1>
            <div className="app__header-actions">
              <button
                className="app__theme-toggle"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {themeIcon}
              </button>
              <button
                className="app__agent-toggle app__agent-toggle--active"
                onClick={handleAgentToggle}
              >
                Editor Mode
              </button>
            </div>
          </div>
          <AgentPanel langfuseStatus={langfuseStatus} />
        </div>
      ) : (
        <div className="app__editor-wrapper">
          <div className="app__header">
            <h1 className="app__title">DuckDB Data Agent</h1>
            <div className="app__header-actions">
              <button
                className="app__theme-toggle"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {themeIcon}
              </button>
              <button
                className="app__agent-toggle"
                onClick={handleAgentToggle}
              >
                Agent Mode
              </button>
            </div>
          </div>
          <div className="app__mode-header">
            <span className="app__mode-title">Editor Mode</span>
          </div>
          <main className="app__main">
            <FileUpload onUpload={handleFileUpload} onLoadSample={handleLoadSample} />
            <QueryEditor
              onExecute={handleQueryExecute}
              initialQuery={editorQuery}
            />
            {error && (
              <ErrorMessage message={error} onDismiss={() => setError(null)} />
            )}
            {queryResult?.resultType === 'markdown' ? (
              <ResultMarkdown result={queryResult} />
            ) : (
              <ResultsTable result={queryResult} />
            )}
          </main>
        </div>
      )}
    </div>
  );
```

In the `App` component, wrap `AgentProvider` with `ThemeProvider`. Replace the return (lines 217-221):

```tsx
  return (
    <ThemeProvider>
      <AgentProvider refreshTables={refreshTables}>
        <AppContent tables={tables} refreshTables={refreshTables} langfuseStatus={langfuseStatus} />
      </AgentProvider>
    </ThemeProvider>
  );
```

**Step 2: Update App.css — replace hardcoded colors with CSS variables and add theme toggle styles**

Replace the full contents of `App.css`:

```css
.app {
  display: grid;
  grid-template-columns: 250px 1fr;
  min-height: 100vh;
}

.app--sidebar-collapsed {
  grid-template-columns: auto 1fr;
}

.app__sidebar-wrapper {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: visible;
}

.app__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--color-border-light);
  flex-shrink: 0;
}

.app__header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.app__main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

.app__title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text-primary);
}

.app__theme-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 8px;
  color: var(--color-text-muted);
  cursor: pointer;
}

.app__theme-toggle:hover {
  background: var(--color-bg-hover-strong);
  color: var(--color-text-primary);
}

.app__agent-toggle {
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  border: 1px solid var(--color-accent-primary);
  border-radius: 8px;
  background: var(--color-bg-primary);
  color: var(--color-accent-primary);
  cursor: pointer;
  white-space: nowrap;
}

.app__agent-toggle:hover {
  background: var(--color-bg-user-msg);
}

.app__agent-toggle--active {
  background: var(--color-accent-primary);
  color: #fff;
}

.app__agent-toggle--active:hover {
  background: var(--color-accent-primary-hover);
}

.app__agent-wrapper,
.app__editor-wrapper {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-width: 0;
}

.app__mode-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 1px solid var(--color-border-light);
  background: var(--color-bg-primary);
}

.app__mode-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text-secondary);
}

.app-loading,
.app-error {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  font-size: 16px;
  color: var(--color-text-muted);
}

.app-error {
  color: var(--color-error-text);
}
```

**Step 3: Verify the toggle renders and switches themes**

Run: `cd frontend && npm run dev` — click the sun/moon icon, verify the `data-theme` attribute on `<html>` changes.

**Step 4: Commit**

```bash
git add frontend/src/App.tsx frontend/src/App.css
git commit -m "feat: integrate ThemeProvider, add sun/moon toggle button to header"
```

---

### Task 5: Update Sidebar.css to use CSS variables

**Files:**
- Modify: `frontend/src/components/Sidebar.css`

**Step 1: Replace all hardcoded colors**

Apply these replacements throughout the file:
- `#f5f5f5` → `var(--color-bg-tertiary)`
- `#ddd` → `var(--color-border-medium)`
- `#666` → `var(--color-text-muted)`
- `#333` → `var(--color-text-primary)`
- `#e8e8e8` → `var(--color-bg-hover-strong)`
- `#999` → `var(--color-text-faint)`
- `#fee` → `var(--color-error-bg-subtle)`

**Step 2: Commit**

```bash
git add frontend/src/components/Sidebar.css
git commit -m "feat: update Sidebar.css to use theme CSS variables"
```

---

### Task 6: Update MessageBubble.css to use CSS variables

**Files:**
- Modify: `frontend/src/components/MessageBubble.css`

**Step 1: Replace all hardcoded colors**

Apply these replacements:
- `#eef2ff` → `var(--color-bg-user-msg)`
- `#fff` → `var(--color-bg-primary)`
- `#e5e7eb` → `var(--color-border-light)`
- `#6b7280` → `var(--color-text-subtle)`
- `#1f2937` → `var(--color-text-secondary)`
- `#f3f4f6` → `var(--color-bg-code)`
- `#d1d5db` → `var(--color-border-dark)`
- `#f9fafb` → `var(--color-bg-secondary)`
- `#9ca3af` → `var(--color-text-disabled)`
- `#f0fdf4` → `var(--color-success-bg)`
- `#22c55e` → `var(--color-success-border)`
- `#16a34a` → `var(--color-success-text)`
- `#374151` → `var(--color-text-tertiary)`
- `#fee2e2` → `var(--color-error-bg-hover)`
- `#dc2626` → `var(--color-error)`
- `#c7d2fe` → `var(--color-accent-primary-border)`
- `#818cf8` → `var(--color-accent-primary-light)`
- `rgba(129, 140, 248, 0.2)` → `var(--color-accent-primary-shadow-strong)`
- `#4f46e5` → `var(--color-accent-primary-hover)`
- `#4338ca` → `var(--color-accent-primary-active)`
- `#fef2f2` → `var(--color-error-bg)`
- `#fecaca` → `var(--color-error-border-light)`
- `#991b1b` → `var(--color-error-text-dark)`
- `#b91c1c` → `var(--color-error-hover)`

**Step 2: Commit**

```bash
git add frontend/src/components/MessageBubble.css
git commit -m "feat: update MessageBubble.css to use theme CSS variables"
```

---

### Task 7: Update ChatInput.css to use CSS variables

**Files:**
- Modify: `frontend/src/components/ChatInput.css`

**Step 1: Replace all hardcoded colors**

- `#e5e7eb` → `var(--color-border-light)`
- `#fff` → `var(--color-bg-primary)`
- `#d1d5db` → `var(--color-border-dark)`
- `#6366f1` → `var(--color-accent-primary)`
- `rgba(99, 102, 241, 0.15)` → `var(--color-accent-primary-shadow)`
- `#f9fafb` → `var(--color-bg-secondary)`
- `#9ca3af` → `var(--color-text-disabled)`
- `#4f46e5` → `var(--color-accent-primary-hover)`

**Step 2: Commit**

```bash
git add frontend/src/components/ChatInput.css
git commit -m "feat: update ChatInput.css to use theme CSS variables"
```

---

### Task 8: Update QueryEditor.css to use CSS variables

**Files:**
- Modify: `frontend/src/components/QueryEditor.css`

**Step 1: Replace all hardcoded colors**

- `#ddd` → `var(--color-border-medium)`
- `#4a90d9` → `var(--color-accent-secondary)`
- `rgba(74, 144, 217, 0.2)` → `var(--color-accent-secondary-shadow)`
- `#357abd` → `var(--color-accent-secondary-hover)`
- `white` → `#fff` (keep as-is, it's button text on accent bg)

**Step 2: Commit**

```bash
git add frontend/src/components/QueryEditor.css
git commit -m "feat: update QueryEditor.css to use theme CSS variables"
```

---

### Task 9: Update ResultsTable.css to use CSS variables

**Files:**
- Modify: `frontend/src/components/ResultsTable.css`

**Step 1: Replace all hardcoded colors**

- `#ddd` → `var(--color-border-medium)`
- `#4a90d9` → `var(--color-accent-secondary)`
- `rgba(74, 144, 217, 0.2)` → `var(--color-accent-secondary-shadow)`
- `#666` → `var(--color-text-muted)`
- `#eee` → `var(--color-border-faint)`
- `#f5f5f5` → `var(--color-bg-tertiary)`
- `#e8e8e8` → `var(--color-bg-hover-strong)`
- `#999` → `var(--color-text-faint)`
- `#f9f9f9` → `var(--color-bg-secondary)`

**Step 2: Commit**

```bash
git add frontend/src/components/ResultsTable.css
git commit -m "feat: update ResultsTable.css to use theme CSS variables"
```

---

### Task 10: Update ResultMarkdown.css to use CSS variables

**Files:**
- Modify: `frontend/src/components/ResultMarkdown.css`

**Step 1: Replace all hardcoded colors**

- `#666` → `var(--color-text-muted)`
- `#ddd` → `var(--color-border-medium)`

**Step 2: Commit**

```bash
git add frontend/src/components/ResultMarkdown.css
git commit -m "feat: update ResultMarkdown.css to use theme CSS variables"
```

---

### Task 11: Update FileUpload.css to use CSS variables

**Files:**
- Modify: `frontend/src/components/FileUpload.css`

**Step 1: Replace all hardcoded colors**

- `#ccc` → `var(--color-border-dashed)`
- `#4a90d9` → `var(--color-accent-secondary)`
- `#f0f7ff` → `var(--color-bg-hover)`
- `#666` → `var(--color-text-muted)`
- `#ddd` → `var(--color-border-medium)`
- `#999` → `var(--color-text-faint)`
- `transparent` → keep as-is

**Step 2: Commit**

```bash
git add frontend/src/components/FileUpload.css
git commit -m "feat: update FileUpload.css to use theme CSS variables"
```

---

### Task 12: Update ErrorMessage.css to use CSS variables

**Files:**
- Modify: `frontend/src/components/ErrorMessage.css`

**Step 1: Replace all hardcoded colors**

- `#fef2f2` → `var(--color-error-bg)`
- `#fca5a5` → `var(--color-error-border)`
- `#b91c1c` → `var(--color-error-text)`

**Step 2: Commit**

```bash
git add frontend/src/components/ErrorMessage.css
git commit -m "feat: update ErrorMessage.css to use theme CSS variables"
```

---

### Task 13: Update AgentPanel.css to use CSS variables

**Files:**
- Modify: `frontend/src/components/AgentPanel.css`

**Step 1: Replace all hardcoded colors**

- `#f9fafb` → `var(--color-bg-secondary)`
- `#e5e7eb` → `var(--color-border-light)`
- `#fff` → `var(--color-bg-primary)`
- `#1f2937` → `var(--color-text-secondary)`
- `#d1d5db` → `var(--color-border-dark)`
- `#6b7280` → `var(--color-text-subtle)`
- `#f3f4f6` → `var(--color-bg-code)`
- `#374151` → `var(--color-text-tertiary)`
- `#9ca3af` → `var(--color-text-disabled)`

**Step 2: Commit**

```bash
git add frontend/src/components/AgentPanel.css
git commit -m "feat: update AgentPanel.css to use theme CSS variables"
```

---

### Task 14: Update InlineQueryResult.css to use CSS variables

**Files:**
- Modify: `frontend/src/components/InlineQueryResult.css`

**Step 1: Replace all hardcoded colors**

- `#e5e7eb` → `var(--color-border-light)`
- `#fca5a5` → `var(--color-error-border)`
- `#c4b5fd` → `var(--color-tool-bash-border)`
- `#93c5fd` → `var(--color-tool-generic-border)`
- `#065f46` → `var(--color-success-text-dark)`
- `#ecfdf5` → `var(--color-success-bg-alt)`
- `#a7f3d0` → `var(--color-success-border-light)`
- `#6d28d9` → `var(--color-tool-bash-text)`
- `#ede9fe` → `var(--color-tool-bash-bg)`
- `#1e40af` → `var(--color-tool-generic-text)`
- `#eff6ff` → `var(--color-tool-generic-bg)`
- `#f3f4f6` → `var(--color-bg-code)`
- `#4b5563` → `var(--color-text-code)`
- `#b91c1c` → `var(--color-error-text)`
- `#fef2f2` → `var(--color-error-bg)`
- `#f9fafb` → `var(--color-bg-secondary)`
- `#374151` → `var(--color-text-tertiary)`
- `#9ca3af` → `var(--color-text-disabled)`

**Step 2: Commit**

```bash
git add frontend/src/components/InlineQueryResult.css
git commit -m "feat: update InlineQueryResult.css to use theme CSS variables"
```

---

### Task 15: Manual verification

**Step 1: Run the dev server and verify both themes**

Run: `cd frontend && npm run dev`

Verify in browser:
1. Page loads without flash of wrong theme
2. Click the sun/moon toggle — all UI elements switch colors
3. Check these areas in both themes:
   - Sidebar (background, text, borders, hover states)
   - Header (title, toggle buttons)
   - Agent panel (messages, chat input, typing indicator)
   - Editor mode (query editor, results table, file upload, error messages)
   - Inline query results (SQL/Bash/generic tool labels)
4. Refresh the page — theme persists
5. Clear localStorage, set OS to dark — page loads in dark mode
6. Clear localStorage, set OS to light — page loads in light mode

**Step 2: Run the build to check for errors**

Run: `cd frontend && npm run build`

Expected: Build completes with no errors.

**Step 3: Commit any fixes if needed**
