import { bedrockProviderModule } from "@i-enliven/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@i-enliven/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@i-enliven/pi-ai/compat";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
