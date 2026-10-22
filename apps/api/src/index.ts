import { createDbStores, createGateway, createModelDiscovery, loadAiConfig } from "@upzy/ai";
import { createAuth } from "@upzy/auth/server";
import { createDb } from "@upzy/db";

import { createApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const auth = createAuth(db);

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
}).listen(env.PORT);
console.log(`api listening on :${env.PORT}`);
