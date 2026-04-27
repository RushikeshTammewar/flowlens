/**
 * Extension auth bridge.
 *
 * Flow:
 *   1. Extension opens this page in a new tab.
 *   2. Clerk middleware enforces sign-in; if not authed, redirects to /sign-in.
 *   3. Once authed we mint a Clerk JWT (default `__session` cookie) and
 *      surface a button "Authorize Flowlens extension".
 *   4. Click hands the token to the extension via `chrome.runtime.sendMessage`
 *      (the extension's manifest declares `externally_connectable` matching
 *      flowlens.in).
 *
 * For local dev (extension manifest currently lacks externally_connectable
 * because it depends on the production domain) the page also surfaces a
 * "copy token" affordance so dev can paste it into the extension's
 * settings screen.
 */
import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function ExtensionCallbackPage() {
	const sess = await auth();
	if (!sess.userId) redirect('/sign-in' as never);

	const cu = await currentUser();
	const email =
		cu?.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId)?.emailAddress ??
		cu?.emailAddresses[0]?.emailAddress ??
		'(unknown)';

	const token = await sess.getToken();

	return (
		<main className="min-h-screen px-6 py-16">
			<div className="mx-auto max-w-xl">
				<header className="mb-8 border-b border-fl-light pb-6">
					<h1 className="text-2xl font-semibold tracking-tight">Authorize Flowlens extension</h1>
					<p className="text-fl-gray mt-1 text-sm">Signed in as {email}.</p>
				</header>

				<section className="mb-8">
					<p className="text-sm">
						The Flowlens Chrome extension uses this token to authenticate uploads to flowlens.in.
						Click below to hand the token to the extension.
					</p>
				</section>

				<ExtensionAuthClient token={token ?? ''} />

				<p className="text-fl-gray mt-12 text-xs">
					Phase 2: this page works for the local-dev "copy token" path. Production-grade
					<code className="text-fl-black"> chrome.runtime.sendMessage </code>
					handoff lands when we ship the Chrome Web Store build with{' '}
					<code className="text-fl-black">externally_connectable</code> declared.
				</p>
			</div>
		</main>
	);
}

// Client island only for the copy-button + sendMessage handoff
function ExtensionAuthClient({ token }: { token: string }) {
	return (
		<div className="space-y-3">
			<textarea
				readOnly
				className="border-fl-light w-full rounded-none border bg-white p-3 text-xs"
				rows={4}
				defaultValue={token}
			/>
			{/* eslint-disable-next-line @typescript-eslint/no-empty-function */}
			<form
				action={async () => {
					'use server';
					// no-op; client-side copy button below handles the UX
				}}
			>
				<noscript>
					<p className="text-fl-gray text-xs">
						Enable JavaScript to copy the token directly to the extension.
					</p>
				</noscript>
			</form>
			<CopyAndPostScript token={token} />
		</div>
	);
}

function CopyAndPostScript({ token }: { token: string }) {
	const safeToken = token.replace(/[<>"&'\\]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
	const script = `(() => {
  const token = "${safeToken}";
  const btn = document.getElementById('flowlens-auth-btn');
  const status = document.getElementById('flowlens-auth-status');
  if (!btn || !status) return;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(token);
      status.textContent = 'Token copied. Paste it in the Flowlens side panel.';
      try {
        // Attempt direct extension message (works once externally_connectable is set).
        // chrome.runtime is undefined on regular pages without that manifest entry.
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: 'flowlens_auth_token', token });
        }
      } catch (_) {}
    } catch (err) {
      status.textContent = 'Could not copy automatically. Please select + copy from the box above.';
    }
  });
})();`;
	return (
		<>
			<button
				id="flowlens-auth-btn"
				className="bg-fl-black text-fl-white hover:bg-fl-black/90 rounded-none px-4 py-2 text-xs uppercase tracking-wider"
			>
				Copy token to extension
			</button>
			<p id="flowlens-auth-status" className="text-fl-gray text-xs" />
			<script
				// eslint-disable-next-line react/no-danger
				dangerouslySetInnerHTML={{ __html: script }}
			/>
		</>
	);
}
