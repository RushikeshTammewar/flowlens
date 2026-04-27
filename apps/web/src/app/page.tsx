export default function Home() {
	return (
		<main className="min-h-screen px-6 py-16">
			<div className="mx-auto max-w-3xl">
				<header className="mb-12 border-b border-fl-light pb-6">
					<h1 className="text-2xl font-semibold tracking-tight">Flowlens</h1>
					<p className="text-fl-gray mt-1 text-sm">
						AI QA via record + replay on Browser Use Cloud.
					</p>
				</header>

				<section className="mb-10">
					<h2 className="text-base font-semibold">Phase 1 placeholder</h2>
					<p className="text-fl-gray mt-2 text-sm">
						Web dashboard scaffold. Sites, flows, runs, and the run report live here.
					</p>
				</section>

				<section className="border-t border-fl-light pt-6">
					<h3 className="text-fl-gray text-xs uppercase tracking-wider">Smoke tests</h3>
					<ul className="mt-3 space-y-1 text-sm">
						<li>
							<a href="/api/health" className="underline-offset-2 hover:underline">
								/api/health
							</a>{' '}
							<span className="text-fl-gray">— DB + BU Cloud reachability</span>
						</li>
					</ul>
				</section>

				<footer className="text-fl-gray mt-16 text-xs">
					Flowlens v3 · {new Date().getFullYear()}
				</footer>
			</div>
		</main>
	);
}
