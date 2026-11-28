import { join } from 'node:path';
import * as z from 'zod';
import type { WorkspacePackage } from './types.ts';

const packageJSONSchema = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
});

// The `@impz/*` packages, scripts included, each with the names of the workspace packages it
// depends on at run time, so a dev dependency, such as a test helper package, joins no feature.
export async function readWorkspacePackages(rootDir: string): Promise<WorkspacePackage[]> {
  // Bun's glob scan finds nothing for a brace group of a wildcard and a plain folder
  const paths = [
    ...new Bun.Glob('packages/*/package.json').scanSync({ cwd: rootDir }),
    'scripts/package.json',
  ];

  const packages: WorkspacePackage[] = [];

  for (const path of paths) {
    const packageJSON: unknown = await Bun.file(join(rootDir, path)).json();

    const parsed = packageJSONSchema.parse(packageJSON);

    packages.push({
      folder: path.slice(0, -'/package.json'.length),
      name: parsed.name,
      workspaceDependencies: Object.entries(parsed.dependencies ?? {})
        .filter(([, version]) => version === 'workspace:*')
        .map(([name]) => name),
    });
  }

  return packages;
}
