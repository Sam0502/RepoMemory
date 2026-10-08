# RepoMemory — How the System Works (Plain-English Guide)

This document explains what RepoMemory does and how it works, **without assuming you
know how to program**. If you can use a search box on a website, you can understand
this guide.

---

## 1. What is RepoMemory, in one sentence?

**RepoMemory is a librarian for computer code.** It reads a software project, keeps
a detailed memory of every "thing" in it and how those things connect to each other,
watches for changes, and answers questions about what the project is doing — in plain
language.

A software project (also called a **repository** or just **repo**) is a folder of
files that, together, form a program. Think of it as a huge cookbook with thousands
of recipes. RepoMemory reads the cookbook and builds an index: every recipe, every
ingredient, and every cross-reference between recipes.

---

## 2. The big idea: giving software a memory

Software changes all the time. People add features, fix bugs, rename things. Without
a memory, anyone trying to understand the project has to read thousands of files
manually. RepoMemory instead:

1. **Reads** the whole project.
2. **Extracts** the meaningful pieces (functions, classes, files, configs).
3. **Connects** the pieces (what uses what, what calls what).
4. **Remembers** the history (what changed, when, how much).
5. **Answers questions** in everyday language.
6. **Keeps up to date** automatically when files are edited.

From the outside, RepoMemory behaves like a search engine, a map, and a chat
assistant — all combined, and all specific to your code.

---

## 3. The vocabulary you need

| Word | What it means | Everyday analogy |
|------|---------------|------------------|
| **Repository** | A whole software project (a folder of code) | A cookbook |
| **Entity** | One meaningful thing: a function, a class, a file | A single recipe |
| **Relationship** | A connection between two entities | "Recipe A uses Recipe B" |
| **Graph** | A map of entities as dots and relationships as lines | A subway map |
| **Scan** | The act of reading the project and updating the memory | Re-indexing the cookbook |
| **Embedding** | A numeric "fingerprint" of what something means | A song's acoustic signature |
| **Commit** | A saved snapshot of changes by a developer | A dated revision of a recipe |
| **Stable ID** | A permanent name for an entity that never changes | A recipe's catalog number |
| **Dead code** | Code that exists but nothing uses it | A recipe nobody ever cooks |
| **Churn / Risk** | How much a file changes and how dangerous that is | A chapter rewritten constantly |
| **QA** | Question & Answer | Asking the librarian |

---

## 4. How a scan works (the reading process)

When RepoMemory first meets a project, it performs a **full scan**. This is a
multi-step pipeline, like an assembly line:

```
    1. DISCOVER        2. PARSE          3. RESOLVE          4. EMBED          5. PERSIST
  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
  │ Find every  │   │ Break each  │   │ Connect the │   │ Give each   │   │ Save        │
  │ source file │→  │ file into   │→  │ pieces that │→  │ piece a     │→  │ everything  │
  │ in the repo │   │ entities &  │   │ refer to    │   │ "meaning    │   │ to the two  │
  │             │   │ relationships│  │ each other  │   │ fingerprint"│   │ databases   │
  └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘
```

Let's look at each stage.

### Stage 1 — Discover
RepoMemory walks through the project's folders and finds all the files that contain
code (while ignoring junk like downloaded libraries or build output). **Result: a
list of files.**

### Stage 2 — Parse
This is where the clever part happens. RepoMemory uses special "grammar readers"
(one per programming language, e.g. TypeScript, JavaScript, Python). These readers
know the *rules of the language*, so they can find the real building blocks:

- **Functions** — small units that perform a task
- **Classes** — blueprints for objects
- **Files** — the containers themselves
- **Imports / calls** — "this file borrows from that file"

Importantly, the reader is grammar-based, not guess-based: it understands the code
*structurally*, the same way an English grammarian can diagram a sentence.

**Result: a list of entities and relationships per file.**

### Stage 3 — Resolve (the "connect the dots" step)
When code says "use the thing called `createUser`", RepoMemory has to figure out
*which* `createUser` is meant. There might be dozens across the project. RepoMemory
builds a project-wide **symbol index** (like a phone book) and uses rules — same file
first, then imported files, then unique names — to match each reference to its true
definition. This is what makes the memory trustworthy rather than fuzzy.

**Result: relationships that point at the *correct* entities.**

### Stage 4 — Embed
Each meaningful piece is converted into a **vector** — a long list of numbers that
captures its meaning. Think of it as the piece's "signature". Later, RepoMemory can
find pieces with similar meanings even if their names are completely different.

**Result: a meaning-fingerprint for each entity.**

### Stage 5 — Persist
Everything is saved into PostgreSQL — a *table database* that stores both the
details (metadata, full text, change history, meaning-fingerprints via
pgvector) and the map (entities + relationships). Graph questions like "who is
connected to whom" run directly against those tables as recursive queries, so
there is only one store to run and no second database to keep in sync.

**Result: a complete, searchable memory of the project.**

---

## 5. What the memory can tell you (the features)

Once the memory exists, RepoMemory answers many different questions. Each is a
separate "view" of the same data.

### 5.1 Searching and browsing
Find any entity by name, browse entities of a certain type, or list everything in a
single file.

### 5.2 Dependencies and dependents
- **Dependencies**: "What does this thing rely on?"
- **Dependents**: "What relies on this thing?"
- **Transitive**: "What relies on it, directly *and* indirectly?" (the ripple effect)

This is like a "who calls whom" map of the whole project.

### 5.3 Impact analysis
If you change one piece of code, impact analysis tells you everything that could be
affected — direct users, indirect users, and the files involved. **It is the answer
to "will this break something?"**

### 5.4 Dead code detection
RepoMemory starts from the "entry points" of the project (the places the program
starts, and test files) and walks every connection. Anything that can never be
reached from those starting points is flagged as **dead code** — code that exists but
nothing uses. Great for cleanup.

### 5.5 Ownership and domains
RepoMemory examines who has committed changes to each file most often (the **owner**)
and classifies each file's *role* (e.g. "API layer", "database layer", "tests").
This reveals how the project is organized and who knows each part best.

### 5.6 Architecture boundary validation
If the project defines rules — for example "the API layer must never talk directly to
the database layer" — RepoMemory can check every connection against those rules and
report **violations**. It acts as a referee for the project's architecture.

### 5.7 Change analytics (churn, risk, drift)
Using the project's saved history (commits), RepoMemory computes:

- **Churn** — which files are edited the most, and how heavily.
- **Risk** — a score (0–100) per file, combining how often it changes, how many things
  depend on it, whether it breaks architecture rules, whether it contains dead code,
  and how stale it is. The score comes with a *breakdown* so you can see *why*.
- **Drift** — signals that the architecture is slowly getting off-track (e.g. tests
  missing, recent rule violations, unstable public interfaces).

### 5.8 Natural-language QA
You can ask RepoMemory questions in plain English, like:

> "What does `createUser` depend on?"
> "Who calls `sendEmail`?"
> "Which files have no tests?"

It classifies the question into an intent, finds the relevant entity, gathers
evidence, and answers with citations. It can even handle **compound questions**
("how does A relate to B?") and **multi-hop** questions that require chaining facts.

### 5.9 Context packs for AI assistants
When an AI coding assistant needs to work on a piece of code, RepoMemory can generate
a **context pack** — a compact dossier containing the entity, its dependencies, its
users, recent changes, and similar entities. This hands the assistant exactly what it
needs without flooding it with the whole codebase.

There are two kinds:

- **By entity** — point at a specific piece of code and get its dossier.
- **By task** — describe what you're trying to do in plain language ("add a paginated
  endpoint for users"), and RepoMemory figures out which pieces of code matter and
  assembles the dossier itself. It recognizes the relevant symbols directly or by
  meaning, gathers their connections and change history, and trims everything to fit
  a token budget so the answer stays focused.

### 5.10 MCP: plugging RepoMemory into AI tools directly
**MCP** (Model Context Protocol) is a standard way for AI assistants and coding tools
to use external services. RepoMemory exposes an MCP **server** that any MCP-aware
assistant can connect to. Through it, an assistant can call 23 read-only
"tools" — search for symbols, look up dependencies and dependents, list a
class's members, pull exact source lines, run dead-code or risk reports,
ask questions, pull context packs, and even ask across all projects at once.

The key properties:

- **Read-only** — the assistant can *look* but never *change* anything.
- **Speaks the same language** — it uses the very same QA and context-pack engine as
  the web page and the command line.
- **Self-contained** — one command starts it, and it talks over standard input/output
  (stdio), so it works with any MCP client on any machine.

This means an AI assistant can browse your codebase's memory directly — no web page
needed.

---

## 6. More than one project: the workspace

RepoMemory can remember **many** projects at once. Each project's data is tagged with
its own name, so two projects with identical file structures never get confused. You
can then:

- List every remembered project with its size.
- Search across **all** projects at once.
- Ask questions that span projects (answers will say which project they came from).

This turns RepoMemory from "a memory for one project" into "a memory for all the
projects your team works on".

---

## 7. Staying up to date (the "live" mode)

A memory is only useful if it's fresh. RepoMemory has two ways of staying current:

### 7.1 Incremental scans (saved snapshots)
After the first full scan, RepoMemory remembers which saved snapshot (commit) it last
saw. On the next scan it only re-reads the files that actually **changed** since then
— it doesn't re-read the whole project. That makes regular updates fast.

### 7.2 Live watching
In **watch mode**, RepoMemory sits beside the project with its "ears open". The moment
you save an edit to a file, it notices, waits a short moment (debounce) in case you're
typing more, and then updates just that file's memory automatically. Add a new
function → it appears in the memory. Delete a file → it disappears. No manual scan
needed. A small "live" indicator on the web page shows that it is watching and when it
last synced.

---

## 8. Staying healthy: integrity checks

Even with a single database, it is worth checking the memory periodically — a
relationship might point at an entity that no longer exists, or some entities
might be missing their meaning-fingerprints. RepoMemory has two special
maintenance jobs:

- **Verify** — inspects the database and produces a report: per-type counts,
  duplicate IDs, dangling edges, and entities without embeddings. It answers
  "is the memory healthy?"
- **Repair** — re-generates any missing meaning-fingerprints, then runs Verify
  again to prove everything is clean.

This is the equivalent of a librarian periodically checking the card catalog against
the actual books on the shelves.

---

## 9. Memory under control: streaming for very large projects

Very big projects contain enormous numbers of entities. Reading them all into memory
at once would be wasteful (and could crash the computer). RepoMemory instead
**streams**: it reads the data in small **batches** (windows) — a few thousand at a
time — and processes each window, keeping only the current window in memory. The
amount of memory used stays flat no matter how big the project is. You can even tune
the window size (called `ANALYSIS_BATCH_SIZE`) and run a built-in **benchmark**
(`pnpm bench`) to see how fast each analysis runs and how much memory it uses.

---

## 10. How people interact with RepoMemory

There are three doors into the system — all showing the same memory:

```
┌──────────────────────────────────────────────────────────────────┐
│                        RepoMemory memory                        │
│        (PostgreSQL: table store + connection map)             │
└──────────────────────────────────────────────────────────────────┘
              ▲                        ▲                        ▲
              │                        │                        │
      ┌───────┴───────┐      ┌────────┴────────┐      ┌────────┴────────┐
      │ Command line  │      │  Web page       │      │  AI tools /     │
      │ (CLI)         │      │  (frontend)     │      │  HTTP API       │
      └───────────────┘      └─────────────────┘      └─────────────────┘
      e.g. "show dead        a visual map you can     a standard web
      code"                  click and browse         interface other
                                                      programs can call
              ▲
              │
      ┌───────┴───────────────────┐
      │  MCP server (AI tools)    │
      │  standard "plug in" port  │
      │  for AI assistants        │
      └───────────────────────────┘
```

- **The command line (CLI)** — for people comfortable with a terminal. Typing a
  command like `repo-memory query dead-code` prints a report.
- **The web page** — a visual explorer with a clickable map, entity lists, commit
  history, analysis reports, and an "Ask" chat box.
- **The HTTP API** — a standard web interface that other programs and AI assistants
  can call automatically. This is how RepoMemory plugs into developer tools.
- **The MCP server** — an extra port made specially for AI assistants. An
  MCP-aware tool (a coding assistant, for example) connects to it and gets a whole
  toolbox of read-only commands to inspect the memory (see section 5.10).

---

## 11. Good engineering hygiene (what keeps it trustworthy)

Even though it's invisible from the outside, RepoMemory follows careful engineering
practices so the memory is reliable:

- **Tests** — 170+ automated checks (a "safety net") that run on every change,
  verifying each part behaves correctly.
- **Logging** — every important action writes a structured, timestamped record, so
  when something goes wrong you can trace exactly what happened.
- **Metrics** — it counts its own activity (scans, requests, timing) and exposes these
  numbers for monitoring dashboards.
- **Schema migrations** — as the system evolves, its databases change shape. Migrations
  are versioned and applied safely, like upgrades that never lose data.
- **Access control** — the server can require a secret token (set via
  `REPO_MEMORY_API_TOKEN`). When enabled, requests without the token are politely refused,
  and the web page picks the token up automatically so people can keep browsing.
- **Repair jobs** — as described in section 8, the memory is kept healthy.

---

## 12. A quick tour of the technology (for the curious)

You don't need any of this to *use* RepoMemory, but if you're curious about what's
under the hood:

| Component | What it does | Everyday analogy |
|-----------|--------------|------------------|
| Tree-sitter | A grammar-based code reader per language | A grammarian who can diagram any sentence |
| Symbol index | A project-wide "phone book" of names | The phone book that resolves who's who |
| PostgreSQL + pgvector | A table database with meaning-fingerprints — and the connection map, queried recursively | The encyclopedia with a "similarity" index |
| Embeddings | Meaning-fingerprints for pieces of code | Song recognition fingerprints |
| Hono | A lightweight web server | The front desk that answers all requests |
| logger | A dependency-free structured logger (JSON lines) | A black box recorder |
| Prometheus | A metrics collector | A dashboard of gauges |
| chokidar | A file-change listener | The "ears" that hear edits |
| MCP SDK | The standard "AI tool port" | A universal power outlet for assistants |

---

## 13. Where to go from here

- **Read the README** in this project — it lists every command and every web endpoint.
- **Explore the web page** after starting the server — click around the map, try the
  "Ask" box.
- **Ask RepoMemory about itself** — it has a memory of this very repository, so you
  can ask it questions about how *it* is built.

---

## Appendix — a complete worked example

Let's walk through one realistic story to tie everything together.

1. A developer creates a project with two files:
   - `math.ts` — defines `add` and `multiply`
   - `app.ts` — imports `add` from `math.ts` and uses it

2. **Full scan**: RepoMemory reads both files.
   - Entities found: `add`, `multiply`, `app.ts`, `math.ts`.
   - Relationships found: `app.ts` imports from `math.ts`; `app.ts` calls `add`.

3. **Resolve**: the reference to `add` inside `app.ts` is matched to the real `add`
   in `math.ts`. The relationship now points at the correct definition.

4. **Embed**: `add` gets a meaning-fingerprint. Later, a search for "sum two
   numbers" can find it even though the words differ.

5. **Change analytics**: `app.ts` is edited several times → it shows high churn and a
   higher risk score, with a breakdown explaining why.

6. **Live watching**: the developer renames `add` to `addNumbers` and saves.
   RepoMemory notices, updates the memory within a moment, and the next search already
   shows the new name.

7. **QA**: the developer asks *"what does app.ts depend on?"* and gets a clear answer
   with evidence, naming `math.ts` and `addNumbers`.

8. **Verify (safety net)**: once in a while, a Verify job confirms the memory is
   healthy — no dangling edges, no duplicate IDs, no missing embeddings.

9. **AI assistant**: a coding assistant connects through the MCP server. It asks
   *"what does app.ts depend on?"* through the `qa_ask` tool and asks for a
   *task context pack* before editing — and RepoMemory hands back the exact dossier,
   built from the very same engine that answered the developer at the command line.

That's RepoMemory: a librarian, a map, a detective, and an assistant — all in one,
built to keep a living memory of everything a software project does.
