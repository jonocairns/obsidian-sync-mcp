import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatterAndLinks } from "./parse.js";

describe("parseFrontmatterAndLinks", () => {
    it("parses YAML frontmatter", () => {
        const content = `---
title: My Note
date: 2026-03-24
status: draft
---

# Content`;
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.frontmatter.title, "My Note");
        assert.equal(result.frontmatter.date, "2026-03-24");
        assert.equal(result.frontmatter.status, "draft");
    });

    it("parses frontmatter tags", () => {
        const content = `---
tags: [project, active, important]
---

Content`;
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.tags.includes("project"));
        assert.ok(result.tags.includes("active"));
        assert.ok(result.tags.includes("important"));
    });

    it("parses multi-line YAML tags", () => {
        const content = `---
tags:
  - project
  - active
  - important
---

Content`;
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.tags.includes("project"));
        assert.ok(result.tags.includes("active"));
        assert.ok(result.tags.includes("important"));
    });

    it("parses inline and multi-line aliases", () => {
        const content = `---
aliases:
  - "Provider recovery"
  - Stream repair
alias: [Edge recovery, Playback recovery]
---`;
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.aliases, [
            "Provider recovery",
            "Stream repair",
            "Edge recovery",
            "Playback recovery",
        ]);
    });

    it("preserves quoted commas in YAML aliases", () => {
        const result = parseFrontmatterAndLinks(`---
aliases: ["Smith, John", "Person record"]
---`);
        assert.deepEqual(result.aliases, ["Smith, John", "Person record"]);
    });

    it("preserves unresolved Obsidian template scalars as strings", () => {
        const result = parseFrontmatterAndLinks(`---
created: {{date:YYYY-MM-DD}}
reviewed: {{date:YYYY-MM-DD}} # populated when the template runs
---`);
        assert.equal(result.frontmatter.created, "{{date:YYYY-MM-DD}}");
        assert.equal(result.frontmatter.reviewed, "{{date:YYYY-MM-DD}}");
    });

    it("parses inline #tags", () => {
        const content = "Some text #idea and #project/sub-tag here";
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.tags.includes("idea"));
        assert.ok(result.tags.includes("project/sub-tag"));
    });

    it("rejects purely numeric prose references as tags", () => {
        const content = "Landed in PR #6553 and issue #27, tracked under #1984.";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, []);
    });

    it("keeps tags that mix digits with other tag characters", () => {
        const content = "Notes on #1984book #q1-goals #2026/planning #v2 here";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(
            result.tags.sort(),
            ["1984book", "2026/planning", "q1-goals", "v2"],
        );
    });

    it("rejects purely numeric frontmatter tags", () => {
        const content = `---
tags: [2026, release, 27]
---

# Release`;
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, ["release"]);
    });

    it("keeps non-ASCII tags whole", () => {
        const content = "Notes on #café and #日本語 and #привет here";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags.sort(), ["café", "日本語", "привет"].sort());
    });

    it("keeps emoji tags including ZWJ sequences", () => {
        const content = "Shipped #\u{1F680} with #\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467} today";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(
            result.tags.sort(),
            ["\u{1F680}", "\u{1F469}\u{200D}\u{1F469}\u{200D}\u{1F467}"].sort(),
        );
    });

    it("keeps flag and keycap emoji tags", () => {
        const content = "Team #\u{1F1F3}\u{1F1FF} ranked #1\u{FE0F}\u{20E3} this year";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(
            result.tags.sort(),
            ["\u{1F1F3}\u{1F1FF}", "1\u{FE0F}\u{20E3}"].sort(),
        );
    });

    it("stops non-ASCII tags at trailing punctuation", () => {
        const content = "Wrote #日本語。 and #café, then stopped";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags.sort(), ["café", "日本語"].sort());
    });

    it("folds the two Unicode spellings of a tag into one", () => {
        const content = "Both #caf\u00E9 and #cafe\u0301 mean the same tag";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, ["caf\u00E9"]);
    });

    it("rejects non-ASCII digit runs as tags", () => {
        const content = "Arabic-Indic #\u0661\u0669\u0668\u0664 is still a number";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.tags, []);
    });

    it("deduplicates tags from frontmatter and inline", () => {
        const content = `---
tags: [shared]
---

Also #shared inline`;
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.tags.filter((t) => t === "shared").length, 1);
    });

    it("parses [[wikilinks]]", () => {
        const content = "See [[Other Note]] and [[folder/Linked Note|display text]]";
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.links.includes("Other Note"));
        assert.ok(result.links.includes("folder/Linked Note"));
        assert.ok(result.linkLabels.includes("Other Note"));
        assert.ok(result.linkLabels.includes("display text"));
    });

    it("parses markdown links to .md files", () => {
        const content = "See [my link](other-note.md) and [another](folder/note.md)";
        const result = parseFrontmatterAndLinks(content);
        assert.ok(result.links.includes("other-note.md"));
        assert.ok(result.links.includes("folder/note.md"));
        assert.ok(result.linkLabels.includes("my link"));
    });

    it("ignores non-md markdown links", () => {
        const content = "See [link](https://example.com) and [img](photo.png)";
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.links.length, 0);
    });

    it("deduplicates links", () => {
        const content = "See [[Note]] and [[Note]] again";
        const result = parseFrontmatterAndLinks(content);
        assert.equal(result.links.filter((l) => l === "Note").length, 1);
    });

    it("returns empty results for plain text", () => {
        const result = parseFrontmatterAndLinks("Just plain text, no metadata.");
        assert.deepEqual(result.frontmatter, {});
        assert.deepEqual(result.tags, []);
        assert.deepEqual(result.links, []);
        assert.deepEqual(result.aliases, []);
        assert.deepEqual(result.linkLabels, []);
    });

    it("handles content with no frontmatter closing delimiter", () => {
        const content = "---\ntitle: Broken\nNo closing delimiter";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.frontmatter, {});
    });

    it("ignores invalid YAML without making the note unindexable", () => {
        const content = "---\ntags: [unterminated\n---\n# Recovery\nSearchable body #fallback";
        const result = parseFrontmatterAndLinks(content);
        assert.deepEqual(result.frontmatter, {});
        assert.deepEqual(result.tags, ["fallback"]);
    });
});
