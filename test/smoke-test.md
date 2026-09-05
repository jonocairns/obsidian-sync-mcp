# MCP Smoke Test

Run this test against a live MCP server to verify all tools work end-to-end.
Requires a connected vault (local or CouchDB). Uses a test vault — will create and delete notes.

## Prerequisites

- MCP server running and connected (via Claude Desktop, Claude Code, or MCP Inspector)
- A vault with at least one existing note

## Test Script

Run each step in order. Each step builds on the previous.

---

### 1. Discovery — list folders and tags

```
list_folders()
list_tags()
list_notes(sort_by='modified', limit=5)
```

**Expected**: Folders listed with note counts. Tags listed (may be empty). Recent notes shown with timestamps and deep links.

---

### 2. Create project notes with tags, links, and frontmatter

```
create_note(path='test-smoke/project.md', content="""---
title: Smoke Test Project
tags: [smoke-test, project]
status: active
---

# Smoke Test Project

A project for testing MCP tools.

## Links
- [[test-smoke/notes]]
- [[test-smoke/daily]]
""")

create_note(path='test-smoke/notes.md', content="""---
tags: [smoke-test, reference]
---

# Notes

Reference material for [[test-smoke/project]].

CouchDB uses a _changes feed for real-time sync. Compaction removes old revisions.
""")

create_note(path='test-smoke/daily.md', content="""---
tags: [smoke-test, daily]
---

# Daily Log

- Ran smoke test on MCP tools
- Verified search, tags, and backlinks

See [[test-smoke/project]] for the main project.

#standup
""")
```

**Expected**: All three notes saved. Deep links returned.

---

### 3. Verify folder and tag discovery

```
list_folders()
list_tags()
```

**Expected**: `test-smoke` folder appears with 3 notes. Tags include `smoke-test`, `project`, `reference`, `daily`, `standup`.

---

### 4. Name and tag filtering

```
list_notes(name='notes')
list_notes(tag='smoke-test')
list_notes(tag='reference')
list_notes(tag='daily', folder='test-smoke')
```

**Expected**: First finds notes with "notes" in path. Second returns all 3 test notes. Third returns only `test-smoke/notes.md`. Fourth finds `test-smoke/daily.md`.

---

### 6. Knowledge graph — metadata and backlinks

```
get_note_metadata(path='test-smoke/project.md')
```

**Expected**:
- Frontmatter: title, tags, status
- Tags: smoke-test, project
- Outgoing links: test-smoke/notes, test-smoke/daily
- Backlinks: test-smoke/notes.md, test-smoke/daily.md

```
get_note_metadata(path='test-smoke/notes.md')
```

**Expected**:
- Outgoing links: test-smoke/project
- Backlinks: test-smoke/project.md

---

### 7. Edit — append

```
get_note_metadata(path='test-smoke/daily.md')  # save result.version as DAILY_VERSION
edit_note(path='test-smoke/daily.md', version=DAILY_VERSION, operation='append', content='
- Append test passed')
read_note(path='test-smoke/daily.md')
```

**Expected**: "Append test passed" appears at end of note.

---

### 8. Edit — prepend (after frontmatter)

```
get_note_metadata(path='test-smoke/project.md')  # save result.version as PROJECT_VERSION
edit_note(path='test-smoke/project.md', version=PROJECT_VERSION, content='> Status: All tests passing

', operation='prepend_body')
read_note(path='test-smoke/project.md')
```

**Expected**: "> Status: All tests passing" appears after frontmatter, before "# Smoke Test Project".

---

### 9. Edit — replace

```
get_note_metadata(path='test-smoke/project.md')  # refresh PROJECT_VERSION
edit_note(path='test-smoke/project.md', version=PROJECT_VERSION, content='status: complete', operation='replace_once', old_text='status: active')
read_note(path='test-smoke/project.md')
```

**Expected**: Frontmatter now shows `status: complete`.

---

### 10. Move note

```
get_note_metadata(path='test-smoke/notes.md')  # save result.version as NOTES_VERSION
move_note(from='test-smoke/notes.md', to='test-smoke/archive/notes.md', version=NOTES_VERSION)
list_folders()
```

**Expected**: Note moved. `test-smoke/archive` folder appears.

---

### 11. Time-based filtering

```
list_notes(modified_after='2020-01-01', sort_by='modified', limit=3)
```

**Expected**: Returns up to 3 most recently modified notes.

```
list_notes(modified_after='invalid-date')
```

**Expected**: Error message about invalid date format.

---

### 12. Cleanup

```
get_note_metadata(path='test-smoke/project.md')       # save PROJECT_VERSION
get_note_metadata(path='test-smoke/daily.md')         # save DAILY_VERSION
get_note_metadata(path='test-smoke/archive/notes.md') # save NOTES_VERSION
delete_note(path='test-smoke/project.md', version=PROJECT_VERSION)
delete_note(path='test-smoke/daily.md', version=DAILY_VERSION)
delete_note(path='test-smoke/archive/notes.md', version=NOTES_VERSION)
list_notes(folder='test-smoke')
```

**Expected**: All three deleted. Final list returns no notes in `test-smoke` folder.

---

## Pass Criteria

All 12 steps return expected results. No errors except the intentional invalid date test.
Each single-note call includes `structuredContent`; successful writes report
`status: ok`. Do not reuse a version after any mutation. Investigate any
`partial` or `indeterminate` result before cleanup.
