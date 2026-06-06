import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type ThoughtMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
};

type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string | null;
};

const CITATION_BASE_URL =
  Deno.env.get("OPEN_BRAIN_CITATION_BASE_URL") || "https://openbrain.local/thoughts";

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id: string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${id}`;
}

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- Markdown chunker (used by capture_note) ---
//
// Splits a markdown document into chunks at H1/H2 boundaries. Frontmatter
// is stripped; fenced code blocks (```/~~~) suppress heading detection so
// `# foo` inside a code sample is not treated as a section break. Empty
// chunk bodies are dropped. See obsidian-open-brain/server/lib/chunker.ts
// for the source of truth and Deno unit tests.

interface Chunk {
  heading: string | null;
  body: string;
}

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;
const FENCE_RE = /^(```|~~~)/;
const HEADING_RE = /^(#{1,2})\s+(.+?)\s*#*\s*$/;

function chunkMarkdown(markdown: string): Chunk[] {
  const stripped = markdown.replace(FRONTMATTER_RE, "");
  const lines = stripped.split("\n");

  const headings: Array<{ line: number; text: string }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (m) headings.push({ line: i, text: m[2].trim() });
  }

  if (headings.length === 0) {
    const body = stripped.trim();
    return body ? [{ heading: null, body }] : [];
  }

  const chunks: Chunk[] = [];

  const preamble = lines.slice(0, headings[0].line).join("\n").trim();
  if (preamble) chunks.push({ heading: null, body: preamble });

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].line + 1;
    const end = i + 1 < headings.length ? headings[i + 1].line : lines.length;
    const body = lines.slice(start, end).join("\n").trim();
    if (body) chunks.push({ heading: headings[i].text, body });
  }

  return chunks;
}

// --- MCP Server Setup ---

// Build a FRESH server per request (see the request handler). McpServer is
// stateful — connect() binds it to a single transport — so a module-level
// singleton shared across requests races under concurrency: a second request's
// connect() rebinds the server, orphaning the first request's response. The
// client then sees a hang or "Unexpected content type: null". A new instance per
// request keeps each exchange isolated.
//
// NOTE: the tool registrations below are intentionally left at their original
// indentation inside this function to keep the fix diff small and reviewable.
function createServer() {
const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep
// research look for exact read-only `search` and `fetch` tool shapes.
server.registerTool(
  "search",
  {
    title: "Search Open Brain",
    description:
      "Search Open Brain memories by meaning. Use this read-only compatibility tool when ChatGPT needs search/fetch-style access to stored thoughts.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe("The search query to run against Open Brain thoughts"),
    },
  },
  async ({ query }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: 0.5,
        match_count: 10,
        filter: {},
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      const results = ((data || []) as ThoughtMatch[]).map((t) => ({
        id: t.id,
        title: thoughtTitle(t.content, t.created_at),
        url: thoughtUrl(t.id),
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "fetch",
  {
    title: "Fetch Open Brain Thought",
    description:
      "Fetch one Open Brain thought by ID after using search. Use this read-only compatibility tool to retrieve the full text and metadata for citation.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      id: z.string().describe("The Open Brain thought ID returned by the search tool"),
    },
  },
  async ({ id }) => {
    try {
      const { data, error } = await supabase
        .from("thoughts")
        .select("id, content, metadata, created_at, updated_at")
        .eq("id", id)
        .single();

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Fetch error: ${error.message}` }],
          isError: true,
        };
      }

      const thought = data as ThoughtRecord;
      const document = {
        id: thought.id,
        title: thoughtTitle(thought.content, thought.created_at),
        text: thought.content,
        url: thoughtUrl(thought.id),
        metadata: {
          ...thought.metadata,
          created_at: thought.created_at,
          updated_at: thought.updated_at,
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(document) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 1: Semantic Search
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter: {},
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
        };
      }

      const results = data.map(
        (
          t: ThoughtMatch,
          i: number
        ) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: List Recent
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      let q = supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }

      const { data, error } = await q;

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || !data.length) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }

      const results = data.map(
        (
          t: { content: string; metadata: Record<string, unknown>; created_at: string },
          i: number
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase
        .from("thoughts")
        .select("*", { count: "exact", head: true });

      const { data } = await supabase
        .from("thoughts")
        .select("metadata, created_at")
        .order("created_at", { ascending: false });

      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};

      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics))
          for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people))
          for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
      }

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${
          data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " → " +
              new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems.",
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      content: z.string().describe("The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
    },
  },
  async ({ content }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", {
        p_content: content,
        p_payload: { metadata: { ...metadata, source: "mcp" } },
      });

      if (upsertError) {
        return {
          content: [{ type: "text" as const, text: `Failed to capture: ${upsertError.message}` }],
          isError: true,
        };
      }

      const thoughtId = upsertResult?.id;
      const { error: embError } = await supabase
        .from("thoughts")
        .update({ embedding })
        .eq("id", thoughtId);

      if (embError) {
        return {
          content: [{ type: "text" as const, text: `Failed to save embedding: ${embError.message}` }],
          isError: true,
        };
      }

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length)
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length)
        confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: Delete Obsidian Note
server.registerTool(
  "delete_note",
  {
    title: "Delete Obsidian Note",
    description:
      "Remove all chunks of an Obsidian note from Open Brain by note_id. Called by the Obsidian plugin when a tracked note is deleted from the vault. Idempotent.",
    inputSchema: {
      note_id: z
        .string()
        .uuid()
        .describe("UUID from the Obsidian note's open_brain_id frontmatter"),
    },
  },
  async ({ note_id }) => {
    try {
      const { error, count } = await supabase
        .from("thoughts")
        .delete({ count: "exact" })
        .eq("note_id", note_id);

      if (error) {
        return {
          content: [
            { type: "text" as const, text: `delete_note failed: ${error.message}` },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ note_id, deleted: count ?? 0 }),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  }
);

// Tool 6: Count Pending Captures
server.registerTool(
  "count_pending_captures",
  {
    title: "Count Pending Captures",
    description:
      "Return the number of free-form captures (phone Shortcut, future webhook sources) created after the given timestamp. Used by the Obsidian plugin's indicator. Excludes note chunks and legacy Obsidian-sourced rows.",
    inputSchema: {
      since: z
        .string()
        .datetime()
        .describe(
          "ISO 8601 UTC timestamp. Only captures created strictly after this are counted."
        ),
    },
  },
  async ({ since }) => {
    try {
      const { count, error } = await supabase
        .from("thoughts")
        .select("*", { count: "exact", head: true })
        .is("note_id", null)
        .not("content", "like", "[Obsidian:%")
        .gt("created_at", since);

      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `count_pending_captures failed: ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: count ?? 0 }),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  }
);

// Tool 7: List Pending Captures
server.registerTool(
  "list_pending_captures",
  {
    title: "List Pending Captures",
    description:
      "Return free-form captures (phone Shortcut, future webhook sources) created after the given timestamp, ordered by created_at ASC. Used by the Obsidian plugin to pull new thoughts into Inbox.md. Excludes note chunks and legacy Obsidian-sourced rows.",
    inputSchema: {
      since: z
        .string()
        .datetime()
        .describe(
          "ISO 8601 UTC timestamp. Only captures created strictly after this are returned."
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .default(100)
        .describe("Max rows to return. Defaults to 100; capped at 500."),
    },
  },
  async ({ since, limit }) => {
    try {
      const { data, error } = await supabase
        .from("thoughts")
        .select("id, content, created_at, metadata")
        .is("note_id", null)
        .not("content", "like", "[Obsidian:%")
        .gt("created_at", since)
        .order("created_at", { ascending: true })
        .limit(limit);

      if (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `list_pending_captures failed: ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      const captures = data ?? [];
      const last_created_at =
        captures.length > 0
          ? captures[captures.length - 1].created_at
          : null;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ captures, last_created_at }),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  }
);

// Tool 8: Capture Obsidian Note
server.registerTool(
  "capture_note",
  {
    title: "Capture Obsidian Note",
    description:
      "Chunk an Obsidian note at H1/H2 boundaries and replace its rows in Open Brain. Each chunk is stored with the [Obsidian: title | path > heading] prefix, structural metadata, and an embedding. Idempotent — rerunning with the same note_id replaces the previous chunks.",
    inputSchema: {
      note_id: z
        .string()
        .uuid()
        .describe("UUID from the Obsidian note's open_brain_id frontmatter"),
      path: z
        .string()
        .describe(
          "Directory-relative path from vault root, e.g. 'PIPELINES/3-PROJECTS'. Does not include the filename."
        ),
      title: z.string().describe("Filename without the .md extension"),
      content: z
        .string()
        .describe(
          "Full markdown body. Frontmatter is optional; the chunker strips it."
        ),
    },
  },
  async ({ note_id, path, title, content }) => {
    try {
      // Chunk and embed BEFORE mutating — if embedding fails the existing rows
      // are untouched (no silent data loss from a partial delete+insert).
      const noteChunks = chunkMarkdown(content);
      if (noteChunks.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ note_id, chunks: [] }),
            },
          ],
        };
      }

      const buildPrefixedContent = (heading: string | null, body: string) =>
        heading
          ? `[Obsidian: ${title} | ${path} > ${heading}] ${body}`
          : `[Obsidian: ${title} | ${path}] ${body}`;

      const baseRows = noteChunks.map((c, index) => ({
        content: buildPrefixedContent(c.heading, c.body),
        note_id,
        chunk_index: index,
        content_fingerprint: null,
        metadata: {
          source: "obsidian",
          title,
          path,
          heading: c.heading,
          chunk_index: index,
        },
        updated_at: new Date().toISOString(),
      }));

      const embeddings = await Promise.all(
        baseRows.map((r) => getEmbedding(r.content))
      );

      const rows = baseRows.map((r, i) => ({
        ...r,
        embedding: embeddings[i],
      }));

      // Embeddings ready — now replace the stored rows atomically.
      const { error: deleteError } = await supabase
        .from("thoughts")
        .delete()
        .eq("note_id", note_id);
      if (deleteError) {
        return {
          content: [
            {
              type: "text" as const,
              text: `capture_note delete phase failed: ${deleteError.message}`,
            },
          ],
          isError: true,
        };
      }

      const { error: insertError } = await supabase
        .from("thoughts")
        .insert(rows);
      if (insertError) {
        return {
          content: [
            {
              type: "text" as const,
              text: `capture_note insert phase failed: ${insertError.message}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              note_id,
              chunks: noteChunks.map((c, index) => ({
                index,
                heading: c.heading,
              })),
            }),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  }
);

// Tool 9: Rename Obsidian Note
server.registerTool(
  "rename_note",
  {
    title: "Rename Obsidian Note",
    description:
      "Rewrite the [Obsidian: title | path > heading] prefix on every chunk of a note when its file is renamed or moved. Heading per chunk is read from metadata.heading. content_fingerprint stays NULL; embedding is NOT recomputed (re-sync via capture_note if you need fresh embeddings).",
    inputSchema: {
      note_id: z.string().uuid().describe("UUID of the note to rename."),
      new_path: z
        .string()
        .describe(
          "New directory-relative path from vault root, e.g. 'PIPELINES/4-ARCHIVED'. Excludes filename."
        ),
      new_title: z
        .string()
        .describe("New filename without the .md extension."),
    },
  },
  async ({ note_id, new_path, new_title }) => {
    try {
      const { data: rows, error: fetchError } = await supabase
        .from("thoughts")
        .select("id, content, metadata")
        .eq("note_id", note_id);

      if (fetchError) {
        return {
          content: [
            {
              type: "text" as const,
              text: `rename_note fetch phase failed: ${fetchError.message}`,
            },
          ],
          isError: true,
        };
      }

      if (!rows || rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ note_id, rows_updated: 0 }),
            },
          ],
        };
      }

      const PREFIX_RE = /^\[Obsidian:[^\]]*\] ?/;
      const now = new Date().toISOString();

      const updates = rows.map((row) => {
        const meta = (row.metadata as Record<string, unknown> | null) ?? {};
        const heading = (meta.heading as string | null | undefined) ?? null;
        const body = row.content.replace(PREFIX_RE, "");
        const newContent = heading
          ? `[Obsidian: ${new_title} | ${new_path} > ${heading}] ${body}`
          : `[Obsidian: ${new_title} | ${new_path}] ${body}`;
        const newMetadata = {
          ...meta,
          title: new_title,
          path: new_path,
        };
        return supabase
          .from("thoughts")
          .update({
            content: newContent,
            metadata: newMetadata,
            updated_at: now,
          })
          .eq("id", row.id);
      });

      const results = await Promise.all(updates);
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        const first = failed[0].error!.message;
        const extra =
          failed.length > 1 ? ` (and ${failed.length - 1} more)` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `rename_note update phase failed: ${first}${extra}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ note_id, rows_updated: rows.length }),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  }
);

  return server;
}

// --- Hono App with Auth + CORS ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

// JSON-RPC error code for unauthorized requests.
// Per the JSON-RPC 2.0 spec, the range -32099 to -32000 is reserved for
// implementation-defined server errors. -32001 is the conventional
// "Unauthorized" code used by MCP clients/servers in the wild.
//
// Why a JSON-RPC envelope (HTTP 200) instead of a bare HTTP 401?
// Strict MCP hosts (Codex CLI, Claude Code) treat bare HTTP 4xx responses
// as transport-level failures and tear the connection down rather than
// surfacing the failure to the application layer. Wrapping the auth
// rejection in a JSON-RPC error keeps the connection alive and lets
// clients recover (e.g. prompt the user for a new key, refetch a stale
// cache) instead of dying.
const JSON_RPC_UNAUTHORIZED_CODE = -32001;
const UNAUTHORIZED_MESSAGE = "Unauthorized: missing or invalid authentication.";

/**
 * Read the request body as text without consuming the original request's
 * body stream for downstream handlers. Returns null on bodyless methods
 * or read failure.
 */
async function readBodyText(req: Request): Promise<string | null> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") {
    return null;
  }
  try {
    return await req.text();
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of the JSON-RPC `id` from a raw request body.
 * Returns null when the body is missing, not JSON, or not a JSON-RPC
 * shape with an id. Per the JSON-RPC 2.0 spec, id may be a string,
 * number, or null — we preserve any of those; anything else becomes null.
 */
function extractJsonRpcId(bodyText: string | null): string | number | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      const id = (parsed as { id: unknown }).id;
      if (typeof id === "string" || typeof id === "number" || id === null) {
        return id;
      }
    }
  } catch {
    // fall through — malformed body
  }
  return null;
}

/**
 * Build a JSON-RPC 2.0 error envelope response for auth failures.
 * Returns HTTP 200 — the JSON-RPC layer expresses the error so that
 * strict MCP clients keep the connection alive instead of treating
 * the failure as a transport-level fault.
 */
function unauthorizedResponse(id: string | number | null): Response {
  const body = {
    jsonrpc: "2.0",
    error: {
      code: JSON_RPC_UNAUTHORIZED_CODE,
      message: UNAUTHORIZED_MESSAGE,
    },
    id,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

const app = new Hono();

// CORS preflight — required for browser/Electron-based clients (Claude Desktop, claude.ai)
app.options("*", (c) => {
  return c.text("ok", 200, corsHeaders);
});

app.all("*", async (c) => {
  // Accept access key via header OR URL query parameter
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    // Return a JSON-RPC 2.0 error envelope (HTTP 200) instead of a bare
    // HTTP 401 so strict MCP hosts treat this as an application-level
    // error rather than a transport fault and keep the connection alive.
    // Best-effort echo of the inbound request id keeps the response
    // correlated; malformed/missing bodies fall back to id: null.
    const bodyText = await readBodyText(c.req.raw);
    const id = extractJsonRpcId(bodyText);
    return unauthorizedResponse(id);
  }

  // This server is stateless: a fresh StreamableHTTPTransport is created per
  // request (below), so it can never push server-initiated messages over the
  // standalone GET SSE stream — handleRequest would hold a GET open forever
  // (clients hang and time out). The MCP Streamable HTTP spec lets a server
  // decline that stream with 405; clients treat it as "no standalone stream"
  // and continue over POST.
  if (c.req.method === "GET") {
    return c.json(
      { error: "Method Not Allowed: server-initiated SSE stream not supported" },
      405,
      { ...corsHeaders, Allow: "POST, OPTIONS, DELETE" }
    );
  }

  // Fix: Claude Desktop connectors don't send the Accept header that
  // StreamableHTTPTransport requires. Build a patched request if missing.
  // See: https://github.com/NateBJones-Projects/OB1/issues/33
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const server = createServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
