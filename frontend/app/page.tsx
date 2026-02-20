"use client";

import { useState } from "react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [scanState, setScanState] = useState<"idle" | "loading" | "done">(
    "idle"
  );

  const handleScan = () => {
    if (!url.trim()) return;
    let v = url.trim();
    if (!v.startsWith("http")) {
      v = `https://${v}`;
      setUrl(v);
    }
    setScanState("loading");
    setTimeout(() => setScanState("done"), 2200);
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

              {scanState === "done" ? (
                <div
                  style={{
                    background: "#f5f5f4",
                    border: `2px solid var(--green)`,
                    borderRadius: 8,
                    padding: "40px 32px",
                    textAlign: "center",
                  }}
                >
                  <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
                    ✓ Scan requested
                  </p>
                  <p style={{ fontSize: 13, color: "var(--gray)", marginBottom: 4 }}>
                    {url}
                  </p>
                  <p style={{ fontSize: 12, color: "var(--gray)", marginBottom: 24 }}>
                    We&apos;ll email your health report to contact@flowlens.in within 24 hours.
                  </p>
                  <button
                    className="btn"
                    onClick={() => { setUrl(""); setScanState("idle"); }}
                    style={{ width: "auto" }}
                  >
                    Scan Another Site
                  </button>
                </div>
              ) : (
                <div>
                  <div
                    style={{
                      background: "#f5f5f4",
                      border: "2px solid var(--light)",
                      borderRadius: 8,
                      padding: "32px 28px",
                      transition: "border-color 0.2s",
                    }}
                  >
                    <p style={{ fontSize: 13, color: "var(--gray)", marginBottom: 16 }}>
                      Enter your website URL and we&apos;ll scan it for bugs, performance issues, and accessibility problems across desktop and mobile.
                    </p>
                    <input
                      type="url"
                      placeholder="https://yoursite.com"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleScan()}
                      disabled={scanState === "loading"}
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
                    className="btn"
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
                style={{
                  background: "var(--white)",
                  padding: "40px 32px",
                }}
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
          <p className="label" style={{ marginBottom: 40 }}>
            Your morning briefing
          </p>
          <div
            className="briefing-grid"
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
                style={{
                  fontSize: 36,
                  marginBottom: 16,
                  letterSpacing: "-0.02em",
                }}
              >
                Wake up to
                <br />
                <em>clarity</em>
              </h2>
              <p
                style={{
                  color: "var(--gray)",
                  fontSize: 14,
                  maxWidth: 340,
                  marginBottom: 24,
                }}
              >
                Every day, FlowLens sends you a briefing of what changed on your
                site overnight. New bugs, fixed bugs, performance shifts — all
                in one message.
              </p>
              <p
                style={{
                  color: "var(--gray)",
                  fontSize: 13,
                }}
              >
                A senior QA engineer costs $120K/year.
                <br />
                FlowLens does the same job, every day.
              </p>
            </div>

            <div
              style={{
                background: "var(--white)",
                border: "1px solid var(--light)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "12px 20px",
                  borderBottom: "1px solid var(--light)",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: "var(--gray)",
                }}
              >
                FlowLens Daily — myapp.com — Feb 21
              </div>
              <div
                style={{
                  padding: 20,
                  fontSize: 13,
                  lineHeight: 1.7,
                }}
              >
                <p style={{ color: "var(--gray)", marginBottom: 16 }}>
                  I tested 847 pages across 14 flows last night.
                </p>
                <p style={{ marginBottom: 4 }}>
                  <strong>Health:</strong>{" "}
                  <span style={{ color: "var(--green)" }}>78/100 ↑3</span>
                </p>
                <div style={{ marginTop: 16 }}>
                  <p style={{ color: "var(--red)", fontWeight: 500, marginBottom: 4 }}>
                    New (2):
                  </p>
                  <p style={{ color: "var(--gray)", paddingLeft: 12 }}>
                    P1 — Checkout btn unresponsive on mobile
                    <br />
                    P2 — /pricing hero image 404
                  </p>
                </div>
                <div style={{ marginTop: 12 }}>
                  <p style={{ color: "var(--green)", fontWeight: 500, marginBottom: 4 }}>
                    Fixed (3):
                  </p>
                  <p style={{ color: "var(--gray)", paddingLeft: 12 }}>
                    ✓ Login redirect loop
                    <br />
                    ✓ Footer overlap on tablet
                    <br />✓ Missing alt on /about
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Contact */}
      <section id="contact" style={{ padding: "100px 0" }}>
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
