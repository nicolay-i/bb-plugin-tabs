import type { PluginRpcContract, PluginRpcResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  renderSlot,
  type RenderSlotOptions,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server";

type FakeHost = ReturnType<typeof createFakePluginHost>;
type TabsHost = Omit<FakeHost, "harness"> & {
  harness: Omit<FakeHost["harness"], "behavior"> & {
    behavior: Omit<FakeHost["harness"]["behavior"], "callRpc"> & {
      callRpc<Method extends keyof typeof rpcContract>(
        method: Method,
        input?: unknown,
      ): Promise<PluginRpcResult<(typeof rpcContract)[Method]>>;
    };
  };
};

/** The SDK validates RPC responses at runtime but its old harness returns unknown. */
export function withTabsRpcTypes(host: FakeHost): TabsHost {
  return host as TabsHost;
}

export function createTabsTestHost(options?: Parameters<typeof createFakePluginHost>[0]): TabsHost {
  return withTabsRpcTypes(createFakePluginHost(options));
}

export type PartialRenderSlotOptions<Contract extends PluginRpcContract = PluginRpcContract> = Omit<
  RenderSlotOptions<Contract>,
  "rpc"
> & { rpc?: Partial<PluginRpcTestHandlers<Contract>> };

/** Missing mock handlers intentionally reject in the SDK; supplied handlers remain typed. */
export function renderPartialSlot<
  Props extends object,
  Contract extends PluginRpcContract = PluginRpcContract,
>(
  registration: Parameters<typeof renderSlot<Props, Contract>>[0],
  props: Props,
  options?: PartialRenderSlotOptions<Contract>,
) {
  return renderSlot<Props, Contract>(registration, props, options as RenderSlotOptions<Contract>);
}
