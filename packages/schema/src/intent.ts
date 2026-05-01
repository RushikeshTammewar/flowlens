/**
 * Intent classification (Phase 3.5c — the brain upgrade).
 *
 * After compile, we run a NEW reasoning-model stage that classifies the flow
 * into a structured `IntentReport`. Variant generation, T3 judge, and the
 * failure investigator all consume this to ground their reasoning in what
 * the flow ACTUALLY tests.
 *
 * Why a separate stage from synthesis: synthesize-flow.ts is gpt-4.1 (cheap,
 * fast, names+descriptions). Intent classification needs deeper reasoning
 * to spot non-obvious tech stacks, fragility patterns, and the "what would
 * a senior engineer test about this" surface area.
 */
import { z } from 'zod';

export const PrimaryIntentSchema = z.enum([
	'signup',
	'login',
	'search',
	'checkout',
	'crud',
	'navigation',
	'configuration',
	'data_entry',
	'social',
	'other',
]);
export type PrimaryIntent = z.infer<typeof PrimaryIntentSchema>;

export const FormStyleSchema = z.enum(['controlled', 'uncontrolled', 'no-form', 'mixed']);
export type FormStyle = z.infer<typeof FormStyleSchema>;

export const RoutingSchema = z.enum(['spa', 'mpa', 'hybrid']);
export type Routing = z.infer<typeof RoutingSchema>;

export const IntentTechStackSchema = z.object({
	frontend: z.string().min(1).max(80), // "React" | "Vue" | "Angular" | "vanilla" | "server-rendered" | etc.
	formStyle: FormStyleSchema,
	routing: RoutingSchema,
	knownLibraries: z.array(z.string().min(1).max(80)).max(20).default([]),
});
export type IntentTechStack = z.infer<typeof IntentTechStackSchema>;

export const SensitiveSurfaceSchema = z.object({
	stepIndex: z.number().int().nonnegative(),
	reason: z.string().min(1).max(280),
});
export type SensitiveSurface = z.infer<typeof SensitiveSurfaceSchema>;

export const IntentReportSchema = z.object({
	primaryIntent: PrimaryIntentSchema,
	domain: z.string().min(1).max(120), // "e-commerce", "saas-dashboard", "email-client", "social-network"
	techStack: IntentTechStackSchema,
	criticalAssertions: z.array(z.string().min(1).max(400)).min(1).max(15),
	knownFragilityPatterns: z.array(z.string().min(1).max(280)).max(15).default([]),
	sensitiveSurfaces: z.array(SensitiveSurfaceSchema).max(20).default([]),
	humanSummary: z.string().min(1).max(800),
	confidence: z.number().min(0).max(1).default(0.5),
	classifierModel: z.string().min(1).max(60),
	classifierUsage: z
		.object({
			promptTokens: z.number().int().nonnegative(),
			completionTokens: z.number().int().nonnegative(),
			totalTokens: z.number().int().nonnegative(),
			reasoningTokens: z.number().int().nonnegative().optional(),
		})
		.optional(),
});
export type IntentReport = z.infer<typeof IntentReportSchema>;

/**
 * Test data generated PER variant by an o4-mini call. Keeps the o3 variant
 * generator on "what should we test" and pushes "what's the actual hostile
 * string we feed in" to a cheap, fast, structured-output call.
 */
export const VariantTestDatumSchema = z.object({
	stepIndex: z.number().int().nonnegative(),
	value: z.string(), // explicit empty string is OK (e.g. boundary: empty input)
	rationale: z.string().min(1).max(280),
});
export type VariantTestDatum = z.infer<typeof VariantTestDatumSchema>;

export const VariantTestDataSchema = z.object({
	variantNameRef: z.string(),
	values: z.array(VariantTestDatumSchema).min(1).max(20),
	generatorModel: z.string(),
});
export type VariantTestData = z.infer<typeof VariantTestDataSchema>;
