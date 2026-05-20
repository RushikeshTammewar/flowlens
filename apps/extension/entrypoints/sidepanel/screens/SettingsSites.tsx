import { useEffect, useState } from 'react';
import { ArrowLeft, Globe, Plus } from 'lucide-react';
import {
	Button,
	Card,
	EmptyState,
	IconButton,
	PageShell,
	PanelHeader,
	Pill,
	Wordmark,
} from '../../../components/ui';

interface Props {
	onBack: () => void;
}

interface SiteRow {
	host: string;
	flows: number;
	runs: number;
	auth: 'fresh' | 'stale' | 'unknown';
}

const PLACEHOLDER_SITES: ReadonlyArray<SiteRow> = [];

export function SettingsSites({ onBack }: Props) {
	const [sites, setSites] = useState<SiteRow[]>(() => [...PLACEHOLDER_SITES]);

	useEffect(() => {
		setSites([...PLACEHOLDER_SITES]);
	}, []);

	const revoke = (host: string) => {
		setSites((prev) => prev.filter((s) => s.host !== host));
	};

	return (
		<PageShell
			motionKey="settings_sites"
			header={
				<PanelHeader>
					<div className="flex items-center gap-2">
						<IconButton
							size="sm"
							label="Back"
							icon={<ArrowLeft size={13} aria-hidden="true" />}
							onClick={onBack}
						/>
						<Wordmark />
					</div>
					<Pill size="xs">sites</Pill>
				</PanelHeader>
			}
		>
			<section className="px-3.5 py-3">
				{sites.length === 0 ? (
					<EmptyState
						icon={<Globe size={18} aria-hidden="true" />}
						title="no sites yet"
						body="record a flow on any site — it'll show up here once you save."
					/>
				) : (
					<ul className="space-y-1.5">
						{sites.map((s) => (
							<li key={s.host}>
								<Card padding="sm" interactive>
									<div className="flex items-center gap-2">
										<span className="bg-fl-soft border-fl-line flex h-6 w-6 shrink-0 items-center justify-center border">
											<Globe size={12} className="text-fl-gray" aria-hidden="true" />
										</span>
										<div className="min-w-0 flex-1">
											<div className="text-fl-black truncate text-[11px] font-semibold">
												{s.host}
											</div>
											<div className="text-fl-gray text-[10px]">
												{s.flows} flows · {s.runs} runs ·{' '}
												<Pill size="xs" variant={s.auth === 'fresh' ? 'success' : 'warn'} dot>
													auth {s.auth}
												</Pill>
											</div>
										</div>
										<Button size="sm" variant="ghost" onClick={() => revoke(s.host)}>
											revoke
										</Button>
									</div>
								</Card>
							</li>
						))}
					</ul>
				)}
				<Button
					className="mt-3"
					block
					variant="secondary"
					size="md"
					leftIcon={<Plus size={12} aria-hidden="true" />}
				>
					add site
				</Button>
				<p className="text-fl-gray mt-2 text-[10px]">
					Revoking deletes flows, runs, cookies, and recordings for that site immediately.
				</p>
			</section>
		</PageShell>
	);
}
