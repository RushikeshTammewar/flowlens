"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.flowlens.in";
const CLEARBIT_URL = "https://autocomplete.clearbit.com/v1/companies/suggest";

interface Suggestion {
  name: string;
  domain: string;
  source: "history" | "clearbit";
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [scanState, setScanState] = useState<"idle" | "loading" | "done">(
    "idle"
  );
  const [scanError, setScanError] = useState("");
  const router = useRouter();

  // Autocomplete state
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [scanHistory, setScanHistory] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const blurRef = useRef<ReturnType<typeof setTimeout>>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/v1/scans`)
      .then(r => r.json())
      .then((scans: Array<{ url: string }>) => {
        const urls = [...new Set(scans.map(s => s.url))];
        setScanHistory(urls);
      })
      .catch(() => {});
  }, []);

  const fetchSuggestions = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }

    const clean = query.replace(/^https?:\/\//, "").replace(/^www\./, "");
    const merged: Suggestion[] = [];
    const seenDomains = new Set<string>();

    const historyMatches = scanHistory.filter(u => {
      const domain = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
      return domain.toLowerCase().includes(clean.toLowerCase());
    });
    for (const u of historyMatches.slice(0, 3)) {
      const domain = u.replace(/^https?:\/\//, "").replace(/\/$/, "");
      if (!seenDomains.has(domain)) {
        seenDomains.add(domain);
        merged.push({ name: domain, domain, source: "history" });
      }
    }

    try {
      const res = await fetch(`${CLEARBIT_URL}?query=${encodeURIComponent(clean)}`);
      const results: Array<{ name: string; domain: string }> = await res.json();
      for (const r of results.slice(0, 5)) {
        if (!seenDomains.has(r.domain)) {
          seenDomains.add(r.domain);
          merged.push({ name: r.name, domain: r.domain, source: "clearbit" });
        }
      }
    } catch {}

    setSuggestions(merged);
    setHighlightIdx(-1);
    if (merged.length > 0) setShowSuggestions(true);
  }, [scanHistory]);

  const handleInputChange = (value: string) => {
    setUrl(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    debounceRef.current = setTimeout(() => fetchSuggestions(value), 250);
  };

  const selectSuggestion = (s: Suggestion) => {
    setUrl(`https://${s.domain}`);
    setShowSuggestions(false);
    setSuggestions([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) {
      if (e.key === "Enter") handleScan();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIdx >= 0) {
        selectSuggestion(suggestions[highlightIdx]);
      } else {
        setShowSuggestions(false);
        handleScan();
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  const handleScan = async () => {
    if (!url.trim()) return;
    let v = url.trim();
    if (!v.startsWith("http")) {
      v = `https://${v}`;
      setUrl(v);
    }
    setScanState("loading");
    setScanError("");
    setShowSuggestions(false);

    try {
      const res = await fetch(`${API_URL}/api/v1/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: v, max_pages: 10 }),
      });
      const data = await res.json();
      if (data.scan_id) {
        router.push(`/scan/${data.scan_id}`);
      } else {
        throw new Error("No scan ID returned");
      }
    } catch {
      setScanState("done");
      setScanError("Could not reach the scan server. We'll email your report instead.");
    }
  };

  return (
    <>
      <style jsx global>{`
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 0 24px;
        }
        .serif {
          font-family: "Instrument Serif", serif;
          font-weight: 400;
        }
        .label {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: var(--gray);
        }
        .nav-link {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--black);
          text-decoration: none;
        }
        .nav-link:hover {
          text-decoration: underline;
        }
        .btn {
          display: inline-block;
          padding: 14px 28px;
          background: var(--black);
          color: var(--white);
          font-family: "IBM Plex Mono", monospace;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          border: none;
          cursor: pointer;
          transition: background 0.2s;
          text-decoration: none;
        }
        .btn:hover:not(:disabled) {
          background: #262626;
        }
        .btn:disabled {
          background: var(--light);
          color: var(--gray);
          cursor: not-allowed;
        }
        .btn-cta {
          background: #1a5c2e;
        }
        .btn-cta:hover:not(:disabled) {
          background: #174f27;
        }
        .scan-card {
          background: #f5f5f4;
          border: 2px solid var(--light);
          border-radius: 8px;
          padding: 32px 28px;
          transition: border-color 0.2s, box-shadow 0.2s;
          box-shadow: 0 2px 12px rgba(0,0,0,0.04);
        }
        .scan-card:focus-within {
          border-color: var(--black);
          box-shadow: 0 4px 20px rgba(0,0,0,0.08);
        }
        .step-card {
          background: var(--white);
          padding: 40px 32px;
          transition: box-shadow 0.2s;
        }
        .step-card:hover {
          box-shadow: 0 2px 16px rgba(0,0,0,0.05);
        }
        .status-dot {
          width: 6px;
          height: 6px;
          background: var(--green);
          border-radius: 50%;
          display: inline-block;
          animation: pulse 2s infinite;
        }
        @keyframes pulse {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.4;
          }
        }
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (max-width: 768px) {
          .hero-grid {
            grid-template-columns: 1fr !important;
            gap: 24px !important;
          }
          .hero-title {
            font-size: 42px !important;
          }
          .steps-grid {
            grid-template-columns: 1fr !important;
          }
          .detect-grid {
            grid-template-columns: 1fr !important;
          }
          .briefing-grid {
            grid-template-columns: 1fr !important;
          }
          .footer-inner {
            flex-direction: column !important;
            gap: 12px !important;
            text-align: center !important;
          }
          .nav-links {
            display: none !important;
          }
        }
      `}</style>

      <header
        style={{
          padding: "20px 0",
          borderBottom: "1px solid var(--black)",
          position: "sticky",
          top: 0,
          background: "var(--white)",
          zIndex: 100,
        }}
      >
        <div className="container">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <a
              href="/"
              className="serif"
              style={{ fontSize: 28, letterSpacing: "-0.02em", textDecoration: "none", color: "var(--black)" }}
            >
              FlowLens
            </a>
            <nav className="nav-links" style={{ display: "flex", gap: 32 }}>
              <a href="#scan" className="nav-link" onClick={(e) => { e.preventDefault(); document.getElementById("scan")?.scrollIntoView({ behavior: "smooth" }); }}>
                Try It
              </a>
              <a href="#how" className="nav-link" onClick={(e) => { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }}>
                How It Works
              </a>
              <a href="#contact" className="nav-link" onClick={(e) => { e.preventDefault(); document.getElementById("contact")?.scrollIntoView({ behavior: "smooth" }); }}>
                Contact
              </a>
            </nav>
          </div>
        </div>
      </header>

      {/* Hero + Scan — unified hero with scan as the centerpiece */}
      <section
        id="scan"
        style={{ padding: "80px 0 60px", borderBottom: "1px solid var(--black)" }}
      >
        <div className="container">
          <div
            className="hero-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 80,
              alignItems: "start",
            }}
          >
            <div>
              <h1
                className="serif hero-title"
                style={{
                  fontSize: "clamp(42px, 7vw, 72px)",
                  lineHeight: 0.95,
                  letterSpacing: "-0.03em",
                  marginBottom: 24,
                }}
              >
                Your AI
                <br />
                <em>QA Engineer</em>
              </h1>
              <p
                style={{
                  fontSize: 15,
                  color: "var(--gray)",
                  maxWidth: 400,
                  marginBottom: 24,
                  lineHeight: 1.7,
                }}
              >
                Paste your URL. We crawl every page like a human — on desktop
                and mobile. Every day. We find the bugs, track performance, and
                send you a morning briefing of what changed.
              </p>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                }}
              >
                <span className="status-dot" />
                <span>Beta — Try it now</span>
              </div>
            </div>

            {/* Scan input — right side, prominent */}
            <div style={{ paddingTop: 16 }}>
              <p className="label" style={{ marginBottom: 20 }}>
                Scan your website
              </p>

              {scanState === "done" && scanError ? (
                <div
                  style={{
                    background: "#f5f5f4",
                    border: `2px solid var(--amber)`,
                    borderRadius: 8,
                    padding: "40px 32px",
                    textAlign: "center",
                  }}
                >
                  <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
                    Scan requested for {url}
                  </p>
                  <p style={{ fontSize: 13, color: "var(--gray)", marginBottom: 24 }}>
                    {scanError}
                  </p>
                  <button
                    className="btn"
                    onClick={() => { setUrl(""); setScanState("idle"); setScanError(""); }}
                    style={{ width: "auto" }}
                  >
                    Try Again
                  </button>
                </div>
              ) : (
                <div>
                  <div className="scan-card">
                    <p style={{ fontSize: 13, color: "var(--gray)", marginBottom: 16 }}>
                      Enter your website URL and we&apos;ll scan it for bugs, performance issues, and accessibility problems across desktop and mobile.
                    </p>
                    <div style={{ position: "relative" }}>
                      <input
                        type="url"
                        placeholder="https://yoursite.com"
                        value={url}
                        onChange={(e) => handleInputChange(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                        onBlur={() => { blurRef.current = setTimeout(() => setShowSuggestions(false), 200); }}
                        disabled={scanState === "loading"}
                        autoComplete="off"
                        style={{
                          width: "100%",
                          padding: "14px 0",
                          border: "none",
                          borderBottom: "2px solid var(--black)",
                          background: "transparent",
                          fontFamily: "'IBM Plex Mono', monospace",
                          fontSize: 16,
                          outline: "none",
                          color: "var(--black)",
                        }}
                      />

                      {showSuggestions && suggestions.length > 0 && (
                        <div
                          ref={dropdownRef}
                          style={{
                            position: "absolute",
                            top: "100%",
                            left: 0,
                            right: 0,
                            background: "#fff",
                            border: "1px solid var(--light)",
                            borderTop: "none",
                            borderRadius: "0 0 8px 8px",
                            boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
                            zIndex: 50,
                            maxHeight: 280,
                            overflowY: "auto",
                          }}
                        >
                          {suggestions.some(s => s.source === "history") && (
                            <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--gray)", padding: "8px 16px 4px", margin: 0 }}>
                              Previously scanned
                            </p>
                          )}
                          {suggestions.filter(s => s.source === "history").map((s, i) => {
                            const idx = suggestions.indexOf(s);
                            return (
                              <div
                                key={`h-${s.domain}`}
                                onMouseDown={() => { if (blurRef.current) clearTimeout(blurRef.current); selectSuggestion(s); }}
                                onMouseEnter={() => setHighlightIdx(idx)}
                                style={{
                                  padding: "10px 16px",
                                  cursor: "pointer",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                  background: highlightIdx === idx ? "#f5f5f4" : "transparent",
                                  transition: "background 0.1s",
                                }}
                              >
                                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#28c840", flexShrink: 0 }} />
                                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: "var(--black)" }}>{s.domain}</span>
                              </div>
                            );
                          })}

                          {suggestions.some(s => s.source === "clearbit") && (
                            <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--gray)", padding: "8px 16px 4px", margin: 0, borderTop: suggestions.some(s => s.source === "history") ? "1px solid var(--light)" : "none" }}>
                              Suggestions
                            </p>
                          )}
                          {suggestions.filter(s => s.source === "clearbit").map((s) => {
                            const idx = suggestions.indexOf(s);
                            return (
                              <div
                                key={`c-${s.domain}`}
                                onMouseDown={() => { if (blurRef.current) clearTimeout(blurRef.current); selectSuggestion(s); }}
                                onMouseEnter={() => setHighlightIdx(idx)}
                                style={{
                                  padding: "10px 16px",
                                  cursor: "pointer",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  background: highlightIdx === idx ? "#f5f5f4" : "transparent",
                                  transition: "background 0.1s",
                                }}
                              >
                                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: "var(--black)" }}>{s.domain}</span>
                                <span style={{ fontSize: 11, color: "var(--gray)" }}>{s.name}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
                      <p style={{ fontSize: 11, color: "var(--gray)" }}>
                        No signup required
                      </p>
                      <p style={{ fontSize: 11, color: "var(--gray)" }}>
                        Results in &lt; 5 min
                      </p>
                    </div>
                  </div>

                  <button
                    className="btn btn-cta"
                    onClick={handleScan}
                    disabled={scanState === "loading" || !url.trim()}
                    style={{ width: "100%", marginTop: 12, padding: "16px 28px" }}
                  >
                    {scanState === "loading" ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            width: 14,
                            height: 14,
                            border: "2px solid var(--gray)",
                            borderTopColor: "var(--white)",
                            borderRadius: "50%",
                            display: "inline-block",
                            animation: "spin 1s linear infinite",
                          }}
                        />
                        Scanning...
                      </span>
                    ) : (
                      "Scan Free →"
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section
        id="how"
        style={{ padding: "80px 0", borderBottom: "1px solid var(--black)" }}
      >
        <div className="container">
          <p className="label" style={{ marginBottom: 40 }}>
            How it works
          </p>
          <div
            className="steps-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 1,
              background: "var(--black)",
            }}
          >
            {[
              {
                num: "01",
                title: "Paste URL",
                desc: "Give us your website address. No scripts, no SDK, no configuration needed.",
              },
              {
                num: "02",
                title: "We Crawl",
                desc: "Our agent navigates every page like a human — desktop and mobile viewports.",
              },
              {
                num: "03",
                title: "Bugs Found",
                desc: "JS errors, broken links, slow pages, accessibility issues — caught automatically.",
              },
              {
                num: "04",
                title: "Daily Report",
                desc: "Every morning, a briefing of what changed: new bugs, fixed bugs, performance shifts.",
              },
            ].map((step) => (
              <div
                key={step.num}
                className="step-card"
              >
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--gray)",
                    marginBottom: 24,
                  }}
                >
                  {step.num}
                </p>
                <h3
                  className="serif"
                  style={{ fontSize: 24, marginBottom: 12 }}
                >
                  {step.title}
                </h3>
                <p style={{ fontSize: 13, color: "var(--gray)" }}>
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why FlowLens */}
      <section
        style={{
          padding: "80px 0",
          borderBottom: "1px solid var(--black)",
          background: "#f5f5f4",
        }}
      >
        <div className="container">
          <p className="label" style={{ marginBottom: 40 }}>
            Why FlowLens
          </p>
          <div
            className="hero-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 60,
              alignItems: "start",
            }}
          >
            <div>
              <h2
                className="serif"
                style={{ fontSize: 36, marginBottom: 16, letterSpacing: "-0.02em" }}
              >
                Not a scanner.
                <br />
                A <em>service</em>.
              </h2>
              <p style={{ color: "var(--gray)", fontSize: 14, maxWidth: 380, lineHeight: 1.7 }}>
                Most testing tools scan once and give you a report. FlowLens
                guards your site every day of the year — tracking bugs over
                time, detecting regressions after deploys, and alerting you the
                moment something breaks. Like having a QA engineer on your team
                who never takes a day off.
              </p>
            </div>
            <div>
              {[
                {
                  title: "Autonomous flow discovery",
                  desc: "No test scripts needed. FlowLens discovers every navigable flow on your site automatically — login, checkout, search, settings.",
                },
                {
                  title: "Continuous daily monitoring",
                  desc: "Your site is scanned every day. Changes are tracked over time. You always know if things are getting better or worse.",
                },
                {
                  title: "Health score & trends",
                  desc: "A single score (0–100) that tells you your site's quality. Tracked daily. Show it in standups. Rally the team around it.",
                },
                {
                  title: "Multi-viewport testing",
                  desc: "Every page tested on desktop, tablet, and mobile. Responsive bugs caught before your users hit them.",
                },
                {
                  title: "Bug lifecycle tracking",
                  desc: "Every bug has a birthday, an age, and a death date. Know when it appeared, how long it's been open, and when it was fixed.",
                },
                {
                  title: "Deploy correlation",
                  desc: "Connect your CI/CD. When a regression appears, FlowLens tells you which deploy caused it.",
                },
              ].map((f) => (
                <div
                  key={f.title}
                  style={{
                    padding: "14px 0",
                    borderBottom: "1px solid var(--light)",
                  }}
                >
                  <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    {f.title}
                  </p>
                  <p style={{ fontSize: 12, color: "var(--gray)", lineHeight: 1.6 }}>
                    {f.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* What We Detect */}
      <section
        style={{
          padding: "80px 0",
          borderBottom: "1px solid var(--black)",
          background: "#f5f5f4",
        }}
      >
        <div className="container">
          <p className="label" style={{ marginBottom: 40 }}>
            What we detect
          </p>
          <div
            className="detect-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 40,
              alignItems: "start",
            }}
          >
            <div>
              <h2
                className="serif"
                style={{
                  fontSize: 36,
                  marginBottom: 16,
                  letterSpacing: "-0.02em",
                }}
              >
                20+ bug types.
                <br />
                Zero guessing.
              </h2>
              <p
                style={{
                  color: "var(--gray)",
                  fontSize: 14,
                  maxWidth: 380,
                }}
              >
                Deterministic detection — if the condition is true, it&apos;s a
                bug. No AI hallucinations. Every finding comes with evidence.
              </p>
            </div>
            <div>
              {[
                {
                  label: "Functional",
                  items: "JS errors · Broken links · HTTP 500s · Broken images · Mixed content",
                },
                {
                  label: "Performance",
                  items: "Slow pages · Web Vitals (LCP, CLS, FCP) · DOM bloat · Large transfers",
                },
                {
                  label: "Responsive",
                  items: "Horizontal overflow · Small touch targets · Mobile layout breaks",
                },
                {
                  label: "Accessibility",
                  items: "Missing alt text · No form labels · Missing lang · No page title",
                },
              ].map((cat) => (
                <div
                  key={cat.label}
                  style={{
                    padding: "16px 0",
                    borderBottom: "1px solid var(--light)",
                  }}
                >
                  <p
                    style={{
                      fontSize: 12,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      marginBottom: 6,
                    }}
                  >
                    {cat.label}
                  </p>
                  <p style={{ fontSize: 13, color: "var(--gray)" }}>
                    {cat.items}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Daily Briefing Preview */}
      <section
        style={{ padding: "80px 0", borderBottom: "1px solid var(--black)" }}
      >
        <div className="container">
          <p className="label" style={{ marginBottom: 16 }}>
            Your morning briefing
          </p>
          <h2
            className="serif"
            style={{
              fontSize: 36,
              marginBottom: 8,
              letterSpacing: "-0.02em",
            }}
          >
            Wake up to <em>clarity</em>
          </h2>
          <p
            style={{
              color: "var(--gray)",
              fontSize: 14,
              maxWidth: 520,
              marginBottom: 48,
              lineHeight: 1.7,
            }}
          >
            Every morning, FlowLens sends you a briefing of what changed
            overnight. New bugs, fixed bugs, performance shifts. Like a
            standup report from a QA engineer who worked the night shift.
          </p>

          {/* Briefing mock — full width, looks like a real product UI */}
          <div
            style={{
              background: "#1a1a1a",
              borderRadius: 10,
              overflow: "hidden",
              boxShadow: "0 8px 40px rgba(0,0,0,0.15)",
            }}
          >
            {/* Terminal-style header bar */}
            <div
              style={{
                padding: "12px 20px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                borderBottom: "1px solid #333",
              }}
            >
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57" }} />
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#febc2e" }} />
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840" }} />
              <span style={{ fontSize: 12, color: "#666", marginLeft: 12, fontFamily: "'IBM Plex Mono', monospace" }}>
                FlowLens Daily — myapp.com
              </span>
            </div>

            {/* Briefing content */}
            <div style={{ padding: "32px 32px 40px" }}>
              {/* Health score — prominent */}
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                  marginBottom: 32,
                }}
              >
                <span
                  className="serif"
                  style={{ fontSize: 56, color: "#fff", letterSpacing: "-0.03em" }}
                >
                  78
                </span>
                <span style={{ fontSize: 18, color: "#666" }}>/100</span>
                <span style={{ fontSize: 14, color: "#28c840", marginLeft: 8 }}>↑ 3</span>
                <span style={{ fontSize: 12, color: "#666", marginLeft: "auto" }}>
                  Feb 21, 2026 · 847 pages · 14 flows
                </span>
              </div>

              {/* Three columns: New / Fixed / Performance */}
              <div
                className="briefing-grid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 1,
                  background: "#333",
                }}
              >
                {/* New bugs */}
                <div style={{ background: "#1a1a1a", padding: "24px" }}>
                  <div
                    style={{
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: "#ff5f57",
                      marginBottom: 16,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#ff5f57", display: "inline-block" }} />
                    New Bugs (2)
                  </div>
                  <div style={{ fontSize: 13, color: "#ccc", lineHeight: 2.0 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={{ color: "#ff5f57", fontWeight: 600, flexShrink: 0 }}>P1</span>
                      <span>Checkout button unresponsive on mobile</span>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={{ color: "#febc2e", fontWeight: 600, flexShrink: 0 }}>P2</span>
                      <span>/pricing hero image returns 404</span>
                    </div>
                  </div>
                </div>

                {/* Fixed */}
                <div style={{ background: "#1a1a1a", padding: "24px" }}>
                  <div
                    style={{
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: "#28c840",
                      marginBottom: 16,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#28c840", display: "inline-block" }} />
                    Fixed (3)
                  </div>
                  <div style={{ fontSize: 13, color: "#888", lineHeight: 2.0 }}>
                    <div>✓ Login redirect loop on Safari</div>
                    <div>✓ Footer overlap on tablet</div>
                    <div>✓ Missing alt text on /about</div>
                  </div>
                </div>

                {/* Performance */}
                <div style={{ background: "#1a1a1a", padding: "24px" }}>
                  <div
                    style={{
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: "#888",
                      marginBottom: 16,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#888", display: "inline-block" }} />
                    Performance
                  </div>
                  <div style={{ fontSize: 13, color: "#ccc", lineHeight: 2.0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>/checkout</span>
                      <span style={{ color: "#ff5f57" }}>2.8s ↑</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>/homepage</span>
                      <span style={{ color: "#28c840" }}>1.9s ↓</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>/search</span>
                      <span style={{ color: "#888" }}>0.8s —</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Persistent bugs warning */}
              <div
                style={{
                  marginTop: 24,
                  padding: "14px 20px",
                  background: "rgba(254, 188, 46, 0.08)",
                  border: "1px solid rgba(254, 188, 46, 0.2)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "#febc2e",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span>⚠</span>
                <span>
                  <strong>Persistent:</strong> Signup form 500 error — open for 12 days
                </span>
              </div>
            </div>
          </div>

          <p
            style={{
              color: "var(--gray)",
              fontSize: 12,
              marginTop: 20,
              textAlign: "center",
            }}
          >
            Delivered to your inbox and Slack every morning. A senior QA engineer costs $120K/year — FlowLens does this daily.
          </p>
        </div>
      </section>

      {/* CTA — conversion block */}
      <section
        style={{
          padding: "80px 0",
          borderBottom: "1px solid var(--black)",
          background: "var(--black)",
          color: "var(--white)",
        }}
      >
        <div className="container" style={{ textAlign: "center", maxWidth: 640 }}>
          <h2
            className="serif"
            style={{
              fontSize: "clamp(28px, 4vw, 42px)",
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
              marginBottom: 16,
            }}
          >
            Stop shipping bugs to production
          </h2>
          <p
            style={{
              fontSize: 14,
              color: "#a3a3a3",
              marginBottom: 32,
              lineHeight: 1.7,
            }}
          >
            Paste your URL. Get your first scan in 5 minutes. Wake up to a
            daily briefing tomorrow morning. No signup, no credit card.
          </p>
          <a
            href="#scan"
            onClick={(e) => { e.preventDefault(); document.getElementById("scan")?.scrollIntoView({ behavior: "smooth" }); }}
            className="btn"
            style={{
              background: "#1a5c2e",
              padding: "16px 40px",
              fontSize: 13,
            }}
          >
            Scan Your Site Free →
          </a>
        </div>
      </section>

      {/* Contact */}
      <section id="contact" style={{ padding: "80px 0" }}>
        <div className="container">
          <div
            className="briefing-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 80,
            }}
          >
            <div>
              <h2
                className="serif"
                style={{
                  fontSize: "clamp(32px, 5vw, 48px)",
                  lineHeight: 1.1,
                  letterSpacing: "-0.02em",
                }}
              >
                Questions or early access?
              </h2>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
              }}
            >
              <p
                style={{
                  fontSize: 14,
                  color: "var(--gray)",
                  marginBottom: 24,
                  maxWidth: 320,
                }}
              >
                We&apos;re onboarding select teams for our beta. Get in touch to
                try FlowLens on your site.
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: "var(--gray)",
                  marginBottom: 24,
                }}
              >
                contact@flowlens.in
              </p>
              <a
                href="mailto:contact@flowlens.in"
                className="btn"
                style={{ width: "auto", display: "inline-block", textAlign: "center" }}
              >
                Send an email
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer
        style={{ padding: "24px 0", borderTop: "1px solid var(--black)" }}
      >
        <div className="container">
          <div
            className="footer-inner"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 12, color: "var(--gray)" }}>
              © 2026 FlowLens
            </span>
            <span style={{ fontSize: 12, color: "var(--gray)" }}>
              Built by Rushikesh Tammewar
            </span>
            <a
              href="mailto:contact@flowlens.in"
              style={{
                fontSize: 12,
                color: "var(--gray)",
                textDecoration: "none",
              }}
            >
              contact@flowlens.in
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
