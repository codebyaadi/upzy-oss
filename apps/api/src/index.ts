import { createDbStores, createGateway, createModelDiscovery, loadAiConfig } from "@upzy/ai";
import { createAuth } from "@upzy/auth/server";
import { createDodoClient, loadBillingConfig } from "@upzy/billing";
import { createDb } from "@upzy/db";

import { createApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const billingConfig = loadBillingConfig(process.env);
const dodo = billingConfig.enabled ? createDodoClient(billingConfig) : undefined;
const cancelSubscription = dodo ? (id: string) => dodo.cancelSubscription(id) : undefined;
const auth = createAuth(db, { cancelSubscription });

const aiConfig = loadAiConfig(process.env);
const aiStores = createDbStores(db, {
  dailyTokenBudget: aiConfig.defaultDailyTokenBudget,
  encryptionKey: env.UPZY_ENCRYPTION_KEY,
});
const discovery = createModelDiscovery();
const ai = {
  config: aiConfig,
  stores: aiStores,
  discovery,
  gateway: createGateway({ config: aiConfig, stores: aiStores, discovery }),
};

createApp({
  db,
  auth,
  webOrigin: env.WEB_ORIGIN,
  encryptionKey: env.UPZY_ENCRYPTION_KEY,
  ai,
  cancelSubscription,
}).listen(env.PORT);
console.log(`api listening on :${env.PORT}`);
