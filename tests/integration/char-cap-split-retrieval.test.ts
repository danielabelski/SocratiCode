// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Regression for the character cap, against a real Qdrant and a real embedding
 * path.
 *
 * A chunk longer than MAX_CHUNK_CHARS used to be truncated before it was
 * stored, so everything past the cap reached neither the stored text nor the
 * keyword index and no search could return it. On a fresh format-2 collection
 * the cap now splits instead, and this proves the tail survives all the way to
 * a search result — not in a unit test of the chunker, but through indexing,
 * embedding, storage and retrieval.
 *
 * Chunking cuts by line count (CHUNK_SIZE) while the cap counts characters, so
 * the fixture below is one window whose marker sits past the cap: the exact
 * shape that used to lose content.
 *
 * Nothing is stubbed. The embedding provider, the OpenAI-compatible HTTP
 * request it makes, Qdrant, and the hybrid search are all real. What the test
 * supplies is the model behind the endpoint: an embedding service of its own,
 * on an ephemeral port, so the job needs no model download and no extra
 * container. Its vectors are a deterministic hashed term frequency — a poor
 * model, but a real one: different texts get different vectors, and a query
 * scores highest against the text holding its term.
 */

import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { MAX_CHUNK_CHARS } = await import("../../src/constants.js");
const {
  collectionName,
  projectIdFromPath,
  symgraphFileCollectionName,
  symgraphIndexCollectionName,
  symgraphMetaCollectionName,
} = await import("../../src/config.js");
const { ensureQdrantReady } = await import("../../src/services/docker.js");
const { resetEmbeddingConfig } = await import("../../src/services/embedding-config.js");
const { resetLMStudioClient } = await import("../../src/services/provider-lmstudio.js");
const { resetEffectiveEmbeddingReadiness } = await import("../../src/services/index-profile.js");
const { indexProject } = await import("../../src/services/indexer.js");
const { loadProjectEffectiveProfile, searchChunks } = await import("../../src/services/qdrant.js");
const { isDockerAvailable } = await import("../helpers/fixtures.js");
const { cleanupTestCollections, createTestQdrantClient, waitForQdrant } = await import(
  "../helpers/setup.js"
);

/**
 * Locally this skips without Docker. In CI it must not: a test that skips itself
 * is a silent no-op, and a silent no-op reads exactly like a passing boundary
 * check. REQUIRE_QDRANT=1 turns an unreachable backend into a failure.
 */
const requireQdrant = process.env.REQUIRE_QDRANT === "1";
const shouldRun = requireQdrant || isDockerAvailable();

const DIMENSIONS = 256;
const MODEL = "char-cap-regression-embeddings";

/** Appears once, past the cap, and nowhere else in the fixture. */
const TAIL_MARKER = "zarquonThresholdMarker";

/**
 * A deterministic embedding: term frequency over hashed tokens, L2-normalised.
 *
 * Wide enough that the fixture's tokens rarely share a dimension, so a query
 * term lands on a dimension the chunks holding that term are the only ones with
 * weight in. That is what makes the dense half of the hybrid query meaningful
 * here rather than a tie broken by the keyword half alone.
 */
function embedText(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

/** Requests the embedding endpoint actually served, so stubbing cannot pass. */
let embeddingRequests = 0;

function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    request.on("error", reject);
  });
}

/** The smallest OpenAI-compatible embedding server the provider will accept. */
function createEmbeddingServer(): http.Server {
  return http.createServer((request, response) => {
    const url = request.url ?? "";

    // The provider lists models to check the configured one is loaded before it
    // embeds anything, so the readiness path is exercised too.
    if (request.method === "GET" && url.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
      return;
    }

    if (request.method === "POST" && url.endsWith("/embeddings")) {
      embeddingRequests += 1;
      readJsonBody(request)
        .then((body) => {
          const input = body.input;
          const texts = Array.isArray(input) ? (input as string[]) : [String(input ?? "")];
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              object: "list",
              model: MODEL,
              data: texts.map((text, index) => ({
                object: "embedding",
                index,
                embedding: embedText(text),
              })),
              usage: { prompt_tokens: 0, total_tokens: 0 },
            }),
          );
        })
        .catch(() => {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "malformed embedding request" } }));
        });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `no route for ${url}` } }));
  });
}

/**
 * A file of CHUNK_SIZE lines whose total length is past the cap, with the
 * marker on the last line.
 *
 * The line count matters: at or below CHUNK_SIZE the file becomes a single
 * chunk, so the cap is the only thing that can divide it and the marker really
 * does sit past the cap of the chunk that holds it. Spread the same text over
 * more lines and the line-based path starts a new window near the end, which
 * puts the marker back inside the first cap's worth of its own window — where
 * truncation would never have dropped it, and the regression would pass against
 * the very defect it exists to catch.
 */
function overCapSource(): string {
  const filler = Array.from(
    { length: 95 },
    (_, i) => `export const settlementFactor${String(i).padStart(3, "0")} = ${i} + 0.5;`,
  ).join("\n");
  return `${filler}\nexport const settlementThreshold = "${TAIL_MARKER}";\n`;
}

async function writeFile(dir: string, rel: string, body: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body);
}

const originalEnv = { ...process.env };
let root = "";
let server: http.Server | null = null;
let embeddingUrl = "";

/** The only keys this test sets, so afterEach can put each one back. */
const OVERRIDDEN_ENV: Record<string, string> = {};

describe.skipIf(!shouldRun)("content past the character cap is retrievable", () => {
  beforeAll(async () => {
    server = createEmbeddingServer();
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    embeddingUrl = `http://127.0.0.1:${port}/v1`;
    Object.assign(OVERRIDDEN_ENV, {
      EMBEDDING_PROVIDER: "lmstudio",
      EMBEDDING_MODEL: MODEL,
      EMBEDDING_DIMENSIONS: String(DIMENSIONS),
      LMSTUDIO_URL: embeddingUrl,
    });

    if (!requireQdrant) await ensureQdrantReady();
    const ready = await waitForQdrant(60_000);
    if (!ready) {
      throw new Error(
        requireQdrant
          ? "REQUIRE_QDRANT=1 but Qdrant is not reachable — this regression must fail rather than skip."
          : "Qdrant did not become ready",
      );
    }
  }, 180_000);

  beforeEach(async () => {
    // Set the keys rather than replacing process.env. Assigning to process.env
    // swaps the magic object for a plain one, and everything spawned afterwards
    // — the Docker calls in the cleanup helper among them — would stop seeing
    // the real environment.
    for (const [key, value] of Object.entries(OVERRIDDEN_ENV)) {
      process.env[key] = value;
    }
    // The configuration, the HTTP client and the readiness result are all cached
    // from the first use; this run needs them built from the env just set.
    resetEmbeddingConfig();
    resetLMStudioClient();
    resetEffectiveEmbeddingReadiness();
    embeddingRequests = 0;
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-char-cap-"));
  });

  afterEach(async () => {
    for (const key of Object.keys(OVERRIDDEN_ENV)) {
      const previous = originalEnv[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    resetEmbeddingConfig();
    resetLMStudioClient();
    resetEffectiveEmbeddingReadiness();
    await fsp.rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      // close() only stops accepting; it waits for open keep-alive sockets,
      // which the embedding client leaves behind. Drop them first so this is
      // deterministic rather than a wait of up to the socket timeout.
      server.closeAllConnections();
      server.close(() => resolve());
    });
    server = null;
  });

  it("returns the tail of an over-cap window from a fresh format-2 index", async () => {
    const project = root;
    const source = overCapSource();
    expect(source.length).toBeGreaterThan(MAX_CHUNK_CHARS);
    expect(source.slice(0, MAX_CHUNK_CHARS)).not.toContain(TAIL_MARKER);

    await writeFile(project, "src/settlement.ts", source);

    try {
      await indexProject(project);

      const collection = collectionName(projectIdFromPath(project));

      // A fresh collection adopts the current format; splitting is what that
      // format means, and the assertions below depend on it.
      const profile = await loadProjectEffectiveProfile(collection);
      expect(profile).not.toBeNull();
      expect(profile?.indexFormatVersion).toBe(2);

      // Indexing went through the embedding endpoint rather than around it.
      expect(embeddingRequests).toBeGreaterThan(0);
      const requestsAfterIndexing = embeddingRequests;

      // Ask for one result, not a page of them. The fixture is only a few
      // chunks, so a wide limit would return every stored chunk whatever the
      // ranking did — proving the content exists rather than that a search
      // finds it. With a limit of one, the chunk holding the marker has to be
      // ranked first to come back at all.
      const [top] = await searchChunks(collection, TAIL_MARKER, 1);

      // The query was embedded too: the dense half of the hybrid search is
      // running against vectors this service produced.
      expect(embeddingRequests).toBeGreaterThan(requestsAfterIndexing);

      // The marker is past the cap. Before the split it reached no chunk, so
      // no result could contain it however the query was phrased.
      expect(top, "the search returned nothing for the marker").toBeDefined();
      expect(top.content, "no retrieved chunk holds the content past the cap").toContain(
        TAIL_MARKER,
      );
      expect(top.filePath).toContain("settlement.ts");

      // The whole file is still stored, in chunks that each honour the cap: the
      // tail became further chunks rather than widening one. Counting the
      // chunks would not show that — a regression dropping a middle piece
      // leaves more than one behind — so check coverage instead.
      //
      const stored = await searchChunks(collection, TAIL_MARKER, 50);
      expect(stored.length).toBeGreaterThan(1);
      for (const result of stored) {
        expect(result.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
        expect(source).toContain(result.content);
      }
      // This fixture splits only at newlines, so each piece has a distinct
      // startLine. Reconstructing the exact source catches an omitted or
      // replaced equal-length piece that a length total would miss. (The
      // fixture holds no whitespace-only piece, which the splitter drops.)
      const reconstructed = [...stored]
        .sort((left, right) => left.startLine - right.startLine)
        .map((result) => result.content)
        .join("");
      expect(reconstructed).toBe(source);
    } finally {
      await cleanupTestCollections(project).catch(() => undefined);
      // Indexing also builds the symbol graph, whose collections
      // cleanupTestCollections does not know about. Left behind they would
      // accumulate three per run in whatever Qdrant the suite is pointed at.
      const client = createTestQdrantClient();
      const projectId = projectIdFromPath(project);
      for (const name of [
        symgraphMetaCollectionName(projectId),
        symgraphFileCollectionName(projectId),
        symgraphIndexCollectionName(projectId),
      ]) {
        await client.deleteCollection(name).catch(() => undefined);
      }
    }
  }, 180_000);

  it("keeps a capped minified identifier intact and retrievable", async () => {
    const project = root;
    const identifier = "getUserSettlementFactor";
    // The semicolon is inside the capped window, while a hard split at the cap
    // would cut the identifier itself. Minified detection selects the
    // character chunker because this is one long line.
    const source = `${"a".repeat(MAX_CHUNK_CHARS - 21)};${identifier}=42;`;
    expect(source.slice(0, MAX_CHUNK_CHARS)).not.toContain(identifier);

    await writeFile(project, "src/settlement.js", source);

    try {
      await indexProject(project);

      const collection = collectionName(projectIdFromPath(project));
      const profile = await loadProjectEffectiveProfile(collection);
      expect(profile?.indexFormatVersion).toBe(2);

      const [top] = await searchChunks(collection, identifier, 1);
      expect(top, "the search returned nothing for the intact identifier").toBeDefined();
      expect(top.content).toContain(identifier);
      expect(top.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    } finally {
      await cleanupTestCollections(project).catch(() => undefined);
      const client = createTestQdrantClient();
      const projectId = projectIdFromPath(project);
      for (const name of [
        symgraphMetaCollectionName(projectId),
        symgraphFileCollectionName(projectId),
        symgraphIndexCollectionName(projectId),
      ]) {
        await client.deleteCollection(name).catch(() => undefined);
      }
    }
  }, 180_000);
});
