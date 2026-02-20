"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Shield,
  Search,
  BarChart3,
  Smartphone,
  Bell,
  Zap,
  ArrowRight,
  CheckCircle2,
  Clock,
  Bug,
  TrendingUp,
  Monitor,
} from "lucide-react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [scanState, setScanState] = useState<"idle" | "loading" | "done">("idle");

  const handleScan = () => {
    if (!url.trim()) return;
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith("http")) {
      normalizedUrl = `https://${normalizedUrl}`;
      setUrl(normalizedUrl);
    }
    setScanState("loading");
    setTimeout(() => setScanState("done"), 2000);
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      <Nav />
      <Hero url={url} setUrl={setUrl} scanState={scanState} onScan={handleScan} />
      <HowItWorks />
      <Features />
      <DailyBriefingPreview />
      <WhatWeDetect />
      <CTA />
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <nav
      className="fixed top-0 w-full z-50 border-b backdrop-blur-md"
      style={{
        borderColor: "var(--border)",
        background: "rgba(250, 250, 248, 0.85)",
      }}
    >
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={20} style={{ color: "var(--accent)" }} />
          <span className="font-semibold text-[15px]">FlowLens</span>
        </div>
        <div className="flex items-center gap-6">
          <a
            href="#how-it-works"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" });
            }}
            className="text-sm hidden sm:block hover:opacity-70 transition-opacity"
            style={{ color: "var(--text-secondary)" }}
          >
            How it works
          </a>
          <a
            href="#features"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
            }}
            className="text-sm hidden sm:block hover:opacity-70 transition-opacity"
            style={{ color: "var(--text-secondary)" }}
          >
            Features
          </a>
          <a
            href="#scan"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("scan")?.scrollIntoView({ behavior: "smooth" });
            }}
            className="text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
            style={{
              background: "var(--accent)",
              color: "#fff",
            }}
          >
            Scan Free
          </a>
        </div>
      </div>
    </nav>
  );
}

function Hero({
  url,
  setUrl,
  scanState,
  onScan,
}: {
  url: string;
  setUrl: (u: string) => void;
  scanState: "idle" | "loading" | "done";
  onScan: () => void;
}) {
  return (
    <section className="pt-32 pb-20 px-6" id="scan">
      <div className="max-w-3xl mx-auto text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-6"
            style={{
              background: "var(--accent-light)",
              color: "var(--accent)",
            }}
          >
            <Zap size={12} />
            Your AI QA Engineer
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-tight mb-4">
            Test every flow on your site.
            <br />
            <span style={{ color: "var(--accent)" }}>Every single day.</span>
          </h1>

          <p
            className="text-lg leading-relaxed max-w-xl mx-auto mb-10"
            style={{ color: "var(--text-secondary)" }}
          >
            FlowLens crawls your website daily, detects bugs, tracks
            performance, and sends you a morning briefing — like a dedicated QA
            engineer who never sleeps.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          {scanState === "done" ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="max-w-lg mx-auto p-6 rounded-xl text-center"
              style={{
                background: "var(--success-light)",
                border: "1px solid var(--accent-muted)",
              }}
            >
              <CheckCircle2
                size={32}
                className="mx-auto mb-3"
                style={{ color: "var(--accent)" }}
              />
              <p className="font-semibold text-[15px] mb-1">
                Scan requested for {url}
              </p>
              <p
                className="text-sm"
                style={{ color: "var(--text-secondary)" }}
              >
                We&apos;ll email your full health report to{" "}
                <span className="font-medium">contact@flowlens.in</span> within
                24 hours.
              </p>
              <button
                onClick={() => {
                  setUrl("");
                  onScan(); // reset handled by parent
                  window.location.reload();
                }}
                className="mt-4 text-sm font-medium cursor-pointer"
                style={{ color: "var(--accent)" }}
              >
                Scan another site
              </button>
            </motion.div>
          ) : (
            <>
              <div
                className="flex flex-col sm:flex-row gap-3 max-w-lg mx-auto p-2 rounded-xl"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}
              >
                <input
                  type="url"
                  placeholder="https://yoursite.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && onScan()}
                  disabled={scanState === "loading"}
                  className="flex-1 px-4 py-3 text-[15px] rounded-lg outline-none placeholder:text-[var(--text-tertiary)] disabled:opacity-60"
                  style={{ background: "var(--bg)" }}
                />
                <button
                  onClick={onScan}
                  disabled={scanState === "loading" || !url.trim()}
                  className="px-6 py-3 rounded-lg font-medium text-[15px] text-white transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{ background: "var(--accent)" }}
                  onMouseEnter={(e) => {
                    if (scanState !== "loading")
                      e.currentTarget.style.background = "var(--accent-hover)";
                  }}
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "var(--accent)")
                  }
                >
                  {scanState === "loading" ? (
                    <>
                      <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                      Scanning...
                    </>
                  ) : (
                    <>
                      Scan Free
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </div>
              <p
                className="text-xs mt-3"
                style={{ color: "var(--text-tertiary)" }}
              >
                {scanState === "loading"
                  ? "Analyzing your site..."
                  : "No signup required. Results in under 5 minutes."}
              </p>
            </>
          )}
        </motion.div>

        <motion.div
          className="mt-16 grid grid-cols-3 gap-6 max-w-md mx-auto"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.4 }}
        >
          {[
            { number: "20+", label: "Bug types detected" },
            { number: "3", label: "Viewports tested" },
            { number: "< 5min", label: "Time to first report" },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-xl font-bold" style={{ color: "var(--accent)" }}>
                {stat.number}
              </div>
              <div
                className="text-xs mt-0.5"
                style={{ color: "var(--text-tertiary)" }}
              >
                {stat.label}
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      icon: Search,
      title: "Paste your URL",
      description: "Just give us your website address. No scripts, no SDK, no setup.",
    },
    {
      icon: Monitor,
      title: "We crawl like a human",
      description: "Our agent navigates every page, clicks buttons, fills forms — on desktop and mobile.",
    },
    {
      icon: Bug,
      title: "Bugs are detected",
      description: "JS errors, broken links, slow pages, accessibility issues, responsive breakage — caught automatically.",
    },
    {
      icon: Bell,
      title: "You get a morning briefing",
      description: "Every day, a summary of what changed: new bugs, fixed bugs, performance shifts.",
    },
  ];

  return (
    <section className="py-20 px-6" id="how-it-works">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-2xl font-bold mb-3">How it works</h2>
          <p style={{ color: "var(--text-secondary)" }}>
            Four steps. Zero configuration.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {steps.map((step, i) => (
            <motion.div
              key={step.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: i * 0.1 }}
              className="p-5 rounded-xl"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border-light)",
              }}
            >
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center mb-4"
                style={{
                  background: "var(--accent-light)",
                  color: "var(--accent)",
                }}
              >
                <step.icon size={18} />
              </div>
              <div
                className="text-xs font-medium mb-2"
                style={{ color: "var(--text-tertiary)" }}
              >
                Step {i + 1}
              </div>
              <h3 className="font-semibold text-[15px] mb-1.5">{step.title}</h3>
              <p
                className="text-sm leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
              >
                {step.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Features() {
  const features = [
    {
      icon: Shield,
      title: "Autonomous flow discovery",
      description: "No test scripts needed. FlowLens discovers every navigable flow on your site automatically.",
    },
    {
      icon: Clock,
      title: "Daily monitoring",
      description: "Your site is scanned every day. Not once — continuously. Changes are tracked over time.",
    },
    {
      icon: TrendingUp,
      title: "Health score & trends",
      description: "A single score (0-100) that tells you if your site is getting better or worse. Tracked daily.",
    },
    {
      icon: Smartphone,
      title: "Multi-viewport testing",
      description: "Every page tested on desktop, tablet, and mobile. Responsive bugs caught automatically.",
    },
    {
      icon: BarChart3,
      title: "Performance tracking",
      description: "Page load times, Web Vitals, and resource sizes — tracked per page, per day, over time.",
    },
    {
      icon: Bell,
      title: "Morning briefing",
      description: "A daily summary in your inbox: new bugs, fixed bugs, performance shifts, health score change.",
    },
  ];

  return (
    <section
      className="py-20 px-6"
      id="features"
      style={{ background: "var(--surface)" }}
    >
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-2xl font-bold mb-3">
            Like hiring a QA engineer — for a fraction of the cost
          </h2>
          <p style={{ color: "var(--text-secondary)" }}>
            A senior QA engineer costs $120K/year. FlowLens does the same job,
            every day, without missing a beat.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 15 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: i * 0.05 }}
              className="p-5 rounded-xl"
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border-light)",
              }}
            >
              <feature.icon
                size={18}
                className="mb-3"
                style={{ color: "var(--accent)" }}
              />
              <h3 className="font-semibold text-[15px] mb-1.5">
                {feature.title}
              </h3>
              <p
                className="text-sm leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
              >
                {feature.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DailyBriefingPreview() {
  return (
    <section className="py-20 px-6">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-10">
          <h2 className="text-2xl font-bold mb-3">
            Your morning starts with clarity
          </h2>
          <p style={{ color: "var(--text-secondary)" }}>
            Every day, FlowLens sends you a briefing of what changed on your
            site overnight.
          </p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="rounded-xl overflow-hidden"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
          }}
        >
          <div
            className="px-5 py-3 text-xs font-medium flex items-center gap-2"
            style={{
              borderBottom: "1px solid var(--border-light)",
              color: "var(--text-tertiary)",
            }}
          >
            <Bell size={12} />
            FlowLens Daily Briefing — myapp.com — Feb 21, 2026
          </div>
          <div className="p-5 font-mono text-[13px] leading-relaxed space-y-4">
            <p style={{ color: "var(--text-secondary)" }}>
              Hey team, I tested 847 pages across 14 flows last night.
            </p>

            <div>
              <span className="font-semibold">Site Health: </span>
              <span style={{ color: "var(--success)" }} className="font-bold">
                78/100
              </span>
              <span style={{ color: "var(--success)" }}> ↑ 3</span>
            </div>

            <div>
              <div className="font-semibold mb-1" style={{ color: "var(--critical)" }}>
                New Bugs (2):
              </div>
              <div className="ml-3 space-y-1" style={{ color: "var(--text-secondary)" }}>
                <div>
                  <span style={{ color: "var(--critical)" }}>P1</span> Checkout
                  button unresponsive on mobile
                </div>
                <div>
                  <span style={{ color: "var(--warning)" }}>P2</span> /pricing
                  hero image returns 404
                </div>
              </div>
            </div>

            <div>
              <div className="font-semibold mb-1" style={{ color: "var(--success)" }}>
                Fixed (3):
              </div>
              <div className="ml-3 space-y-1" style={{ color: "var(--text-tertiary)" }}>
                <div>
                  <CheckCircle2
                    size={12}
                    className="inline mr-1"
                    style={{ color: "var(--success)" }}
                  />
                  Login redirect loop on Safari
                </div>
                <div>
                  <CheckCircle2
                    size={12}
                    className="inline mr-1"
                    style={{ color: "var(--success)" }}
                  />
                  Footer overlap on tablet
                </div>
                <div>
                  <CheckCircle2
                    size={12}
                    className="inline mr-1"
                    style={{ color: "var(--success)" }}
                  />
                  Missing alt text on /about
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function WhatWeDetect() {
  const categories = [
    {
      label: "Functional",
      items: ["JS errors", "Broken links", "HTTP 500s", "Broken images"],
      confidence: "HIGH",
    },
    {
      label: "Performance",
      items: ["Slow pages", "Large bundles", "Web Vitals", "Load time trends"],
      confidence: "HIGH",
    },
    {
      label: "Responsive",
      items: ["Horizontal overflow", "Small touch targets", "Layout breaks"],
      confidence: "MEDIUM",
    },
    {
      label: "Accessibility",
      items: ["Missing alt text", "No form labels", "Low contrast", "Missing lang"],
      confidence: "MEDIUM",
    },
  ];

  return (
    <section
      className="py-20 px-6"
      style={{ background: "var(--surface)" }}
    >
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-2xl font-bold mb-3">What we detect</h2>
          <p style={{ color: "var(--text-secondary)" }}>
            20+ bug types across 4 categories. Deterministic detection — zero
            guessing.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {categories.map((cat) => (
            <div
              key={cat.label}
              className="p-5 rounded-xl"
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border-light)",
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-[15px]">{cat.label}</h3>
                <span
                  className="text-[10px] font-medium px-2 py-0.5 rounded-full"
                  style={{
                    background:
                      cat.confidence === "HIGH"
                        ? "var(--success-light)"
                        : "var(--warning-light)",
                    color:
                      cat.confidence === "HIGH"
                        ? "var(--success)"
                        : "var(--warning)",
                  }}
                >
                  {cat.confidence} confidence
                </span>
              </div>
              <div className="space-y-1.5">
                {cat.items.map((item) => (
                  <div
                    key={item}
                    className="flex items-center gap-2 text-sm"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    <CheckCircle2
                      size={14}
                      style={{ color: "var(--success)" }}
                    />
                    {item}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="py-24 px-6">
      <div className="max-w-2xl mx-auto text-center">
        <h2 className="text-3xl font-bold mb-4">
          Stop shipping bugs to production
        </h2>
        <p
          className="text-lg mb-8"
          style={{ color: "var(--text-secondary)" }}
        >
          Paste your URL. Get your first report in 5 minutes. Wake up to a
          daily briefing tomorrow morning.
        </p>
        <a
          href="#scan"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById("scan")?.scrollIntoView({ behavior: "smooth" });
          }}
          className="inline-flex items-center gap-2 px-8 py-3 rounded-lg font-medium text-white transition-colors"
          style={{ background: "var(--accent)" }}
        >
          Scan your site free
          <ArrowRight size={16} />
        </a>
        <p
          className="text-xs mt-3"
          style={{ color: "var(--text-tertiary)" }}
        >
          No signup. No credit card. Results in minutes.
        </p>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer
      className="py-8 px-6 border-t"
      style={{ borderColor: "var(--border-light)" }}
    >
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Shield size={16} style={{ color: "var(--accent)" }} />
          <span className="text-sm font-medium">FlowLens</span>
        </div>
        <div
          className="text-xs"
          style={{ color: "var(--text-tertiary)" }}
        >
          Built by Rushikesh Tammewar
        </div>
        <div className="flex gap-4 text-xs" style={{ color: "var(--text-tertiary)" }}>
          <a href="mailto:contact@flowlens.in">contact@flowlens.in</a>
        </div>
      </div>
    </footer>
  );
}
