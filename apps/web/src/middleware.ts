/**
 * Clerk middleware — protects every route except the explicitly public ones.
 * `/api/webhooks/*` is public so Clerk + BU Cloud webhooks can hit us without auth.
 * `/api/health` is public so uptime checks don't 401.
 * Marketing pages (`/`) are public; signed-in users go to `/app/*`.
 *
 * # Demo-mode bearer bypass
 *
 * If `FLOWLENS_DEMO_MODE=true` AND the request carries `Authorization: Bearer
 * flowlens-demo-${FLOWLENS_DEMO_BEARER}`, we skip Clerk's middleware entirely.
 * Clerk would otherwise try to parse the bearer as a JWT, see the non-JWT
 * shape, and reject the request before our route handler runs. The route
 * handler's `requireAuthContext()` performs the actual demo-bearer match.
 *
 * Next.js 16 deprecates `middleware.ts` in favor of `proxy.ts`. We keep the old
 * filename for now because Clerk's documented integration still exports
 * `clerkMiddleware`; the rename is a one-line change once Clerk's docs catch up.
 */
import { NextResponse } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
	'/',
	'/api/health',
	'/api/webhooks/(.*)',
	'/extension-callback',
	'/sign-in(.*)',
	'/sign-up(.*)',
]);

const DEMO_BEARER_PREFIX = 'bearer flowlens-demo-';

function looksLikeDemoBearer(req: Request): boolean {
	if (process.env.FLOWLENS_DEMO_MODE !== 'true') return false;
	const expected = process.env.FLOWLENS_DEMO_BEARER;
	if (!expected) return false;
	const auth = req.headers.get('authorization') ?? '';
	if (!auth.toLowerCase().startsWith(DEMO_BEARER_PREFIX)) return false;
	const presented = auth.slice(7).trim(); // strip "Bearer "
	const expectedFull = `flowlens-demo-${expected}`;
	if (presented.length !== expectedFull.length) return false;
	let diff = 0;
	for (let i = 0; i < presented.length; i++) {
		diff |= presented.charCodeAt(i) ^ expectedFull.charCodeAt(i);
	}
	return diff === 0;
}

export default clerkMiddleware(async (auth, req) => {
	// Demo-mode short-circuit: skip Clerk entirely so it doesn't try to parse
	// our non-JWT bearer. The route handler still verifies the demo bearer
	// via requireAuthContext() — middleware just gets out of the way.
	if (looksLikeDemoBearer(req)) {
		return NextResponse.next();
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
