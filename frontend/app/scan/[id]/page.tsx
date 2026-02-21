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
  element_count?: number;
  action_count?: number;
}

interface GraphEdge {
  from: string;
  to: string;
}

interface SiteGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
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

const SEV_COLORS: Record<string, string> = { P0: "#ff5f57", P1: "#ff5f57", P2: "#febc2e", P3: "#888", P4: "#555" };
const SEV_BG: Record<string, string> = { P0: "rgba(255,95,87,0.1)", P1: "rgba(255,95,87,0.08)", P2: "rgba(254,188,46,0.08)", P3: "rgba(136,136,136,0.08)", P4: "rgba(85,85,85,0.05)" };
const CAT_LABELS: Record<string, string> = { functional: "Functional", performance: "Performance", responsive: "Responsive", accessibility: "Accessibility", security: "Security", visual: "Visual" };
const CONF_DOTS: Record<string, string> = { HIGH: "●", MEDIUM: "◐", LOW: "○" };

/* ─── Main Component ─── */

export default function ScanResultPage() {
  const params = useParams();
  const scanId = params.id as string;
  const [data, setData] = useState<ScanResult | null>(null);
  const [polling, setPolling] = useState(true);
  const [expandedBug, setExpandedBug] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"bugs" | "flowmap" | "performance" | "pages">("bugs");

  // Live state
  const [isLive, setIsLive] = useState(false);
  const [liveNodes, setLiveNodes] = useState<Map<string, LiveNode>>(new Map());
  const [liveEdges, setLiveEdges] = useState<Array<{ from: string; to: string }>>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [counters, setCounters] = useState({ pages: 0, elements: 0, bugs: 0, actions: 0 });
  const logIdRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const addLog = useCallback((text: string, type: LogEntry["type"] = "info") => {
    logIdRef.current += 1;
    setLogEntries(prev => [...prev.slice(-100), { id: logIdRef.current, text, type, timestamp: Date.now() }]);
  }, []);

  // SSE connection for live updates
  useEffect(() => {
    if (!scanId) return;

    const es = new EventSource(`${API_URL}/api/v1/scan/${scanId}/stream`);
    eventSourceRef.current = es;
    setIsLive(true);

    es.addEventListener("page_discovered", (e) => {
      const d = JSON.parse(e.data);
      setLiveNodes(prev => {
        const next = new Map(prev);
        if (!next.has(d.url)) {
          next.set(d.url, {
            url: d.url,
            depth: d.depth ?? 0,
            status: "discovered",
            from: d.from ?? null,
            bugs: 0,
            elements: 0,
            via: d.via,
          });
        }
        return next;
      });
      if (d.from) {
        setLiveEdges(prev => [...prev, { from: d.from, to: d.url }]);
      }
      const via = d.via ? ` (via ${d.via})` : "";
      addLog(`Discovered ${shortUrl(d.url)}${via}`, "discovery");
    });

    es.addEventListener("visiting_page", (e) => {
      const d = JSON.parse(e.data);
      setLiveNodes(prev => {
        const next = new Map(prev);
        const node = next.get(d.url);
        if (node) node.status = "visiting";
        return next;
      });
      setCounters(c => ({ ...c, pages: d.page_number ?? c.pages }));
      addLog(`Visiting ${shortUrl(d.url)} [${d.page_number}/${d.total_discovered}]`, "info");
    });

    es.addEventListener("elements_found", (e) => {
      const d = JSON.parse(e.data);
      setLiveNodes(prev => {
        const next = new Map(prev);
        const node = next.get(d.url);
        if (node) node.elements = d.total ?? 0;
        return next;
      });
      setCounters(c => ({ ...c, elements: c.elements + (d.total ?? 0) }));
      const parts: string[] = [];
      if (d.nav_link) parts.push(`${d.nav_link} nav`);
      if (d.form) parts.push(`${d.form} form${d.form > 1 ? "s" : ""}`);
      if (d.search) parts.push(`${d.search} search`);
      if (d.cta) parts.push(`${d.cta} button${d.cta > 1 ? "s" : ""}`);
      if (d.dropdown) parts.push(`${d.dropdown} dropdown${d.dropdown > 1 ? "s" : ""}`);
      addLog(`Found ${d.total} elements${parts.length ? ": " + parts.join(", ") : ""}`, "info");
    });

    es.addEventListener("action", (e) => {
      const d = JSON.parse(e.data);
      setCounters(c => ({ ...c, actions: c.actions + 1 }));
      const labels: Record<string, string> = {
        follow_link: "Following link",
        expand_menu: "Expanding menu",
        fill_form: "Filling form",
        search: "Testing search",
        click_button: "Clicking button",
      };
      addLog(`${labels[d.action] ?? d.action} "${d.target}"`, "action");
    });

    es.addEventListener("bug_found", (e) => {
      const d = JSON.parse(e.data);
      setCounters(c => ({ ...c, bugs: c.bugs + 1 }));
      setLiveNodes(prev => {
        const next = new Map(prev);
        const node = next.get(d.page);
        if (node) node.bugs += 1;
        return next;
      });
      addLog(`${d.severity} ${d.title}`, "bug");
    });

    es.addEventListener("page_complete", (e) => {
      const d = JSON.parse(e.data);
      setLiveNodes(prev => {
        const next = new Map(prev);
        const node = next.get(d.url);
        if (node) node.status = d.status === "failed" ? "failed" : "visited";
        return next;
      });
    });

    es.addEventListener("scan_complete", (e) => {
      const d = JSON.parse(e.data);
      addLog(`Scan complete: ${d.pages} pages, ${d.bugs} bugs, ${d.actions_taken} actions`, "complete");
      es.close();
      setIsLive(false);
    });

    es.addEventListener("scan_failed", (e) => {
      const d = JSON.parse(e.data);
      addLog(`Scan failed: ${d.error}`, "bug");
      es.close();
      setIsLive(false);
    });

    es.onerror = () => {
      es.close();
      setIsLive(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [scanId, addLog]);

  // Polling for final result
  useEffect(() => {
    if (!scanId) return;
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/scan/${scanId}`);
        const json = await res.json();
        setData(json);
        if (json.status === "completed" || json.status === "failed") {
          setPolling(false);
          setIsLive(false);
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
          }
        }
      } catch { /* retry */ }
    };
    poll();
    if (polling) {
      const interval = setInterval(poll, 3000);
      return () => clearInterval(interval);
    }
  }, [scanId, polling]);

  const isRunning = !data || data.status === "running";
  const isCompleted = data?.status === "completed";

  return (
    <div style={{ minHeight: "100vh", background: "#0f0f0f", color: "#e5e5e5", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>
      <Header />

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px" }}>
        {!data ? <ScanLoading /> :
          data.status === "failed" ? <ScanFailed url={data.url} error={data.errors?.[0]} /> :
          isRunning ? (
            <LiveScanView
              url={data.url}
              nodes={liveNodes}
              edges={liveEdges}
              log={logEntries}
              counters={counters}
            />
          ) : isCompleted ? (
            <CompletedView
              data={data}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              expandedBug={expandedBug}
              setExpandedBug={setExpandedBug}
            />
          ) : null}
      </main>
    </div>
  );
}

/* ─── Header ─── */

function Header() {
  return (
    <header style={{ padding: "16px 0", borderBottom: "1px solid #2a2a2a" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <a href="/" style={{ fontFamily: "'Instrument Serif', serif", fontSize: 24, color: "#fff", textDecoration: "none" }}>FlowLens</a>
        <a href="/" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#888", textDecoration: "none" }}>← New Scan</a>
      </div>
    </header>
  );
}

/* ─── Live Scan View ─── */

function LiveScanView({
  url,
  nodes,
  edges,
  log,
  counters,
}: {
  url: string;
  nodes: Map<string, LiveNode>;
  edges: Array<{ from: string; to: string }>;
  log: LogEntry[];
  counters: { pages: number; elements: number; bugs: number; actions: number };
}) {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  const nodeArray = Array.from(nodes.values());

  return (
    <div style={{ padding: "40px 0 80px" }}>
      {/* Title */}
      <div style={{ marginBottom: 32 }}>
        <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#666", marginBottom: 8 }}>Live Scan</p>
        <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: "#fff", fontWeight: 400, marginBottom: 4 }}>{shortUrl(url)}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#28c840", display: "inline-block", animation: "pulse 1.5s infinite" }} />
          <span style={{ fontSize: 11, color: "#28c840", textTransform: "uppercase", letterSpacing: "0.1em" }}>Exploring</span>
        </div>
      </div>

      {/* Counters */}
      <div style={{ display: "flex", gap: 1, marginBottom: 32, background: "#2a2a2a", borderRadius: 8, overflow: "hidden" }}>
        {([
          { label: "Pages", value: counters.pages, color: "#fff" },
          { label: "Elements", value: counters.elements, color: "#888" },
          { label: "Actions", value: counters.actions, color: "#888" },
          { label: "Bugs", value: counters.bugs, color: counters.bugs > 0 ? "#ff5f57" : "#28c840" },
        ]).map(c => (
          <div key={c.label} style={{ flex: 1, background: "#141414", padding: "20px 24px", textAlign: "center" }}>
            <motion.p
              key={c.value}
              initial={{ scale: 1.3, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              style={{ fontFamily: "'Instrument Serif', serif", fontSize: 36, color: c.color, lineHeight: 1 }}
            >
              {c.value}
            </motion.p>
            <p style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 6 }}>{c.label}</p>
          </div>
        ))}
      </div>

      {/* Graph + Log layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 24, alignItems: "start" }}>
        {/* Live graph */}
        <div style={{ background: "#141414", borderRadius: 8, border: "1px solid #2a2a2a", padding: 24, minHeight: 400 }}>
          <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "#555", marginBottom: 16 }}>
            Site Graph · {nodeArray.length} pages discovered
          </p>
          <LiveGraph nodes={nodeArray} edges={edges} />
        </div>

        {/* Activity log */}
        <div style={{ background: "#141414", borderRadius: 8, border: "1px solid #2a2a2a", display: "flex", flexDirection: "column", maxHeight: 500 }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #2a2a2a" }}>
            <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "#555" }}>Activity Log</p>
          </div>
          <div ref={logRef} style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
            <AnimatePresence>
              {log.map(entry => (
                <motion.div
                  key={entry.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  style={{ padding: "5px 16px", fontSize: 11, display: "flex", gap: 8, alignItems: "flex-start" }}
                >
                  <span style={{ color: logColor(entry.type), flexShrink: 0 }}>{logIcon(entry.type)}</span>
                  <span style={{ color: entry.type === "bug" ? "#ff5f57" : "#999" }}>{entry.text}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes visitPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(59,130,246,0.5); }
          50% { box-shadow: 0 0 0 6px rgba(59,130,246,0); }
        }
      `}</style>
    </div>
  );
}

/* ─── Live Graph Visualization ─── */

function LiveGraph({ nodes, edges }: { nodes: LiveNode[]; edges: Array<{ from: string; to: string }> }) {
  if (nodes.length === 0) {
    return <div style={{ textAlign: "center", padding: "60px 0", color: "#444" }}>Waiting for pages...</div>;
  }

  const depths = new Map<number, LiveNode[]>();
  for (const node of nodes) {
    const d = node.depth;
    if (!depths.has(d)) depths.set(d, []);
    depths.get(d)!.push(node);
  }

  const sortedDepths = [...depths.keys()].sort((a, b) => a - b);

  return (
    <div>
      {sortedDepths.map(depth => {
        const row = depths.get(depth)!;
        return (
          <div key={depth}>
            {depth > 0 && (
              <div style={{ display: "flex", justifyContent: "center", padding: "4px 0" }}>
                <div style={{ width: 1, height: 20, background: "#333" }} />
              </div>
            )}
            <div style={{
              display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center",
              padding: "4px 0",
            }}>
              {row.map(node => (
                <motion.div
                  key={node.url}
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 300, damping: 25 }}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 6,
                    background: nodeStatusBg(node),
                    border: `1px solid ${nodeStatusBorder(node)}`,
                    maxWidth: 180,
                    overflow: "hidden",
                    animation: node.status === "visiting" ? "visitPulse 1.5s infinite" : undefined,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: nodeStatusDot(node),
                      display: "inline-block", flexShrink: 0,
                    }} />
                    <span style={{ fontSize: 11, color: "#ddd", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {shortPath(node.url)}
                    </span>
                  </div>
                  {node.bugs > 0 && (
                    <span style={{ fontSize: 9, color: "#ff5f57", display: "block", marginTop: 3 }}>
                      {node.bugs} bug{node.bugs !== 1 ? "s" : ""}
                    </span>
                  )}
                </motion.div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Completed Results View ─── */

function CompletedView({
  data,
  activeTab,
  setActiveTab,
  expandedBug,
  setExpandedBug,
}: {
  data: ScanResult;
  activeTab: "bugs" | "flowmap" | "performance" | "pages";
  setActiveTab: (tab: "bugs" | "flowmap" | "performance" | "pages") => void;
  expandedBug: number | null;
  setExpandedBug: (i: number | null) => void;
}) {
  return (
    <>
      {/* Hero section */}
      <section style={{ padding: "48px 0 40px", borderBottom: "1px solid #2a2a2a" }}>
        <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#666", marginBottom: 12 }}>Scan Report</p>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 24 }}>
          <div>
            <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 32, color: "#fff", marginBottom: 8, fontWeight: 400 }}>{shortUrl(data.url)}</h1>
            <p style={{ color: "#666", fontSize: 12 }}>
              {data.pages_tested} pages · {data.bugs.length} bugs · {data.duration_seconds ? `${Math.round(data.duration_seconds)}s` : ""} · {new Date(data.started_at).toLocaleString()}
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: 64, color: scoreColor(data.health_score ?? 0), lineHeight: 1 }}>{data.health_score}</span>
              <span style={{ fontSize: 18, color: "#555" }}>/100</span>
            </div>
            <span style={{
              display: "inline-block", marginTop: 4, padding: "4px 12px", fontSize: 10,
              textTransform: "uppercase", letterSpacing: "0.1em",
              background: scoreBg(data.health_score ?? 0), color: scoreColor(data.health_score ?? 0),
              borderRadius: 3,
            }}>
              {(data.health_score ?? 0) >= 80 ? "Healthy" : (data.health_score ?? 0) >= 60 ? "Needs Attention" : "Critical"}
            </span>
          </div>
        </div>

        {data.bug_summary && data.bug_summary.total > 0 && (
          <div style={{ display: "flex", gap: 8, marginTop: 24, flexWrap: "wrap" }}>
            {Object.entries(data.bug_summary.by_severity || {}).sort().map(([sev, count]) => (
              <span key={sev} style={{ padding: "4px 12px", background: SEV_BG[sev] || "rgba(255,255,255,0.05)", color: SEV_COLORS[sev] || "#888", fontSize: 11, borderRadius: 3 }}>
                {count} {sev}
              </span>
            ))}
            <span style={{ padding: "4px 12px", background: "rgba(255,255,255,0.03)", color: "#666", fontSize: 11, borderRadius: 3, marginLeft: 8 }}>
              {Object.entries(data.bug_summary.by_category || {}).map(([cat, count]) => `${count} ${cat}`).join(" · ")}
            </span>
          </div>
        )}
      </section>

      {/* Tab navigation */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #2a2a2a", overflowX: "auto" }}>
        {([
          { key: "bugs" as const, label: `Bugs (${data.bugs.length})` },
          { key: "flowmap" as const, label: "Flow Map" },
          { key: "performance" as const, label: "Performance" },
          { key: "pages" as const, label: `Pages (${data.pages_tested})` },
        ]).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
            padding: "14px 24px", background: "transparent", border: "none", color: activeTab === tab.key ? "#fff" : "#666",
            fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer",
            borderBottom: activeTab === tab.key ? "2px solid #fff" : "2px solid transparent", fontFamily: "inherit",
            whiteSpace: "nowrap",
          }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <section style={{ padding: "32px 0 80px" }}>
        {activeTab === "bugs" && <BugsTab bugs={data.bugs} expandedBug={expandedBug} setExpandedBug={setExpandedBug} />}
        {activeTab === "flowmap" && <FlowMapView graph={data.site_graph} bugs={data.bugs} />}
        {activeTab === "performance" && <PerformanceTab metrics={data.metrics} />}
        {activeTab === "pages" && <PagesTab pages={data.pages_visited} />}
      </section>

      {/* Bottom CTA */}
      <section style={{ padding: "48px 0", borderTop: "1px solid #2a2a2a", textAlign: "center" }}>
        <p style={{ color: "#666", fontSize: 13, marginBottom: 16 }}>Want this report every morning? FlowLens monitors your site daily.</p>
        <a href="mailto:contact@flowlens.in?subject=FlowLens Beta Access" style={{
          display: "inline-block", padding: "14px 32px", background: "#1a5c2e", color: "#fff",
          fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", textDecoration: "none",
        }}>Get Daily Monitoring →</a>
      </section>
    </>
  );
}

/* ─── Tab Components ─── */

function BugsTab({ bugs, expandedBug, setExpandedBug }: { bugs: Bug[]; expandedBug: number | null; setExpandedBug: (i: number | null) => void }) {
  if (bugs.length === 0) {
    return (
      <div style={{ padding: "60px 0", textAlign: "center" }}>
        <p style={{ fontSize: 24, marginBottom: 8 }}>✓</p>
        <p style={{ color: "#28c840", fontSize: 15 }}>No bugs found. Your site is looking healthy.</p>
      </div>
    );
  }

  return (
    <div>
      {bugs.map((bug, i) => (
        <div key={i} style={{ borderBottom: "1px solid #1f1f1f" }}>
          <div
            onClick={() => setExpandedBug(expandedBug === i ? null : i)}
            style={{ padding: "16px 0", cursor: "pointer", display: "flex", alignItems: "center", gap: 16 }}
          >
            <span style={{ color: SEV_COLORS[bug.severity] || "#888", fontWeight: 700, width: 32, flexShrink: 0 }}>{bug.severity}</span>
            <span style={{ color: "#555", width: 16, flexShrink: 0 }} title={`${bug.confidence} confidence`}>{CONF_DOTS[bug.confidence] || "?"}</span>
            <span style={{ flex: 1, color: "#ddd" }}>{bug.title}</span>
            <span style={{ color: "#555", fontSize: 11, flexShrink: 0 }}>{CAT_LABELS[bug.category] || bug.category}</span>
            <span style={{ color: "#444", fontSize: 11, width: 60, textAlign: "right", textTransform: "uppercase", flexShrink: 0 }}>{bug.viewport}</span>
            <span style={{ color: "#444", fontSize: 14, flexShrink: 0 }}>{expandedBug === i ? "−" : "+"}</span>
          </div>

          {expandedBug === i && (
            <div style={{ padding: "0 0 24px 48px" }}>
              <p style={{ color: "#999", lineHeight: 1.7, marginBottom: 20, maxWidth: 700 }}>{bug.description}</p>
              <div style={{ marginBottom: 16 }}>
                <span style={{ color: "#555", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>Page: </span>
                <span style={{ color: "#888" }}>{bug.page_url}</span>
              </div>
              {bug.repro_steps && bug.repro_steps.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <p style={{ color: "#555", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Reproduction Steps</p>
                  <div style={{ background: "#1a1a1a", borderRadius: 6, padding: "16px 20px" }}>
                    {bug.repro_steps.map((step, si) => (
                      <div key={si} style={{ display: "flex", gap: 12, padding: "4px 0", color: "#aaa", fontSize: 12 }}>
                        <span style={{ color: "#555", flexShrink: 0 }}>{si + 1}.</span>
                        <span>{step}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {bug.screenshot_b64 && (
                <div style={{ marginBottom: 16 }}>
                  <p style={{ color: "#555", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Screenshot</p>
                  <img
                    src={`data:image/jpeg;base64,${bug.screenshot_b64}`}
                    alt={`Screenshot of ${bug.title}`}
                    style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid #2a2a2a" }}
                  />
                </div>
              )}
              {Object.keys(bug.evidence).filter(k => !["repro_steps", "screenshot_key", "page_title"].includes(k)).length > 0 && (
                <div>
                  <p style={{ color: "#555", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Evidence</p>
                  <div style={{ background: "#1a1a1a", borderRadius: 6, padding: "12px 16px", fontSize: 12 }}>
                    {Object.entries(bug.evidence)
                      .filter(([k]) => !["repro_steps", "screenshot_key", "page_title"].includes(k))
                      .map(([key, val]) => (
                        <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #222" }}>
                          <span style={{ color: "#666" }}>{key}</span>
                          <span style={{ color: "#aaa", maxWidth: "60%", textAlign: "right", wordBreak: "break-all" }}>{String(val).substring(0, 200)}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function FlowMapView({ graph, bugs }: { graph?: SiteGraph; bugs: Bug[] }) {
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    return <div style={{ padding: "60px 0", textAlign: "center", color: "#555" }}><p>No flow map data available.</p></div>;
  }

  const nodeColors = (node: GraphNode) => {
    if (node.bugs === 0) return { bg: "#0d2818", border: "#1a5c2e", dot: "#28c840" };
    if (node.max_severity === "P0" || node.max_severity === "P1") return { bg: "#2a1215", border: "#7f1d1d", dot: "#ff5f57" };
    if (node.max_severity === "P2") return { bg: "#2a2010", border: "#78350f", dot: "#febc2e" };
    return { bg: "#1a1a1a", border: "#333", dot: "#888" };
  };

  const rootNode = graph.nodes.find(n => n.path === "/" || n.path === "") || graph.nodes[0];
  const childNodes = graph.nodes.filter(n => n.id !== rootNode?.id);

  const nodeLabel = (node: GraphNode) => {
    const label = node.label || "";
    if (label && label !== "/" && label.length <= 25) return label;
    return truncPath(node.path);
  };

  return (
    <div>
      <p style={{ color: "#555", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 24 }}>
        Site Structure · {graph.nodes.length} pages · {graph.edges.length} connections
      </p>

      {rootNode && (
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            display: "inline-block", padding: "16px 32px", borderRadius: 8, maxWidth: 280,
            background: nodeColors(rootNode).bg, border: `2px solid ${nodeColors(rootNode).border}`,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: nodeColors(rootNode).dot, display: "inline-block" }} />
              <span style={{ color: "#fff", fontSize: 14, fontWeight: 500 }}>{nodeLabel(rootNode)}</span>
            </div>
            <p style={{ color: "#666", fontSize: 11, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{truncPath(rootNode.path)}</p>
            {rootNode.bugs > 0 && (
              <span style={{ display: "inline-block", marginTop: 6, padding: "2px 8px", fontSize: 10, background: SEV_BG[rootNode.max_severity || "P3"], color: SEV_COLORS[rootNode.max_severity || "P3"], borderRadius: 3 }}>
                {rootNode.bugs} bug{rootNode.bugs !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          {childNodes.length > 0 && <div style={{ width: 1, height: 32, background: "#333", margin: "0 auto" }} />}
        </div>
      )}

      {childNodes.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 12,
        }}>
          {childNodes.map((node) => {
            const colors = nodeColors(node);
            const pageBugs = bugs.filter(b => b.page_url === node.id);
            return (
              <div key={node.id} style={{
                padding: "14px 16px", borderRadius: 8,
                background: colors.bg, border: `1px solid ${colors.border}`,
                overflow: "hidden", minWidth: 0,
              }} title={node.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: colors.dot, display: "inline-block", flexShrink: 0 }} />
                  <span style={{ color: "#ddd", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                    {nodeLabel(node)}
                  </span>
                </div>
                <p style={{ color: "#555", fontSize: 10, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {truncPath(node.path)}
                </p>
                {node.bugs > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <span style={{ padding: "2px 8px", fontSize: 9, background: SEV_BG[node.max_severity || "P3"], color: SEV_COLORS[node.max_severity || "P3"], borderRadius: 3, textTransform: "uppercase" }}>
                      {node.bugs} bug{node.bugs !== 1 ? "s" : ""} · {node.max_severity}
                    </span>
                  </div>
                )}
                {pageBugs.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {pageBugs.slice(0, 2).map((b, bi) => (
                      <div key={bi} style={{ fontSize: 10, color: "#666", padding: "2px 0", borderTop: "1px solid #1f1f1f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ color: SEV_COLORS[b.severity], marginRight: 4 }}>{b.severity}</span>
                        {b.title.length > 30 ? b.title.slice(0, 27) + "..." : b.title}
                      </div>
                    ))}
                    {pageBugs.length > 2 && <p style={{ fontSize: 9, color: "#444", marginTop: 2 }}>+{pageBugs.length - 2} more</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", gap: 24, marginTop: 32, justifyContent: "center" }}>
        {[
          { color: "#28c840", label: "Healthy" },
          { color: "#febc2e", label: "Warnings" },
          { color: "#ff5f57", label: "Bugs found" },
        ].map(item => (
          <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#666" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: item.color, display: "inline-block" }} />
            {item.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function PerformanceTab({ metrics }: { metrics: Metric[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(350px, 1fr))", gap: 1, background: "#2a2a2a" }}>
      {metrics.map((m, i) => {
        const loadColor = m.load_time_ms < 2000 ? "#28c840" : m.load_time_ms < 3000 ? "#febc2e" : "#ff5f57";
        return (
          <div key={i} style={{ background: "#141414", padding: 24 }}>
            <p style={{ color: "#555", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 16 }}>
              {shortUrl(m.url)} · {m.viewport}
            </p>
            <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
              <div>
                <p style={{ fontFamily: "'Instrument Serif', serif", fontSize: 32, color: loadColor }}>{m.load_time_ms}<span style={{ fontSize: 14, color: "#555" }}>ms</span></p>
                <p style={{ fontSize: 10, color: "#555", textTransform: "uppercase" }}>Load time</p>
              </div>
              {m.fcp_ms != null && (
                <div>
                  <p style={{ fontFamily: "'Instrument Serif', serif", fontSize: 32, color: "#ddd" }}>{m.fcp_ms}<span style={{ fontSize: 14, color: "#555" }}>ms</span></p>
                  <p style={{ fontSize: 10, color: "#555", textTransform: "uppercase" }}>FCP</p>
                </div>
              )}
              <div>
                <p style={{ fontFamily: "'Instrument Serif', serif", fontSize: 32, color: "#ddd" }}>{m.dom_node_count}</p>
                <p style={{ fontSize: 10, color: "#555", textTransform: "uppercase" }}>DOM nodes</p>
              </div>
              {m.request_count > 0 && (
                <div>
                  <p style={{ fontFamily: "'Instrument Serif', serif", fontSize: 32, color: "#ddd" }}>{m.request_count}</p>
                  <p style={{ fontSize: 10, color: "#555", textTransform: "uppercase" }}>Requests</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PagesTab({ pages }: { pages: string[] }) {
  return (
    <div>
      {pages.map((page, i) => (
        <div key={i} style={{ padding: "12px 0", borderBottom: "1px solid #1f1f1f", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "#28c840", flexShrink: 0 }}>✓</span>
          <span style={{ color: "#aaa" }}>{page}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── Status Screens ─── */

function ScanLoading() {
  return (
    <div style={{ textAlign: "center", padding: "120px 0" }}>
      <Spinner />
      <p style={{ color: "#666", marginTop: 20 }}>Connecting to scan...</p>
    </div>
  );
}

function ScanFailed({ url, error }: { url: string; error?: string }) {
  return (
    <div style={{ textAlign: "center", padding: "120px 0" }}>
      <p style={{ fontSize: 36, marginBottom: 16, color: "#ff5f57" }}>✕</p>
      <h2 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: "#fff", fontWeight: 400 }}>Scan failed</h2>
      <p style={{ color: "#666", marginTop: 8 }}>{url}</p>
      {error && <p style={{ color: "#ff5f57", fontSize: 12, marginTop: 12, maxWidth: 400, margin: "12px auto 0" }}>{error}</p>}
      <a href="/" style={{ display: "inline-block", marginTop: 32, padding: "14px 28px", background: "#fff", color: "#0f0f0f", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", textDecoration: "none" }}>Try Again</a>
    </div>
  );
}

function Spinner() {
  return (
    <>
      <div style={{ width: 40, height: 40, border: "2px solid #2a2a2a", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto" }} />
      <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}

/* ─── Helpers ─── */

function shortUrl(u: string) {
  const s = u.replace("https://", "").replace("http://", "");
  return s.length > 50 ? s.slice(0, 47) + "..." : s;
}

function shortPath(urlOrPath: string) {
  let p = urlOrPath;
  try {
    p = new URL(urlOrPath).pathname;
  } catch {
    p = urlOrPath.replace("https://", "").replace("http://", "");
    const slashIdx = p.indexOf("/");
    if (slashIdx >= 0) p = p.substring(slashIdx);
    else p = "/";
  }
  if (p === "/" || p === "") return "/";
  return p.length > 30 ? p.slice(0, 27) + "..." : p;
}

function truncPath(pathOrUrl: string) {
  if (!pathOrUrl || pathOrUrl === "/" || pathOrUrl === "") return "/";
  let p = pathOrUrl;
  try {
    const u = new URL(pathOrUrl);
    p = u.pathname + (u.search ? "?" + u.search.slice(1, 20) + "..." : "");
  } catch {
    p = p.replace("https://", "").replace("http://", "");
    const slashIdx = p.indexOf("/");
    if (slashIdx >= 0) p = p.substring(slashIdx);
  }
  if (p === "/") return "/";
  const segments = p.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const last = segments[segments.length - 1];
  const clean = last.length > 25 ? last.slice(0, 22) + "..." : last;
  return segments.length > 1 ? "/.../" + clean : "/" + clean;
}

function nodeStatusBg(node: LiveNode): string {
  if (node.bugs > 0) return "#2a1215";
  if (node.status === "visiting") return "#0c1b3a";
  if (node.status === "visited") return "#0d2818";
  if (node.status === "failed") return "#2a1215";
  return "#1a1a1a";
}

function nodeStatusBorder(node: LiveNode): string {
  if (node.bugs > 0) return "#7f1d1d";
  if (node.status === "visiting") return "#1e40af";
  if (node.status === "visited") return "#1a5c2e";
  if (node.status === "failed") return "#7f1d1d";
  return "#333";
}

function nodeStatusDot(node: LiveNode): string {
  if (node.bugs > 0) return "#ff5f57";
  if (node.status === "visiting") return "#3b82f6";
  if (node.status === "visited") return "#28c840";
  if (node.status === "failed") return "#ff5f57";
  return "#555";
}

function logColor(type: LogEntry["type"]): string {
  switch (type) {
    case "bug": return "#ff5f57";
    case "discovery": return "#3b82f6";
    case "action": return "#febc2e";
    case "complete": return "#28c840";
    default: return "#555";
  }
}

function logIcon(type: LogEntry["type"]): string {
  switch (type) {
    case "bug": return "●";
    case "discovery": return "→";
    case "action": return "▸";
    case "complete": return "✓";
    default: return "·";
  }
}

function scoreColor(score: number): string {
  if (score >= 80) return "#28c840";
  if (score >= 60) return "#febc2e";
  return "#ff5f57";
}

function scoreBg(score: number): string {
  if (score >= 80) return "rgba(40,200,64,0.1)";
  if (score >= 60) return "rgba(254,188,46,0.1)";
  return "rgba(255,95,87,0.1)";
}
