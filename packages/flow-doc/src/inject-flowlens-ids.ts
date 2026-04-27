/**
 * At replay time we inject `data-flowlens-id="step-{n}-target"` on each
 * step's recorded element so the agent has a perfectly stable hint that
 * survives DOM rebuilds. We don't run the script at compile time — we just
 * generate it here so the replay-engine can `Runtime.evaluate` it via CDP.
 */
import type { FlowStep } from '@flowlens/schema';

export function injectFlowlensIdsScript(steps: FlowStep[]): string {
	const entries = steps
		.filter((s) => s.selectors.css)
		.map((s) => ({
			id: `step-${s.index}-target`,
			css: s.selectors.css!,
		}));
	const json = JSON.stringify(entries);
	return `(() => {
  try {
    const entries = ${json};
    for (const e of entries) {
      const el = document.querySelector(e.css);
      if (el) el.setAttribute('data-flowlens-id', e.id);
    }
  } catch (err) { /* swallow — replay tolerates missing hints */ }
})();`;
}
