import { envOriginals } from './env-originals';

export function updateEnv(key: string, value: string | undefined): void {
  if (!envOriginals.has(key)) {
    envOriginals.set(key, process.env[key]);
  }

  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
