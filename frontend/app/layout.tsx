import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowLens — Your AI QA Engineer. Always On.",
  description:
    "Continuous website quality monitoring. FlowLens tests every flow on your site daily, tracks bugs over time, and delivers a morning briefing of what changed.",
  openGraph: {
    title: "FlowLens — Your AI QA Engineer",
    description:
      "Give us your URL. We test every flow daily. You wake up to a bug report.",
    url: "https://flowlens.in",
    siteName: "FlowLens",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
