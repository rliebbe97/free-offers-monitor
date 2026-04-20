import { Axiom } from '@axiomhq/js';

const dataset = process.env.AXIOM_DATASET ?? 'free-offers-monitor';

let axiom: Axiom | null = null;

if (!process.env.AXIOM_TOKEN) {
  console.warn('[logger] AXIOM_TOKEN not set — running in console-only mode');
} else {
  axiom = new Axiom({
    token: process.env.AXIOM_TOKEN,
    orgId: process.env.AXIOM_ORG_ID,
  });
}

function ingest(level: string, event: string, fields?: Record<string, unknown>): void {
  if (axiom !== null) {
    axiom.ingest(dataset, [
      {
        _time: new Date().toISOString(),
        level,
        event,
        ...fields,
      },
    ]);
  }
}

export const logger = {
  info(event: string, fields?: Record<string, unknown>): void {
    console.log(JSON.stringify({ _time: new Date().toISOString(), level: 'info', event, ...fields }));
    ingest('info', event, fields);
  },

  warn(event: string, fields?: Record<string, unknown>): void {
    console.warn(JSON.stringify({ _time: new Date().toISOString(), level: 'warn', event, ...fields }));
    ingest('warn', event, fields);
  },

  error(event: string, fields?: Record<string, unknown>): void {
    console.error(JSON.stringify({ _time: new Date().toISOString(), level: 'error', event, ...fields }));
    ingest('error', event, fields);
  },

  async flush(): Promise<void> {
    if (axiom !== null) {
      await axiom.flush();
    }
  },
};
