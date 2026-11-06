import { afterEach } from 'bun:test';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

export const spanExporter = new InMemorySpanExporter();

export function registerTracing(): void {
  const isRegistered = trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }),
  );

  if (!isRegistered) {
    throw new Error('a tracer provider was registered before the preload');
  }

  afterEach(() => {
    spanExporter.reset();
  });
}
