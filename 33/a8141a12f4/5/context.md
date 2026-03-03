# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# Skill Disable/Enable Toggle & Built-in Protection

## Context

Users need to temporarily disable skills without deleting them, and built-in skills (shipped with the project) should be protected from deletion. The approach uses a `builtin: true` marker in SKILL.md frontmatter and a `disabled: true` frontmatter flag for the toggle.

## Changes

### 1. Backend: Parse new frontmatter fields (`backend/app/skills.py`)

- `_parse_skill_md()` — extract `builtin` and `d...

### Prompt 2

Base directory for this skill: /Users/cyyeh/.claude/plugins/cache/superpowers-marketplace/superpowers/4.3.1/skills/executing-plans

# Executing Plans

## Overview

Load plan, review critically, execute tasks in batches, report for review between batches.

**Core principle:** Batch execution with checkpoints for architect review.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

## The Process

### Step 1: Load and Review Plan
1. Read plan file
2. Review criti...

### Prompt 3

should put builtin field in metadata field in skill.md

