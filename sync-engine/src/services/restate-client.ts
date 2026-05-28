import { createEndpointHandler } from "@restatedev/restate-sdk/fetch";
import * as clients from "@restatedev/restate-sdk-clients";
import { config } from "../config.ts";
import { inventorySaga } from "./restate.ts";

export const restateClient = clients.connect({ url: config.RESTATE_URL });

export const restateHandler = createEndpointHandler({
	services: [inventorySaga],
});
