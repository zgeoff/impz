import { createFirecrackerClient } from '../../src/vm/vmm/firecracker-client';
import type {
  CreateFirecrackerClient,
  FirecrackerClient,
} from '../../src/vm/vmm/firecracker-client';

export function makeRecordingFirecrackerClient(calls: string[]): CreateFirecrackerClient {
  return (socketPath, timeouts) => {
    const client = createFirecrackerClient(socketPath, timeouts);

    const record =
      <A extends unknown[], R>(name: keyof FirecrackerClient, method: (...args: A) => R) =>
      (...args: A): R => {
        calls.push(`${socketPath} ${name}`);

        return method(...args);
      };

    return {
      putBootSource: record('putBootSource', client.putBootSource),
      putMachineConfig: record('putMachineConfig', client.putMachineConfig),
      loadMachineConfig: record('loadMachineConfig', client.loadMachineConfig),
      putDrive: record('putDrive', client.putDrive),
      patchDrive: record('patchDrive', client.patchDrive),
      putNetworkInterface: record('putNetworkInterface', client.putNetworkInterface),
      putVsock: record('putVsock', client.putVsock),
      putBalloon: record('putBalloon', client.putBalloon),
      readBalloonStats: record('readBalloonStats', client.readBalloonStats),
      putHotplugMemory: record('putHotplugMemory', client.putHotplugMemory),
      readHotplugMemory: record('readHotplugMemory', client.readHotplugMemory),
      patchHotplugMemory: record('patchHotplugMemory', client.patchHotplugMemory),
      instanceStart: record('instanceStart', client.instanceStart),
      pause: record('pause', client.pause),
      resume: record('resume', client.resume),
      createSnapshot: record('createSnapshot', client.createSnapshot),
      loadSnapshot: record('loadSnapshot', client.loadSnapshot),
      readVersion: record('readVersion', client.readVersion),
      readInstanceState: record('readInstanceState', client.readInstanceState),
    };
  };
}
