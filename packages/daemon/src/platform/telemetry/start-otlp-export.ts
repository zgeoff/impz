import { metrics, trace } from '@opentelemetry/api';

export async function startOtlpExport(
  env: Readonly<Record<string, string | undefined>>,
  version: string,
): Promise<(() => Promise<void>) | null> {
  if ((env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '') === '') {
    return null;
  }

  const [metricsExporter, traceExporter, resources, sdkMetrics, sdkTrace] = await Promise.all([
    import('@opentelemetry/exporter-metrics-otlp-proto'),
    import('@opentelemetry/exporter-trace-otlp-proto'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/sdk-trace-base'),
  ]);

  const resource = resources.resourceFromAttributes({
    'service.name': env['OTEL_SERVICE_NAME'] ?? 'impd',
    'service.version': version,
  });

  const meterProvider = new sdkMetrics.MeterProvider({
    resource,
    readers: [
      new sdkMetrics.PeriodicExportingMetricReader({
        exporter: new metricsExporter.OTLPMetricExporter(),
      }),
    ],
  });

  const tracerProvider = new sdkTrace.BasicTracerProvider({
    resource,
    spanProcessors: [new sdkTrace.BatchSpanProcessor(new traceExporter.OTLPTraceExporter())],
  });

  metrics.setGlobalMeterProvider(meterProvider);
  trace.setGlobalTracerProvider(tracerProvider);

  return async () => {
    await Promise.all([meterProvider.shutdown(), tracerProvider.shutdown()]);
  };
}
