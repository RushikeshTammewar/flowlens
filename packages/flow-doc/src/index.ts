export {
	compileRecording,
	type CompileInput,
	type CompileOutput,
	type CompileProgressEvent,
	type CompileProgressEmitter,
} from './compile';
export { narrateStep, type NarrateInput } from './narrate-step';
export {
	synthesizeFlow,
	synthesizeFlowWithContract,
	FlowSynthesisOutputSchema,
	FlowSynthesisWithContractOutputSchema,
	type SynthesizeInput,
	type FlowSynthesisOutput,
	type FlowSynthesisWithContractOutput,
} from './synthesize-flow';
export { suggestSiblingFlows, type SiblingsInput } from './sibling-flows';
export { classifySensitive, type SensitiveClassifyInput } from './sensitive-classify';
export { injectFlowlensIdsScript } from './inject-flowlens-ids';
export {
	generateTestMatrix,
	generateTestMatrixWithContract,
	type GenerateMatrixInput,
	type GenerateMatrixWithContractInput,
	type TestVariant,
	type TestVariantV2,
	type VariantFamily,
	type VariantMode,
	type VariantExpectedOutcome,
	TestVariantSchema,
	TestVariantV2Schema,
	VariantExpectedOutcomeSchema,
	VariantFamilySchema,
	VariantModeSchema,
} from './generate-matrix';
