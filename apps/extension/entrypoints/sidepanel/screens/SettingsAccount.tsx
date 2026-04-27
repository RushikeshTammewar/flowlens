import { ArrowLeft, Check, Crown, Mail, Slack, Webhook } from 'lucide-react';
import {
	Button,
	Card,
	IconButton,
	KeyValue,
	KeyValueList,
	PageShell,
	PanelHeader,
	Pill,
	Wordmark,
} from '../../../components/ui';

interface Props {
	onBack: () => void;
	userEmail: string;
}

interface UsageBar {
	label: string;
	used: number;
	limit: number;
	hint?: string;
}

const USAGE: ReadonlyArray<UsageBar> = [
	{ label: 'Runs', used: 47, limit: 50, hint: 'this month' },
	{ label: 'Flows', used: 8, limit: 10 },
	{ label: 'Sites', used: 3, limit: 3 },
];

export function SettingsAccount({ onBack, userEmail }: Props) {
	return (
		<PageShell
			motionKey="settings_account"
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
					<Pill size="xs">account</Pill>
				</PanelHeader>
			}
		>
			<section className="px-3.5 py-3">
				<Card padding="md" tone="neutral">
					<KeyValueList>
						<KeyValue label="email" value={userEmail.includes('@') ? userEmail : '—'} />
						<KeyValue label="plan" value={<span>free</span>} />
						<KeyValue label="org" value="personal" />
					</KeyValueList>
				</Card>
			</section>

			<section className="px-3.5 py-1">
				<header className="text-fl-gray mb-1.5 text-[10px] uppercase tracking-wider">
					this month
				</header>
				<div className="space-y-2">
					{USAGE.map((u) => (
						<UsageRow key={u.label} bar={u} />
					))}
				</div>
			</section>

			<section className="px-3.5 py-3">
				<Card
					tone="info"
					padding="md"
					title={
						<span className="flex items-center gap-1.5">
							<Crown size={12} className="text-fl-blue" aria-hidden="true" /> Upgrade to Pro
						</span>
					}
					subtitle="$39/mo · cancel anytime"
				>
					<ul className="text-fl-black mt-1 space-y-1 text-[11px]">
						<ProBullet>10 sites, 100 flows, 1000 runs/mo</ProBullet>
						<ProBullet>Daily scheduled runs</ProBullet>
						<ProBullet>Visual regression diffing</ProBullet>
						<ProBullet>Priority support</ProBullet>
					</ul>
					<Button className="mt-3" block variant="primary" size="md">
						upgrade
					</Button>
				</Card>
			</section>

			<section className="px-3.5 py-3">
				<header className="text-fl-gray mb-1.5 text-[10px] uppercase tracking-wider">
					notifications
				</header>
				<div className="space-y-1.5">
					<ChannelRow
						icon={<Mail size={12} aria-hidden="true" />}
						label="email"
						hint="on"
						active
					/>
					<ChannelRow
						icon={<Slack size={12} aria-hidden="true" />}
						label="slack"
						hint="not connected"
					/>
					<ChannelRow
						icon={<Webhook size={12} aria-hidden="true" />}
						label="webhook"
						hint="not configured"
					/>
				</div>
				<p className="text-fl-gray mt-2 text-[10px]">
					channel config arrives in phase 4.
				</p>
			</section>
		</PageShell>
	);
}

function UsageRow({ bar }: { bar: UsageBar }) {
	const pct = Math.min(100, Math.round((bar.used / bar.limit) * 100));
	const tone = pct >= 90 ? 'bg-fl-amber' : 'bg-fl-cta';
	return (
		<div>
			<div className="flex items-baseline justify-between text-[10px]">
				<span className="text-fl-black uppercase tracking-wider">{bar.label}</span>
				<span className="text-fl-gray font-mono">
					{bar.used} / {bar.limit}
					{bar.hint && <span className="ml-1 text-fl-gray/60">· {bar.hint}</span>}
				</span>
			</div>
			<div className="bg-fl-light mt-1 h-1.5 w-full overflow-hidden">
				<div className={`${tone} h-full`} style={{ width: `${pct}%` }} />
			</div>
		</div>
	);
}

function ProBullet({ children }: { children: React.ReactNode }) {
	return (
		<li className="flex items-start gap-1.5">
			<Check size={12} className="text-fl-green mt-px shrink-0" aria-hidden="true" />
			<span>{children}</span>
		</li>
	);
}

function ChannelRow({
	icon,
	label,
	hint,
	active,
}: {
	icon: React.ReactNode;
	label: string;
	hint: string;
	active?: boolean;
}) {
	return (
		<div className="border-fl-line flex items-center gap-2 border bg-fl-white px-2 py-1.5">
			<span className="text-fl-gray">{icon}</span>
			<span className="text-fl-black flex-1 text-[11px] uppercase tracking-wider">{label}</span>
			<Pill size="xs" variant={active ? 'success' : 'default'} dot>
				{hint}
			</Pill>
		</div>
	);
}
