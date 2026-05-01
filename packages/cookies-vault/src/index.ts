/**
 * Workspace package barrel.
 *
 * Imports use NO extension on purpose — Next.js / Webpack / esbuild all
 * resolve the `.ts` source via tsconfig `moduleResolution: 'Bundler'`.
 * Adding `.ts` here breaks `next build` (typed-routes / strict tsc) and
 * adding `.js` would break `tsx`-driven Node CLI scripts that resolve
 * the `.ts` source. Bare specifiers work for both bundler-driven
 * builds AND for the workspace's `pnpm --filter` script runners.
 *
 * If you re-introduce a Node-runtime ESM script that imports this
 * package directly (no bundler), wrap it in `tsx` rather than node.
 */
export { sealForOrg, openForOrg, deriveOrgKeyPair, type SealedPayload } from './encrypt';
export { syncCookiesToBuProfile, type ProfileSyncInput } from './bu-profile-sync';
export {
	isCookieSnapshotStale,
	earliestCookieExpiry,
	hasAuthCookieHeuristic,
	type StalenessCheck,
} from './refresh-detect';
export { hashAuthDomains, type CookieRecord } from './capture';
