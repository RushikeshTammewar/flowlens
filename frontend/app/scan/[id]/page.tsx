"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.flowlens.in";

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

const SEV_COLORS: Record<string, string> = { P0: "#ff5f57", P1: "#ff5f57", P2: "#febc2e", P3: "#888", P4: "#555" };
const SEV_BG: Record<string, string> = { P0: "rgba(255,95,87,0.1)", P1: "rgba(255,95,87,0.08)", P2: "rgba(254,188,46,0.08)", P3: "rgba(136,136,136,0.08)", P4: "rgba(85,85,85,0.05)" };
const CAT_LABELS: Record<string, string> = { functional: "Functional", performance: "Performance", responsive: "Responsive", accessibility: "Accessibility", security: "Security", visual: "Visual" };
const CONF_DOTS: Record<string, string> = { HIGH: "●", MEDIUM: "◐", LOW: "○" };

export default function ScanResultPage() {
  const params = useParams();
  const scanId = params.id as string;
  const [data, setData] = useState<ScanResult | null>(null);
  const [polling, setPolling] = useState(true);
  const [expandedBug, setExpandedBug] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"bugs" | "flowmap" | "performance" | "pages">("bugs");

  useEffect(() => {
    if (!scanId) return;
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/scan/${scanId}`);
        const json = await res.json();
        setData(json);
        if (json.status === "completed" || json.status === "failed") setPolling(false);
      } catch { /* retry */ }
    };
    poll();
    if (polling) {
      const interval = setInterval(poll, 3000);
      return () => clearInterval(interval);
    }
  }, [scanId, polling]);

  const shortUrl = (u: string) => {
    const s = u.replace("https://", "").replace("http://", "");
    return s.length > 50 ? s.slice(0, 47) + "..." : s;
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0f0f0f", color: "#e5e5e5", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>
      {/* Header */}
      <header style={{ padding: "16px 0", borderBottom: "1px solid #2a2a2a" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <a href="/" style={{ fontFamily: "'Instrument Serif', serif", fontSize: 24, color: "#fff", textDecoration: "none" }}>FlowLens</a>
          <a href="/" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#888", textDecoration: "none" }}>← New Scan</a>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px" }}>
        {!data ? <ScanLoading /> :
         data.status === "running" ? <ScanRunning url={data.url} /> :
         data.status === "failed" ? <ScanFailed url={data.url} error={data.errors?.[0]} /> : (
          <>
            {/* Hero section: URL + Health Score */}
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
                    <span style={{ fontFamily: "'Instrument Serif', serif", fontSize: 64, color: _scoreColor(data.health_score ?? 0), lineHeight: 1 }}>{data.health_score}</span>
                    <span style={{ fontSize: 18, color: "#555" }}>/100</span>
                  </div>
                  <span style={{
                    display: "inline-block", marginTop: 4, padding: "4px 12px", fontSize: 10,
                    textTransform: "uppercase", letterSpacing: "0.1em",
                    background: _scoreBg(data.health_score ?? 0), color: _scoreColor(data.health_score ?? 0),
                    borderRadius: 3,
                  }}>
                    {(data.health_score ?? 0) >= 80 ? "Healthy" : (data.health_score ?? 0) >= 60 ? "Needs Attention" : "Critical"}
                  </span>
                </div>
              </div>

              {/* Bug summary chips */}
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
              {activeTab === "bugs" && (
                data.bugs.length === 0 ? (
                  <div style={{ padding: "60px 0", textAlign: "center" }}>
                    <p style={{ fontSize: 24, marginBottom: 8 }}>✓</p>
                    <p style={{ color: "#28c840", fontSize: 15 }}>No bugs found. Your site is looking healthy.</p>
                  </div>
                ) : (
                  <div>
                    {data.bugs.map((bug, i) => (
                      <div key={i} style={{ borderBottom: "1px solid #1f1f1f" }}>
                        {/* Bug header row */}
                        <div
                          onClick={() => setExpandedBug(expandedBug === i ? null : i)}
                          style={{
                            padding: "16px 0", cursor: "pointer", display: "flex", alignItems: "center", gap: 16,
                            transition: "background 0.1s",
                          }}
                        >
                          <span style={{ color: SEV_COLORS[bug.severity] || "#888", fontWeight: 700, width: 32, flexShrink: 0 }}>{bug.severity}</span>
                          <span style={{ color: "#555", width: 16, flexShrink: 0 }} title={`${bug.confidence} confidence`}>{CONF_DOTS[bug.confidence] || "?"}</span>
                          <span style={{ flex: 1, color: "#ddd" }}>{bug.title}</span>
                          <span style={{ color: "#555", fontSize: 11, flexShrink: 0 }}>{CAT_LABELS[bug.category] || bug.category}</span>
                          <span style={{ color: "#444", fontSize: 11, width: 60, textAlign: "right", textTransform: "uppercase", flexShrink: 0 }}>{bug.viewport}</span>
                          <span style={{ color: "#444", fontSize: 14, flexShrink: 0 }}>{expandedBug === i ? "−" : "+"}</span>
                        </div>

                        {/* Expanded bug detail */}
                        {expandedBug === i && (
                          <div style={{ padding: "0 0 24px 48px" }}>
                            {/* Description */}
                            <p style={{ color: "#999", lineHeight: 1.7, marginBottom: 20, maxWidth: 700 }}>{bug.description}</p>

                            {/* Page URL */}
                            <div style={{ marginBottom: 16 }}>
                              <span style={{ color: "#555", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>Page: </span>
                              <span style={{ color: "#888" }}>{bug.page_url}</span>
                            </div>

                            {/* Reproduction steps */}
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

                            {/* Screenshot */}
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

                            {/* Evidence details */}
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
                )
              )}

              {activeTab === "flowmap" && (
                <FlowMapView graph={data.site_graph} bugs={data.bugs} />
              )}

              {activeTab === "performance" && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(350px, 1fr))", gap: 1, background: "#2a2a2a" }}>
                  {data.metrics.map((m, i) => {
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
              )}

              {activeTab === "pages" && (
                <div>
                  {data.pages_visited.map((page, i) => (
                    <div key={i} style={{ padding: "12px 0", borderBottom: "1px solid #1f1f1f", display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ color: "#28c840", flexShrink: 0 }}>✓</span>
                      <span style={{ color: "#aaa" }}>{page}</span>
                    </div>
                  ))}
                </div>
              )}
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
        )}
      </main>
    </div>
  );
}

function ScanLoading() {
  return (
    <div style={{ textAlign: "center", padding: "120px 0" }}>
      <Spinner />
      <p style={{ color: "#666", marginTop: 20 }}>Loading scan...</p>
    </div>
  );
}

function ScanRunning({ url }: { url: string }) {
  return (
    <div style={{ textAlign: "center", padding: "120px 0" }}>
      <Spinner />
      <h2 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: "#fff", marginTop: 24, fontWeight: 400 }}>Scanning...</h2>
      <p style={{ color: "#888", marginTop: 8 }}>{url}</p>
      <p style={{ color: "#555", fontSize: 12, marginTop: 8 }}>Crawling pages · Testing viewports · Detecting bugs</p>
      <p style={{ color: "#444", fontSize: 11, marginTop: 24 }}>This usually takes 15–60 seconds</p>
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

function FlowMapView({ graph, bugs }: { graph?: SiteGraph; bugs: Bug[] }) {
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    return (
      <div style={{ padding: "60px 0", textAlign: "center", color: "#555" }}>
        <p>No flow map data available for this scan.</p>
      </div>
    );
  }

  const nodeColors = (node: GraphNode) => {
    if (node.bugs === 0) return { bg: "#0d2818", border: "#1a5c2e", dot: "#28c840" };
    if (node.max_severity === "P0" || node.max_severity === "P1") return { bg: "#2a1215", border: "#7f1d1d", dot: "#ff5f57" };
    if (node.max_severity === "P2") return { bg: "#2a2010", border: "#78350f", dot: "#febc2e" };
    return { bg: "#1a1a1a", border: "#333", dot: "#888" };
  };

  const rootNode = graph.nodes.find(n => n.path === "/" || n.path === "") || graph.nodes[0];
  const childNodes = graph.nodes.filter(n => n.id !== rootNode?.id);

  const shortPath = (path: string) => {
    if (path === "/" || path === "") return "/";
    const p = path.length > 30 ? path.slice(0, 27) + "..." : path;
    return p;
  };

  return (
    <div>
      <p style={{ color: "#555", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 24 }}>
        Site Structure · {graph.nodes.length} pages · {graph.edges.length} connections
      </p>

      {/* Root node */}
      {rootNode && (
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            display: "inline-block", padding: "16px 32px", borderRadius: 8,
            background: nodeColors(rootNode).bg, border: `2px solid ${nodeColors(rootNode).border}`,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: nodeColors(rootNode).dot, display: "inline-block" }} />
              <span style={{ color: "#fff", fontSize: 14, fontWeight: 500 }}>{rootNode.label || "/"}</span>
            </div>
            <p style={{ color: "#666", fontSize: 11, marginTop: 4 }}>{shortPath(rootNode.path)}</p>
            {rootNode.bugs > 0 && (
              <span style={{ display: "inline-block", marginTop: 6, padding: "2px 8px", fontSize: 10, background: SEV_BG[rootNode.max_severity || "P3"], color: SEV_COLORS[rootNode.max_severity || "P3"], borderRadius: 3 }}>
                {rootNode.bugs} bug{rootNode.bugs !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          {/* Connection line down */}
          {childNodes.length > 0 && (
            <div style={{ width: 1, height: 32, background: "#333", margin: "0 auto" }} />
          )}
        </div>
      )}

      {/* Child nodes in a grid */}
      {childNodes.length > 0 && (
        <>
          {/* Horizontal connector bar */}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 0 }}>
            <div style={{
              height: 1, background: "#333",
              width: `min(${Math.min(childNodes.length, 4) * 25}%, 90%)`,
            }} />
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(${Math.min(childNodes.length, 4)}, 1fr)`,
            gap: 12,
            marginTop: 0,
          }}>
            {childNodes.map((node) => {
              const colors = nodeColors(node);
              const pageBugs = bugs.filter(b => b.page_url === node.id);
              return (
                <div key={node.id} style={{ textAlign: "center" }}>
                  {/* Vertical connector */}
                  <div style={{ width: 1, height: 24, background: "#333", margin: "0 auto" }} />

                  <div style={{
                    padding: "14px 16px", borderRadius: 8,
                    background: colors.bg, border: `1px solid ${colors.border}`,
                    transition: "border-color 0.2s",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: colors.dot, display: "inline-block", flexShrink: 0 }} />
                      <span style={{ color: "#ddd", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {node.label || shortPath(node.path)}
                      </span>
                    </div>
                    <p style={{ color: "#555", fontSize: 10, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {shortPath(node.path)}
                    </p>

                    {node.bugs > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <span style={{ padding: "2px 8px", fontSize: 9, background: SEV_BG[node.max_severity || "P3"], color: SEV_COLORS[node.max_severity || "P3"], borderRadius: 3, textTransform: "uppercase" }}>
                          {node.bugs} bug{node.bugs !== 1 ? "s" : ""} · {node.max_severity}
                        </span>
                      </div>
                    )}

                    {/* Mini bug list for this page */}
                    {pageBugs.length > 0 && (
                      <div style={{ marginTop: 8, textAlign: "left" }}>
                        {pageBugs.slice(0, 3).map((b, bi) => (
                          <div key={bi} style={{ fontSize: 10, color: "#666", padding: "2px 0", borderTop: "1px solid #1f1f1f" }}>
                            <span style={{ color: SEV_COLORS[b.severity], marginRight: 4 }}>{b.severity}</span>
                            {b.title.length > 35 ? b.title.slice(0, 32) + "..." : b.title}
                          </div>
                        ))}
                        {pageBugs.length > 3 && (
                          <p style={{ fontSize: 9, color: "#444", marginTop: 2 }}>+{pageBugs.length - 3} more</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Legend */}
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

function _scoreColor(score: number): string {
  if (score >= 80) return "#28c840";
  if (score >= 60) return "#febc2e";
  return "#ff5f57";
}

function _scoreBg(score: number): string {
  if (score >= 80) return "rgba(40,200,64,0.1)";
  if (score >= 60) return "rgba(254,188,46,0.1)";
  return "rgba(255,95,87,0.1)";
}
