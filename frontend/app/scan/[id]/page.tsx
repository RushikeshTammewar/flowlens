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
  ai_used: boolean;
}

interface FlowResult {
  flow: { name: string; priority: number; steps: FlowStepDef[] };
  status: "passed" | "failed" | "partial";
  steps: FlowStepResult[];
  duration_ms: number;
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

interface LogEntry {
  id: number;
  text: string;
  type: "info" | "action" | "discovery" | "bug" | "complete";
  timestamp: number;
}

/* ─── Theme ─── */

interface Theme {
  key: string;
  label: string;
  isDark: boolean;
  bg: string;
  bgAlt: string;
  card: string;
  cardBorder: string;
  cardShadow: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderSubtle: string;
  accent: string;
  radius: number;
  codeBg: string;
  hoverBg: string;
}

const DARK: Theme = {
  key: "dark", label: "Dark", isDark: true,
  bg: "#0a0a0a", bgAlt: "#0f0f0f", card: "#141414",
  cardBorder: "#1e1e1e", cardShadow: "none",
  text: "#f0f0f0", textSecondary: "#a0a0a0", textMuted: "#555",
  border: "#2a2a2a", borderSubtle: "#1a1a1a", accent: "#1a5c2e",
  radius: 10, codeBg: "#0f0f0f", hoverBg: "rgba(255,255,255,0.02)",
};

const T = DARK;

const SEV_COLORS: Record<string, string> = { P0: "#ef4444", P1: "#ef4444", P2: "#f59e0b", P3: "#888", P4: "#555" };
const SEV_BG: Record<string, string> = { P0: "rgba(239,68,68,0.1)", P1: "rgba(239,68,68,0.08)", P2: "rgba(245,158,11,0.08)", P3: "rgba(136,136,136,0.06)", P4: "rgba(85,85,85,0.04)" };
const CAT_LABELS: Record<string, string> = { functional: "Functional", performance: "Performance", responsive: "Responsive", accessibility: "Accessibility", security: "Security", visual: "Visual" };
const CAT_ICONS: Record<string, string> = { functional: "⚡", performance: "⏱", responsive: "📱", accessibility: "♿", security: "🔒", visual: "👁" };

/* ─── Main Component ─── */

export default function ScanResultPage() {
  const params = useParams();
  const scanId = params.id as string;
  const [data, setData] = useState<ScanResult | null>(null);
  const [polling, setPolling] = useState(true);
  const [expandedBug, setExpandedBug] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"bugs" | "flows" | "flowmap" | "performance" | "pages">("bugs");
  const theme = T;

  const [liveNodes, setLiveNodes] = useState<Map<string, LiveNode>>(new Map());
  const [liveEdges, setLiveEdges] = useState<Array<{ from: string; to: string }>>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [counters, setCounters] = useState({ pages: 0, elements: 0, bugs: 0, actions: 0 });
  const logIdRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const t = theme;

  const addLog = useCallback((text: string, type: LogEntry["type"] = "info") => {
    logIdRef.current += 1;
    setLogEntries(prev => [...prev.slice(-100), { id: logIdRef.current, text, type, timestamp: Date.now() }]);
  }, []);

  useEffect(() => {
    if (!scanId) return;
    const es = new EventSource(`${API_URL}/api/v1/scan/${scanId}/stream`);
    eventSourceRef.current = es;

    es.addEventListener("page_discovered", (e) => {
      const d = JSON.parse(e.data);
      setLiveNodes(prev => { const next = new Map(prev); if (!next.has(d.url)) next.set(d.url, { url: d.url, depth: d.depth ?? 0, status: "discovered", from: d.from ?? null, bugs: 0, elements: 0, via: d.via }); return next; });
      if (d.from) setLiveEdges(prev => [...prev, { from: d.from, to: d.url }]);
      addLog(`Discovered ${shortUrl(d.url)}${d.via ? ` (via ${d.via})` : ""}`, "discovery");
    });
    es.addEventListener("visiting_page", (e) => {
      const d = JSON.parse(e.data);
      setLiveNodes(prev => { const next = new Map(prev); const n = next.get(d.url); if (n) n.status = "visiting"; return next; });
      setCounters(c => ({ ...c, pages: d.page_number ?? c.pages }));
      addLog(`Visiting ${shortUrl(d.url)} [${d.page_number}/${d.total_discovered}]`, "info");
    });
    es.addEventListener("elements_found", (e) => {
      const d = JSON.parse(e.data);
      setLiveNodes(prev => { const next = new Map(prev); const n = next.get(d.url); if (n) n.elements = d.total ?? 0; return next; });
      setCounters(c => ({ ...c, elements: c.elements + (d.total ?? 0) }));
      addLog(`Found ${d.total} elements`, "info");
    });
    es.addEventListener("action", (e) => {
      const d = JSON.parse(e.data);
      setCounters(c => ({ ...c, actions: c.actions + 1 }));
      const labels: Record<string, string> = { follow_link: "Following link", expand_menu: "Expanding menu", fill_form: "Filling form", search: "Testing search", click_button: "Clicking button" };
      addLog(`${labels[d.action] ?? d.action} "${d.target}"`, "action");
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
    es.addEventListener("scan_complete", (e) => { const d = JSON.parse(e.data); addLog(`Complete: ${d.pages} pages, ${d.bugs} bugs`, "complete"); es.close(); });
    es.addEventListener("scan_failed", (e) => { const d = JSON.parse(e.data); addLog(`Failed: ${d.error}`, "bug"); es.close(); });
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
  const isCompleted = data?.status === "completed";

  return (
    <div style={{ minHeight: "100vh", background: t.bg, color: t.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, transition: "background 0.3s, color 0.3s" }}>
      {/* Header */}
      <header style={{ padding: "16px 0", borderBottom: `1px solid ${t.border}` }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <a href="/" style={{ fontFamily: "'Instrument Serif', serif", fontSize: 24, color: t.text, textDecoration: "none" }}>FlowLens</a>
          <a href="/" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: t.textSecondary, textDecoration: "none" }}>← New Scan</a>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px" }}>
        {!data ? <ScanLoading t={t} /> :
          data.status === "failed" ? <ScanFailed url={data.url} error={data.errors?.[0]} t={t} /> :
          isRunning ? <LiveScanView url={data.url} nodes={liveNodes} edges={liveEdges} log={logEntries} counters={counters} t={t} /> :
          isCompleted ? <CompletedView data={data} activeTab={activeTab} setActiveTab={setActiveTab} expandedBug={expandedBug} setExpandedBug={setExpandedBug} t={t} /> : null}
      </main>

      <style jsx global>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes visitPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(59,130,246,0.5); } 50% { box-shadow: 0 0 0 6px rgba(59,130,246,0); } }
        @media (max-width: 640px) {
          .scan-counters, .stat-cards { flex-wrap: wrap !important; }
          .scan-counter-item, .stat-card { flex: 1 1 45% !important; min-width: 45% !important; padding: 14px 12px !important; }
          .scan-counter-value, .stat-value { font-size: 28px !important; }
          .scan-graph-log { grid-template-columns: 1fr !important; }
          .scan-bug-cat, .scan-bug-vp { display: none !important; }
          .scan-bug-detail { padding-left: 12px !important; }
          .scan-tabs button { padding: 12px 14px !important; font-size: 10px !important; }
          .scan-perf-grid { grid-template-columns: 1fr !important; }
          .scan-page-url { word-break: break-all; font-size: 12px !important; }
          .scan-flowmap-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)) !important; }
          .health-ring { width: 80px !important; height: 80px !important; }
        }
      `}</style>
    </div>
  );
}

/* ─── Live Scan View ─── */

function LiveScanView({ url, nodes, edges, log, counters, t }: {
  url: string; nodes: Map<string, LiveNode>; edges: Array<{ from: string; to: string }>;
  log: LogEntry[]; counters: { pages: number; elements: number; bugs: number; actions: number }; t: Theme;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);
  const nodeArray = Array.from(nodes.values());

  return (
    <div style={{ padding: "40px 0 80px" }}>
      <div style={{ marginBottom: 32 }}>
        <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: t.textMuted, marginBottom: 8 }}>Live Scan</p>
        <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: t.text, fontWeight: 400, marginBottom: 4 }}>{shortUrl(url)}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#28c840", display: "inline-block", animation: "pulse 1.5s infinite" }} />
          <span style={{ fontSize: 11, color: "#28c840", textTransform: "uppercase", letterSpacing: "0.1em" }}>Exploring</span>
        </div>
      </div>

      <div className="scan-counters" style={{ display: "flex", flexWrap: "wrap", gap: 1, marginBottom: 32, background: t.border, borderRadius: t.radius, overflow: "hidden" }}>
        {([
          { label: "Explored", value: counters.pages, color: t.text },
          { label: "Elements", value: counters.elements, color: t.textSecondary },
          { label: "Actions", value: counters.actions, color: t.textSecondary },
          { label: "Bugs", value: counters.bugs, color: counters.bugs > 0 ? "#ef4444" : "#28c840" },
        ]).map(c => (
          <div key={c.label} className="scan-counter-item" style={{ flex: 1, minWidth: 0, background: t.card, padding: "20px 24px", textAlign: "center" }}>
            <motion.p key={c.value} initial={{ scale: 1.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="scan-counter-value"
              style={{ fontFamily: "'Instrument Serif', serif", fontSize: 36, color: c.color, lineHeight: 1 }}>{c.value}</motion.p>
            <p style={{ fontSize: 10, color: t.textMuted, textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 6 }}>{c.label}</p>
          </div>
        ))}
      </div>

      <div className="scan-graph-log" style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24, alignItems: "start" }}>
        <div style={{ background: t.card, borderRadius: t.radius, border: `1px solid ${t.cardBorder}`, boxShadow: t.cardShadow, padding: 24, minHeight: 300 }}>
          <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: t.textMuted, marginBottom: 16 }}>
            Site Graph · {counters.pages} explored · {nodeArray.length} found
          </p>
          <LiveGraph nodes={nodeArray} t={t} />
        </div>
        <div style={{ background: t.card, borderRadius: t.radius, border: `1px solid ${t.cardBorder}`, boxShadow: t.cardShadow, display: "flex", flexDirection: "column", maxHeight: 500 }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${t.cardBorder}` }}>
            <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: t.textMuted }}>Activity Log</p>
          </div>
          <div ref={logRef} style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
            <AnimatePresence>
              {log.map(entry => (
                <motion.div key={entry.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                  style={{ padding: "5px 16px", fontSize: 11, display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: logColor(entry.type), flexShrink: 0 }}>{logIcon(entry.type)}</span>
                  <span style={{ color: entry.type === "bug" ? "#ef4444" : t.textSecondary }}>{entry.text}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveGraph({ nodes, t }: { nodes: LiveNode[]; t: Theme }) {
  if (nodes.length === 0) return <div style={{ textAlign: "center", padding: "60px 0", color: t.textMuted }}>Waiting for pages...</div>;
  const depths = new Map<number, LiveNode[]>();
  for (const n of nodes) { if (!depths.has(n.depth)) depths.set(n.depth, []); depths.get(n.depth)!.push(n); }
  return (
    <div>
      {[...depths.keys()].sort((a, b) => a - b).map(depth => (
        <div key={depth}>
          {depth > 0 && <div style={{ display: "flex", justifyContent: "center", padding: "4px 0" }}><div style={{ width: 1, height: 16, background: t.border }} /></div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", padding: "4px 0" }}>
            {depths.get(depth)!.map(node => (
              <motion.div key={node.url} initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 25 }}
                style={{ padding: "6px 12px", borderRadius: 6, background: nodeStatusBg(node), border: `1px solid ${nodeStatusBorder(node)}`, maxWidth: 160, overflow: "hidden", animation: node.status === "visiting" ? "visitPulse 1.5s infinite" : undefined }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 5, height: 5, borderRadius: "50%", background: nodeStatusDot(node), display: "inline-block", flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: t.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortPath(node.url)}</span>
                </div>
                {node.bugs > 0 && <span style={{ fontSize: 9, color: "#ef4444", display: "block", marginTop: 2 }}>{node.bugs} bug{node.bugs !== 1 ? "s" : ""}</span>}
              </motion.div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Completed View ─── */

function CompletedView({ data, activeTab, setActiveTab, expandedBug, setExpandedBug, t }: {
  data: ScanResult; activeTab: string; setActiveTab: (t: "bugs" | "flows" | "flowmap" | "performance" | "pages") => void;
  expandedBug: string | null; setExpandedBug: (i: string | null) => void; t: Theme;
}) {
  const score = data.health_score ?? 0;
  const sColor = score >= 80 ? "#28c840" : score >= 60 ? "#f59e0b" : "#ef4444";
  const sLabel = score >= 80 ? "Healthy" : score >= 60 ? "Needs Work" : "Critical";

  return (
    <>
      {/* Hero: URL + stat cards */}
      <section style={{ padding: "40px 0 32px" }}>
        <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: t.textMuted, marginBottom: 8 }}>Scan Report</p>
        <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: t.text, fontWeight: 400, marginBottom: 4 }}>{shortUrl(data.url)}</h1>
        <p style={{ color: t.textMuted, fontSize: 12, marginBottom: 28 }}>
          {new Date(data.started_at).toLocaleString()} · {data.duration_seconds ? `${Math.round(data.duration_seconds)}s` : ""}
        </p>

        {/* Stat cards */}
        <div className="stat-cards" style={{ display: "flex", gap: 12, marginBottom: 24 }}>
          {/* Health ring card */}
          <div className="stat-card" style={{ flex: 1, background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: t.radius, boxShadow: t.cardShadow, padding: "24px 20px", textAlign: "center" }}>
            <div className="health-ring" style={{
              width: 96, height: 96, borderRadius: "50%", margin: "0 auto 12px",
              background: `conic-gradient(${sColor} ${score * 3.6}deg, ${t.borderSubtle} ${score * 3.6}deg)`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <div style={{ width: 76, height: 76, borderRadius: "50%", background: t.card, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span className="stat-value" style={{ fontFamily: "'Instrument Serif', serif", fontSize: 32, color: sColor, lineHeight: 1 }}>{score}</span>
              </div>
            </div>
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: sColor, padding: "3px 10px", background: `${sColor}15`, borderRadius: 4 }}>{sLabel}</span>
          </div>

          {(() => {
            const statItems: Array<{ value: string | number; label: string; sub?: string; color?: string }> = [
              { value: data.pages_tested, label: "Pages", sub: "explored" },
              { value: data.bugs.length, label: "Bugs", sub: "found", color: data.bugs.length > 0 ? "#ef4444" : "#28c840" },
            ];
            if (data.flows && data.flows.length > 0) {
              const passed = data.flows.filter(f => f.status === "passed").length;
              statItems.push({ value: `${passed}/${data.flows.length}`, label: "Flows", sub: "passed", color: passed === data.flows.length ? "#28c840" : t.text });
            }
            statItems.push({ value: data.duration_seconds ? `${Math.round(data.duration_seconds)}s` : "—", label: "Duration", sub: "" });
            return statItems.map((s, i) => (
              <div key={s.label + i} className="stat-card" style={{ flex: 1, background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: t.radius, boxShadow: t.cardShadow, padding: "24px 20px", textAlign: "center", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <p className="stat-value" style={{ fontFamily: "'Instrument Serif', serif", fontSize: 36, color: s.color || t.text, lineHeight: 1, marginBottom: 6 }}>{s.value}</p>
                <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: t.textMuted }}>{s.label}</p>
                {s.sub && <p style={{ fontSize: 10, color: t.textMuted, marginTop: 2 }}>{s.sub}</p>}
              </div>
            ));
          })()}
        </div>

        {/* Severity + category chips */}
        {data.bug_summary && data.bug_summary.total > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(data.bug_summary.by_severity || {}).sort().map(([sev, count]) => (
              <span key={sev} style={{ padding: "4px 12px", background: SEV_BG[sev], color: SEV_COLORS[sev], fontSize: 11, borderRadius: 6 }}>
                {count} {sev}
              </span>
            ))}
            <span style={{ padding: "4px 12px", background: t.hoverBg, color: t.textMuted, fontSize: 11, borderRadius: 6, marginLeft: 4 }}>
              {Object.entries(data.bug_summary.by_category || {}).map(([cat, count]) => `${count} ${cat}`).join(" · ")}
            </span>
          </div>
        )}
      </section>

      {/* Tabs */}
      <div className="scan-tabs" style={{ display: "flex", gap: 0, borderBottom: `1px solid ${t.border}`, overflowX: "auto" }}>
        {([
          { key: "bugs" as const, label: `Bugs (${data.bugs.length})` },
          ...(data.flows && data.flows.length > 0 ? [{ key: "flows" as const, label: `Flows (${data.flows.length})` }] : []),
          { key: "flowmap" as const, label: "Flow Map" },
          { key: "performance" as const, label: "Performance" },
          { key: "pages" as const, label: `Pages (${data.pages_tested})` },
        ]).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
            padding: "14px 24px", background: "transparent", border: "none",
            color: activeTab === tab.key ? t.text : t.textMuted,
            fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer",
            borderBottom: activeTab === tab.key ? `2px solid ${t.text}` : "2px solid transparent",
            fontFamily: "inherit", whiteSpace: "nowrap", transition: "color 0.2s",
          }}>
            {tab.label}
          </button>
        ))}
      </div>

      <section style={{ padding: "32px 0 80px" }}>
        {activeTab === "bugs" && <BugsTab bugs={data.bugs} expandedBug={expandedBug} setExpandedBug={setExpandedBug} t={t} />}
        {activeTab === "flows" && <FlowsTab flows={data.flows || []} t={t} />}
        {activeTab === "flowmap" && <FlowMapView graph={data.site_graph} bugs={data.bugs} t={t} />}
        {activeTab === "performance" && <PerformanceTab metrics={data.metrics} t={t} />}
        {activeTab === "pages" && <PagesTab pages={data.pages_visited} bugs={data.bugs} graph={data.site_graph} t={t} />}
      </section>

      <section style={{ padding: "48px 0", borderTop: `1px solid ${t.border}`, textAlign: "center" }}>
        <p style={{ color: t.textMuted, fontSize: 13, marginBottom: 16 }}>Want this report every morning?</p>
        <a href="mailto:contact@flowlens.in?subject=FlowLens Beta Access" style={{
          display: "inline-block", padding: "14px 32px", background: t.accent, color: "#fff",
          fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", textDecoration: "none", borderRadius: 8,
        }}>Get Daily Monitoring →</a>
      </section>
    </>
  );
}

/* ─── Bugs Tab (Grouped) ─── */

function BugsTab({ bugs, expandedBug, setExpandedBug, t }: {
  bugs: Bug[]; expandedBug: string | null; setExpandedBug: (k: string | null) => void; t: Theme;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  if (bugs.length === 0) {
    return <div style={{ padding: "60px 0", textAlign: "center" }}>
      <p style={{ fontSize: 24, marginBottom: 8 }}>✓</p>
      <p style={{ color: "#28c840", fontSize: 15 }}>No bugs found. Your site is looking healthy.</p>
    </div>;
  }

  const sevOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
  const groups: Record<string, Bug[]> = {};
  for (const bug of bugs) {
    const cat = bug.category;
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(bug);
  }
  for (const cat in groups) groups[cat].sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));
  const sortedCategories = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {sortedCategories.map(cat => {
        const catBugs = groups[cat];
        const isGroupExpanded = expandedGroups.has(cat);
        const visibleBugs = isGroupExpanded ? catBugs : catBugs.slice(0, 5);
        const hasP0P1 = catBugs.some(b => b.severity === "P0" || b.severity === "P1");

        return (
          <div key={cat} style={{
            background: t.card, border: `1px solid ${hasP0P1 ? "rgba(239,68,68,0.2)" : t.cardBorder}`,
            borderRadius: t.radius, boxShadow: t.cardShadow, overflow: "hidden",
          }}>
            {/* Group header */}
            <div style={{
              padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between",
              borderBottom: `1px solid ${t.cardBorder}`,
              background: hasP0P1 ? "rgba(239,68,68,0.04)" : "transparent",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 16 }}>{CAT_ICONS[cat] || "●"}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: t.text, textTransform: "capitalize" }}>{CAT_LABELS[cat] || cat}</span>
                <span style={{ fontSize: 11, color: t.textMuted, padding: "2px 8px", background: t.hoverBg, borderRadius: 4 }}>
                  {catBugs.length}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {Object.entries(catBugs.reduce<Record<string, number>>((acc, b) => { acc[b.severity] = (acc[b.severity] || 0) + 1; return acc; }, {}))
                  .sort(([a], [b]) => (sevOrder[a] ?? 5) - (sevOrder[b] ?? 5))
                  .map(([sev, count]) => (
                    <span key={sev} style={{ fontSize: 10, color: SEV_COLORS[sev], padding: "2px 6px", background: SEV_BG[sev], borderRadius: 4 }}>
                      {count} {sev}
                    </span>
                  ))}
              </div>
            </div>

            {/* Bug rows */}
            <div>
              {visibleBugs.map((bug, i) => {
                const bugKey = `${cat}-${i}`;
                const isExpanded = expandedBug === bugKey;
                const isAlert = bug.severity === "P0" || bug.severity === "P1";
                return (
                  <div key={bugKey}>
                    <div
                      onClick={() => setExpandedBug(isExpanded ? null : bugKey)}
                      className="scan-bug-row"
                      style={{
                        padding: "12px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                        borderBottom: `1px solid ${t.borderSubtle}`,
                        background: isAlert ? "rgba(239,68,68,0.03)" : "transparent",
                        transition: "background 0.15s",
                      }}
                    >
                      <span style={{ color: SEV_COLORS[bug.severity], fontWeight: 700, fontSize: 12, width: 28, flexShrink: 0 }}>{bug.severity}</span>
                      <span style={{ flex: 1, color: t.text, fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bug.title}</span>
                      <span className="scan-bug-vp" style={{ color: t.textMuted, fontSize: 10, textTransform: "uppercase", flexShrink: 0 }}>{bug.viewport}</span>
                      <span style={{ color: t.textMuted, fontSize: 12, flexShrink: 0 }}>{isExpanded ? "−" : "+"}</span>
                    </div>

                    {isExpanded && (
                      <div className="scan-bug-detail" style={{ padding: "16px 20px 20px 60px", borderBottom: `1px solid ${t.borderSubtle}`, background: t.hoverBg }}>
                        <p style={{ color: t.textSecondary, lineHeight: 1.7, marginBottom: 16, maxWidth: 700, fontSize: 12 }}>{bug.description}</p>
                        <div style={{ marginBottom: 12 }}>
                          <span style={{ color: t.textMuted, fontSize: 10, textTransform: "uppercase" }}>Page: </span>
                          <span style={{ color: t.textSecondary, fontSize: 12, wordBreak: "break-all" }}>{bug.page_url}</span>
                        </div>
                        {bug.repro_steps && bug.repro_steps.length > 0 && (
                          <div style={{ marginBottom: 16 }}>
                            <p style={{ color: t.textMuted, fontSize: 10, textTransform: "uppercase", marginBottom: 8 }}>Reproduction Steps</p>
                            <div style={{ background: t.codeBg, borderRadius: t.radius, padding: "12px 16px" }}>
                              {bug.repro_steps.map((step, si) => (
                                <div key={si} style={{ display: "flex", gap: 10, padding: "3px 0", color: t.textSecondary, fontSize: 12 }}>
                                  <span style={{ color: t.textMuted, flexShrink: 0 }}>{si + 1}.</span>
                                  <span>{step}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {bug.screenshot_b64 && (
                          <div style={{ marginBottom: 12 }}>
                            <p style={{ color: t.textMuted, fontSize: 10, textTransform: "uppercase", marginBottom: 8 }}>Screenshot</p>
                            <img src={`data:image/jpeg;base64,${bug.screenshot_b64}`} alt={bug.title}
                              style={{ maxWidth: "100%", borderRadius: 8, border: `1px solid ${t.cardBorder}` }} />
                          </div>
                        )}
                        {Object.keys(bug.evidence).filter(k => !["repro_steps", "screenshot_key", "page_title"].includes(k)).length > 0 && (
                          <div>
                            <p style={{ color: t.textMuted, fontSize: 10, textTransform: "uppercase", marginBottom: 8 }}>Evidence</p>
                            <div style={{ background: t.codeBg, borderRadius: t.radius, padding: "10px 14px", fontSize: 11 }}>
                              {Object.entries(bug.evidence).filter(([k]) => !["repro_steps", "screenshot_key", "page_title"].includes(k)).map(([key, val]) => (
                                <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: `1px solid ${t.borderSubtle}` }}>
                                  <span style={{ color: t.textMuted }}>{key}</span>
                                  <span style={{ color: t.textSecondary, maxWidth: "55%", textAlign: "right", wordBreak: "break-all" }}>{String(val).substring(0, 200)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {catBugs.length > 5 && (
              <button onClick={() => setExpandedGroups(prev => {
                const next = new Set(prev);
                next.has(cat) ? next.delete(cat) : next.add(cat);
                return next;
              })} style={{
                width: "100%", padding: "10px", background: "transparent", border: "none",
                color: t.textMuted, fontSize: 11, cursor: "pointer", fontFamily: "inherit",
                borderTop: `1px solid ${t.borderSubtle}`,
              }}>
                {isGroupExpanded ? "Show less" : `Show all ${catBugs.length} bugs`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Flows Tab (Flow Verifications) ─── */

function FlowsTab({ flows, t }: { flows: FlowResult[]; t: Theme }) {
  if (flows.length === 0) {
    return (
      <div style={{ padding: "60px 0", textAlign: "center" }}>
        <p style={{ color: t.textMuted, fontSize: 14 }}>No flow verifications for this scan.</p>
        <p style={{ color: t.textMuted, fontSize: 12, marginTop: 8 }}>Flow-based testing runs after discovery. Try scanning a site with search, login, or forms.</p>
      </div>
    );
  }

  const actionLabels: Record<string, string> = {
    navigate: "Navigate",
    click: "Click",
    fill_form: "Fill form",
    search: "Search",
    verify: "Verify",
  };

  // Calculate flow statistics
  const passedFlows = flows.filter(f => f.status === "passed").length;
  const failedFlows = flows.filter(f => f.status === "failed").length;
  const partialFlows = flows.filter(f => f.status === "partial").length;
  const successRate = Math.round((passedFlows / flows.length) * 100);
  const totalSteps = flows.reduce((sum, f) => sum + f.steps.length, 0);
  const totalDuration = flows.reduce((sum, f) => sum + f.duration_ms, 0);
  const avgDuration = Math.round(totalDuration / flows.length);

  // Group flows by priority
  const groupedFlows = flows.reduce((acc, flow) => {
    const priority = flow.flow.priority;
    if (!acc[priority]) acc[priority] = [];
    acc[priority].push(flow);
    return acc;
  }, {} as Record<number, FlowResult[]>);

  const priorityLabels: Record<number, { label: string; color: string }> = {
    1: { label: "Critical", color: "#ef4444" },
    2: { label: "Important", color: "#f59e0b" },
    3: { label: "Standard", color: "#3b82f6" },
    4: { label: "Optional", color: "#8b5cf6" },
    5: { label: "Low", color: "#6b7280" },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Flow Summary Stats */}
      <div style={{
        background: t.card,
        border: `1px solid ${t.cardBorder}`,
        borderRadius: t.radius,
        padding: "20px 24px",
        boxShadow: t.cardShadow,
      }}>
        <p style={{ color: t.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>
          Flow Testing Summary
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 20 }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 700, color: t.text, lineHeight: 1 }}>{flows.length}</div>
            <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>Flows Tested</div>
          </div>
          <div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#28c840", lineHeight: 1 }}>{successRate}%</div>
            <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>Success Rate</div>
          </div>
          <div>
            <div style={{ fontSize: 28, fontWeight: 700, color: t.text, lineHeight: 1 }}>{passedFlows}/{failedFlows}/{partialFlows}</div>
            <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>Pass/Fail/Partial</div>
          </div>
          <div>
            <div style={{ fontSize: 28, fontWeight: 700, color: t.text, lineHeight: 1 }}>{totalSteps}</div>
            <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>Total Steps</div>
          </div>
          <div>
            <div style={{ fontSize: 28, fontWeight: 700, color: t.text, lineHeight: 1 }}>{avgDuration}ms</div>
            <div style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>Avg Duration</div>
          </div>
        </div>
      </div>

      <p style={{ color: t.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>
        Flows by Priority
      </p>
      <p style={{ color: t.textSecondary, fontSize: 12, maxWidth: 600, marginBottom: 24, lineHeight: 1.6 }}>
        FlowLens uses heuristic selector rules first. When the page structure is ambiguous, it falls back to AI to find the right element. This keeps scans fast and accurate.
      </p>

      {/* Group and display flows by priority */}
      {Object.keys(groupedFlows).sort((a, b) => Number(a) - Number(b)).map(priority => {
        const priorityNum = Number(priority);
        const priorityInfo = priorityLabels[priorityNum] || { label: `Priority ${priority}`, color: t.textMuted };
        const flowsInGroup = groupedFlows[priorityNum];

        return (
          <div key={priority} style={{ marginBottom: 32 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <span style={{
                padding: "4px 12px",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                background: `${priorityInfo.color}20`,
                color: priorityInfo.color,
                borderRadius: 6,
              }}>
                {priorityInfo.label}
              </span>
              <span style={{ fontSize: 12, color: t.textMuted }}>
                {flowsInGroup.length} {flowsInGroup.length === 1 ? 'flow' : 'flows'}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {flowsInGroup.map((fr, fi) => {
                const statusColor = fr.status === "passed" ? "#28c840" : fr.status === "failed" ? "#ef4444" : "#f59e0b";
                const heuristicCount = fr.steps.filter(s => !s.ai_used).length;
                const aiCount = fr.steps.filter(s => s.ai_used).length;

                return (
                  <div
                    key={fi}
            style={{
              background: t.card,
              border: `1px solid ${t.cardBorder}`,
              borderRadius: t.radius,
              boxShadow: t.cardShadow,
              overflow: "hidden",
            }}
          >
            <div style={{
              padding: "16px 20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 12,
              borderBottom: `1px solid ${t.cardBorder}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: t.text }}>{fr.flow.name}</span>
                <span style={{
                  padding: "3px 10px",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  background: `${statusColor}20`,
                  color: statusColor,
                  borderRadius: 4,
                }}>
                  {fr.status}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: t.textMuted }}>
                <span>{fr.duration_ms}ms</span>
                <span>·</span>
                <span>{heuristicCount} heuristic, {aiCount} AI-assisted</span>
              </div>
            </div>

            <div style={{ padding: "12px 20px 20px" }}>
              {fr.steps.map((sr, si) => (
                <div
                  key={si}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    padding: "12px 0",
                    borderBottom: si < fr.steps.length - 1 ? `1px solid ${t.borderSubtle}` : "none",
                  }}
                >
                  <span style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    fontSize: 11,
                    background: sr.status === "passed" ? "rgba(40,200,64,0.15)" : sr.status === "failed" ? "rgba(239,68,68,0.15)" : "rgba(136,136,136,0.15)",
                    color: sr.status === "passed" ? "#28c840" : sr.status === "failed" ? "#ef4444" : t.textMuted,
                  }}>
                    {sr.status === "passed" ? "✓" : sr.status === "failed" ? "✗" : "−"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ color: t.text, fontSize: 12 }}>
                        {actionLabels[sr.step.action] || sr.step.action}: {sr.step.target || "(none)"}
                      </span>
                      <span style={{
                        padding: "2px 6px",
                        fontSize: 9,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        background: sr.ai_used ? "rgba(147,51,234,0.15)" : t.hoverBg,
                        color: sr.ai_used ? "#a78bfa" : t.textMuted,
                        borderRadius: 4,
                      }}>
                        {sr.ai_used ? "AI-assisted" : "Heuristic"}
                      </span>
                    </div>
                    {sr.error && (
                      <p style={{ color: "#ef4444", fontSize: 11, marginTop: 4 }}>{sr.error}</p>
                    )}
                    {sr.screenshot_b64 && (
                      <div style={{ marginTop: 8 }}>
                        <img
                          src={`data:image/jpeg;base64,${sr.screenshot_b64}`}
                          alt={`Step ${si + 1}`}
                          style={{ maxWidth: "100%", maxHeight: 200, borderRadius: 6, border: `1px solid ${t.cardBorder}` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Flow Map ─── */

function FlowMapView({ graph, bugs, t }: { graph?: SiteGraph; bugs: Bug[]; t: Theme }) {
  if (!graph || !graph.nodes || graph.nodes.length === 0) return <div style={{ padding: "60px 0", textAlign: "center", color: t.textMuted }}>No flow map data available.</div>;

  const nodeColors = (node: GraphNode) => {
    if (node.bugs === 0) return { bg: t.isDark ? "#0d2818" : "#f0fdf4", border: t.isDark ? "#1a5c2e" : "#86efac", dot: "#28c840" };
    if (node.max_severity === "P0" || node.max_severity === "P1") return { bg: t.isDark ? "#2a1215" : "#fef2f2", border: t.isDark ? "#7f1d1d" : "#fca5a5", dot: "#ef4444" };
    if (node.max_severity === "P2") return { bg: t.isDark ? "#2a2010" : "#fffbeb", border: t.isDark ? "#78350f" : "#fcd34d", dot: "#f59e0b" };
    return { bg: t.card, border: t.cardBorder, dot: t.textMuted };
  };

  const rootNode = graph.nodes.find(n => n.path === "/" || n.path === "") || graph.nodes[0];
  const childNodes = graph.nodes.filter(n => n.id !== rootNode?.id);
  const nodeLabel = (node: GraphNode) => { const l = node.label || ""; return (l && l !== "/" && l.length <= 25) ? l : truncPath(node.path); };

  return (
    <div>
      <p style={{ color: t.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 24 }}>
        {graph.nodes.length} pages · {graph.edges.length} connections
      </p>
      {rootNode && (
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ display: "inline-block", padding: "14px 28px", borderRadius: t.radius, maxWidth: 280, background: nodeColors(rootNode).bg, border: `2px solid ${nodeColors(rootNode).border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: nodeColors(rootNode).dot }} />
              <span style={{ color: t.text, fontSize: 14, fontWeight: 500 }}>{nodeLabel(rootNode)}</span>
            </div>
            {rootNode.bugs > 0 && <span style={{ display: "inline-block", marginTop: 6, padding: "2px 8px", fontSize: 10, background: SEV_BG[rootNode.max_severity || "P3"], color: SEV_COLORS[rootNode.max_severity || "P3"], borderRadius: 4 }}>{rootNode.bugs} bug{rootNode.bugs !== 1 ? "s" : ""}</span>}
          </div>
          {childNodes.length > 0 && <div style={{ width: 1, height: 24, background: t.border, margin: "0 auto" }} />}
        </div>
      )}
      {childNodes.length > 0 && (
        <div className="scan-flowmap-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
          {childNodes.map(node => {
            const colors = nodeColors(node);
            return (
              <div key={node.id} style={{ padding: "12px 14px", borderRadius: t.radius, background: colors.bg, border: `1px solid ${colors.border}`, overflow: "hidden", minWidth: 0 }} title={node.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: colors.dot, flexShrink: 0 }} />
                  <span style={{ color: t.text, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{nodeLabel(node)}</span>
                </div>
                <p style={{ color: t.textMuted, fontSize: 10, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{truncPath(node.path)}</p>
                {node.bugs > 0 && <span style={{ display: "inline-block", marginTop: 6, padding: "2px 6px", fontSize: 9, background: SEV_BG[node.max_severity || "P3"], color: SEV_COLORS[node.max_severity || "P3"], borderRadius: 4, textTransform: "uppercase" }}>{node.bugs} bug{node.bugs !== 1 ? "s" : ""}</span>}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: 20, marginTop: 28, justifyContent: "center" }}>
        {[{ color: "#28c840", label: "Healthy" }, { color: "#f59e0b", label: "Warnings" }, { color: "#ef4444", label: "Bugs" }].map(item => (
          <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: t.textMuted }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: item.color }} />{item.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Performance Tab ─── */

function PerformanceTab({ metrics, t }: { metrics: Metric[]; t: Theme }) {
  const maxLoad = Math.max(...metrics.map(m => m.load_time_ms), 1);
  const metricColor = (val: number, warn: number, crit: number) => val > crit ? "#ef4444" : val > warn ? "#f59e0b" : "#28c840";

  return (
    <div className="scan-perf-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12 }}>
      {metrics.map((m, i) => {
        const loadColor = metricColor(m.load_time_ms, 3000, 5000);
        const barWidth = `${Math.min((m.load_time_ms / maxLoad) * 100, 100)}%`;
        return (
          <div key={i} style={{ background: t.card, border: `1px solid ${t.cardBorder}`, borderRadius: t.radius, boxShadow: t.cardShadow, padding: 20, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", bottom: 0, left: 0, width: barWidth, height: 3, background: loadColor, opacity: 0.5, borderRadius: "0 3px 0 0" }} />
            <p style={{ color: t.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {shortUrl(m.url)} · {m.viewport}
            </p>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div>
                <p style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: loadColor }}>{m.load_time_ms}<span style={{ fontSize: 12, color: t.textMuted }}>ms</span></p>
                <p style={{ fontSize: 10, color: t.textMuted, textTransform: "uppercase" }}>Load</p>
              </div>
              {m.fcp_ms != null && (
                <div>
                  <p style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: metricColor(m.fcp_ms, 1800, 3000) }}>{m.fcp_ms}<span style={{ fontSize: 12, color: t.textMuted }}>ms</span></p>
                  <p style={{ fontSize: 10, color: t.textMuted, textTransform: "uppercase" }}>FCP</p>
                </div>
              )}
              <div>
                <p style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: metricColor(m.dom_node_count, 1500, 3000) }}>{m.dom_node_count}</p>
                <p style={{ fontSize: 10, color: t.textMuted, textTransform: "uppercase" }}>DOM</p>
              </div>
              {m.request_count > 0 && (
                <div>
                  <p style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: t.textSecondary }}>{m.request_count}</p>
                  <p style={{ fontSize: 10, color: t.textMuted, textTransform: "uppercase" }}>Reqs</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Pages Tab ─── */

function PagesTab({ pages, bugs, graph, t }: { pages: string[]; bugs: Bug[]; graph?: SiteGraph; t: Theme }) {
  const bugsByPage: Record<string, number> = {};
  for (const b of bugs) bugsByPage[b.page_url] = (bugsByPage[b.page_url] || 0) + 1;
  const graphNodes = graph?.nodes || [];
  const titleMap: Record<string, string> = {};
  for (const n of graphNodes) if (n.label && n.label !== "/") titleMap[n.id] = n.label;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {pages.map((page, i) => {
        const bugCount = bugsByPage[page] || 0;
        const title = titleMap[page];
        return (
          <div key={i} style={{
            padding: "12px 16px", borderRadius: 8, display: "flex", alignItems: "center", gap: 12,
            background: i % 2 === 0 ? "transparent" : t.hoverBg,
          }}>
            <span style={{ color: bugCount > 0 ? "#ef4444" : "#28c840", flexShrink: 0, fontSize: 14 }}>{bugCount > 0 ? "●" : "✓"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {title && <p style={{ color: t.text, fontSize: 12, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</p>}
              <p className="scan-page-url" style={{ color: t.textMuted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{page}</p>
            </div>
            {bugCount > 0 && (
              <span style={{ fontSize: 10, color: "#ef4444", padding: "2px 8px", background: SEV_BG.P2, borderRadius: 4, flexShrink: 0 }}>
                {bugCount} bug{bugCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Status Screens ─── */

function ScanLoading({ t }: { t: Theme }) {
  return (
    <div style={{ textAlign: "center", padding: "120px 0" }}>
      <div style={{ width: 40, height: 40, border: `2px solid ${t.border}`, borderTopColor: t.text, borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto" }} />
      <p style={{ color: t.textMuted, marginTop: 20 }}>Connecting to scan...</p>
    </div>
  );
}

function ScanFailed({ url, error, t }: { url: string; error?: string; t: Theme }) {
  return (
    <div style={{ textAlign: "center", padding: "120px 0" }}>
      <p style={{ fontSize: 36, marginBottom: 16, color: "#ef4444" }}>✕</p>
      <h2 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: t.text, fontWeight: 400 }}>Scan failed</h2>
      <p style={{ color: t.textMuted, marginTop: 8 }}>{url}</p>
      {error && <p style={{ color: "#ef4444", fontSize: 12, marginTop: 12, maxWidth: 400, margin: "12px auto 0" }}>{error}</p>}
      <a href="/" style={{ display: "inline-block", marginTop: 32, padding: "14px 28px", background: t.text, color: t.bg, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", textDecoration: "none", borderRadius: 8 }}>Try Again</a>
    </div>
  );
}

/* ─── Helpers ─── */

function shortUrl(u: string) { const s = u.replace("https://", "").replace("http://", ""); return s.length > 50 ? s.slice(0, 47) + "..." : s; }

function shortPath(urlOrPath: string) {
  let p = urlOrPath;
  try { p = new URL(urlOrPath).pathname; } catch { p = p.replace("https://", "").replace("http://", ""); const i = p.indexOf("/"); p = i >= 0 ? p.substring(i) : "/"; }
  if (p === "/" || p === "") return "/";
  return p.length > 30 ? p.slice(0, 27) + "..." : p;
}

function truncPath(pathOrUrl: string) {
  if (!pathOrUrl || pathOrUrl === "/" || pathOrUrl === "") return "/";
  let p = pathOrUrl;
  try { const u = new URL(pathOrUrl); p = u.pathname + (u.search ? "?" + u.search.slice(1, 20) + "..." : ""); } catch { p = p.replace("https://", "").replace("http://", ""); const i = p.indexOf("/"); if (i >= 0) p = p.substring(i); }
  if (p === "/") return "/";
  const segs = p.split("/").filter(Boolean);
  if (segs.length === 0) return "/";
  const last = segs[segs.length - 1];
  const clean = last.length > 25 ? last.slice(0, 22) + "..." : last;
  return segs.length > 1 ? "/.../" + clean : "/" + clean;
}

function nodeStatusBg(n: LiveNode) { if (n.bugs > 0) return "#2a1215"; if (n.status === "visiting") return "#0c1b3a"; if (n.status === "visited") return "#0d2818"; if (n.status === "failed") return "#2a1215"; return "#1a1a1a"; }
function nodeStatusBorder(n: LiveNode) { if (n.bugs > 0) return "#7f1d1d"; if (n.status === "visiting") return "#1e40af"; if (n.status === "visited") return "#1a5c2e"; if (n.status === "failed") return "#7f1d1d"; return "#333"; }
function nodeStatusDot(n: LiveNode) { if (n.bugs > 0) return "#ef4444"; if (n.status === "visiting") return "#3b82f6"; if (n.status === "visited") return "#28c840"; if (n.status === "failed") return "#ef4444"; return "#555"; }
function logColor(type: LogEntry["type"]) { switch (type) { case "bug": return "#ef4444"; case "discovery": return "#3b82f6"; case "action": return "#f59e0b"; case "complete": return "#28c840"; default: return "#555"; } }
function logIcon(type: LogEntry["type"]) { switch (type) { case "bug": return "●"; case "discovery": return "→"; case "action": return "▸"; case "complete": return "✓"; default: return "·"; } }
