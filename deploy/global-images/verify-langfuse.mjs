// Run inside each service container. Creates a synthetic trace, without calling an LLM.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve dependencies from the container application's working directory.
const require = createRequire(`${process.cwd()}/package.json`);
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const service = process.argv[2];
let host = process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST;
let publicKey = process.env.LANGFUSE_PUBLIC_KEY;
let secretKey = process.env.LANGFUSE_SECRET_KEY;
if (service === 'proxy') {
  const { parse } = await load('yaml');
  const config = parse(readFileSync('/data/config.yaml', 'utf8')).langfuse;
  if (!config?.enabled) throw new Error('Proxy Langfuse is disabled');
  ({ host, publicKey, secretKey } = config);
}
if (!host || !publicKey || !secretKey) throw new Error('Langfuse configuration is incomplete');
host = host.replace(/\/+$/, '');
const headers = { Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}` };
const projects = await fetch(`${host}/api/public/projects`, { headers, signal: AbortSignal.timeout(15000) });
if (!projects.ok) throw new Error(`Langfuse authentication failed: HTTP ${projects.status}`);
const project = (await projects.json()).data?.[0];

let shutdown;
if (service === 'core') {
  const { initOTelSDK, shutdownOTelSDK } = await import(pathToFileURL(`${process.cwd()}/src/core/report/otel-sdk-init.ts`).href);
  if (!await initOTelSDK({ langfuse: { host, publicKey, secretKey } })) throw new Error('Core OTel initialization failed');
  shutdown = shutdownOTelSDK;
} else {
  const { NodeSDK } = await load('@opentelemetry/sdk-node');
  const { LangfuseSpanProcessor } = await load('@langfuse/otel');
  const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor({ baseUrl: host, publicKey, secretKey })] });
  sdk.start();
  shutdown = () => sdk.shutdown();
}
const { trace } = await load('@opentelemetry/api');
const name = `docker-integration-smoke-${service}`;
const fromStartTime = new Date(Date.now() - 60000).toISOString();
const span = trace.getTracer('langfuse-sdk').startSpan('ai.generateText', {
  attributes: {
    'langfuse.trace.name': name,
    'langfuse.trace.tags': ['integration-smoke', service],
    'langfuse.observation.type': 'generation',
    'langfuse.observation.input': 'Synthetic connectivity test; no LLM request.',
    'langfuse.observation.output': 'Langfuse export verified.',
  },
});
const traceId = span.spanContext().traceId;
span.end();
await shutdown();
for (let attempt = 0; attempt < 20; attempt++) {
  const query = new URLSearchParams({ traceId, fromStartTime, toStartTime: new Date(Date.now() + 60000).toISOString(), fields: 'core', limit: '10' });
  const result = await fetch(`${host}/api/public/v2/observations?${query}`, { headers, signal: AbortSignal.timeout(15000) });
  if (result.ok) {
    const traceData = await result.json();
    if (traceData.data?.some(observation => observation.traceId === traceId)) {
      console.log(JSON.stringify({ service, traceId, verified: true, url: `${host}/project/${project.id}/traces/${traceId}` }));
      process.exit(0);
    }
  } else {
    throw new Error(`Trace verification failed: HTTP ${result.status}`);
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
}
throw new Error(`Trace ${traceId} was not queryable within 60 seconds`);
