import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createLogger, onLog, type LogEntry } from "./logger.js";
import type { Runtime } from "./runtime.js";
import type { ResearchService } from "./service.js";

const log = createLogger("web");
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal web UI:
 *   GET  /                      single-page app (public/index.html)
 *   GET  /api/status            balances, mode, models, refuels
 *   GET  /api/logs              Server-Sent Events stream of agent logs
 *   GET  /api/reports           archived reports
 *   GET  /api/reports/:id       one report (json record + markdown)
 *   GET  /api/reports/:id.md    download markdown
 *   GET  /api/reports/:id.log   the run's log
 *   POST /api/research          { topic, steps } → starts a run (one at a time)
 *   POST /api/reports/:id/ask   { question } → follow-up answer
 *   POST /api/compare           { a, b } → comparison markdown
 */
export async function startServer(svc: ResearchService, rt: Runtime, port: number) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(join(__dirname, "..", "public")));

  // ---- live logs (SSE) ----
  const recent: LogEntry[] = [];
  onLog((e) => {
    recent.push(e);
    if (recent.length > 300) recent.shift();
  });

  app.get("/api/logs", (req: Request, res: Response) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();
    for (const e of recent.slice(-100)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const off = onLog((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      off();
      clearInterval(ping);
    });
  });

  // ---- status ----
  app.get("/api/status", async (_req, res) => {
    try {
      res.json(await svc.status());
    } catch (e) {
      res.status(500).json({ error: msg(e) });
    }
  });

  // ---- reports ----
  app.get("/api/reports", (_req, res) => res.json(rt.store.list()));

  app.get("/api/reports/:id.md", (req, res) => {
    const md = rt.store.markdown(req.params.id);
    if (!md) return res.status(404).send("not found");
    res.setHeader("content-type", "text/markdown; charset=utf-8");
    // Header values must be ASCII; report ids contain the (often Chinese) topic, so use RFC 5987 encoding.
    const ascii = req.params.id.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    res.setHeader("content-disposition", `attachment; filename="${ascii}.md"; filename*=UTF-8''${encodeURIComponent(req.params.id)}.md`);
    res.send(md);
  });

  app.get("/api/reports/:id.log", (req, res) => {
    const text = rt.store.log(req.params.id);
    if (!text) return res.status(404).send("not found");
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.send(text);
  });

  app.get("/api/reports/:id", (req, res) => {
    const rec = rt.store.get(req.params.id);
    if (!rec) return res.status(404).json({ error: "not found" });
    res.json({ ...rec, markdown: rt.store.markdown(rec.id) ?? "" });
  });

  // ---- actions ----
  app.post("/api/research", async (req, res) => {
    const topic = String(req.body?.topic ?? "").trim();
    const steps = req.body?.steps ? Number(req.body.steps) : undefined;
    const workers = req.body?.workers ? Number(req.body.workers) : undefined;
    if (!topic) return res.status(400).json({ error: "topic required" });
    if (svc.isBusy) return res.status(409).json({ error: "a research run is already in progress" });
    // Fire and forget; the client follows progress via /api/logs and polls /api/reports.
    svc
      .research(topic, steps, workers)
      .then((r) => log.info(`Web research finished: ${r.record.id}`))
      .catch((e) => log.error(`Web research failed: ${msg(e)}`));
    res.status(202).json({ started: true, topic, workers: workers ?? 1 });
  });

  app.post("/api/reports/:id/ask", async (req, res) => {
    const question = String(req.body?.question ?? "").trim();
    if (!question) return res.status(400).json({ error: "question required" });
    try {
      res.json({ answer: await svc.ask(req.params.id, question) });
    } catch (e) {
      res.status(500).json({ error: msg(e) });
    }
  });

  app.post("/api/compare", async (req, res) => {
    const { a, b } = req.body ?? {};
    if (!a || !b) return res.status(400).json({ error: "a and b required" });
    try {
      res.json(await svc.compare(String(a), String(b)));
    } catch (e) {
      res.status(500).json({ error: msg(e) });
    }
  });

  await new Promise<void>((resolve) => app.listen(port, resolve));
  log.info(`Web UI listening on http://localhost:${port}  (${rt.mode})`);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
