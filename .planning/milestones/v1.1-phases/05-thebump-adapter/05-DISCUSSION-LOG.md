# Phase 5: TheBump Adapter - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-21
**Phase:** 05-thebump-adapter
**Areas discussed:** Base class design, Error handling, Skip-post criteria, Eval data strategy

---

## Base Class Design

| Option | Description | Selected |
|--------|-------------|----------|
| CheerioAPI | fetchPage fetches HTML, parses with Cheerio, returns loaded $ object | ✓ |
| Raw HTML string | fetchPage returns raw HTML, each subclass loads Cheerio itself | |

**User's choice:** CheerioAPI
**Notes:** Keeps HTTP + parsing concerns in the base class, subclasses work directly with selectors.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Template method | Base class owns fetchNewPosts loop, subclasses implement extractPostsFromPage and getNextPageUrl | ✓ |
| Minimal base + utilities | Base class just provides fetchPage and shouldSkipPost as callable methods | |

**User's choice:** Template method
**Notes:** Enforces consistent pagination/skip behavior across all forum adapters.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Default + override | Base provides common checks, subclasses can override for source-specific logic | ✓ |
| Abstract only | Every subclass must implement shouldSkipPost from scratch | |

**User's choice:** Default + override
**Notes:** Reduces boilerplate for simple adapters while allowing source-specific flexibility.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Base implements SourceAdapter | Template method in base fulfills fetchNewPosts contract, subclasses inherit | ✓ |
| Separate concerns | TheBumpAdapter extends base AND implements SourceAdapter separately | |

**User's choice:** Base implements SourceAdapter
**Notes:** Clean single hierarchy, no unnecessary ceremony.

---

## Error Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Single ScrapeError with code | One class with code field (NETWORK, PARSE, CHALLENGE, TIMEOUT) | ✓ |
| Separate error classes | NetworkError, ParseError, ChallengeError, TimeoutError as distinct classes | |

**User's choice:** Single ScrapeError with code
**Notes:** Flat hierarchy matching existing structured logging pattern.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Log and stop pagination | Return posts collected so far, don't attempt further pages | ✓ |
| Log and skip to next page | Skip failed page, try next one | |
| Throw immediately | Throw ScrapeError, entire crawl fails | |

**User's choice:** Log and stop pagination
**Notes:** Partial results are better than no results, but continuing past a failure risks hitting the same block repeatedly.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Warn log only | Emit thebump_challenge_detected warn log, let Axiom handle alerting | ✓ |
| Warn log + increment counter | Log AND track consecutive challenges, escalate after N | |

**User's choice:** Warn log only
**Notes:** Proportionate for initial adapter; alerting can be added at Axiom level.

---

## Skip-Post Criteria

| Option | Description | Selected |
|--------|-------------|----------|
| Admin/staff posts | Skip posts by forum administrators or staff accounts | ✓ |
| Sticky/pinned threads | Skip pinned threads (rules, FAQs, megathreads) | ✓ |
| Very short body (<20 chars) | Same threshold as Reddit adapter | ✓ |
| Empty or deleted posts | Skip empty, deleted, or placeholder posts | ✓ |

**User's choice:** All four signals selected
**Notes:** Multi-select — all signals are worth checking.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Common in base, role/sticky in sub | Base: empty/deleted, short body. TheBump override: admin/staff, sticky/pinned | ✓ |
| All in base class | All four checks in base with configurable selectors | |

**User's choice:** Common in base, role/sticky in sub
**Notes:** Forum-structural signals (admin roles, sticky attributes) vary by platform and belong in subclass overrides.

---

## Eval Data Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Real scrapes, manually labeled | Scrape real TheBump posts, manually label each | ✓ |
| Synthetic posts | Write fake posts with known labels | |
| Mix of both | Real scrapes + synthetic edge cases | |

**User's choice:** Real scrapes, manually labeled
**Notes:** Most realistic — tests against actual HTML structure and real language patterns.

---

| Option | Description | Selected |
|--------|-------------|----------|
| Balanced ~50/50 | Half genuine free offers, half non-offers | ✓ |
| Skew toward negatives ~30/70 | More non-offers reflecting real distribution | |

**User's choice:** Balanced ~50/50
**Notes:** Tests both precision and recall equally, matching existing Reddit eval approach.

---

## Claude's Discretion

- Exact CSS selectors for admin/staff/sticky detection (determined during live fixture analysis)
- Internal ScrapeError structure beyond code field
- Relative-date parsing library choice
- fetchWithRetry retry count and backoff strategy

## Deferred Ideas

None — discussion stayed within phase scope.
