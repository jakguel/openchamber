import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import * as sdk from '@opencode-ai/sdk/v2';
import * as runtimeAPIRegistry from '@/contexts/runtimeAPIRegistry';
import * as runtimeUrl from '@/lib/runtime-url';
import * as runtimeSwitch from '@/lib/runtime-switch';
import * as runtimeFetchMod from '@/lib/runtime-fetch';
import * as startupTrace from '@/lib/startupTrace';

type ConfigResponse = { data: Record<string, unknown> };

const configResolvers: Array<(response: ConfigResponse) => void> = [];
let configCalls = 0;

// De-mocked: the external SDK factory and the runtime transport boundaries are
// spied on their real modules before ./client is dynamically imported (cache-busted
// for a fresh internal cache), so the client's real getConfig caching logic runs.
spyOn(sdk, 'createOpencodeClient').mockImplementation((() => ({
  config: {
    get: () => {
      configCalls += 1;
      return new Promise<ConfigResponse>((resolve) => {
        configResolvers.push(resolve);
      });
    },
  },
})) as unknown as typeof sdk.createOpencodeClient);
spyOn(runtimeAPIRegistry, 'getRegisteredRuntimeAPIs').mockImplementation(() => null);
spyOn(runtimeUrl, 'getRuntimeUrlResolver').mockImplementation((() => ({
  api: (path: string) => path,
})) as unknown as typeof runtimeUrl.getRuntimeUrlResolver);
spyOn(runtimeSwitch, 'getRuntimeApiBaseUrl').mockImplementation(() => '');
spyOn(runtimeSwitch, 'getRuntimeKey').mockImplementation(() => 'test-runtime');
spyOn(runtimeFetchMod, 'runtimeFetch').mockImplementation((async () => new Response(JSON.stringify([]), {
  headers: { 'Content-Type': 'application/json' },
})) as typeof runtimeFetchMod.runtimeFetch);
spyOn(startupTrace, 'markStartupTrace').mockImplementation(() => undefined);

afterAll(() => {
  mock.restore();
});

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[0]?.({ data: { model: 'old/model' } });
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[1]?.({ data: { model: 'new/model' } });
    expect(await second).toEqual({ model: 'new/model' });
    expect(await third).toEqual({ model: 'new/model' });

    const cached = await opencodeClient.getConfig('/workspace/project');
    expect(cached).toEqual({ model: 'new/model' });
    expect(configCalls).toBe(2);
  });
});
