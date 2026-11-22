export function directCodexEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('OTEL_') && name !== 'OPENPANE_DATADOG_LLMOBS' && !name.startsWith('OPENPANE_SETUP_') && name !== 'OPENCODE_GO_API_KEY'));
}
