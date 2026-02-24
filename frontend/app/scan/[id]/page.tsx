"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.flowlens.in";

/* ─── Types ─── */

interface Bug {
  title: string;
  category: string;
  severity: string;
  confidence: string;
  page_url: string;
  viewport: string;
  description: string;
  screenshot_b64?: string;
  repro_steps?: string[];
  evidence: Record<string, unknown>;
}

interface Metric {
  url: string;
  viewport: string;
  load_time_ms: number;
  ttfb_ms: number;
  fcp_ms: number | null;
  dom_node_count: number;
  request_count: number;
  transfer_bytes: number;
}

interface BugSummary {
  total: number;
  by_severity: Record<string, number>;
  by_category: Record<string, number>;
}

interface GraphNode {
  id: string;
  label: string;
  path: string;
  bugs: number;
  max_severity: string | null;
  status?: string;
  page_type?: string;
  depth?: number;
}

interface GraphEdge { from: string; to: string; }
interface SiteGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

interface FlowStepDef {
  action: string;
  target: string;
  url_hint: string;
  verify: string;
}

interface FlowStepResult {
  step: FlowStepDef;
  status: "passed" | "failed" | "skipped";
  actual_url: string;
  screenshot_b64?: string;
  error?: string;
  ai_used: string;
  state_changes?: {
    url_changed?: boolean;
    cookies_set?: string[];
    js_errors?: string[];
    network_errors?: string[];
    dom_changed?: boolean;
  };
}

interface FlowResult {
  flow: { name: string; priority: number; steps: FlowStepDef[] };
  status: "passed" | "failed" | "partial";
  steps: FlowStepResult[];
  duration_ms: number;
  context_summary?: Record<string, unknown>;
}

interface ScanResult {
  scan_id: string;
  status: string;
  url: string;
  started_at: string;
  completed_at?: string;
  duration_seconds?: number;
  health_score: number | null;
  pages_tested: number;
  bugs: Bug[];
  bug_summary?: BugSummary;
  metrics: Metric[];
  pages_visited: string[];
  site_graph?: SiteGraph;
  screenshots?: Record<string, string>;
  errors: string[];
  flows?: FlowResult[];
}

interface LiveNode {
  url: string;
  depth: number;
  status: "discovered" | "visiting" | "visited" | "failed";
  from: string | null;
  bugs: number;
  elements: number;
  via?: string;
}

interface LiveFlowStep {
  flow: string;
  stepIndex: number;
  action: string;
  target: string;
  status: "running" | "passed" | "failed" | "skipped";
}

interface LogEntry {
  id: number;
  text: string;
  type: "info" | "action" | "discovery" | "bug" | "complete" | "flow" | "auth";
  timestamp: number;
}

/* ─── Theme ─── */

const T = {
  bg: "#09090b",
  bgAlt: "#0f0f12",
  card: "#131316",
  cardBorder: "#1e1e22",
  text: "#ececef",
  textSecondary: "#a1a1aa",
  textMuted: "#52525b",
  border: "#27272a",
  borderSubtle: "#1c1c20",
  accent: "#22c55e",
  accentDim: "rgba(34,197,94,0.12)",
  red: "#ef4444",
  redDim: "rgba(239,68,68,0.1)",
  yellow: "#eab308",
  yellowDim: "rgba(234,179,8,0.1)",
  blue: "#3b82f6",
  blueDim: "rgba(59,130,246,0.12)",
  purple: "#a78bfa",
  purpleDim: "rgba(167,139,250,0.12)",
  radius: 12,
};

const SEV_COLORS: Record<string, string> = { P0: T.red, P1: T.red, P2: T.yellow, P3: T.textMuted, P4: "#3f3f46" };
const SEV_BG: Record<string, string> = { P0: T.redDim, P1: T.redDim, P2: T.yellowDim, P3: "rgba(82,82,91,0.1)", P4: "rgba(63,63,70,0.06)" };
const CAT_ICONS: Record<string, string> = { functional: "⚡", performance: "⏱", responsive: "📱", accessibility: "♿", security: "🔒", visual: "👁" };

/* ─── Main ─── */

export default function ScanResultPage() {
  const params = useParams();
  const scanId = params.id as string;
  const [data, setData] = useState<ScanResult | null>(null);
  const [polling, setPolling] = useState(true);

  const [liveNodes, setLiveNodes] = useState<Map<string, LiveNode>>(new Map());
  const [liveEdges, setLiveEdges] = useState<Array<{ from: string; to: string }>>([]);
  const [liveFlowSteps, setLiveFlowSteps] = useState<LiveFlowStep[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [counters, setCounters] = useState({ pages: 0, elements: 0, bugs: 0, actions: 0, flows: 0 });
  const logIdRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const addLog = useCallback((text: string, type: LogEntry["type"] = "info") => {
    logIdRef.current += 1;
    setLogEntries(prev => [...prev.slice(-150), { id: logIdRef.current, text, type, timestamp: Date.now() }]);
  }, []);

  useEffect(() => {
    if (!scanId) return;
    const es = new EventSource(`${API_URL}/api/v1/scan/${scanId}/stream`);
    eventSourceRef.current = es;

    es.addEventListener("page_discovered", (e) => {
      const d = JSON.parse(e.data);
      setLiveNodes(prev => { const next = new Map(prev); if (!next.has(d.url)) next.set(d.url, { url: d.url, depth: d.depth ?? 0, status: "discovered", from: d.from ?? null, bugs: 0, elements: 0, via: d.via }); return next; });
      if (d.from) setLiveEdges(prev => [...prev, { from: d.from, to: d.url }]);
      addLog(`Discovered ${shortUrl(d.url)}${d.via ? ` via ${d.via}` : ""}`, "discovery");
    });
    es.addEventListener("visiting_page", (e) => {
      const d = JSON.parse(e.data);
      setLiveNodes(prev => { const next = new Map(prev); const n = next.get(d.url); if (n) n.status = "visiting"; return next; });
      setCounters(c => ({ ...c, pages: d.page_number ?? c.pages }));
      addLog(`Visiting ${shortUrl(d.url)}`, "info");
    });
    es.addEventListener("elements_found", (e) => {
      const d = JSON.parse(e.data);
      setCounters(c => ({ ...c, elements: c.elements + (d.total ?? 0) }));
    });
    es.addEventListener("action", (e) => {
      const d = JSON.parse(e.data);
      setCounters(c => ({ ...c, actions: c.actions + 1 }));
      addLog(`${d.action}: "${d.target}"`, "action");
    });
    es.addEventListener("bug_found", (e) => {
      const d = JSON.parse(e.data);
      setCounters(c => ({ ...c, bugs: c.bugs + 1 }));
      setLiveNodes(prev => { const next = new Map(prev); const n = next.get(d.page); if (n) n.bugs += 1; return next; });
      addLog(`${d.severity} ${d.title}`, "bug");
    });
    es.addEventListener("page_complete", (e) => {
      const d = JSON.parse(e.data);
      setLiveNodes(prev => { const next = new Map(prev); const n = next.get(d.url); if (n) n.status = d.status === "failed" ? "failed" : "visited"; return next; });
    });
    es.addEventListener("flow_step", (e) => {
      const d = JSON.parse(e.data);
      setLiveFlowSteps(prev => [...prev, { flow: d.flow, stepIndex: d.step_index, action: d.step_action, target: d.step_target, status: "running" }]);
      addLog(`Flow "${d.flow}" → ${d.step_action}: ${d.step_target}`, "flow");
    });
    es.addEventListener("flow_complete", (e) => {
      const d = JSON.parse(e.data);
      setCounters(c => ({ ...c, flows: c.flows + 1 }));
      const icon = d.status === "passed" ? "✓" : d.status === "failed" ? "✗" : "~";
      addLog(`${icon} Flow "${d.flow}" ${d.status.toUpperCase()} (${d.duration_ms}ms)`, "flow");
    });
    es.addEventListener("auth_attempted", (e) => {
      const d = JSON.parse(e.data);
      addLog(`Auth: ${d.success ? "SUCCESS" : "FAILED"} — ${d.message}`, "auth");
    });
    es.addEventListener("popup_dismissed", (e) => {
      const d = JSON.parse(e.data);
      addLog(`Dismissed: ${(d.types || []).join(", ")}`, "action");
    });
    es.addEventListener("state_errors", (e) => {
      const d = JSON.parse(e.data);
      for (const err of (d.js_errors || []).slice(0, 2)) addLog(`JS Error: ${err}`, "bug");
    });
    es.addEventListener("scan_complete", (e) => { const d = JSON.parse(e.data); addLog(`Scan complete: ${d.pages} pages, ${d.bugs} bugs`, "complete"); es.close(); });
    es.addEventListener("scan_failed", (e) => { const d = JSON.parse(e.data); addLog(`Scan failed: ${d.error}`, "bug"); es.close(); });
    es.onerror = () => es.close();
    return () => { es.close(); eventSourceRef.current = null; };
  }, [scanId, addLog]);

  useEffect(() => {
    if (!scanId) return;
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/scan/${scanId}`);
        const json = await res.json();
        setData(json);
        if (json.status === "completed" || json.status === "failed") {
          setPolling(false);
          eventSourceRef.current?.close();
        }
      } catch {}
    };
    poll();
    if (polling) { const iv = setInterval(poll, 3000); return () => clearInterval(iv); }
  }, [scanId, polling]);

  const isRunning = !data || data.status === "running";

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>
      <header style={{ padding: "16px 0", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <a href="/" style={{ fontFamily: "'Instrument Serif', serif", fontSize: 22, color: T.text, textDecoration: "none", letterSpacing: "-0.02em" }}>FlowLens</a>
          <a href="/" style={{ fontSize: 11, color: T.textMuted, textDecoration: "none", letterSpacing: "0.05em" }}>NEW SCAN</a>
        </div>
      </header>

      <main style={{ maxWidth: 960, margin: "0 auto", padding: "0 24px" }}>
        {!data ? <Loading /> :
          data.status === "failed" ? <Failed url={data.url} error={data.errors?.[0]} /> :
          isRunning ? <LiveView url={data.url} nodes={liveNodes} edges={liveEdges} flowSteps={liveFlowSteps} log={logEntries} counters={counters} /> :
          <Report data={data} />
        }
      </main>

      <style jsx global>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
      `}</style>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   LIVE SCAN VIEW
   ═══════════════════════════════════════════════════════════ */

function LiveView({ url, nodes, edges, flowSteps, log, counters }: {
  url: string; nodes: Map<string, LiveNode>; edges: Array<{ from: string; to: string }>;
  flowSteps: LiveFlowStep[]; log: LogEntry[];
  counters: { pages: number; elements: number; bugs: number; actions: number; flows: number };
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);
  const nodeArray = Array.from(nodes.values());

  return (
    <div style={{ padding: "48px 0 80px" }}>
      <Label>Live Scan</Label>
      <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 32, fontWeight: 400, marginBottom: 6, letterSpacing: "-0.02em" }}>{shortUrl(url)}</h1>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 40 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.accent, animation: "pulse 1.5s infinite" }} />
        <span style={{ fontSize: 11, color: T.accent, letterSpacing: "0.08em" }}>SCANNING</span>
      </div>

      {/* Counters */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 1, background: T.border, borderRadius: T.radius, overflow: "hidden", marginBottom: 32 }}>
        {([
          { label: "Pages", value: counters.pages, color: T.text },
          { label: "Elements", value: counters.elements, color: T.textSecondary },
          { label: "Actions", value: counters.actions, color: T.textSecondary },
          { label: "Flows", value: counters.flows, color: T.blue },
          { label: "Bugs", value: counters.bugs, color: counters.bugs > 0 ? T.red : T.accent },
        ]).map(c => (
          <div key={c.label} style={{ background: T.card, padding: "20px 16px", textAlign: "center" }}>
            <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 32, color: c.color, lineHeight: 1 }}>{c.value}</div>
            <div style={{ fontSize: 10, color: T.textMuted, letterSpacing: "0.08em", marginTop: 6 }}>{c.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      {/* Live flow execution */}
      {flowSteps.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <Label>Flow Execution</Label>
          <LiveFlowTimeline steps={flowSteps} />
        </div>
      )}

      {/* Graph + Log side by side */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 20, alignItems: "start" }}>
        <Card>
          <Label style={{ marginBottom: 16 }}>Site Graph · {nodeArray.length} pages</Label>
          <LiveGraph nodes={nodeArray} />
        </Card>
        <Card style={{ display: "flex", flexDirection: "column", maxHeight: 460 }}>
          <Label style={{ padding: "0 0 12px", borderBottom: `1px solid ${T.borderSubtle}` }}>Activity</Label>
          <div ref={logRef} style={{ flex: 1, overflowY: "auto", paddingTop: 8 }}>
            <AnimatePresence>
              {log.map(entry => (
                <motion.div key={entry.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  style={{ padding: "4px 0", fontSize: 11, display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: logColor(entry.type), flexShrink: 0, width: 12, textAlign: "center" }}>{logIcon(entry.type)}</span>
                  <span style={{ color: entry.type === "bug" ? T.red : entry.type === "flow" ? T.blue : T.textSecondary, lineHeight: 1.5 }}>{entry.text}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </Card>
      </div>
    </div>
  );
}

function LiveFlowTimeline({ steps }: { steps: LiveFlowStep[] }) {
  const flowGroups: Record<string, LiveFlowStep[]> = {};
  for (const s of steps) {
    if (!flowGroups[s.flow]) flowGroups[s.flow] = [];
    flowGroups[s.flow].push(s);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {Object.entries(flowGroups).map(([name, fSteps]) => (
        <Card key={name} style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={{ color: T.blue, fontSize: 12 }}>▶</span>
            <span style={{ color: T.text, fontSize: 13, fontWeight: 500 }}>{name}</span>
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
            {fSteps.map((s, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {i > 0 && <div style={{ width: 20, height: 1, background: T.border }} />}
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 8,
                    background: s.status === "passed" ? T.accentDim : s.status === "failed" ? T.redDim : T.blueDim,
                    border: `1px solid ${s.status === "passed" ? "rgba(34,197,94,0.3)" : s.status === "failed" ? "rgba(239,68,68,0.3)" : "rgba(59,130,246,0.3)"}`,
                    fontSize: 10,
                    color: s.status === "passed" ? T.accent : s.status === "failed" ? T.red : T.blue,
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.action}: {s.target.substring(0, 20)}
                </motion.div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function LiveGraph({ nodes }: { nodes: LiveNode[] }) {
  if (nodes.length === 0) return <div style={{ textAlign: "center", padding: 40, color: T.textMuted }}>Waiting for pages...</div>;
  const depths = new Map<number, LiveNode[]>();
  for (const n of nodes) { if (!depths.has(n.depth)) depths.set(n.depth, []); depths.get(n.depth)!.push(n); }
  return (
    <div>
      {[...depths.keys()].sort((a, b) => a - b).map(depth => (
        <div key={depth}>
          {depth > 0 && <div style={{ display: "flex", justifyContent: "center", padding: "3px 0" }}><div style={{ width: 1, height: 12, background: T.border }} /></div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", padding: "3px 0" }}>
            {depths.get(depth)!.map(node => (
              <motion.div key={node.url} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 25 }}
                style={{ padding: "5px 10px", borderRadius: 6, background: statusBg(node.status, node.bugs), border: `1px solid ${statusBorder(node.status, node.bugs)}`, maxWidth: 140 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 5, height: 5, borderRadius: "50%", background: statusDot(node.status, node.bugs) }} />
                  <span style={{ fontSize: 10, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortPath(node.url)}</span>
                </div>
                {node.bugs > 0 && <span style={{ fontSize: 9, color: T.red, marginTop: 2, display: "block" }}>{node.bugs} bug{node.bugs > 1 ? "s" : ""}</span>}
              </motion.div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   COMPLETED REPORT — one continuous scroll, no tabs
   ═══════════════════════════════════════════════════════════ */

function Report({ data }: { data: ScanResult }) {
  const score = data.health_score ?? 0;
  const sColor = score >= 80 ? T.accent : score >= 60 ? T.yellow : T.red;
  const flows = data.flows || [];
  const passedFlows = flows.filter(f => f.status === "passed").length;
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [expandedBug, setExpandedBug] = useState<string | null>(null);

  return (
    <div style={{ padding: "48px 0 80px" }}>
      {/* ── Header ── */}
      <Label>Scan Report</Label>
      <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 32, fontWeight: 400, marginBottom: 6, letterSpacing: "-0.02em" }}>{shortUrl(data.url)}</h1>
      <p style={{ color: T.textMuted, fontSize: 12, marginBottom: 36 }}>
        {new Date(data.started_at).toLocaleString()} · {data.duration_seconds ? `${Math.round(data.duration_seconds)}s` : ""}
      </p>

      {/* ── Stat Cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 48 }}>
        <StatCard value={score} label="Health" sub={score >= 80 ? "Healthy" : score >= 60 ? "Needs work" : "Critical"} color={sColor} ring ringMax={100} />
        <StatCard value={data.pages_tested} label="Pages" sub="explored" />
        {flows.length > 0 && <StatCard value={`${passedFlows}/${flows.length}`} label="Flows" sub="passed" color={passedFlows === flows.length ? T.accent : T.text} />}
        <StatCard value={data.bugs.length} label="Issues" sub="found" color={data.bugs.length > 0 ? T.red : T.accent} />
      </div>

      {/* ── Section: Flow Results ── */}
      {flows.length > 0 && (
        <section style={{ marginBottom: 56 }}>
          <SectionHeader title="Flow Results" subtitle={`${flows.length} user journeys tested`} />
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {flows.map((fr, fi) => (
              <FlowJourney key={fi} result={fr} expandedStep={expandedStep} setExpandedStep={setExpandedStep} />
            ))}
          </div>
        </section>
      )}

      {/* ── Section: Issues Found ── */}
      {data.bugs.length > 0 && (
        <section style={{ marginBottom: 56 }}>
          <SectionHeader title="Issues Found" subtitle={`${data.bugs.length} issues across ${data.pages_tested} pages`} />
          <IssuesList bugs={data.bugs} expandedBug={expandedBug} setExpandedBug={setExpandedBug} />
        </section>
      )}
      {data.bugs.length === 0 && (
        <section style={{ marginBottom: 56 }}>
          <SectionHeader title="Issues" subtitle="" />
          <Card style={{ padding: "48px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 24, marginBottom: 8, color: T.accent }}>✓</div>
            <p style={{ color: T.accent, fontSize: 14 }}>No issues found. Your site is looking healthy.</p>
          </Card>
        </section>
      )}

      {/* ── Section: Performance ── */}
      {data.metrics.length > 0 && (
        <section style={{ marginBottom: 56 }}>
          <SectionHeader title="Performance" subtitle={`${data.metrics.length} pages measured`} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
            {data.metrics.map((m, i) => <PerfCard key={i} metric={m} />)}
          </div>
        </section>
      )}

      {/* ── Section: Site Map ── */}
      {data.site_graph && data.site_graph.nodes.length > 0 && (
        <section style={{ marginBottom: 56 }}>
          <SectionHeader title="Site Map" subtitle={`${data.site_graph.nodes.length} pages · ${data.site_graph.edges.length} connections`} />
          <Card style={{ padding: 24 }}>
            <SiteMapGrid graph={data.site_graph} />
          </Card>
        </section>
      )}
    </div>
  );
}

/* ── Flow Journey ── */

function FlowJourney({ result, expandedStep, setExpandedStep }: {
  result: FlowResult; expandedStep: string | null; setExpandedStep: (k: string | null) => void;
}) {
  const fr = result;
  const statusColor = fr.status === "passed" ? T.accent : fr.status === "failed" ? T.red : T.yellow;
  const statusIcon = fr.status === "passed" ? "✓" : fr.status === "failed" ? "✗" : "~";

  return (
    <Card>
      {/* Flow header */}
      <div style={{ padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${T.borderSubtle}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, background: `${statusColor}18`, color: statusColor, fontWeight: 600 }}>{statusIcon}</span>
          <span style={{ fontSize: 14, fontWeight: 500, color: T.text }}>{fr.flow.name}</span>
          <Pill color={statusColor}>{fr.status}</Pill>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 11, color: T.textMuted }}>
          <span>{fr.duration_ms}ms</span>
          <span>{fr.steps.length} steps</span>
        </div>
      </div>

      {/* Visual journey pipeline */}
      <div style={{ padding: "20px 20px 8px", overflowX: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 0, minWidth: "min-content" }}>
          {fr.steps.map((sr, si) => {
            const key = `${fr.flow.name}-${si}`;
            const isExpanded = expandedStep === key;
            const stepColor = sr.status === "passed" ? T.accent : sr.status === "failed" ? T.red : T.textMuted;
            const stepBg = sr.status === "passed" ? T.accentDim : sr.status === "failed" ? T.redDim : "rgba(82,82,91,0.08)";
            const isAI = sr.ai_used && sr.ai_used !== "Heuristic" && sr.ai_used !== "not_found";

            return (
              <div key={si} style={{ display: "flex", alignItems: "center" }}>
                {si > 0 && (
                  <svg width="28" height="2" style={{ flexShrink: 0 }}>
                    <line x1="0" y1="1" x2="28" y2="1" stroke={sr.status === "passed" || fr.steps[si - 1]?.status === "passed" ? T.accent : T.border} strokeWidth="1.5" />
                  </svg>
                )}
                <div
                  onClick={() => setExpandedStep(isExpanded ? null : key)}
                  style={{
                    cursor: "pointer",
                    padding: "10px 16px",
                    borderRadius: 10,
                    background: stepBg,
                    border: `1px solid ${stepColor}30`,
                    minWidth: 100,
                    textAlign: "center",
                    transition: "transform 0.15s, box-shadow 0.15s",
                    transform: isExpanded ? "scale(1.04)" : "scale(1)",
                    boxShadow: isExpanded ? `0 0 0 2px ${stepColor}40` : "none",
                    flexShrink: 0,
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 600, color: stepColor, marginBottom: 4, textTransform: "capitalize" }}>
                    {sr.step.action}
                  </div>
                  <div style={{ fontSize: 10, color: T.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>
                    {sr.step.target || "—"}
                  </div>
                  {isAI && (
                    <div style={{ marginTop: 4, fontSize: 9, color: T.purple, background: T.purpleDim, padding: "1px 6px", borderRadius: 4, display: "inline-block" }}>AI</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Expanded step detail */}
      <AnimatePresence>
        {fr.steps.map((sr, si) => {
          const key = `${fr.flow.name}-${si}`;
          if (expandedStep !== key) return null;
          return (
            <motion.div key={key} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              style={{ borderTop: `1px solid ${T.borderSubtle}`, overflow: "hidden" }}>
              <div style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: sr.screenshot_b64 ? "1fr 1fr" : "1fr", gap: 20 }}>
                <div>
                  <div style={{ marginBottom: 12 }}>
                    <span style={{ color: T.textMuted, fontSize: 10, letterSpacing: "0.08em" }}>ACTION</span>
                    <p style={{ color: T.text, fontSize: 13, marginTop: 4 }}>{sr.step.action}: {sr.step.target}</p>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <span style={{ color: T.textMuted, fontSize: 10, letterSpacing: "0.08em" }}>URL</span>
                    <p style={{ color: T.textSecondary, fontSize: 11, marginTop: 4, wordBreak: "break-all" }}>{sr.actual_url}</p>
                  </div>
                  {sr.ai_used && sr.ai_used !== "Heuristic" && (
                    <div style={{ marginBottom: 12 }}>
                      <span style={{ color: T.textMuted, fontSize: 10, letterSpacing: "0.08em" }}>METHOD</span>
                      <p style={{ color: T.purple, fontSize: 11, marginTop: 4 }}>{sr.ai_used}</p>
                    </div>
                  )}
                  {sr.error && (
                    <div style={{ marginBottom: 12 }}>
                      <span style={{ color: T.textMuted, fontSize: 10, letterSpacing: "0.08em" }}>RESULT</span>
                      <p style={{ color: sr.status === "failed" ? T.red : T.accent, fontSize: 11, marginTop: 4 }}>{sr.error}</p>
                    </div>
                  )}
                  {sr.state_changes && (sr.state_changes.cookies_set?.length || sr.state_changes.js_errors?.length) ? (
                    <div>
                      <span style={{ color: T.textMuted, fontSize: 10, letterSpacing: "0.08em" }}>STATE CHANGES</span>
                      <div style={{ marginTop: 4 }}>
                        {sr.state_changes.cookies_set?.map((c, i) => <Pill key={i} color={T.accent} style={{ marginRight: 4, marginBottom: 4 }}>Cookie: {c}</Pill>)}
                        {sr.state_changes.js_errors?.map((e, i) => <Pill key={`e${i}`} color={T.red} style={{ marginRight: 4, marginBottom: 4 }}>JS: {e.substring(0, 40)}</Pill>)}
                      </div>
                    </div>
                  ) : null}
                </div>
                {sr.screenshot_b64 && (
                  <div>
                    <span style={{ color: T.textMuted, fontSize: 10, letterSpacing: "0.08em" }}>SCREENSHOT</span>
                    <img src={`data:image/jpeg;base64,${sr.screenshot_b64}`} alt={`Step ${si + 1}`}
                      style={{ width: "100%", borderRadius: 8, border: `1px solid ${T.borderSubtle}`, marginTop: 4 }} />
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </Card>
  );
}

/* ── Issues List ── */

function IssuesList({ bugs, expandedBug, setExpandedBug }: {
  bugs: Bug[]; expandedBug: string | null; setExpandedBug: (k: string | null) => void;
}) {
  const sevOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
  const sorted = [...bugs].sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));

  return (
    <Card>
      {sorted.map((bug, i) => {
        const key = `bug-${i}`;
        const isExpanded = expandedBug === key;
        return (
          <div key={key}>
            <div
              onClick={() => setExpandedBug(isExpanded ? null : key)}
              style={{
                padding: "14px 20px",
                display: "flex", alignItems: "center", gap: 12,
                borderBottom: `1px solid ${T.borderSubtle}`,
                cursor: "pointer",
                transition: "background 0.1s",
              }}
            >
              <Pill color={SEV_COLORS[bug.severity]} style={{ fontWeight: 700, minWidth: 32, textAlign: "center" }}>{bug.severity}</Pill>
              <span style={{ fontSize: 14, marginRight: 4 }}>{CAT_ICONS[bug.category] || "●"}</span>
              <span style={{ flex: 1, fontSize: 12, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bug.title}</span>
              <span style={{ fontSize: 10, color: T.textMuted, textTransform: "uppercase", flexShrink: 0 }}>{bug.viewport}</span>
              <span style={{ color: T.textMuted, fontSize: 14, flexShrink: 0 }}>{isExpanded ? "−" : "+"}</span>
            </div>

            <AnimatePresence>
              {isExpanded && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  style={{ overflow: "hidden", borderBottom: `1px solid ${T.borderSubtle}` }}>
                  <div style={{ padding: "16px 20px 20px 64px" }}>
                    {bug.description && <p style={{ color: T.textSecondary, fontSize: 12, lineHeight: 1.7, marginBottom: 16, maxWidth: 600 }}>{bug.description}</p>}
                    <div style={{ marginBottom: 12 }}>
                      <span style={{ color: T.textMuted, fontSize: 10, letterSpacing: "0.08em" }}>PAGE</span>
                      <p style={{ color: T.textSecondary, fontSize: 11, marginTop: 4, wordBreak: "break-all" }}>{bug.page_url}</p>
                    </div>
                    {bug.repro_steps && bug.repro_steps.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <span style={{ color: T.textMuted, fontSize: 10, letterSpacing: "0.08em" }}>REPRO STEPS</span>
                        <div style={{ background: T.bgAlt, borderRadius: 8, padding: "10px 14px", marginTop: 4 }}>
                          {bug.repro_steps.map((s, si) => (
                            <div key={si} style={{ display: "flex", gap: 8, padding: "3px 0", color: T.textSecondary, fontSize: 11 }}>
                              <span style={{ color: T.textMuted }}>{si + 1}.</span><span>{s}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {bug.screenshot_b64 && <img src={`data:image/jpeg;base64,${bug.screenshot_b64}`} alt={bug.title} style={{ maxWidth: "100%", maxHeight: 300, borderRadius: 8, border: `1px solid ${T.borderSubtle}` }} />}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </Card>
  );
}

/* ── Performance Card ── */

function PerfCard({ metric: m }: { metric: Metric }) {
  const loadColor = m.load_time_ms > 5000 ? T.red : m.load_time_ms > 3000 ? T.yellow : T.accent;
  return (
    <Card style={{ padding: 20 }}>
      <p style={{ color: T.textMuted, fontSize: 10, letterSpacing: "0.06em", marginBottom: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {shortUrl(m.url)} · {m.viewport}
      </p>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: loadColor }}>{m.load_time_ms}<span style={{ fontSize: 11, color: T.textMuted }}>ms</span></div>
          <div style={{ fontSize: 10, color: T.textMuted }}>LOAD</div>
        </div>
        {m.fcp_ms != null && (
          <div>
            <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: m.fcp_ms > 3000 ? T.red : m.fcp_ms > 1800 ? T.yellow : T.accent }}>{m.fcp_ms}<span style={{ fontSize: 11, color: T.textMuted }}>ms</span></div>
            <div style={{ fontSize: 10, color: T.textMuted }}>FCP</div>
          </div>
        )}
        <div>
          <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: m.dom_node_count > 3000 ? T.red : m.dom_node_count > 1500 ? T.yellow : T.textSecondary }}>{m.dom_node_count}</div>
          <div style={{ fontSize: 10, color: T.textMuted }}>DOM</div>
        </div>
      </div>
    </Card>
  );
}

/* ── Site Map Grid ── */

function SiteMapGrid({ graph }: { graph: SiteGraph }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
      {graph.nodes.map(node => {
        const hasBugs = node.bugs > 0;
        const bg = hasBugs ? T.redDim : T.accentDim;
        const border = hasBugs ? "rgba(239,68,68,0.25)" : "rgba(34,197,94,0.2)";
        const dot = hasBugs ? T.red : T.accent;
        return (
          <div key={node.id} style={{ padding: "10px 14px", borderRadius: 8, background: bg, border: `1px solid ${border}` }} title={node.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: dot, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.label || shortPath(node.id)}</span>
            </div>
            <p style={{ fontSize: 10, color: T.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortPath(node.path || node.id)}</p>
            {hasBugs && <Pill color={T.red} style={{ marginTop: 6, fontSize: 9 }}>{node.bugs} bug{node.bugs > 1 ? "s" : ""}</Pill>}
          </div>
        );
      })}
    </div>
  );
}

/* ── Stat Card ── */

function StatCard({ value, label, sub, color, ring, ringMax }: {
  value: string | number; label: string; sub?: string; color?: string; ring?: boolean; ringMax?: number;
}) {
  const c = color || T.text;
  return (
    <Card style={{ padding: "24px 20px", textAlign: "center", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      {ring && typeof value === "number" && ringMax ? (
        <div style={{
          width: 80, height: 80, borderRadius: "50%", margin: "0 auto 10px",
          background: `conic-gradient(${c} ${(value / ringMax) * 360}deg, ${T.borderSubtle} ${(value / ringMax) * 360}deg)`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: T.card, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: c }}>{value}</span>
          </div>
        </div>
      ) : (
        <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 36, color: c, lineHeight: 1, marginBottom: 6 }}>{value}</div>
      )}
      <div style={{ fontSize: 10, color: T.textMuted, letterSpacing: "0.08em" }}>{label.toUpperCase()}</div>
      {sub && <div style={{ fontSize: 10, color: c === T.text ? T.textMuted : c, marginTop: 2, opacity: 0.7 }}>{sub}</div>}
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════
   SHARED COMPONENTS & HELPERS
   ═══════════════════════════════════════════════════════════ */

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.cardBorder}`, borderRadius: T.radius, overflow: "hidden", ...style }}>
      {children}
    </div>
  );
}

function Label({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <p style={{ fontSize: 10, letterSpacing: "0.1em", color: T.textMuted, marginBottom: 8, ...style }}>{typeof children === "string" ? children.toUpperCase() : children}</p>;
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 22, fontWeight: 400, color: T.text, letterSpacing: "-0.01em" }}>{title}</h2>
      {subtitle && <p style={{ color: T.textMuted, fontSize: 12, marginTop: 4 }}>{subtitle}</p>}
    </div>
  );
}

function Pill({ children, color, style }: { children: React.ReactNode; color: string; style?: React.CSSProperties }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", fontSize: 10, letterSpacing: "0.04em",
      background: `${color}18`, color, borderRadius: 4, ...style,
    }}>
      {children}
    </span>
  );
}

function Loading() {
  return (
    <div style={{ textAlign: "center", padding: "120px 0" }}>
      <div style={{ width: 32, height: 32, border: `2px solid ${T.border}`, borderTopColor: T.text, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto" }} />
      <p style={{ color: T.textMuted, marginTop: 20, fontSize: 12 }}>Connecting...</p>
    </div>
  );
}

function Failed({ url, error }: { url: string; error?: string }) {
  return (
    <div style={{ textAlign: "center", padding: "120px 0" }}>
      <div style={{ fontSize: 36, color: T.red, marginBottom: 16 }}>✕</div>
      <h2 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 24, fontWeight: 400, marginBottom: 8 }}>Scan Failed</h2>
      <p style={{ color: T.textMuted, fontSize: 12 }}>{url}</p>
      {error && <p style={{ color: T.red, fontSize: 12, marginTop: 12, maxWidth: 400, margin: "12px auto 0" }}>{error}</p>}
      <a href="/" style={{ display: "inline-block", marginTop: 32, padding: "12px 28px", background: T.text, color: T.bg, fontSize: 11, letterSpacing: "0.08em", textDecoration: "none", borderRadius: 8 }}>TRY AGAIN</a>
    </div>
  );
}

function shortUrl(u: string) { const s = u.replace(/^https?:\/\//, ""); return s.length > 50 ? s.slice(0, 47) + "..." : s; }
function shortPath(urlOrPath: string) {
  let p = urlOrPath;
  try { p = new URL(urlOrPath).pathname; } catch { p = p.replace(/^https?:\/\//, ""); const i = p.indexOf("/"); p = i >= 0 ? p.substring(i) : "/"; }
  if (p === "/" || !p) return "/";
  return p.length > 28 ? p.slice(0, 25) + "..." : p;
}

function statusBg(status: string, bugs: number) {
  if (bugs > 0) return T.redDim;
  if (status === "visiting") return T.blueDim;
  if (status === "visited") return T.accentDim;
  if (status === "failed") return T.redDim;
  return "rgba(82,82,91,0.06)";
}
function statusBorder(status: string, bugs: number) {
  if (bugs > 0) return "rgba(239,68,68,0.25)";
  if (status === "visiting") return "rgba(59,130,246,0.3)";
  if (status === "visited") return "rgba(34,197,94,0.2)";
  if (status === "failed") return "rgba(239,68,68,0.25)";
  return T.borderSubtle;
}
function statusDot(status: string, bugs: number) {
  if (bugs > 0) return T.red;
  if (status === "visiting") return T.blue;
  if (status === "visited") return T.accent;
  if (status === "failed") return T.red;
  return T.textMuted;
}
function logColor(type: LogEntry["type"]) {
  switch (type) { case "bug": return T.red; case "discovery": return T.blue; case "action": return T.yellow; case "complete": return T.accent; case "flow": return T.blue; case "auth": return T.purple; default: return T.textMuted; }
}
function logIcon(type: LogEntry["type"]) {
  switch (type) { case "bug": return "●"; case "discovery": return "→"; case "action": return "▸"; case "complete": return "✓"; case "flow": return "◆"; case "auth": return "🔑"; default: return "·"; }
}
