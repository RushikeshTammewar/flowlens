/**
 * Server-only OpenAI client used inside the compile pipeline. Lives in this
 * package (not in apps/web) because the compile pipeline is invoked from
 * server actions / route handlers / future Vercel Workflow steps and we want
 * a single import surface.
 */
import OpenAI from 'openai';

let _client: OpenAI | undefined;

export function getOpenAi(): OpenAI {
	if (!process.env.OPENAI_API_KEY) {
		throw new Error('OPENAI_API_KEY is required for any flow-doc LLM call');
	}
	if (!_client) {
		_client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	}
	return _client;
}
