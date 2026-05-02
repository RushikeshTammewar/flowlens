/**
 * Clerk middleware — protects every route except the explicitly public ones.
 * `/api/webhooks/*` is public so Clerk + BU Cloud webhooks can hit us without auth.
 * `/api/health` is public so uptime checks don't 401.
 * Marketing pages (`/`) are public; signed-in users go to `/app/*`.
 *
 * Next.js 16 deprecates `middleware.ts` in favor of `proxy.ts`. We keep the old
 * filename for now because Clerk's documented integration still exports
 * `clerkMiddleware`; the rename is a one-line change once Clerk's docs catch up.
 */
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
	'/',
	'/api/health',
	// /api/_smoke-run + /api/_db-migrate are dev-only and NODE_ENV-gated in their routes.
	'/api/_smoke-run',
	'/api/_db-migrate',
	'/api/webhooks/(.*)',
	'/extension-callback',
	'/sign-in(.*)',
	'/sign-up(.*)',
]);

// Demo-mode flag — when on, browser navigations to /app/* skip Clerk
// and the page server-component falls through to the singleton demo
// {user, org} via tryPageAuthContext(). Without this, the side panel's
// "Open full report ↗" deep-link opens a new tab that Clerk redirects
// to sign-in BEFORE the page can apply its demo bypass. Closed-beta
// builds ship with FLOWLENS_DEMO_MODE=true.
const DEMO_MODE = process.env.FLOWLENS_DEMO_MODE === 'true';

export default clerkMiddleware(async (auth, req) => {
	// Demo-bearer requests bypass Clerk; route handlers validate via tryDemoBypass().
	// Without this, Clerk's auth.protect() returns 404 for the unrecognized bearer
	// before our handlers even see the request.
	const authHeader = req.headers.get('authorization') ?? req.headers.get('Authorization');
	if (authHeader?.startsWith('Bearer flowlens-demo-')) {
		return;
	}
	// Demo-mode browser navigations to /app/* — let them through so the
	// server-component's tryPageAuthContext() can lift the demo org.
	if (DEMO_MODE && req.nextUrl.pathname.startsWith('/app/')) {
		return;
	}
	if (!isPublicRoute(req)) {
		await auth.protect();
	}
});

export const config = {
	matcher: [
		// Skip Next.js internals, static files, AND Vercel Workflow's internal paths
		// (.well-known/workflow/* — required per workflow/next docs to avoid Clerk
		// intercepting workflow runtime callbacks).
		'/((?!_next|\\.well-known/workflow|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
		// Always run for API routes
		'/(api|trpc)(.*)',
	],
};
