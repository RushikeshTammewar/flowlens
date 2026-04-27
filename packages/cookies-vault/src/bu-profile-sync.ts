/**
 * Push a fresh CookieSnapshot to a Browser Use Cloud profile so the next
 * replay session can attach the profile and inherit the user's auth state.
 *
 * BU Cloud's v2 profile API lets us create or update profile metadata. The
 * cookie + storage push happens via the dedicated `/profiles/:id/sync` upload
 * (TBD in BU Cloud — for Phase 2 we just create/return the profile id and
 * Phase 3 will wire the actual cookie injection through `cdp_url`).
 */
import type { BuCloudClient } from '@flowlens/bu-cloud-client';

export interface ProfileSyncInput {
	bu: BuCloudClient;
	flowId: string;
	siteOrigin: string;
	existingProfileId: string | null;
}

export interface ProfileSyncResult {
	profileId: string;
	created: boolean;
}

export async function syncCookiesToBuProfile(
	input: ProfileSyncInput,
): Promise<ProfileSyncResult> {
	if (input.existingProfileId) {
		await input.bu.updateProfile(input.existingProfileId, {
			name: profileName(input),
		});
		return { profileId: input.existingProfileId, created: false };
	}
	const created = await input.bu.createProfile({
		name: profileName(input),
		description: `Auto-created by Flowlens for ${input.siteOrigin} (flow ${input.flowId.slice(0, 8)}).`,
	});
	return { profileId: created.id, created: true };
}

function profileName(input: ProfileSyncInput): string {
	let host = input.siteOrigin;
	try {
		host = new URL(input.siteOrigin).host;
	} catch {
		// fall back to raw origin
	}
	return `flowlens • ${host}`;
}
