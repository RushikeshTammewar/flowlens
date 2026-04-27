/**
 * Sensitive-data heuristic. Returns `isSensitive: true` whenever any of:
 *
 *   - input.type ∈ {password, tel, credit-card}
 *   - field name/id matches /password|pwd|cvv|cvc|cardnumber|ssn|secret|token/i
 *   - value matches a card pattern (16 digits, optional dashes/spaces)
 *   - value matches an SSN pattern (123-45-6789)
 *   - autocomplete attribute starts with "cc-" or equals "current-password" / "new-password"
 *
 * On a hit the recorder MUST NOT include the raw value in the Flow document.
 * The original value is only kept in the encrypted cookie vault and substituted
 * back at replay time via browser-use's `sensitive_data` mechanism.
 */
const SENSITIVE_NAME_RE = /password|pwd|cvv|cvc|cardnumber|card_number|ssn|secret|token|api[-_]?key|private[-_]?key/i;
const CARD_VALUE_RE = /\b(?:\d[ -]?){13,19}\b/;
const SSN_VALUE_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const SENSITIVE_AUTOCOMPLETE = new Set([
	'current-password',
	'new-password',
	'one-time-code',
	'cc-name',
	'cc-number',
	'cc-csc',
	'cc-exp',
	'cc-exp-month',
	'cc-exp-year',
]);
const SENSITIVE_INPUT_TYPES = new Set(['password', 'tel', 'credit-card']);

export interface SensitiveCheckInput {
	element: Element;
	value?: string | undefined;
}

export interface SensitiveResult {
	isSensitive: boolean;
	reason?: 'input-type' | 'name-pattern' | 'value-pattern' | 'autocomplete' | undefined;
}

export function detectSensitive(input: SensitiveCheckInput): SensitiveResult {
	const el = input.element;

	if (el instanceof HTMLInputElement) {
		if (SENSITIVE_INPUT_TYPES.has(el.type)) return { isSensitive: true, reason: 'input-type' };
		const ac = el.autocomplete?.toLowerCase();
		if (ac && (SENSITIVE_AUTOCOMPLETE.has(ac) || ac.startsWith('cc-'))) {
			return { isSensitive: true, reason: 'autocomplete' };
		}
	}

	const nameLike = (el.getAttribute('name') ?? '') + ' ' + (el.id ?? '');
	if (SENSITIVE_NAME_RE.test(nameLike)) return { isSensitive: true, reason: 'name-pattern' };

	if (input.value) {
		const cleaned = input.value.replace(/\s/g, '');
		if (CARD_VALUE_RE.test(cleaned) && passesLuhn(cleaned)) {
			return { isSensitive: true, reason: 'value-pattern' };
		}
		if (SSN_VALUE_RE.test(input.value)) {
			return { isSensitive: true, reason: 'value-pattern' };
		}
	}

	return { isSensitive: false };
}

/**
 * Luhn check — reduces card-pattern false positives (e.g. random 16-digit
 * order numbers in URLs or product codes won't pass Luhn).
 */
function passesLuhn(digits: string): boolean {
	const ds = digits.replace(/\D/g, '');
	if (ds.length < 13 || ds.length > 19) return false;
	let sum = 0;
	let alt = false;
	for (let i = ds.length - 1; i >= 0; i--) {
		const ch = ds[i];
		if (ch === undefined) return false;
		let d = ch.charCodeAt(0) - 48;
		if (alt) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		alt = !alt;
	}
	return sum % 10 === 0;
}
