"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface Bug {
  title: string;
  category: string;
  severity: string;
  confidence: string;
  page_url: string;
  viewport: string;
  description: string;
}

interface Metric {
  url: string;
  viewport: string;
  load_time_ms: number;
  fcp_ms: number | null;
  dom_node_count: number;
}

interface ScanResult {
  scan_id: string;
  status: string;
  url: string;
  started_at: string;
  health_score: number | null;
  pages_tested: number;
  bugs: Bug[];
  metrics: Metric[];
  pages_visited: string[];
  errors: string[];
}

export default function ScanResultPage() {
  const params = useParams();
  const scanId = params.id as string;
  const [data, setData] = useState<ScanResult | null>(null);
  const [polling, setPolling] = useState(true);

  useEffect(() => {
    if (!scanId) return;

    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/scan/${scanId}`);
        const json = await res.json();
        setData(json);
        if (json.status === "completed" || json.status === "failed") {
          setPolling(false);
        }
      } catch {
        /* retry */
      }
    };

    poll();
    if (polling) {
      const interval = setInterval(poll, 3000);
      return () => clearInterval(interval);
    }
  }, [scanId, polling]);

  return (
    <>
      <style jsx global>{`
        .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
        .serif { font-family: "Instrument Serif", serif; font-weight: 400; }
        .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #737373; }
        @media (max-width: 768px) {
          .metrics-grid { grid-template-columns: 1fr !important; }
          .bug-row { flex-direction: column !important; gap: 4px !important; }
        }
      `}</style>

      <header style={{ padding: "20px 0", borderBottom: "1px solid #0f0f0f", background: "#fafaf9" }}>
        <div className="container" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <a href="/" className="serif" style={{ fontSize: 28, letterSpacing: "-0.02em", textDecoration: "none", color: "#0f0f0f" }}>
            FlowLens
          </a>
          <a href="/" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", textDecoration: "none", color: "#0f0f0f" }}>
            ← New Scan
          </a>
        </div>
      </header>

      <main style={{ padding: "60px 0 100px" }}>
        <div className="container">
          {!data ? (
            <LoadingState />
          ) : data.status === "running" ? (
            <RunningState url={data.url} />
          ) : data.status === "failed" ? (
            <FailedState url={data.url} error={data.errors?.[0]} />
          ) : (
            <CompletedState data={data} />
          )}
        </div>
      </main>

      <footer style={{ padding: "24px 0", borderTop: "1px solid #0f0f0f" }}>
        <div className="container" style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#737373" }}>
          <span>© 2026 FlowLens</span>
          <a href="mailto:contact@flowlens.in" style={{ color: "#737373", textDecoration: "none" }}>contact@flowlens.in</a>
        </div>
      </footer>
    </>
  );
}

function LoadingState() {
  return (
    <div style={{ textAlign: "center", padding: "80px 0" }}>
      <div style={{ width: 40, height: 40, border: "3px solid #e7e5e4", borderTopColor: "#0f0f0f", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 24px" }} />
      <p style={{ color: "#737373" }}>Loading scan...</p>
      <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function RunningState({ url }: { url: string }) {
  return (
    <div style={{ textAlign: "center", padding: "80px 0" }}>
      <div style={{ width: 48, height: 48, border: "3px solid #e7e5e4", borderTopColor: "#0f0f0f", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 24px" }} />
      <h2 className="serif" style={{ fontSize: 28, marginBottom: 8 }}>Scanning {url}</h2>
      <p style={{ color: "#737373", fontSize: 14 }}>Crawling pages, testing viewports, detecting bugs...</p>
      <p style={{ color: "#737373", fontSize: 12, marginTop: 8 }}>This usually takes 15–60 seconds.</p>
      <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function FailedState({ url, error }: { url: string; error?: string }) {
  return (
    <div style={{ textAlign: "center", padding: "80px 0" }}>
      <p style={{ fontSize: 32, marginBottom: 16 }}>⚠</p>
      <h2 className="serif" style={{ fontSize: 28, marginBottom: 8 }}>Scan failed</h2>
      <p style={{ color: "#737373", fontSize: 14, marginBottom: 8 }}>{url}</p>
      {error && <p style={{ color: "#dc2626", fontSize: 13, maxWidth: 400, margin: "0 auto" }}>{error}</p>}
      <a href="/" style={{ display: "inline-block", marginTop: 24, padding: "14px 28px", background: "#0f0f0f", color: "#fafaf9", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", textDecoration: "none" }}>
        Try Again
      </a>
    </div>
  );
}

function CompletedState({ data }: { data: ScanResult }) {
  const sevColors: Record<string, string> = { P0: "#dc2626", P1: "#dc2626", P2: "#b45309", P3: "#737373", P4: "#a3a3a3" };
  const confLabels: Record<string, string> = { HIGH: "●", MEDIUM: "◐", LOW: "○" };

  const shortUrl = (u: string) => {
    const s = u.replace("https://", "").replace("http://", "");
    return s.length > 45 ? s.slice(0, 42) + "..." : s;
  };

  return (
    <>
      {/* Header */}
      <p className="label" style={{ marginBottom: 8 }}>Scan Report</p>
      <h1 className="serif" style={{ fontSize: 36, marginBottom: 4, letterSpacing: "-0.02em" }}>
        {shortUrl(data.url)}
      </h1>
      <p style={{ fontSize: 13, color: "#737373", marginBottom: 48 }}>
        {data.pages_tested} pages tested · {data.bugs.length} bugs found · {new Date(data.started_at).toLocaleString()}
      </p>

      {/* Health Score */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 48, borderBottom: "1px solid #0f0f0f", paddingBottom: 48 }}>
        <span className="serif" style={{ fontSize: 72, letterSpacing: "-0.03em" }}>
          {data.health_score}
        </span>
        <span style={{ fontSize: 24, color: "#737373" }}>/100</span>
        <span style={{ fontSize: 13, color: "#737373", marginLeft: 16 }}>Health Score</span>
        <span style={{
          marginLeft: "auto",
          padding: "6px 16px",
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          background: (data.health_score ?? 0) >= 80 ? "#f0fdf4" : (data.health_score ?? 0) >= 60 ? "#fffbeb" : "#fef2f2",
          color: (data.health_score ?? 0) >= 80 ? "#16a34a" : (data.health_score ?? 0) >= 60 ? "#b45309" : "#dc2626",
        }}>
          {(data.health_score ?? 0) >= 80 ? "Healthy" : (data.health_score ?? 0) >= 60 ? "Needs Attention" : "Critical"}
        </span>
      </div>

      {/* Bugs */}
      <p className="label" style={{ marginBottom: 20 }}>
        Bugs ({data.bugs.length})
      </p>

      {data.bugs.length === 0 ? (
        <div style={{ padding: "40px 0", borderBottom: "1px solid #e7e5e4", marginBottom: 48, color: "#16a34a", fontSize: 14 }}>
          ✓ No bugs found. Your site is looking healthy.
        </div>
      ) : (
        <div style={{ marginBottom: 48 }}>
          {data.bugs.map((bug, i) => (
            <div
              key={i}
              className="bug-row"
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 16,
                padding: "14px 0",
                borderBottom: "1px solid #e7e5e4",
                fontSize: 13,
              }}
            >
              <span style={{ color: sevColors[bug.severity] || "#737373", fontWeight: 600, flexShrink: 0, width: 28 }}>
                {bug.severity}
              </span>
              <span style={{ flexShrink: 0, width: 14, color: "#737373" }} title={bug.confidence}>
                {confLabels[bug.confidence] || "?"}
              </span>
              <span style={{ flex: 1 }}>{bug.title}</span>
              <span style={{ color: "#737373", flexShrink: 0, fontSize: 12 }}>
                {shortUrl(bug.page_url)}
              </span>
              <span style={{ color: "#a3a3a3", flexShrink: 0, fontSize: 11, textTransform: "uppercase", width: 60, textAlign: "right" }}>
                {bug.viewport}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Performance */}
      {data.metrics.length > 0 && (
        <>
          <p className="label" style={{ marginBottom: 20 }}>
            Performance
          </p>
          <div
            className="metrics-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 1,
              background: "#0f0f0f",
              marginBottom: 48,
            }}
          >
            {data.metrics.map((m, i) => {
              const loadColor = m.load_time_ms < 3000 ? "#16a34a" : m.load_time_ms < 5000 ? "#b45309" : "#dc2626";
              return (
                <div key={i} style={{ background: "#fafaf9", padding: "24px" }}>
                  <p style={{ fontSize: 12, color: "#737373", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {shortUrl(m.url)} · {m.viewport}
                  </p>
                  <div style={{ display: "flex", gap: 32 }}>
                    <div>
                      <p className="serif" style={{ fontSize: 28, color: loadColor }}>{m.load_time_ms}ms</p>
                      <p style={{ fontSize: 11, color: "#737373" }}>Load time</p>
                    </div>
                    {m.fcp_ms && (
                      <div>
                        <p className="serif" style={{ fontSize: 28 }}>{m.fcp_ms}ms</p>
                        <p style={{ fontSize: 11, color: "#737373" }}>FCP</p>
                      </div>
                    )}
                    <div>
                      <p className="serif" style={{ fontSize: 28 }}>{m.dom_node_count}</p>
                      <p style={{ fontSize: 11, color: "#737373" }}>DOM nodes</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Pages Visited */}
      <p className="label" style={{ marginBottom: 12 }}>
        Pages crawled ({data.pages_visited.length})
      </p>
      <div style={{ marginBottom: 48 }}>
        {data.pages_visited.map((page, i) => (
          <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid #e7e5e4", fontSize: 13, color: "#737373" }}>
            {page}
          </div>
        ))}
      </div>

      {/* CTA */}
      <div style={{ textAlign: "center", padding: "40px 0" }}>
        <p style={{ fontSize: 14, color: "#737373", marginBottom: 16 }}>
          Want this report every morning? FlowLens monitors your site daily.
        </p>
        <a href="mailto:contact@flowlens.in?subject=FlowLens Beta Access" style={{ display: "inline-block", padding: "14px 32px", background: "#1a5c2e", color: "#fafaf9", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", textDecoration: "none" }}>
          Get Daily Monitoring →
        </a>
      </div>
    </>
  );
}
