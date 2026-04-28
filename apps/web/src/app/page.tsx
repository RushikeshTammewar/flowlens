const EXTENSION_ZIP_URL =
	'https://klaifiooxmmmqygg.public.blob.vercel-storage.com/extension/flowlens-extension.zip';

export default function Home() {
	return (
		<main className="min-h-screen px-6 py-16">
			<div className="mx-auto max-w-2xl">
				{/* Brand */}
				<header className="mb-10 border-b border-fl-light pb-8">
					<h1 className="text-4xl font-semibold tracking-tight">Flowlens</h1>
					<p className="text-fl-gray mt-2 text-base">
						Record a flow once. We test it forever.
					</p>
				</header>

				{/* Three steps */}
				<section className="mb-12">
					<h2 className="text-fl-gray mb-6 text-xs uppercase tracking-wider">
						Get started in 90 seconds
					</h2>

					<ol className="space-y-8">
						<li className="flex gap-4">
							<span className="bg-fl-black text-fl-white flex h-7 w-7 shrink-0 items-center justify-center text-sm font-semibold">
								1
							</span>
							<div className="flex-1">
								<p className="text-base font-semibold">Download the extension</p>
								<p className="text-fl-gray mt-1 text-sm">
									Unzip the file when it lands.
								</p>
								<a
									href={EXTENSION_ZIP_URL}
									download="flowlens-extension.zip"
									className="bg-fl-cta text-fl-white mt-3 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium hover:opacity-90"
								>
									Download flowlens-extension.zip
								</a>
							</div>
						</li>

						<li className="flex gap-4">
							<span className="bg-fl-black text-fl-white flex h-7 w-7 shrink-0 items-center justify-center text-sm font-semibold">
								2
							</span>
							<div className="flex-1">
								<p className="text-base font-semibold">Load it in Chrome</p>
								<p className="text-fl-gray mt-1 text-sm">
									Open <code className="bg-fl-light px-1.5 py-0.5">chrome://extensions</code>.
									Toggle <span className="font-semibold">Developer mode</span> on (top right).
									Click <span className="font-semibold">Load unpacked</span>. Select the
									unzipped <code className="bg-fl-light px-1.5 py-0.5">chrome-mv3</code> folder.
								</p>
								<p className="text-fl-gray mt-1 text-sm">
									Pin the Flowlens icon to your toolbar (puzzle piece menu).
								</p>
							</div>
						</li>

						<li className="flex gap-4">
							<span className="bg-fl-black text-fl-white flex h-7 w-7 shrink-0 items-center justify-center text-sm font-semibold">
								3
							</span>
							<div className="flex-1">
								<p className="text-base font-semibold">Click the icon, hit Record</p>
								<p className="text-fl-gray mt-1 text-sm">
									The side panel opens straight to <span className="font-semibold">Idle</span> —
									no sign-in, no email, no password (closed-beta demo mode).
									On any website, click <span className="font-semibold">Record a flow</span>,
									demonstrate what you want tested, click Stop. We compile it into
									a Flow.
								</p>
								<p className="text-fl-gray mt-1 text-sm">
									Then click <span className="font-semibold">Run</span> — watch
									Browser Use Cloud execute your flow, get a report.
								</p>
							</div>
						</li>
					</ol>
				</section>

				{/* What this is */}
				<section className="border-t border-fl-light pt-8">
					<h2 className="text-fl-gray mb-3 text-xs uppercase tracking-wider">
						What is Flowlens
					</h2>
					<p className="text-sm leading-relaxed">
						AI QA via record + replay. You demonstrate a flow once on any website
						(signup, checkout, search, anything). We capture the DOM events,
						screenshots, and cookies, turn them into a semantic Flow document,
						and replay it on demand on a hosted cloud browser. Each replay
						verifies that your flow still works — for regression testing, for
						scheduled monitoring, for catching production breakage before users
						do.
					</p>
				</section>

				{/* Status / smoke */}
				<section className="border-t border-fl-light mt-12 pt-6">
					<h3 className="text-fl-gray text-xs uppercase tracking-wider">Status</h3>
					<ul className="mt-3 space-y-1 text-xs">
						<li className="flex items-baseline gap-2">
							<span className="bg-fl-green inline-block h-2 w-2 rounded-full" />
							<a
								href="/api/health"
								className="underline-offset-2 hover:underline"
							>
								/api/health
							</a>
							<span className="text-fl-gray">— web app + DB + LLM keys</span>
						</li>
						<li className="flex items-baseline gap-2">
							<span className="bg-fl-green inline-block h-2 w-2 rounded-full" />
							<a
								href="https://ejiymmxysz.us-east-1.awsapprunner.com/healthz"
								target="_blank"
								rel="noreferrer"
								className="underline-offset-2 hover:underline"
							>
								Replay worker
							</a>
							<span className="text-fl-gray">— Python sidecar on AWS App Runner</span>
						</li>
					</ul>
				</section>

				<footer className="text-fl-gray mt-16 text-xs">
					Flowlens v3 · Closed beta · {new Date().getFullYear()}
				</footer>
			</div>
		</main>
	);
}
