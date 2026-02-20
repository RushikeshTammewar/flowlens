import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

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
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans`}>
        {children}
      </body>
    </html>
  );
}
